import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { normalizeVector } from "../store/vectorGeometry";
import type { NodeLite, SceneState, SubPathLite } from "../store/types";
import { makeDeleteOp, makeSetPropsOp, makeSetVectorPathOp } from "../tools/ops";
import { cornerAll, joinSubpaths, offsetSubpaths, simplifySubpath, smoothAll } from "./pathOps";
import { subpathFills } from "../store/vectorGeometry";

// The ops that apply a path edit to a vector node. The invariant (store/vectorGeometry.ts::
// normalizeVector) is that the node's box hugs its geometry, so a new path travels with the
// matching box, in the same gesture. A rotated node turns around its box's center, which a new
// box would move: path edits are for upright nodes (`editable`).

/** True for a vector node the path editing can touch. */
export function editable(n: NodeLite | undefined): n is NodeLite & { vector: { subpaths: SubPathLite[] } } {
  return !!n && n.kind === "vector" && !!n.vector && n.rotation % 360 === 0;
}

/** The ops that replace a vector node's geometry (and fit its box to it). */
export function setPathOps(n: NodeLite, subpaths: readonly SubPathLite[]): Op[] {
  const norm = normalizeVector({ x: n.x, y: n.y }, subpaths);
  return [
    makeSetVectorPathOp(n.id, norm.subpaths),
    makeSetPropsOp(n.id, { x: norm.box.x, y: norm.box.y, width: norm.box.width, height: norm.box.height }, ["x", "y", "width", "height"]),
  ];
}

export type PathTool = "smooth" | "corner" | "simplify";

/** Smooth every anchor, make them all corners, or thin the path out (`tolerance` in local units). */
export function pathToolOps(n: NodeLite, tool: PathTool, tolerance = 1): Op[] {
  if (!editable(n)) return [];
  const f = tool === "smooth" ? smoothAll : tool === "corner" ? cornerAll : (sp: SubPathLite) => simplifySubpath(sp, tolerance);
  const next = n.vector.subpaths.map(f);
  if (JSON.stringify(next) === JSON.stringify(n.vector.subpaths)) return [];
  return setPathOps(n, next);
}

/** Grows or shrinks the closed shapes of a vector by `distance`; open paths stay as they are. */
export function offsetOps(n: NodeLite, distance: number): Op[] {
  if (!editable(n)) return [];
  const grown = offsetSubpaths(n.vector.subpaths, distance);
  if (!grown) return [];
  return setPathOps(n, [...n.vector.subpaths.filter((sp) => !subpathFills(sp)), ...grown]);
}

/**
 * Joins two open vector nodes of the same parent into ONE node (the first one stays, the second is
 * deleted). Null when either is not an upright open path.
 */
export function joinNodesOps(scene: SceneState, aId: string, bId: string): { ops: Op[]; selection: string[] } | null {
  const a = scene.nodes.get(aId), b = scene.nodes.get(bId);
  if (!editable(a) || !editable(b) || a.id === b.id || a.parentId !== b.parentId) return null;
  if (a.vector.subpaths.length !== 1 || b.vector.subpaths.length !== 1) return null;
  const toParent = (n: typeof a): SubPathLite => ({ ...n.vector.subpaths[0], anchors: n.vector.subpaths[0].anchors.map((q) => ({ ...q, x: q.x + n.x, y: q.y + n.y })) });
  const joined = joinSubpaths(toParent(a), toParent(b));
  if (!joined) return null;
  // The first node's origin is the zero of its anchors again.
  const local: SubPathLite = { ...joined, anchors: joined.anchors.map((q) => ({ ...q, x: q.x - a.x, y: q.y - a.y })) };
  return { ops: [...setPathOps(a, [local]), makeDeleteOp(b.id)], selection: [a.id] };
}
