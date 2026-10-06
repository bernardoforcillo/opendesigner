import { useScene } from "../store/store";
import type { ConstraintLite, NodeLite } from "../store/types";
import { cls, Section } from "./ds";
import { constraintOf, constraintOps, parentKind, sizingOf, sizingOps } from "./layoutRelationOps";

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

export function LayoutRelationControls() {
  const scene = useScene((s) => s.scene);
  const selection = useScene((s) => s.selection);
  if (!scene || selection.length === 0) return null;
  const nodes = selection.map((id) => scene.nodes.at(id)).filter((n): n is NodeLite => !!n);
  if (nodes.length !== selection.length) return null;
  const kinds = new Set(nodes.map((n) => parentKind(scene, n)));
  if (kinds.size !== 1) return null;
  const kind = [...kinds][0];
  if (kind === "frame") {
    const row = (axis: "x" | "y", label: string, options: typeof H) => {
      const v = constraintOf(nodes, axis);
      return (
        <label key={axis} className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
          <span className={cls.label}>{label}</span>
          <select aria-label={label} className={cls.select} value={v ?? "__mixed"}
            onChange={(e) => run(constraintOps(scene, selection, axis, e.target.value as ConstraintLite))}>
            {v === undefined && <option value="__mixed" disabled>Mixed</option>}
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      );
    };
    return <Section title="Constraints"><div className="flex flex-col gap-1.5">{row("x", "Horizontal", H)}{row("y", "Vertical", V)}</div></Section>;
  }
  if (kind === "autoLayout") {
    const row = (axis: "x" | "y", label: string) => {
      const v = sizingOf(nodes, axis);
      return (
        <label key={axis} className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
          <span className={cls.label}>{label}</span>
          <select aria-label={`${label} sizing`} className={cls.select} value={v ?? "__mixed"}
            onChange={(e) => run(sizingOps(scene, selection, axis, e.target.value as "fixed" | "fill"))}>
            {v === undefined && <option value="__mixed" disabled>Mixed</option>}
            <option value="fixed">Fixed</option>
            <option value="fill">Fill container</option>
          </select>
        </label>
      );
    };
    return <Section title="Sizing"><div className="flex flex-col gap-1.5">{row("x", "Width")}{row("y", "Height")}</div></Section>;
  }
  return null;
}
