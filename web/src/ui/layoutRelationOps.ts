import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { Constraint, LayoutSizing } from "../gen/opendesigner/v1/opendesigner_pb";
import { makeSetPropsOp } from "../tools/ops";
import type { ConstraintLite, NodeLite, SceneState } from "../store/types";

// The ops of the CONSTRAINTS and SIZING controls: how a node follows its parent frame
// when that frame is resized (constraints), and how an auto layout parent sizes it
// (fixed or fill). Pure: they read a scene and build ops, the panel submits them as one gesture.

type Axis = "x" | "y";

const TO_PB: Record<ConstraintLite, Constraint> = {
  min: Constraint.MIN, max: Constraint.MAX, stretch: Constraint.STRETCH, center: Constraint.CENTER, scale: Constraint.SCALE,
};

/** What the parent of `n` is for the purposes of these controls. */
export function parentKind(scene: SceneState, n: NodeLite): "frame" | "autoLayout" | null {
  const p = scene.nodes.at(n.parentId);
  if (!p || p.kind !== "frame") return null;
  return p.autoLayout ? "autoLayout" : "frame";
}

/** The constraint on `axis` of every node: its value, "min" for none (the default), or undefined when they differ. */
export function constraintOf(nodes: readonly NodeLite[], axis: Axis): ConstraintLite | undefined {
  const values = nodes.map((n) => (axis === "x" ? n.constraintX : n.constraintY) ?? "min");
  return values.every((v) => v === values[0]) ? values[0] : undefined;
}

export function sizingOf(nodes: readonly NodeLite[], axis: Axis): "fixed" | "fill" | undefined {
  const values = nodes.map((n) => ((axis === "x" ? n.layoutSizingX : n.layoutSizingY) === "fill" ? "fill" : "fixed") as "fixed" | "fill");
  return values.every((v) => v === values[0]) ? values[0] : undefined;
}

export function constraintOps(scene: SceneState, ids: readonly string[], axis: Axis, value: ConstraintLite): Op[] {
  return ids.flatMap((id) => {
    const n = scene.nodes.at(id);
    if (!n || (constraintOf([n], axis) === value)) return [];
    return [axis === "x"
      ? makeSetPropsOp(id, { constraintX: TO_PB[value] }, ["constraint_x"])
      : makeSetPropsOp(id, { constraintY: TO_PB[value] }, ["constraint_y"])];
  });
}

export function sizingOps(scene: SceneState, ids: readonly string[], axis: Axis, value: "fixed" | "fill"): Op[] {
  const pb = value === "fill" ? LayoutSizing.FILL : LayoutSizing.FIXED;
  return ids.flatMap((id) => {
    const n = scene.nodes.at(id);
    if (!n || sizingOf([n], axis) === value) return [];
    return [axis === "x"
      ? makeSetPropsOp(id, { layoutSizingX: pb }, ["layout_sizing_x"])
      : makeSetPropsOp(id, { layoutSizingY: pb }, ["layout_sizing_y"])];
  });
}
