import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import { worldTransformOf } from "../canvas/transform";
import { orderKeyBetween } from "../store/orderKey";
import { childrenOf, documentOrder, topmostOf } from "../store/tree";
import { normalizeVector } from "../store/vectorGeometry";
import type { NodeLite, SceneState } from "../store/types";
import { toPbEffects, toPbFills, toPbStrokes, toPbSubPaths } from "../store/types";
import { makeCreateNodeOp, makeDeleteOp, makeSetPropsOp, uuid } from "../tools/ops";
import { groupOps } from "../tools/grouping";
import { META_BOOLEAN, booleanOpOf } from "./regions";
import { BEZIER_TOLERANCE, booleanRegion, isBooleanSource, localOutlines, regionOf, regionOfNode, type BooleanOp } from "./regions";

export { BEZIER_TOLERANCE, booleanRegion, isBooleanSource, localOutlines, regionOfNode };
export type { BooleanOp };

// BOOLEAN OPERATIONS on shapes: union, subtract, intersect, exclude. The result is a plain VECTOR node
// (a "flatten"): one gesture creates it and deletes the sources, so one undo brings everything back.
// The geometry (vector/regions.ts) is done by polygon-clipping. For a result that stays editable --
// the shapes kept as children, the result recomputed -- see store/booleans.ts (a group with `boolean.op`).

export const BOOLEAN_NAMES: Record<BooleanOp, string> = {
  union: "Union", subtract: "Subtract", intersect: "Intersect", exclude: "Exclude",
};

export interface BooleanResult { ops: Op[]; selection: string[] }

/**
 * A boolean operation over the selection as ONE gesture's op list: a new vector node
 * (the style of the BOTTOM node, placed right above the TOPMOST) and the deletion of
 * the sources. Subtract takes the bottom node and removes every other one from it.
 * null when fewer than two shapes are selected, or the result is empty.
 */
export function booleanOps(scene: SceneState, selection: readonly string[], op: BooleanOp): BooleanResult | null {
  const order = new Map<string, number>();
  documentOrder(scene).forEach((n, i) => order.set(n.id, i));
  const ids = topmostOf(scene, selection).filter((id) => order.has(id));
  const nodes = ids
    .map((id) => scene.nodes.at(id))
    .filter((n): n is NodeLite => !!n && isBooleanSource(scene, n))
    .sort((a, b) => (order.get(a.id) as number) - (order.get(b.id) as number));
  if (nodes.length < 2) return null;
  const bottom = nodes[0];
  const top = nodes[nodes.length - 1];
  const parentId = top.parentId;
  const target = worldTransformOf(scene, parentId);
  const regions = nodes.map((n) => regionOf(scene, n, target));
  const subpaths = booleanRegion(op, regions);
  if (subpaths.length === 0) return null;

  const norm = normalizeVector({ x: 0, y: 0 }, subpaths);
  const siblings = childrenOf(scene, parentId);
  const at = siblings.findIndex((s) => s.id === top.id);
  const above = at >= 0 ? siblings[at + 1] : undefined;
  const id = uuid();
  const node = create(NodeSchema, {
    id, parentId,
    orderKey: orderKeyBetween(top.orderKey, above && above.orderKey > top.orderKey ? above.orderKey : null),
    name: BOOLEAN_NAMES[op],
    visible: true,
    opacity: bottom.opacity,
    x: norm.box.x, y: norm.box.y, width: norm.box.width, height: norm.box.height, rotation: 0,
    fills: toPbFills(bottom.fills),
    strokes: toPbStrokes(bottom.strokes),
    effects: toPbEffects(bottom.effects ?? []),
    shape: { case: "vector", value: { subpaths: toPbSubPaths(norm.subpaths) } },
  });
  const ops: Op[] = [makeCreateNodeOp(node), ...nodes.map((n) => makeDeleteOp(n.id))];
  return { ops, selection: [id] };
}

/**
 * A LIVE boolean group over the selection: the shapes become the children of a new group whose
 * `boolean.op` meta makes it DRAW as the result (store/booleans.ts); the group takes the bottom
 * shape's fills, strokes and effects. One gesture. null when fewer than two shapes are selected.
 */
export function liveBooleanOps(scene: SceneState, selection: readonly string[], op: BooleanOp): BooleanResult | null {
  const order = new Map<string, number>();
  documentOrder(scene).forEach((n, i) => order.set(n.id, i));
  const ids = topmostOf(scene, selection).filter((id) => order.has(id));
  const nodes = ids
    .map((id) => scene.nodes.at(id))
    .filter((n): n is NodeLite => !!n && isBooleanSource(scene, n))
    .sort((a, b) => (order.get(a.id) as number) - (order.get(b.id) as number));
  if (nodes.length < 2) return null;
  const grouped = groupOps(scene, nodes.map((n) => n.id));
  if (!grouped) return null;
  const bottom = nodes[0];
  const groupId = grouped.selection[0];
  const style = makeSetPropsOp(
    groupId,
    { name: BOOLEAN_NAMES[op], meta: { [META_BOOLEAN]: op }, fills: toPbFills(bottom.fills), strokes: toPbStrokes(bottom.strokes), effects: toPbEffects(bottom.effects ?? []) },
    ["name", "meta", "fills", "strokes", "effects"],
  );
  // The children keep their own style (it comes back when the group is released); what is drawn is the group's.
  return { ops: [...grouped.ops, style], selection: [groupId] };
}

/** Changes the operation of a live boolean group. */
export function setBooleanOpOps(node: NodeLite, op: BooleanOp): Op[] {
  if (booleanOpOf(node) === null || booleanOpOf(node) === op) return [];
  return [makeSetPropsOp(node.id, { name: BOOLEAN_NAMES[booleanOpOf(node)!] === node.name ? BOOLEAN_NAMES[op] : node.name, meta: { ...(node.meta ?? {}), [META_BOOLEAN]: op } }, ["name", "meta"])];
}

/** Flattens a live boolean group (or any group of shapes) into a plain vector, the shapes gone. One gesture. */
export function flattenGroupOps(scene: SceneState, groupId: string): BooleanResult | null {
  const g = scene.nodes.at(groupId);
  if (!g || g.kind !== "group") return null;
  const op = booleanOpOf(g) ?? "union";
  const subpaths = booleanRegion("union", [regionOf(scene, g, worldTransformOf(scene, g.parentId))]);
  if (subpaths.length === 0) return null;
  const norm = normalizeVector({ x: 0, y: 0 }, subpaths);
  const siblings = childrenOf(scene, g.parentId);
  const above = siblings[siblings.findIndex((s) => s.id === g.id) + 1];
  const id = uuid();
  const node = create(NodeSchema, {
    id, parentId: g.parentId,
    orderKey: orderKeyBetween(g.orderKey, above && above.orderKey > g.orderKey ? above.orderKey : null),
    name: g.name || BOOLEAN_NAMES[op], visible: true, opacity: g.opacity,
    x: norm.box.x, y: norm.box.y, width: norm.box.width, height: norm.box.height, rotation: 0,
    fills: toPbFills(g.fills), strokes: toPbStrokes(g.strokes), effects: toPbEffects(g.effects ?? []),
    shape: { case: "vector", value: { subpaths: toPbSubPaths(norm.subpaths) } },
  });
  return { ops: [makeCreateNodeOp(node), makeDeleteOp(g.id)], selection: [id] };
}
