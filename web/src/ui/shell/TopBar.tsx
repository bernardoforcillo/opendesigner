import type { ReactNode } from "react";
import { ToggleButton, ToggleButtonGroup, Tooltip, TooltipTrigger } from "react-aria-components";
import { Icon, Kbd } from "../ds";
import { useScene } from "../../store/store";
import { DocMenu } from "./DocMenu";
import { useFlowUi, type EditorMode } from "../../store/flowUi";

// LA BARRA IN ALTO: identità del documento, modalità, persone e stato -- le
// cose che riguardano IL DOCUMENTO, non la mano sulla tela (quella resta nel
// ToolDock in basso: strumenti, annulla/ripeti, Presenta). Stessa pillola
// flottante del dock, speculare in alto.
const TOOLTIP_CLS = "z-50 flex items-center gap-2 rounded-md bg-fg px-2 py-1 text-[12px] font-medium text-surface shadow-pop";

// Le tre modalità, nello stesso ordine e con le stesse scorciatoie del dock
// (vedi shell/ToolDock.tsx::MODES, da cui questa lista è spostata).
const MODES = [
  ["design", "Design", "frame", "F", "Disegna le schermate"],
  ["flows", "Flussi", "flow", "F", "Collega le schermate e prova il prototipo"],
  ["dev", "Sviluppo", "code", "S", "Prontezza, codice generato, export"],
] as const;

export function TopBar({
  mode, presence, onNewDocument, connection, statusLabel,
}: {
  mode: EditorMode; presence: ReactNode; onNewDocument: () => void;
  connection: string; statusLabel: string;
}) {
  const zoom = useScene((s) => s.camera.zoom);
  const dot =
    connection === "connected" ? "bg-ok" : connection === "reconnecting" || connection === "connecting" ? "bg-warn" : "bg-danger";

  return (
    <div
      role="toolbar"
      aria-label="Documento"
      className="absolute top-4 left-1/2 z-20 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-xl bg-raised p-1 shadow-bar"
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
      <span className="ml-auto flex items-center gap-2">
        {presence}
        <span className="flex items-center gap-2 px-2 text-[12px] text-fg-muted tabular-nums" aria-live="polite">
          <span title={statusLabel} className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
            <span className="max-[1600px]:hidden">{statusLabel}</span>
          </span>
          <span title="Zoom">{Math.round(zoom * 100)}%</span>
        </span>
      </span>
    </div>
  );
}
