import { ToggleButton, ToggleButtonGroup, Tooltip, TooltipTrigger } from "react-aria-components";
import { Icon, Kbd } from "@/ui/ds";
import { useFlowUi, type EditorMode } from "@/store/flowUi";
import { useScene } from "@/store/store";
import { verticalOf } from "@/store/docSettings";
import { verticalDef } from "@/verticals";
import { useT } from "@/i18n";

// THE MODE TABS: Board, Design, Flows, Develop -- the modes this kind of document has, as the tabs at the top of
// the right panel (where a design tool keeps Design / Prototype). The same radio group the document bar used to
// hold; the shortcuts are unchanged.
const MODES = [
  ["board", "Board", "page", "B", "An infinite board: sticky notes, text and arrows"],
  ["design", "Design", "frame", "F", "Draw the screens"],
  ["flows", "Flows", "flow", "F", "Connect the screens and try the prototype"],
  ["dev", "Develop", "code", "S", "Readiness, generated code, export"],
] as const;

export function ModeTabs() {
  const { t } = useT();
  const mode = useFlowUi((s) => s.mode);
  const def = verticalDef(useScene((s) => verticalOf(s.scene)));
  const modes = MODES.filter(([id]) => def.modes.includes(id));
  return (
    <ToggleButtonGroup
      aria-label={t("Mode")}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[mode]}
      className="flex min-w-0 gap-0.5"
      onSelectionChange={(keys) => useFlowUi.getState().setMode((keys.values().next().value as EditorMode | undefined) ?? "design")}
    >
      {modes.map(([id, defaultLabel, icon, key, hint]) => (
        <TooltipTrigger key={id} delay={300} closeDelay={0}>
          <ToggleButton
            id={id}
            className={({ isSelected }) =>
              `flex h-9 items-center gap-1.5 border-b-2 px-2 text-[12px] font-medium outline-none focus-visible:shadow-[var(--ring)] ` +
              (isSelected ? "border-accent text-fg" : "border-transparent text-fg-subtle hover:text-fg")
            }
          >
            {({ isSelected }) => (
              <>
                <Icon name={icon} size={13} />
                {/* Only the open tab shows its name (the panel is narrow); the others keep it for screen readers. */}
                <span className={isSelected ? "" : "sr-only"}>{def.modeLabels[id] ?? t(defaultLabel)}</span>
              </>
            )}
          </ToggleButton>
          <Tooltip offset={10} className="z-50 flex items-center gap-2 rounded-md bg-fg px-2 py-1 text-[12px] font-medium text-surface shadow-pop">
            {t(hint)}
            <Kbd inverted>{key}</Kbd>
          </Tooltip>
        </TooltipTrigger>
      ))}
    </ToggleButtonGroup>
  );
}
