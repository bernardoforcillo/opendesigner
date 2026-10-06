import type { ReactNode } from "react";
import { ToggleButton, ToggleButtonGroup, Tooltip, TooltipTrigger } from "react-aria-components";
import { Icon, IconButton, Kbd } from "../ds";
import { useScene } from "../../store/store";
import { DocMenu } from "./DocMenu";
import { DocName } from "./DocName";
import { usePanels } from "./panels";
import { useFlowUi, type EditorMode } from "../../store/flowUi";

// THE TOP BAR: document identity, mode, people and status -- the
// things that concern THE DOCUMENT, not the hand on the canvas (that stays in the
// ToolDock at the bottom: tools, undo/redo, Present). A full-width island
// above the panels, like the editor's other islands (see App.tsx).
// Three zones: on the left the menu, left panel and mode; in the middle the
// document name (renamable); on the right people, status, zoom and right panel.
// The shared look of the islands: TopBar, side panels, canvas and timeline.
export const ISLAND_CLS = "rounded-xl border border-line bg-surface";

const TOOLTIP_CLS = "z-50 flex items-center gap-2 rounded-md bg-fg px-2 py-1 text-[12px] font-medium text-surface shadow-pop";

// The three modes, in the same order and with the same shortcuts as the dock
// (see shell/ToolDock.tsx::MODES, from which this list was moved).
const MODES = [
  ["design", "Design", "frame", "F", "Draw the screens"],
  ["flows", "Flows", "flow", "F", "Connect the screens and try the prototype"],
  ["dev", "Develop", "code", "S", "Readiness, generated code, export"],
] as const;

export function TopBar({
  mode, presence, onNewDocument, connection, statusLabel,
}: {
  mode: EditorMode; presence: ReactNode; onNewDocument: () => void;
  connection: string; statusLabel: string;
}) {
  const zoom = useScene((s) => s.camera.zoom);
  const left = usePanels((s) => s.left);
  const right = usePanels((s) => s.right);
  const dot =
    connection === "connected" ? "bg-ok" : connection === "reconnecting" || connection === "connecting" ? "bg-warn" : "bg-danger";

  return (
    <div
      role="toolbar"
      aria-label="Document"
      className={`grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 p-1 ${ISLAND_CLS}`}
    >
      <span className="flex min-w-0 items-center gap-0.5">
      <DocMenu onNewDocument={onNewDocument} />
      <IconButton icon="panelLeft" label={left ? "Close left panel" : "Open left panel"} shortcut="[" size={32} onPress={() => usePanels.getState().toggle("left")} />
      <ToggleButtonGroup
        aria-label="Mode"
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
      </span>
      <DocName />
      <span className="flex min-w-0 items-center justify-end gap-2">
        {presence}
        <span className="flex items-center gap-2 px-2 text-[12px] text-fg-muted tabular-nums" aria-live="polite">
          <span title={statusLabel} className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
            <span className="max-[1600px]:hidden">{statusLabel}</span>
          </span>
          <span title="Zoom">{Math.round(zoom * 100)}%</span>
        </span>
        <IconButton icon="panelRight" label={right ? "Close right panel" : "Open right panel"} shortcut="]" size={32} onPress={() => usePanels.getState().toggle("right")} />
      </span>
    </div>
  );
}
