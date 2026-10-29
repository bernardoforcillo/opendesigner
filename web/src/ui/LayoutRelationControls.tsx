import { useScene } from "@/store/store";
import { currentT } from "@/i18n";
import type { ConstraintLite, NodeLite } from "@/store/types";
import { cls, Section } from "@/ui/ds";
import { NumberField } from "@/ui/fields/NumberField";
import { limitOf, limitOps, positioningOf, positioningOps, type LimitField } from "@/ui/layoutLimitOps";
import { cellOf, cellOps, type CellField } from "@/ui/gridTrackOps";
import { constraintOf, constraintOps, parentKind, sizingOf, sizingOps } from "@/ui/layoutRelationOps";

// Names the shared controls cannot translate on their own (options, text nodes). See docs/localization.md.
const tr = (key: string, vars?: Record<string, string | number>) => currentT().tx(key, vars);

// CONSTRAINTS and SIZING of the selection, i.e. its relation to the parent frame:
//   - a node in a frame WITHOUT auto layout has CONSTRAINTS: when the frame is resized, the
//     node follows it (left/right/both/center/scale, per axis);
//   - a node in an auto layout frame has SIZING: fixed, or fill the free space of that axis.
// Every choice is ONE gesture = one op per node = one undo step. The effect (children moving
// or resizing) is computed by the server, like the auto layout itself.

type Ops = Parameters<ReturnType<typeof useScene.getState>["endGesture"]>[0];
function run(ops: Ops) {
  if (ops.length === 0) return;
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
}

const H: { value: ConstraintLite; label: string }[] = [
  { value: "min", label: "Left" }, { value: "max", label: "Right" }, { value: "stretch", label: "Left & right" },
  { value: "center", label: "Center" }, { value: "scale", label: "Scale" },
];
const V: { value: ConstraintLite; label: string }[] = [
  { value: "min", label: "Top" }, { value: "max", label: "Bottom" }, { value: "stretch", label: "Top & bottom" },
  { value: "center", label: "Center" }, { value: "scale", label: "Scale" },
];

const LIMITS: { field: LimitField; label: string }[] = [
  { field: "minWidth", label: "Min width" }, { field: "maxWidth", label: "Max width" },
  { field: "minHeight", label: "Min height" }, { field: "maxHeight", label: "Max height" },
];

const CELLS: { field: CellField; label: string }[] = [
  { field: "column", label: "Column" }, { field: "row", label: "Row" },
  { field: "columnSpan", label: "Column span" }, { field: "rowSpan", label: "Row span" },
];

export function LayoutRelationControls() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  if (!scene || selection.length === 0) return null;
  const nodes = selection.map((id) => scene.nodes.at(id)).filter((n): n is NodeLite => !!n);
  if (nodes.length !== selection.length) return null;
  const kinds = new Set(nodes.map((n) => parentKind(scene, n)));
  if (kinds.size !== 1) return null;
  const kind = [...kinds][0];
  const constraintRows = () => {
    const row = (axis: "x" | "y", label: string, options: typeof H) => {
      const v = constraintOf(nodes, axis);
      return (
        <label key={axis} className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
          <span className={cls.label}>{tr(label)}</span>
          <select aria-label={tr(label)} className={cls.select} value={v ?? "__mixed"}
            onChange={(e) => run(constraintOps(scene, selection, axis, e.target.value as ConstraintLite))}>
            {v === undefined && <option value="__mixed" disabled>{tr("Mixed")}</option>}
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      );
    };
    return <div className="flex flex-col gap-1.5">{row("x", "Horizontal", H)}{row("y", "Vertical", V)}</div>;
  };
  // An auto layout frame outside an auto layout still takes size limits (they bound what it hugs).
  const ownLimits = kind !== "autoLayout" && nodes.every((n) => n.kind === "frame" && n.autoLayout !== undefined);
  if (kind === "frame") {
    return (
      <>
        <Section title={tr("Constraints")}>{constraintRows()}</Section>
        {ownLimits && <Section title={tr("Size limits")}><LimitFields nodes={nodes} /></Section>}
      </>
    );
  }
  if (ownLimits) return <Section title={tr("Size limits")}><LimitFields nodes={nodes} /></Section>;
  if (kind === "autoLayout") {
    const row = (axis: "x" | "y", label: string) => {
      const v = sizingOf(nodes, axis);
      return (
        <label key={axis} className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
          <span className={cls.label}>{tr(label)}</span>
          <select aria-label={`${label} sizing`} className={cls.select} value={v ?? "__mixed"}
            onChange={(e) => run(sizingOps(scene, selection, axis, e.target.value as "fixed" | "fill"))}>
            {v === undefined && <option value="__mixed" disabled>{tr("Mixed")}</option>}
            <option value="fixed">{tr("Fixed")}</option>
            <option value="fill">{tr("Fill container")}</option>
          </select>
        </label>
      );
    };
    const pos = positioningOf(nodes);
    // The cell controls need a grid parent (0 = auto-placed / one cell).
    const inGrid = nodes.every((n) => scene.nodes.at(n.parentId)?.autoLayout?.mode === "grid");
    return (
      <>
        <Section title={tr("Sizing")}>
          <div className="flex flex-col gap-1.5">
            <label className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
              <span className={cls.label}>{tr("Position")}</span>
              <select aria-label={tr("Layout position")} className={cls.select} value={pos ?? "__mixed"}
                onChange={(e) => run(positioningOps(scene, selection, e.target.value as "auto" | "absolute"))}>
                {pos === undefined && <option value="__mixed" disabled>{tr("Mixed")}</option>}
                <option value="auto">{tr("Auto (in the flow)")}</option>
                <option value="absolute">{tr("Absolute")}</option>
              </select>
            </label>
            {pos === "absolute" ? constraintRows() : <>{row("x", "Width")}{row("y", "Height")}</>}
            <LimitFields nodes={nodes} />
          </div>
        </Section>
        {inGrid && pos !== "absolute" && (
          <Section title={tr("Grid cell")}>
            <div className="grid grid-cols-2 gap-1.5">
              {CELLS.map(({ field, label }) => (
                <NumberField key={field} label={label} value={cellOf(nodes, field) ?? NaN} minValue={0}
                  onCommit={(v) => run(cellOps(scene, selection, field, v))} />
              ))}
            </div>
          </Section>
        )}
      </>
    );
  }
  return null;
}

/** Min/max width and height (0 = no limit), clamped by the auto layout engine. */
function LimitFields({ nodes }: { nodes: NodeLite[] }) {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  if (!scene) return null;
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {LIMITS.map(({ field, label }) => (
        <NumberField key={field} label={label} value={limitOf(nodes, field) ?? NaN} minValue={0}
          onCommit={(v) => run(limitOps(scene, selection, field, v))} />
      ))}
    </div>
  );
}
