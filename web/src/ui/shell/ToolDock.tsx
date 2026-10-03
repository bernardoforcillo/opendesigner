import { useEffect } from "react";
import { ToggleButton, ToggleButtonGroup, Tooltip, TooltipTrigger } from "react-aria-components";
import type { ReactNode } from "react";
import { Button, Icon, IconButton, Kbd, type IconName } from "../ds";
import { useScene } from "../../store/store";
import { DocMenu } from "./DocMenu";
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
export function ToolDock({
  tools, toolId, onChoose, mode, exportButton, presence, onNewDocument, connection, statusLabel,
}: {
  tools: readonly { id: ToolId; label: string }[]; toolId: ToolId; onChoose: (id: ToolId) => void;
  mode: EditorMode; exportButton: ReactNode; presence: ReactNode; onNewDocument: () => void;
  // Stato della connessione e dicitura accanto al pallino: l'ultima cosa del dock.
  connection: string; statusLabel: string;
}) {
  const zoom = useScene((s) => s.camera.zoom);
  const dot =
    connection === "connected" ? "bg-ok" : connection === "reconnecting" || connection === "connecting" ? "bg-warn" : "bg-danger";
  const canUndo = useScene((s) => s.undoStack.length > 0);
  const canRedo = useScene((s) => s.redoStack.length > 0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTextField(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const k = e.key.toUpperCase();
      const hit = tools.find((t) => TOOL_KEYS[t.id] === k && t.id !== "connect");
      if (hit) { e.preventDefault(); onChoose(hit.id); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tools, onChoose]);

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
        {([["design", "Design", "frame"], ["flows", "Flussi", "flow"]] as const).map(([id, label, icon]) => (
          <ToggleButton
            key={id}
            id={id}
            className={({ isSelected }) =>
              `flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium outline-none transition-colors ` +
              `focus-visible:shadow-[var(--ring)] ` +
              (isSelected ? (id === "flows" ? "bg-flow text-white shadow-sm" : "bg-raised text-fg shadow-sm") : "text-fg-muted hover:text-fg")
            }
          >
            <Icon name={icon} size={14} />
            {label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      <span className="mx-1 h-5 w-px bg-line" />
      <IconButton icon="undo" label="Annulla" shortcut="⌘Z" size={36} isDisabled={!canUndo} onPress={() => useScene.getState().undo()} />
      <IconButton icon="redo" label="Ripeti" shortcut="⇧⌘Z" size={36} isDisabled={!canRedo} onPress={() => useScene.getState().redo()} />
      <span className="mx-1 h-5 w-px bg-line" />
      <ToggleButtonGroup
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[toolId]}
        className="flex items-center gap-0.5"
        onSelectionChange={(keys) => onChoose((keys.values().next().value as ToolId | undefined) ?? "select")}
      >
        {tools.map((t, i) => {
          const sep = t.id === "hand" || (t.id === "connect" && i > 0);
          return (
            <span key={t.id} className="flex items-center">
              {sep && i > 0 && <span className="mx-1 h-5 w-px bg-line" />}
              <TooltipTrigger delay={300} closeDelay={0}>
                <ToggleButton
                  id={t.id}
                  aria-label={t.label}
                  className={({ isSelected }) =>
                    `flex h-9 w-9 items-center justify-center rounded-lg outline-none transition-colors ` +
                    `focus-visible:shadow-[var(--ring)] ` +
                    (isSelected
                      ? t.id === "connect" ? "bg-flow text-white" : "bg-accent text-accent-fg"
                      : "text-fg-muted hover:bg-surface-3 hover:text-fg")
                  }
                >
                  <Icon name={ICON[t.id] ?? "select"} size={18} />
                </ToggleButton>
                <Tooltip offset={10} className="z-50 flex items-center gap-2 rounded-md bg-fg px-2 py-1 text-[12px] font-medium text-surface shadow-pop">
                  {t.label}
                  {TOOL_KEYS[t.id] && <Kbd inverted>{TOOL_KEYS[t.id]}</Kbd>}
                </Tooltip>
              </TooltipTrigger>
            </span>
          );
        })}
      </ToggleButtonGroup>
      <span className="mx-1 h-5 w-px bg-line" />
      {mode === "flows" && (
        <Button variant="flow" icon="play" aria-label="Presenta" className="mr-0.5 h-9" onPress={() => useFlowUi.getState().setPresenting(true)}>
          Presenta
        </Button>
      )}
      {exportButton}
      <span className="mx-1 h-5 w-px bg-line" />
      {presence}
      <span className="mx-1 h-5 w-px bg-line" />
      <span className="flex items-center gap-3 px-2 text-[12px] text-fg-muted tabular-nums" aria-live="polite">
        <span title={statusLabel} className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
          {statusLabel}
        </span>
        <span title="Zoom">{Math.round(zoom * 100)}%</span>
      </span>
    </div>
  );
}
