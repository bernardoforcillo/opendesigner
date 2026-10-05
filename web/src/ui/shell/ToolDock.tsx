import { useEffect, useState } from "react";
import { Button as RacButton, Menu, MenuItem, MenuTrigger, Popover, ToggleButton, ToggleButtonGroup, Tooltip, TooltipTrigger } from "react-aria-components";
import type { ReactNode } from "react";
import { Button, Icon, IconButton, Kbd, type IconName } from "../ds";
import { useScene } from "../../store/store";
import { usePanels } from "./panels";
import { useFlowUi, type EditorMode } from "../../store/flowUi";
import { useTimeline } from "../../animation/timelineStore";
import { AnimIconButton } from "../ds/anim-parts";
import type { ToolId } from "../../tools/types";
import { isTextField } from "../../tools/toolManager";

// THE TOOL DOCK: a floating bar at the bottom center of the canvas,
// as in every design editor -- tools sit where the hand is, not in
// a menu bar. Only one tool active at a time (radiogroup: the right
// semantics, and the one the tests query).
const ICON: Record<string, IconName> = {
  select: "select", connect: "connect", frame: "frame", rect: "rect",
  ellipse: "ellipse", text: "text", pen: "pen", hand: "hand",
};

// Single-key shortcuts. F (toggles Design/Flows) and K (Connect) live in
// App; here are the drawing ones. Never inside a text field nor with a
// modifier pressed.
export const TOOL_KEYS: Partial<Record<ToolId, string>> = {
  select: "V", frame: "A", rect: "R", ellipse: "O", text: "T", pen: "P", hand: "H", connect: "K",
};

// SHAPE tools live in a single place in the dock: the button shows
// the last shape used and the chevron opens the others (Rectangle, Ellipse). Fewer
// fixed icons, same speed: R and O remain the shortcuts.
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

const SEP = <span className="mx-1 h-5 w-px shrink-0 bg-line" />;

// The dock gathers EVERYTHING used with the HAND on the canvas: history,
// tools (shapes grouped), Animation and Present in flows -- a
// floating bar at the bottom, mirroring the top bar (shell/TopBar.tsx)
// which instead carries document identity, mode, people and status.
// Export is in neither: it lives in the properties panel, where
// it appears only with a selection (see PropertiesPanel.tsx::ExportSection).
export function ToolDock({
  tools, toolId, onChoose, mode,
}: {
  tools: readonly { id: ToolId; label: string }[]; toolId: ToolId; onChoose: (id: ToolId) => void;
  mode: EditorMode;
}) {
  const canUndo = useScene((s) => s.undoStack.length > 0);
  const canRedo = useScene((s) => s.redoStack.length > 0);
  const timelineOpen = useTimeline((s) => s.open);
  const [lastShape, setLastShape] = useState<ToolId>(readLastShape);
  const activeShape = SHAPE_IDS.includes(toolId) ? toolId : lastShape;

  const choose = (id: ToolId) => {
    if (SHAPE_IDS.includes(id)) {
      setLastShape(id);
      try { localStorage.setItem(LAST_SHAPE_KEY, id); } catch { /* no storage */ }
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
  // The group shows a single button per shape: the other tools stay
  // one each.
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
                aria-label="More shapes"
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
      aria-label="Tools"
      className="absolute bottom-4 left-1/2 z-20 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-xl bg-raised p-1 shadow-bar"
    >
      {mode === "design" && (
        <AnimIconButton icon="timeline" label="Animation" shortcut="M" size={32} selected={timelineOpen} onPress={() => useTimeline.getState().toggleOpen()} />
      )}
      {SEP}
      <IconButton icon="undo" label="Undo" shortcut="⌘Z" size={32} isDisabled={!canUndo} onPress={() => useScene.getState().undo()} />
      <IconButton icon="redo" label="Redo" shortcut="⇧⌘Z" size={32} isDisabled={!canRedo} onPress={() => useScene.getState().redo()} />
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
        <Button variant="flow" icon="play" aria-label="Present" className="mr-0.5 h-9" onPress={() => useFlowUi.getState().setPresenting(true)}>
          Present
        </Button>
      )}
    </div>
  );
}
