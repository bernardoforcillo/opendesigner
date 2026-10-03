import type { ReactNode } from "react";
import { Menu, MenuItem, MenuTrigger, Popover, Separator, ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { Button, Icon, IconButton } from "../ds";
import { useScene } from "../../store/store";
import { useFlowUi, type EditorMode } from "../../store/flowUi";
import { useTheme } from "./theme";

// LA BARRA SUPERIORE: chi sei e dove sei (documento, modalità), cosa puoi fare
// sul documento (annulla, esporta, condividi) e chi c'è con te. Gli strumenti di
// disegno NON stanno qui: stanno nel dock sulla tela.
//
// Tre zone: a sinistra l'identità (logo + nome del documento), al centro il
// commutatore di modalità -- la cosa più importante dello schermo, perché cambia
// ciò che vedi e ciò che il pannello laterale ti offre --, a destra le azioni.

function Logo() {
  return (
    <svg viewBox="0 0 28 28" width="24" height="24" aria-hidden="true">
      <rect width="28" height="28" rx="8" fill="var(--accent)" />
      <rect x="6.5" y="6.5" width="8" height="8" rx="2" fill="var(--accent-fg)" opacity="0.95" />
      <circle cx="19.5" cy="19.5" r="3.6" fill="none" stroke="var(--accent-fg)" strokeWidth="2" />
      <path d="M14.8 10.5h3a2.2 2.2 0 012.2 2.2v3.6" stroke="var(--accent-fg)" strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.7" />
    </svg>
  );
}

const MODES: { id: EditorMode; label: string; icon: "frame" | "flow" }[] = [
  { id: "design", label: "Design", icon: "frame" },
  { id: "flows", label: "Flussi", icon: "flow" },
];

export function TopBar({
  mode, onNewDocument, presence, exportButton,
}: {
  mode: EditorMode;
  onNewDocument: () => void;
  presence: ReactNode;
  exportButton: ReactNode;
}) {
  const docName = useScene((s) => s.scene?.name ?? "");
  const canUndo = useScene((s) => s.undoStack.length > 0);
  const canRedo = useScene((s) => s.redoStack.length > 0);
  const theme = useTheme((s) => s.choice);
  const setTheme = useTheme((s) => s.set);

  return (
    <div
      role="toolbar"
      aria-label="Documento"
      className="relative flex h-11 shrink-0 items-center gap-2 border-b border-line bg-surface px-3"
    >
      {/* sinistra */}
      <div className="flex min-w-0 items-center gap-2">
        <Logo />
        <span className="max-w-[220px] truncate text-[13px] font-semibold text-fg">
          {docName === "" ? "Senza titolo" : docName}
        </span>
        <span className="mx-1 h-4 w-px bg-line" />
        <IconButton icon="undo" label="Annulla" shortcut="⌘Z" isDisabled={!canUndo} onPress={() => useScene.getState().undo()} />
        <IconButton icon="redo" label="Ripeti" shortcut="⇧⌘Z" isDisabled={!canRedo} onPress={() => useScene.getState().redo()} />
      </div>

      {/* centro: la modalità */}
      <div className="absolute left-1/2 -translate-x-1/2">
        <ToggleButtonGroup
          aria-label="Modalità"
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[mode]}
          className="flex gap-0.5 rounded-lg bg-surface-3 p-0.5"
          onSelectionChange={(keys) => {
            useFlowUi.getState().setMode((keys.values().next().value as EditorMode | undefined) ?? "design");
          }}
        >
          {MODES.map((m) => (
            <ToggleButton
              key={m.id}
              id={m.id}
              className={({ isSelected }) =>
                `flex h-7 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium outline-none transition-colors ` +
                `focus-visible:shadow-[var(--ring)] ` +
                (isSelected
                  ? m.id === "flows" ? "bg-flow text-white shadow-sm" : "bg-raised text-fg shadow-sm"
                  : "text-fg-muted hover:text-fg")
              }
            >
              <Icon name={m.icon} size={14} />
              {m.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </div>

      {/* destra */}
      <div className="ml-auto flex items-center gap-2">
        {mode === "flows" && (
          <Button variant="flow" icon="play" aria-label="Presenta" onPress={() => useFlowUi.getState().setPresenting(true)}>
            Presenta
          </Button>
        )}
        {presence}
        {exportButton}
        <MenuTrigger>
          <IconButton icon="more" label="Altro" />
          <Popover
            placement="bottom end"
            className="z-50 min-w-[200px] rounded-xl bg-raised p-1 text-[13px] text-fg shadow-pop"
          >
            <Menu className="outline-none" onAction={(k) => {
              if (k === "new") onNewDocument();
              else if (k === "system" || k === "light" || k === "dark") setTheme(k);
            }}>
              <MenuItem id="new" className={ITEM}>
                <Icon name="plus" size={14} /> Nuovo documento
              </MenuItem>
              <Separator className="my-1 h-px bg-line" />
              <div className="px-2 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">Tema</div>
              {([["system", "Come il sistema", "cpu"], ["light", "Chiaro", "sun"], ["dark", "Scuro", "moon"]] as const).map(([id, label, icon]) => (
                <MenuItem key={id} id={id} className={ITEM}>
                  <Icon name={icon} size={14} /> {label}
                  {theme === id && <Icon name="check" size={14} className="ml-auto text-accent" />}
                </MenuItem>
              ))}
            </Menu>
          </Popover>
        </MenuTrigger>
      </div>
    </div>
  );
}

const ITEM =
  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none " +
  "data-[focused]:bg-surface-3 data-[hovered]:bg-surface-3";
