import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { localToWorld, worldToLocal } from "../canvas/transform";
import { contentWorldBounds, isGroup } from "../store/groups";
import { unionBounds } from "../canvas/geometry";
import { orderKeyBetween } from "../store/orderKey";
import { childrenOf, documentOrder, topmostOf } from "../store/tree";
import type { AutoLayoutLite, NodeLite, SceneState } from "../store/types";
import { toPbAutoLayout } from "../store/types";
import { makeCreateNodeOp, makeDeleteOp, makeReparentOp, makeSetPropsOp, uuid } from "./ops";

// GROUP (Ctrl+G) and UNGROUP (Ctrl+Shift+G) as OP LISTS, without touching
// the store: the caller passes them to a single endGesture, and therefore
//   - a single send over the network,
//   - a single undo entry (one Ctrl+Z undoes the whole group, not the last
//     reparented child).
// That is why these functions are pure and return ops instead of
// applying them: a gesture is their unit, not the single op.
//
// No NEW op in the proto: grouping is createNode + N reparentNode,
// ungrouping is N reparentNode + deleteNode. A "GroupNodes" op would be a
// duplicate with its own invariants to keep aligned between Go and TS, and its
// inverse would not be expressible in a single op anyway.

// The default name of a newly created group. The layers panel shows the
// per-type fallback when `name` is empty (LayersPanel.tsx::fallbackName), but a
// group is born from a user GESTURE: giving it a real name is what makes
// the row that just appeared recognizable.
export const GROUP_NAME = "Group";

export interface GestureOps {
  // The gesture's ops, IN ORDER: they must be applied as they are (the group is
  // created before reparenting into it, the group is deleted after pulling
  // the children out).
  ops: Op[];
  // The selection the gesture leaves: the newly created group, or the children
  // just freed.
  selection: string[];
}

// The index of each node in the DRAW order of the whole document. Between two
// nodes with different parents the order keys are not comparable -- only the tree
// says which is on top (see tree.ts::documentOrder).
function orderIndex(scene: SceneState): Map<string, number> {
  const index = new Map<string, number>();
  documentOrder(scene).forEach((n, i) => index.set(n.id, i));
  return index;
}

// The sibling immediately ABOVE `n` among the children of its parent, if any.
function siblingAbove(scene: SceneState, n: NodeLite): NodeLite | undefined {
  const siblings = childrenOf(scene, n.parentId);
  const i = siblings.findIndex((s) => s.id === n.id);
  return i < 0 ? undefined : siblings[i + 1];
}

// The upper bound to pass to orderKeyBetween: the key of the neighbor
// above, but only if it really leaves room. Two neighbors with the SAME order key
// (an old document, or two clients that wrote the same key) leave
// none, and orderKeyBetween would throw: better to put the node ABOVE that
// neighbor than to blow up the gesture halfway.
function upperBound(above: NodeLite | undefined, lower: string): string | null {
  return above && above.orderKey > lower ? above.orderKey : null;
}

// Moves a node under `newParentId` PRESERVING its position in the world.
//
// `spaceId` is the container whose local space accepts the new coordinates.
// It does not always coincide with newParentId, and it is the delicate point of
// grouping: the newly created group does not yet exist in the scene the ops are
// computed from, but it is born at (0,0) under its own parent, so its
// local space is EXACTLY that of the parent -- which does exist in the scene.
//
// The setProps is added only if the coordinates really change: a node that
// stays in the same space (the normal case, all siblings of a page)
// must not pay an extra op on every grouping.
function moveOps(scene: SceneState, n: NodeLite, newParentId: string, spaceId: string, orderKey: string): Op[] {
  const ops: Op[] = [makeReparentOp(n.id, newParentId, orderKey)];
  const world = localToWorld(scene, n.parentId, n.x, n.y);
  const local = worldToLocal(scene, spaceId, world.x, world.y);
  if (local.x !== n.x || local.y !== n.y) {
    ops.push(makeSetPropsOp(n.id, { x: local.x, y: local.y }, ["x", "y"]));
  }
  return ops;
}

