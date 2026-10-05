import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Bounds } from "../canvas/geometry";
import { contentWorldBounds } from "../store/groups";
import { hasLayout, participates } from "../store/layout";
import { orderKeyBetween } from "../store/orderKey";
import { childrenOf, isAncestorOf } from "../store/tree";
import type { NodeLite, SceneState } from "../store/types";
import { makeReparentOp, makeSetPropsOp } from "./ops";

// DRAG REORDERING in frames with auto layout.
//
// A child of an auto layout is not moved by writing x/y: the server
// recomputes them after every op and the node would immediately snap back. Dragging it
// instead means CHOOSING WHERE TO PUT IT IN THE ROW: the pointer position
// along the layout axis says between which siblings, and the gesture ends
// in an order_key change (same frame) or in a reparent (another frame with
// auto layout). The coordinates are then computed by the layout.
//
// All in pure functions: the gesture state lives in the select tool, here there is only
// the geometry and the ops.

export interface LayoutDrop {
  frameId: string;
  // Insertion position among the NON-dragged siblings, in order_key
  // order: 0 = before all, n = after all.
  index: number;
  vertical: boolean;
  // The insertion line, in WORLD coordinates: a thin rectangle
  // crossing the layout axis, at the point where the node would be put.
  indicator: Bounds;
}

// The thickness of the insertion line, in world units.
const INDICATOR_THICKNESS = 2;

/**
 * The auto layout frame that accepts ALL the given nodes as direct children, or
 * null. It is the condition for the drag to become a reorder instead of
 * a move: a node the layout does not arrange (a group, an instance, a
 * hidden node) or a child of a normal frame is moved with x/y as usual.
 */
export function reorderableParent(scene: SceneState, ids: readonly string[]): string | null {
  if (ids.length === 0) return null;
  const first = scene.nodes.at(ids[0]);
  if (!first) return null;
  const parent = scene.nodes.at(first.parentId);
  if (!hasLayout(parent)) return null;
  for (const id of ids) {
    const n = scene.nodes.at(id);
    if (!n || n.parentId !== parent.id || !participates(n)) return null;
  }
  return parent.id;
}

// The INNERMOST auto layout frame containing the point, excluding the dragged nodes
// and everything inside them (a frame cannot be put
// inside itself).
function frameAt(scene: SceneState, dragged: ReadonlySet<string>, p: { x: number; y: number }): NodeLite | null {
  let best: { node: NodeLite; depth: number } | null = null;
  for (const n of [...scene.nodes.values()]) {
    if (!hasLayout(n) || !n.visible) continue;
    if (dragged.has(n.id) || [...dragged].some((d) => isAncestorOf(scene, d, n.id))) continue;
    const b = contentWorldBounds(scene, n);
    if (!b || p.x < b.x || p.x > b.x + b.width || p.y < b.y || p.y > b.y + b.height) continue;
    let depth = 0;
    for (let cur: NodeLite | undefined = n; cur; cur = scene.nodes.at(cur.parentId)) depth++;
    if (!best || depth > best.depth) best = { node: n, depth };
  }
  return best?.node ?? null;
}

/**
 * Where the dragged node would land with the pointer at `p` (WORLD coordinates).
 *
 * The frame is the innermost auto layout one under the pointer; if there is
 * none, the starting one (`originId`) stays: releasing a bit outside the
 * frame still reorders, instead of throwing the gesture away. The index is the number of
 * siblings whose CENTER is before the pointer along the layout axis.
 *
 * null if there is no frame to land in.
 */
