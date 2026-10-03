import { useEffect, useState } from "react";
import { Button as RacButton, Menu, MenuItem, MenuTrigger, Popover, ToggleButton, ToggleButtonGroup, Tooltip, TooltipTrigger } from "react-aria-components";
import type { ReactNode } from "react";
import { Button, Icon, IconButton, Kbd, type IconName } from "../ds";
import { useScene } from "../../store/store";
import { DocMenu } from "./DocMenu";
import { usePanels } from "./panels";
import { useFlowUi, type EditorMode } from "../../store/flowUi";
import type { ToolId } from "../../tools/types";
import { isTextField } from "../../tools/toolManager";

// IL DOCK DEGLI STRUMENTI: una barra flottante in basso al centro della tela,
// come in ogni editor di design -- gli strumenti stanno dove sta la mano, non in
// una barra di menu. Un solo strumento attivo alla volta (radiogroup: la
// semantica giusta, e quella che i test interrogano).
const ICON: Record<string, IconName> = {
  select: "select", connect: "connect", frame: "frame", rect: "rect",
  ellipse: "ellipse", text: "text", pen: "pen", hand: "hand",
};

// Scorciatoie a tasto singolo. F (alterna Design/Flussi) e K (Collega) vivono in
// App; qui ci sono quelle di disegno. Mai dentro un campo di testo né con un
// modificatore premuto.
export const TOOL_KEYS: Partial<Record<ToolId, string>> = {
  select: "V", frame: "A", rect: "R", ellipse: "O", text: "T", pen: "P", hand: "H", connect: "K",
};

// Il dock raccoglie TUTTO ciò che si usa con la mano sulla tela: annulla/ripeti a
// sinistra, gli strumenti al centro, a destra le azioni sul documento (Presenta
// nei flussi, Esporta). La barra in alto resta per identità, modalità e persone.
// Gli strumenti di FORMA stanno in un solo posto del dock: il pulsante mostra
// l'ultima forma usata e il chevron apre le altre (Rettangolo, Ellisse). Meno
// icone fisse, stessa velocità: R e O restano le scorciatoie.
const SHAPE_IDS: readonly ToolId[] = ["rect", "ellipse"];
const LAST_SHAPE_KEY = "od.lastShape";

function readLastShape(): ToolId {
  try {
    const v = localStorage.getItem(LAST_SHAPE_KEY);
    return v === "ellipse" ? "ellipse" : "rect";
  } catch { return "rect"; }
}

const TOOL_BTN = (selected: boolean, flow: boolean) =>
  `flex h-9 w-9 items-center justify-center rounded-lg outline-none transition-colors focus-visible:shadow-[var(--ring)] ` +
  (selected ? (flow ? "bg-flow text-white" : "bg-accent text-accent-fg") : "text-fg-muted hover:bg-surface-3 hover:text-fg");

const TOOLTIP_CLS = "z-50 flex items-center gap-2 rounded-md bg-fg px-2 py-1 text-[12px] font-medium text-surface shadow-pop";

// Le tre modalità, nell'ordine del percorso: si disegna, si collega, si consegna.
// F alterna Design e Flussi (da Sviluppo riporta a Design); S apre Sviluppo.
const MODES = [
  ["design", "Design", "frame", "F", "Disegna le schermate"],
  ["flows", "Flussi", "flow", "F", "Collega le schermate e prova il prototipo"],
  ["dev", "Sviluppo", "code", "S", "Prontezza, codice generato, export"],
] as const;

const SEP = <span className="mx-1 h-5 w-px shrink-0 bg-line" />;