/**
 * Ctrl+G — groups the selection.
 *
 * The group is born as a SIBLING of the topmost selected node in the
 * draw order, right above it: it is the z position the user expects (the
 * group takes the place of its most visible element) and the only one that does not
 * jump over the nodes that were above the selection.
 *
 * The selected nodes end up inside it in their relative order, with new keys:
 * their old position was relative to siblings that are no longer theirs.
 *
 * A descendant selected together with its container is NOT reparented
 * separately (tree.ts::topmostOf): the container carries it along, and a reparent of its own
 * would pull it out of the container to put it in the group -- i.e. the
 * move the user did not ask for.
 *
 * null when there is nothing to group: no gesture, no send.
 */
export function groupOps(scene: SceneState, selection: readonly string[]): GestureOps | null {
  const index = orderIndex(scene);
  const ids = topmostOf(scene, selection).filter((id) => index.has(id));
  if (ids.length === 0) return null;
  // DRAW order, not selection order: it is what preserves the visual stack
  // inside the group (what was on top stays on top).
  const sorted = [...ids].sort((a, b) => (index.get(a) as number) - (index.get(b) as number));
  const top = scene.nodes.at(sorted[sorted.length - 1]);
  const parentId = top.parentId;

  const groupId = uuid();
  const groupNode = create(NodeSchema, {
    id: groupId,
    parentId,
    orderKey: orderKeyBetween(top.orderKey, upperBound(siblingAbove(scene, top), top.orderKey)),
    name: GROUP_NAME,
    visible: true,
    opacity: 1,
    // No geometry of its own: the bounds are the union of the children (see
    // store/groups.ts) and x/y at 0 means the group does not yet translate
    // anyone -- grouping does not move a pixel.
    x: 0, y: 0, width: 0, height: 0, rotation: 0,
    fills: [],
    shape: { case: "group", value: {} },
  });

  const ops: Op[] = [makeCreateNodeOp(groupNode)];
  let prev: string | null = null;
  for (const id of sorted) {
    const key = orderKeyBetween(prev, null);
    prev = key;
    // The SPACE is that of the group's parent, not of the group: see moveOps.
    ops.push(...moveOps(scene, scene.nodes.at(id), groupId, parentId, key));
  }
  return { ops, selection: [groupId] };
}

/**
 * Ctrl+Shift+G — ungroups the selected groups.
 *
 * The children come back out into the group's z slot (between its key and that
 * of the sibling above it), in their relative order: what was on top inside the
 * group stays on top outside. The coordinates are rewritten to preserve the
 * WORLD position -- a dragged group has a translation of its own, and without
 * rewriting them the children would jump back by its displacement.
 *
 * The group is deleted LAST, when it is already empty: deleteNode deletes
 * in cascade (core.applyDelete), so deleting it first would take away the children
 * we are freeing.
 *
 * If a group and a group that is its descendant are selected, only the
 * OUTER one is ungrouped (topmostOf): the second's ops would be built on a
 * state that the first has already changed.
 *
 * null when there is no group in the selection: no gesture, no send.
 */
export function ungroupOps(scene: SceneState, selection: readonly string[]): GestureOps | null {
  const index = orderIndex(scene);
  const groups = topmostOf(scene, selection)
    .map((id) => scene.nodes.at(id))
    .filter((n): n is NodeLite => n !== undefined && isGroup(n) && index.has(n.id))
    .sort((a, b) => (index.get(a.id) as number) - (index.get(b.id) as number));
  if (groups.length === 0) return null;

  const ops: Op[] = [];
  const freed: string[] = [];
  for (const g of groups) {
    const upper = upperBound(siblingAbove(scene, g), g.orderKey);
    let prev = g.orderKey;
    for (const c of childrenOf(scene, g.id)) {
      const key = orderKeyBetween(prev, upper);
      prev = key;
      // Here parent and space coincide: the group still exists in the scene,
      // so its translation is already inside localToWorld (see moveOps).
      ops.push(...moveOps(scene, c, g.parentId, g.parentId, key));
      freed.push(c.id);
    }
    ops.push(makeDeleteOp(g.id));
  }
  return { ops, selection: freed };
}

// --- WRAP IN A FRAME ----------------------------------------------------

export const FRAME_NAME = "Frame";

// The space between consecutive children that the auto layout must keep so as not to
// change the appearance: the average of the gaps between their boxes along the axis,
// rounded to the pixel and never negative (overlapping children = 0).
function averageGap(sorted: readonly { start: number; end: number }[]): number {
  if (sorted.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < sorted.length; i++) total += sorted[i].start - sorted[i - 1].end;
  return Math.max(0, Math.round(total / (sorted.length - 1)));
}

