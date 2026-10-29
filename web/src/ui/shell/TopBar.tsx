import type { ReactNode } from "react";
import { ToggleButton, ToggleButtonGroup, Tooltip, TooltipTrigger } from "react-aria-components";
import { Icon, IconButton, Kbd } from "@/ui/ds";
import { useAccess } from "@/rpc/access";
import { useScene } from "@/store/store";
import { DocMenu } from "@/ui/shell/DocMenu";
import { DocName } from "@/ui/shell/DocName";
import { ZoomMenu } from "@/ui/shell/ZoomMenu";
import { usePanels } from "@/ui/shell/panels";
import { useFlowUi, type EditorMode } from "@/store/flowUi";
import { verticalOf } from "@/store/docSettings";
import { verticalDef } from "@/verticals";
import { useT } from "@/i18n";

// THE TOP BAR: document identity, mode, people and status -- the
// things that concern THE DOCUMENT, not the hand on the canvas (that stays in the
// ToolDock at the bottom: tools, undo/redo, Present). A full-width island
// above the panels, like the editor's other islands (see App.tsx).
// Three zones: on the left the menu, left panel and mode; in the middle the
// document name (renamable); on the right people, status, zoom and right panel.
// The shared look of the islands: TopBar, side panels, canvas and timeline.
export const ISLAND_CLS = "bg-surface";

const TOOLTIP_CLS = "z-50 flex items-center gap-2 rounded-md bg-fg px-2 py-1 text-[12px] font-medium text-surface shadow-pop";

// The modes, in the same order and with the same shortcuts as the dock
// (see shell/ToolDock.tsx::MODES, from which this list was moved).
const MODES = [
  ["board", "Board", "page", "B", "An infinite board: sticky notes, text and arrows"],
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
  const { t } = useT();
  const accessRole = useAccess((s) => s.role);
  const vertical = useScene((s) => verticalOf(s.scene));
  const def = verticalDef(vertical);
  // Only the modes this kind of document needs (a book has no flows to connect).
  const modes = MODES.filter(([id]) => def.modes.includes(id));
  const left = usePanels((s) => s.left);
  const right = usePanels((s) => s.right);
  const dot =
    connection === "connected" ? "bg-ok" : connection === "reconnecting" || connection === "connecting" ? "bg-warn" : "bg-danger";

  return (
    <div
      role="toolbar"
      aria-label={t("Document")}
      className={`grid h-11 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 px-2 ${ISLAND_CLS}`}
    >
      <span className="flex min-w-0 items-center gap-0.5">
      <DocMenu onNewDocument={onNewDocument} />
      <IconButton icon="panelLeft" label={left ? t("Close left panel") : t("Open left panel")} shortcut="[" size={32} onPress={() => usePanels.getState().toggle("left")} />
      <ToggleButtonGroup
        aria-label={t("Mode")}
        selectionMode="single"
        disallowEmptySelection
        selectedKeys={[mode]}
        className="mx-1 flex gap-px rounded-md border border-line bg-surface-2 p-0.5"
        onSelectionChange={(keys) => {
          useFlowUi.getState().setMode((keys.values().next().value as EditorMode | undefined) ?? "design");
        }}
      >
        {modes.map(([id, defaultLabel, icon, key, hint]) => {
          const label = def.modeLabels[id] ?? t(defaultLabel);
          return (
          <TooltipTrigger key={id} delay={300} closeDelay={0}>
            <ToggleButton
              id={id}
              className={({ isSelected }) =>
                `flex h-7 items-center gap-1.5 rounded-[2px] px-2.5 text-[12px] font-medium outline-none transition-colors ` +
                `focus-visible:shadow-[var(--ring)] ` +
                (isSelected
                  ? id === "flows" ? "bg-flow text-white" : id === "dev" ? "bg-accent text-accent-fg" : "bg-fg text-surface"
                  : "text-fg-muted hover:text-fg")
              }
            >
              <Icon name={icon} size={14} />
              {label}
            </ToggleButton>
            <Tooltip offset={10} className={TOOLTIP_CLS}>
              {t(hint)}
              <Kbd inverted>{key}</Kbd>
            </Tooltip>
          </TooltipTrigger>
          );
        })}
      </ToggleButtonGroup>
      </span>
      <span className="flex min-w-0 items-center justify-center gap-2">
        <DocName />
        {accessRole === "view" || accessRole === "comment" ? (
          <span title={t("Your link does not allow editing")} className="shrink-0 rounded-sm bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase text-fg-muted">
            {accessRole === "view" ? t("View only") : t("Comment only")}
          </span>
        ) : null}
      </span>
      <span className="flex min-w-0 items-center justify-end gap-2">
        {presence}
        <span className="flex items-center gap-2 px-2 font-mono text-[11px] text-fg-muted tabular-nums" aria-live="polite">
          <span title={statusLabel} className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
            <span className="max-[1600px]:hidden">{statusLabel}</span>
          </span>
          <ZoomMenu />
        </span>
        <IconButton icon="panelRight" label={right ? t("Close right panel") : t("Open right panel")} shortcut="]" size={32} onPress={() => usePanels.getState().toggle("right")} />
      </span>
    </div>
  );
}
