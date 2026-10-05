import { useScene } from "../store/store";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { LayoutAlignLite } from "../store/types";
import { wrapSelectionInFrame } from "../tools/wrapFrame";
import { IconButton, Section } from "./ds";
import { SegButtons, type SegOption } from "./ds/props-controls";
import { NumberField } from "./fields/NumberField";
import { autoLayoutOps } from "./autoLayoutOps";

const lookup = (id: string) => useScene.getState().scene?.nodes.at(id);

const DIRECTIONS: SegOption<"horizontal" | "vertical">[] = [
  { value: "horizontal", label: "Horizontal", icon: "dirH" },
  { value: "vertical", label: "Vertical", icon: "dirV" },
];

// Alignments are pictograms with a line (the edge or the midline) and
// resting blocks: the base drawing applies to the HORIZONTAL axis, and `rotate`
// turns it for the vertical one. The main axis is the direction's,
// the cross axis the other.
function aligns(rotate: boolean): SegOption<LayoutAlignLite>[] {
  return [
    { value: "start", label: "Start", icon: "alignStart", rotate },
    { value: "center", label: "Center", icon: "alignCenter", rotate },
    { value: "end", label: "End", icon: "alignEnd", rotate },
    { value: "space-between", label: "Distributed", icon: "alignBetween", rotate },
  ];
}

const checkbox = "size-3.5 shrink-0 cursor-pointer rounded accent-accent";

/**
 * The AUTO LAYOUT section of the selected frame: on/off (the "+" / "−"
 * in the header), direction, spacing, padding, alignments and hug. It does not
 * know gestures: it emits ops through `run`, the same `runGesture` as the panel,
 * so every change is ONE undo step. What results (the children's
 * positions) is computed by the server.
 */
export function AutoLayoutControls({ run }: { run: (build: (ids: readonly string[]) => Op[]) => void }) {
  const first = useScene((s) => (s.selection[0] ? s.scene?.nodes.at(s.selection[0]) : undefined));
  const al = first?.autoLayout;
  const num = (key: "spacing" | "paddingLeft" | "paddingTop" | "paddingRight" | "paddingBottom", label: string) => (
    <NumberField
      label={label} value={al ? al[key] : 0} minValue={0}
      onCommit={(v) => run((ids) => autoLayoutOps(ids, lookup, { [key]: v }))}
    />
  );
  // Horizontal direction: the main axis is x, the cross axis y.
  const horizontal = al?.direction !== "vertical";
  return (
    <Section
      title="Auto layout"
      bare={al === undefined}
      actions={
        al === undefined ? (
          <IconButton
            icon="plus" label="Add auto layout" size={24}
            onPress={() => run((ids) => autoLayoutOps(ids, lookup, { enabled: true }))}
          />
        ) : (
          <IconButton
            icon="minus" label="Remove auto layout" size={24}
            onPress={() => run((ids) => autoLayoutOps(ids, lookup, { enabled: false }))}
          />
        )
      }
    >
      {al && (
        <div className="flex flex-col gap-2">
          <SegButtons
            label="Direction" value={al.direction} options={DIRECTIONS}
            onPick={(direction) => run((ids) => autoLayoutOps(ids, lookup, { direction }))}
          />
          {num("spacing", "Spacing")}
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-fg-subtle">Padding</span>
            <div className="grid grid-cols-2 gap-1.5">
              {num("paddingLeft", "Left")}
              {num("paddingRight", "Right")}
              {num("paddingTop", "Top")}
              {num("paddingBottom", "Bottom")}
            </div>
          </div>
          <SegButtons
            label="Main alignment" showLabel value={al.mainAlign} options={aligns(!horizontal)}
            onPick={(mainAlign) => run((ids) => autoLayoutOps(ids, lookup, { mainAlign }))}
          />
          <SegButtons
            label="Cross alignment" showLabel value={al.crossAlign}
            options={aligns(horizontal).filter((a) => a.value !== "space-between")}
            onPick={(crossAlign) => run((ids) => autoLayoutOps(ids, lookup, { crossAlign }))}
          />
          <div className="flex gap-4 text-[12px] text-fg-muted">
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox" className={checkbox} checked={al.hugWidth}
                onChange={(e) => run((ids) => autoLayoutOps(ids, lookup, { hugWidth: e.target.checked }))}
              />
              Hug width
            </label>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox" className={checkbox} checked={al.hugHeight}
                onChange={(e) => run((ids) => autoLayoutOps(ids, lookup, { hugHeight: e.target.checked }))}
              />
              Hug height
            </label>
          </div>
        </div>
      )}
    </Section>
  );
}

/**
 * For a selection that is NOT a frame: the same section, with the "+" that
 * wraps it in a frame with auto layout (Shift+A). It is the same gesture as the
 * shortcut.
 */
export function WrapInAutoLayoutButton() {
  return (
    <Section
      title="Auto layout"
      bare
      actions={
        <IconButton
          icon="plus" label="Add auto layout" shortcut="⇧A" size={24}
          onPress={() => wrapSelectionInFrame(true)}
        />
      }
    />
  );
}