/**
 * Wraps the selection in a FRAME (Ctrl+Alt+G) and, with `autoLayout`, makes it an
 * auto layout frame (Shift+A). Same shape as groupOps: createNode + N
 * reparentNode, ONE gesture, one undo entry.
 *
 * The frame takes the box of the selected nodes, so wrapping them does not move a
 * pixel. Without auto layout the children keep their position (their coordinates
 * become relative to the frame). With auto layout the frame chooses direction
 * and spacing on its own by looking at how the children are already arranged, and puts them in a row
 * in SPATIAL ORDER -- auto layout arranges in sibling order, so
 * the order keys must be assigned along the axis and not in draw order.
 *
 * null when there is nothing to wrap.
 */
export function wrapInFrameOps(
  scene: SceneState,
  selection: readonly string[],
  withAutoLayout: boolean,
): GestureOps | null {
  const index = orderIndex(scene);
  const ids = topmostOf(scene, selection).filter((id) => index.has(id));
  if (ids.length === 0) return null;
  const byZ = [...ids].sort((a, b) => (index.get(a) as number) - (index.get(b) as number));
  const top = scene.nodes.at(byZ[byZ.length - 1]);
  const parentId = top.parentId;

  // The boxes in the WORLD, then brought into the frame's parent space.
  const worldBox = new Map(ids.flatMap((id) => {
    const b = contentWorldBounds(scene, scene.nodes.at(id));
    return b ? [[id, b] as const] : [];
  }));
  const union = unionBounds([...worldBox.values()]);
  if (!union) return null;
  const origin = worldToLocal(scene, parentId, union.x, union.y);

  let order = byZ;
  let layout: AutoLayoutLite | null = null;
  if (withAutoLayout) {
    const centers = ids.map((id) => {
      const b = worldBox.get(id);
      return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : { x: 0, y: 0 };
    });
    const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
    const horizontal = spread(centers.map((c) => c.x)) >= spread(centers.map((c) => c.y));
    const start = (id: string) => {
      const b = worldBox.get(id);
      return b ? (horizontal ? b.x : b.y) : 0;
    };
    order = [...ids].sort((a, b) => start(a) - start(b) || (index.get(a) as number) - (index.get(b) as number));
    const spans = order.map((id) => {
      const b = worldBox.get(id);
      const s = start(id);
      return { start: s, end: b ? s + (horizontal ? b.width : b.height) : s };
    });
    layout = {
      direction: horizontal ? "horizontal" : "vertical",
      spacing: averageGap(spans),
      paddingLeft: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0,
      mainAlign: "start", crossAlign: "start",
      hugWidth: true, hugHeight: true,
    };
  }

  const frameId = uuid();
  const frameNode = create(NodeSchema, {
    id: frameId,
    parentId,
    orderKey: orderKeyBetween(top.orderKey, upperBound(siblingAbove(scene, top), top.orderKey)),
    name: FRAME_NAME,
    visible: true,
    opacity: 1,
    x: origin.x, y: origin.y, width: union.width, height: union.height, rotation: 0,
    fills: [],
    shape: {
      case: "frame",
      value: { clipsContent: false, ...(layout ? { autoLayout: toPbAutoLayout(layout) } : {}) },
    },
  });

  const ops: Op[] = [makeCreateNodeOp(frameNode)];
  let prev: string | null = null;
  for (const id of order) {
    const key = orderKeyBetween(prev, null);
    prev = key;
    const n = scene.nodes.at(id);
    ops.push(makeReparentOp(id, frameId, key));
    // With auto layout the position is decided by the server: writing it here would be
    // an extra op that the layout immediately overwrites.
    if (!layout) {
      const world = localToWorld(scene, n.parentId, n.x, n.y);
      const inParent = worldToLocal(scene, parentId, world.x, world.y);
      const x = inParent.x - origin.x;
      const y = inParent.y - origin.y;
      if (x !== n.x || y !== n.y) ops.push(makeSetPropsOp(id, { x, y }, ["x", "y"]));
    }
  }
  return { ops, selection: [frameId] };
}
