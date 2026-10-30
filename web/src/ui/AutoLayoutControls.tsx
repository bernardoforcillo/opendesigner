import { useScene } from "@/store/store";
import { currentT } from "@/i18n";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import type { LayoutAlignLite } from "@/store/types";
import { wrapSelectionInFrame } from "@/tools/wrapFrame";
import { cls, IconButton, Section } from "@/ui/ds";
import { SegButtons, type SegOption } from "@/ui/ds/props-controls";
import { NumberField } from "@/ui/fields/NumberField";
import { autoLayoutOps } from "@/ui/autoLayoutOps";
import { withTrackAdded, withTrackChanged, type GridAxis } from "@/ui/gridTrackOps";
import type { AutoLayoutLite } from "@/store/types";

// Names the shared controls cannot translate on their own (options, text nodes). See docs/localization.md.
const tr = (key: string, vars?: Record<string, string | number>) => currentT().tx(key, vars);

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

const MODES: SegOption<"flex" | "grid">[] = [
  { value: "flex", label: "Flex" },
  { value: "grid", label: "Grid" },
];

// In a grid the main alignment is horizontal and the cross one vertical, whatever the direction.
const CELL_ALIGNS = (rotate: boolean): SegOption<LayoutAlignLite>[] => aligns(rotate).filter((a) => a.value !== "space-between");

const checkbox = "size-3.5 shrink-0 cursor-pointer rounded accent-accent";

/**
 * The AUTO LAYOUT section of the selected frame: on/off (the "+" / "−"
 * in the header), direction, spacing, padding, alignments and hug. It does not
 * know gestures: it emits ops through `run`, the same `runGesture` as the panel,
 * so every change is ONE undo step. What results (the children's
 * positions) is computed by the server.
 */
type RunAutoLayout = (patch: Parameters<typeof autoLayoutOps>[2]) => void;

/** The tracks of one axis of a grid: kind, size (fixed px / fr weight) and a remove button each, and an add button. */
function TrackList({ axis, al, patch }: { axis: GridAxis; al: AutoLayoutLite; patch: RunAutoLayout }) {
  const title = axis === "columns" ? "Column" : "Row";
  const tracks = al[axis] ?? [];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-fg-subtle">{title}s</span>
        <IconButton icon="plus" label={axis === "columns" ? tr("Add column") : tr("Add row")} size={24} onPress={() => patch({ [axis]: withTrackAdded(al, axis) })} />
      </div>
      {tracks.map((t, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-1.5">
          <label className="flex flex-col gap-0.5">
            <span className={cls.label}>{title} {i + 1}</span>
            <select
              aria-label={`${title} ${i + 1} kind`} className={cls.select} value={t.kind}
              onChange={(e) => patch({ [axis]: withTrackChanged(al, axis, i, { kind: e.target.value as "fixed" | "hug" | "fr", size: e.target.value === "fr" ? 1 : t.size }) })}
            >
              <option value="fixed">{tr("Fixed")}</option>
              <option value="hug">{tr("Hug")}</option>
              <option value="fr">{tr("Fraction")}</option>
            </select>
          </label>
          {t.kind === "hug" ? <span /> : (
            <NumberField
              label={t.kind === "fr" ? "Weight" : "Size"} value={t.size} minValue={0}
              onCommit={(v) => patch({ [axis]: withTrackChanged(al, axis, i, { size: v }) })}
            />
          )}
          <IconButton icon="minus" label={tr(axis === "columns" ? "Remove column {n}" : "Remove row {n}", { n: i + 1 })} size={24} onPress={() => patch({ [axis]: withTrackChanged(al, axis, i, null) })} />
        </div>
      ))}
    </div>
  );
}

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
  const grid = al?.mode === "grid";
  const patch: RunAutoLayout = (p) => run((ids) => autoLayoutOps(ids, lookup, p));
  return (
    <Section
      title={tr("Auto layout")}
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
          <SegButtons label="Layout mode" value={grid ? "grid" : "flex"} options={MODES} onPick={(mode) => patch({ mode })} />
          {grid ? (
            <>
              <TrackList axis="columns" al={al} patch={patch} />
              <TrackList axis="rows" al={al} patch={patch} />
              <div className="grid grid-cols-2 gap-1.5">
                <NumberField label="Column gap" value={al.columnGap ?? 0} minValue={0} onCommit={(v) => patch({ columnGap: v })} />
                <NumberField label="Row gap" value={al.rowGap ?? 0} minValue={0} onCommit={(v) => patch({ rowGap: v })} />
              </div>
            </>
          ) : (
            <>
              <SegButtons
                label="Direction" value={al.direction} options={DIRECTIONS}
                onPick={(direction) => run((ids) => autoLayoutOps(ids, lookup, { direction }))}
              />
              {num("spacing", "Spacing")}
            </>
          )}
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-fg-subtle">Padding</span>
            <div className="grid grid-cols-2 gap-1.5">
              {num("paddingLeft", "Left")}
              {num("paddingRight", "Right")}
              {num("paddingTop", "Top")}
              {num("paddingBottom", "Bottom")}
            </div>
          </div>
          {grid ? (
            <>
              <SegButtons label="Horizontal alignment" showLabel value={al.mainAlign} options={CELL_ALIGNS(false)} onPick={(mainAlign) => patch({ mainAlign })} />
              <SegButtons label="Vertical alignment" showLabel value={al.crossAlign} options={CELL_ALIGNS(true)} onPick={(crossAlign) => patch({ crossAlign })} />
            </>
          ) : (
            <>
              <SegButtons
                label="Main alignment" showLabel value={al.mainAlign} options={aligns(!horizontal)}
                onPick={(mainAlign) => run((ids) => autoLayoutOps(ids, lookup, { mainAlign }))}
              />
              <SegButtons
                label="Cross alignment" showLabel value={al.crossAlign}
                options={[
                  ...aligns(horizontal).filter((a) => a.value !== "space-between"),
                  // Baselines only line up in a row.
                  ...(horizontal ? [] : [{ value: "baseline" as const, label: "Baseline", icon: "alignBaseline" as const }]),
                ]}
                onPick={(crossAlign) => run((ids) => autoLayoutOps(ids, lookup, { crossAlign }))}
              />
            </>
          )}
          {!grid && <div className="flex flex-col gap-1.5">
            <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-fg-muted">
              <input
                type="checkbox" className={checkbox} checked={al.wrap === true}
                onChange={(e) => run((ids) => autoLayoutOps(ids, lookup, { wrap: e.target.checked }))}
              />
              Wrap
            </label>
            {al.wrap === true && (
              <NumberField
                label="Line spacing" value={al.crossSpacing ?? 0} minValue={0}
                onCommit={(v) => run((ids) => autoLayoutOps(ids, lookup, { crossSpacing: v }))}
              />
            )}
          </div>}
          <div className="flex gap-4 text-[12px] text-fg-muted">
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox" className={checkbox} checked={al.hugWidth}
                onChange={(e) => run((ids) => autoLayoutOps(ids, lookup, { hugWidth: e.target.checked }))}
              />
              {tr("Hug width")}
            </label>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox" className={checkbox} checked={al.hugHeight}
                onChange={(e) => run((ids) => autoLayoutOps(ids, lookup, { hugHeight: e.target.checked }))}
              />
              {tr("Hug height")}
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
      title={tr("Auto layout")}
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