// Il dock raccoglie TUTTO ciò che si usa con la mano sulla tela, in poco spazio:
// il logo apre il menu del documento (tema, renderer, pannelli), poi modalità,
// cronologia, strumenti (le forme raggruppate) e infine le azioni: Presenta nei
// flussi, Esporta, le persone (un solo pulsante con popover) e lo stato.
export function ToolDock({
  tools, toolId, onChoose, mode, exportButton, presence, onNewDocument, connection, statusLabel,
}: {
  tools: readonly { id: ToolId; label: string }[]; toolId: ToolId; onChoose: (id: ToolId) => void;
  mode: EditorMode; exportButton: ReactNode; presence: ReactNode; onNewDocument: () => void;
  connection: string; statusLabel: string;
}) {
  const zoom = useScene((s) => s.camera.zoom);
  const dot =
    connection === "connected" ? "bg-ok" : connection === "reconnecting" || connection === "connecting" ? "bg-warn" : "bg-danger";
  const canUndo = useScene((s) => s.undoStack.length > 0);
  const canRedo = useScene((s) => s.redoStack.length > 0);
  const [lastShape, setLastShape] = useState<ToolId>(readLastShape);
  const activeShape = SHAPE_IDS.includes(toolId) ? toolId : lastShape;

  const choose = (id: ToolId) => {
    if (SHAPE_IDS.includes(id)) {
      setLastShape(id);
      try { localStorage.setItem(LAST_SHAPE_KEY, id); } catch { /* niente storage */ }
    }
    onChoose(id);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTextField(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.key === "[" || e.key === "]") {
        e.preventDefault();
        usePanels.getState().toggle(e.key === "[" ? "left" : "right");
        return;
      }
      const k = e.key.toUpperCase();
      const hit = tools.find((t) => TOOL_KEYS[t.id] === k && t.id !== "connect");
      if (hit) { e.preventDefault(); choose(hit.id); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tools, onChoose]);

  const shapes = tools.filter((t) => SHAPE_IDS.includes(t.id));
  const shapeTool = shapes.find((t) => t.id === activeShape) ?? shapes[0];
  // Il gruppo mostra un solo pulsante per forma: gli altri strumenti restano
  // uno ciascuno.
  const slots = tools.filter((t) => !SHAPE_IDS.includes(t.id));
  const shapeIndex = tools.findIndex((t) => SHAPE_IDS.includes(t.id));

  const renderTool = (t: { id: ToolId; label: string }, i: number) => (
    <span key={t.id} className="flex items-center">
      {(t.id === "hand" || (t.id === "connect" && i > 0)) && i > 0 && SEP}
      <TooltipTrigger delay={300} closeDelay={0}>
        <ToggleButton id={t.id} aria-label={t.label} className={({ isSelected }) => TOOL_BTN(isSelected, t.id === "connect")}>
          <Icon name={ICON[t.id] ?? "select"} size={18} />
        </ToggleButton>
        <Tooltip offset={10} className={TOOLTIP_CLS}>
          {t.label}
          {TOOL_KEYS[t.id] && <Kbd inverted>{TOOL_KEYS[t.id]}</Kbd>}
        </Tooltip>
      </TooltipTrigger>
    </span>
  );

  const ordered: ReactNode[] = [];
  let n = 0;
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    if (SHAPE_IDS.includes(t.id)) {
      if (i === shapeIndex && shapeTool) {
        ordered.push(
          <span key="shapes" className="flex items-center">
            {renderTool(shapeTool, n++)}
            <MenuTrigger>
              <RacButton
                aria-label="Altre forme"
                className="-ml-1 flex h-9 w-4 items-center justify-center rounded-md text-fg-subtle outline-none hover:bg-surface-3 hover:text-fg focus-visible:shadow-[var(--ring)]"
              >
                <Icon name="chevronUp" size={10} />
              </RacButton>
              <Popover placement="top" offset={10} className="z-50 min-w-[170px] rounded-xl bg-raised p-1 text-[13px] text-fg shadow-pop">
                <Menu className="outline-none" onAction={(k) => choose(k as ToolId)}>
                  {shapes.map((s) => (
                    <MenuItem key={s.id} id={s.id} className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-[focused]:bg-surface-3 data-[hovered]:bg-surface-3">
                      <Icon name={ICON[s.id] ?? "rect"} size={14} /> {s.label}
                      <span className="ml-auto text-[11px] text-fg-subtle">{TOOL_KEYS[s.id]}</span>
                    </MenuItem>
                  ))}
                </Menu>
              </Popover>
            </MenuTrigger>
          </span>,
        );
      }
      continue;
    }
    ordered.push(renderTool(t, n++));
  }
  void slots;

  return (
    <div
      role="toolbar"
      aria-label="Strumenti"
      className="absolute bottom-4 left-1/2 z-20 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-xl bg-raised p-1 shadow-bar"
    >
      <DocMenu onNewDocument={onNewDocument} />
      <ToggleButtonGroup
        aria-label="Modalità"
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[mode]}
        className="mx-1 flex gap-0.5 rounded-lg bg-surface-3 p-0.5"
        onSelectionChange={(keys) => {
          useFlowUi.getState().setMode((keys.values().next().value as EditorMode | undefined) ?? "design");
        }}
      >
        {MODES.map(([id, label, icon, key, hint]) => (
          <TooltipTrigger key={id} delay={300} closeDelay={0}>
            <ToggleButton
              id={id}
              className={({ isSelected }) =>
                `flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium outline-none transition-colors ` +
                `focus-visible:shadow-[var(--ring)] ` +
                (isSelected
                  ? id === "flows" ? "bg-flow text-white shadow-sm" : id === "dev" ? "bg-accent text-accent-fg shadow-sm" : "bg-raised text-fg shadow-sm"
                  : "text-fg-muted hover:text-fg")
              }
            >
              <Icon name={icon} size={14} />
              {label}
            </ToggleButton>
            <Tooltip offset={10} className={TOOLTIP_CLS}>
              {hint}
              <Kbd inverted>{key}</Kbd>
            </Tooltip>
          </TooltipTrigger>
        ))}
      </ToggleButtonGroup>
      {SEP}
      <IconButton icon="undo" label="Annulla" shortcut="⌘Z" size={32} isDisabled={!canUndo} onPress={() => useScene.getState().undo()} />
      <IconButton icon="redo" label="Ripeti" shortcut="⇧⌘Z" size={32} isDisabled={!canRedo} onPress={() => useScene.getState().redo()} />
      {SEP}
      <ToggleButtonGroup
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[SHAPE_IDS.includes(toolId) ? activeShape : toolId]}
        className="flex items-center gap-0.5"
        onSelectionChange={(keys) => choose((keys.values().next().value as ToolId | undefined) ?? "select")}
      >
        {ordered}
      </ToggleButtonGroup>
      {SEP}
      {mode === "flows" && (
        <Button variant="flow" icon="play" aria-label="Presenta" className="mr-0.5 h-9" onPress={() => useFlowUi.getState().setPresenting(true)}>
          Presenta
        </Button>
      )}
      {exportButton}
      {presence}
      <span className="flex items-center gap-2 px-2 text-[12px] text-fg-muted tabular-nums" aria-live="polite">
        <span title={statusLabel} className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
          <span className="max-[1600px]:hidden">{statusLabel}</span>
        </span>
        <span title="Zoom">{Math.round(zoom * 100)}%</span>
      </span>
    </div>
  );
}