export function computeLayoutDrop(
  scene: SceneState,
  draggedIds: readonly string[],
  originId: string,
  p: { x: number; y: number },
): LayoutDrop | null {
  const dragged = new Set(draggedIds);
  const frame = frameAt(scene, dragged, p) ?? scene.nodes.at(originId);
  if (!hasLayout(frame)) return null;
  const frameBox = contentWorldBounds(scene, frame);
  if (!frameBox) return null;
  const al = frame.autoLayout;
  const vertical = al.direction === "vertical";

  const siblings = childrenOf(scene, frame.id).filter((c) => participates(c) && !dragged.has(c.id));
  const boxes = siblings.map((c) => contentWorldBounds(scene, c)).filter((b): b is Bounds => b !== null);
  if (boxes.length !== siblings.length) return null; // a child without a box: no decision

  const centerOf = (b: Bounds) => (vertical ? b.y + b.height / 2 : b.x + b.width / 2);
  const at = vertical ? p.y : p.x;
  let index = 0;
  for (const b of boxes) if (centerOf(b) < at) index++;

  // The point along the axis where to draw the line.
  const startOf = (b: Bounds) => (vertical ? b.y : b.x);
  const endOf = (b: Bounds) => (vertical ? b.y + b.height : b.x + b.width);
  const frameStart = startOf(frameBox);
  const padStart = vertical ? al.paddingTop : al.paddingLeft;
  let pos: number;
  if (boxes.length === 0) pos = frameStart + padStart;
  else if (index === 0) pos = startOf(boxes[0]) - al.spacing / 2;
  else if (index === boxes.length) pos = endOf(boxes[index - 1]) + al.spacing / 2;
  else pos = (endOf(boxes[index - 1]) + startOf(boxes[index])) / 2;
  // Never outside the frame.
  pos = Math.max(frameStart, Math.min(pos, endOf(frameBox)));

  const half = INDICATOR_THICKNESS / 2;
  const indicator: Bounds = vertical
    ? { x: frameBox.x, y: pos - half, width: frameBox.width, height: INDICATOR_THICKNESS }
    : { x: pos - half, y: frameBox.y, width: INDICATOR_THICKNESS, height: frameBox.height };
  return { frameId: frame.id, index, vertical, indicator };
}

/**
 * The ops that put the dragged nodes at the indicated point. Empty when
 * nothing changes (same frame, same position in the row): the gesture is
 * cancelled instead of producing an undo entry that does nothing.
 *
 * The dragged nodes keep their relative sibling order. Same frame:
 * one setProps of `order_key` each (it is a field like the others, not a
 * dedicated op). Another frame: a reparent with the new key, which carries the order
 * with it. Positions are NOT written: the layout computes them.
 */
export function layoutDropOps(scene: SceneState, draggedIds: readonly string[], drop: LayoutDrop): Op[] {
  const dragged = new Set(draggedIds);
  // In the order they had in the starting row.
  const moving = draggedIds
    .map((id) => scene.nodes.at(id))
    .filter((n): n is NodeLite => n !== undefined)
    .sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.id < b.id ? -1 : 1));
  const siblings = childrenOf(scene, drop.frameId).filter((c) => participates(c) && !dragged.has(c.id));

  // Already there? Same frame and the dragged ones occupy exactly the positions
  // [index, index + k) of the full row.
  const sameFrame = moving.every((n) => n.parentId === drop.frameId);
  if (sameFrame) {
    const full = childrenOf(scene, drop.frameId).filter(participates).map((c) => c.id);
    const wanted = [...siblings.slice(0, drop.index), ...moving, ...siblings.slice(drop.index)].map((c) => c.id);
    if (full.length === wanted.length && full.every((id, i) => id === wanted[i])) return [];
  }

  let prev: string | null = drop.index > 0 ? siblings[drop.index - 1].orderKey : null;
  const next: string | null = drop.index < siblings.length ? siblings[drop.index].orderKey : null;
  const ops: Op[] = [];
  for (const n of moving) {
    // Two neighbors with the SAME key leave no room: the node is put
    // after `prev` and that's it, rather than failing the gesture.
    const upper = next !== null && prev !== null && prev >= next ? null : next;
    const key = orderKeyBetween(prev, upper);
    prev = key;
    ops.push(n.parentId === drop.frameId ? makeSetPropsOp(n.id, { orderKey: key }, ["order_key"]) : makeReparentOp(n.id, drop.frameId, key));
  }
  return ops;
}
