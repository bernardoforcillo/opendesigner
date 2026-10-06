import { intersectBounds, unionBounds, worldAabbOfNode, type Bounds } from "../canvas/geometry";
import { IDENTITY, compose, localTransformOf, mapBounds, type Transform, worldBoundsOfNode, worldToLocal, worldTransformOf } from "../canvas/transform";
import { ancestorsOf, childrenOf } from "./tree";
import { instanceDescentLocal, isInstance, resolveInstance } from "./instances";
import type { NodeLite, SceneState } from "./types";

// GROUPS: what they are, where their bounds end up and which node a
// click selects.
//
// A group is a container WITHOUT clipping and without geometry of its own:
//   - it is not drawn and not hit (renderer/shapes.ts): it has nothing to
//     fill, and what the user sees are the children;
//   - its BOUNDS are the union of those of the children, DERIVED on every read
//     instead of stored -- storing them would mean recomputing them on every
//     move of a child, in two implementations (Go and TS) that must
//     stay identical, for a value no op writes;
//   - x/y remain the TRANSLATION that contributes to the children (transform.ts::
//     localTransformOf): they are 0 at creation -- grouping moves
//     nothing -- and change when the group is dragged. Nobody reads
//     width/height.
//
// The SELECTION POLICY lives here and not in hit-test (see the comment on
// canvasRenderer.ts::hitTest): hit-test answers "which node is under the
// pointer" -- the innermost, always -- and these functions answer "which
// node should be selected", which is a different question with a different answer.
//
// AN INSTANCE (kind "instance", store/instances.ts) is, for bounds, a GROUP whose
// content is the master's subtree: no box of its own (x/y are its
// translation, nobody reads width/height), bounds DERIVED from the master
// mapped by the descent transform (contentIn -> instanceContentBounds).
// The selection frame, the 8 handles and the panel's X read from here,
// as for a group. Deliberate SIMPLIFICATION: the clipping of a frame
// INSIDE the master (a frame with clipsContent INSIDE the component, with children
// that overflow it) is not applied to the derived bounds -- accumulateMaster
// unions the boxes without redoing the clip-aware chain of clippedWorldBoundsOf, which
// follows the REAL ancestors and not the instance's virtual context. It is an edge
// case; the instance remains OPAQUE anyway (marquee and frame are a single box),
// so the divergence is at most a frame slightly wider than the painted content.

export function isGroup(n: NodeLite | undefined): boolean {
  return n?.kind === "group";
}

// The WORLD box the user SEES for a node: for a group the union of the boxes of its
// children (recursively: a group of groups is the union of the unions), for
// anyone else its own.
//
// null when there is nothing to frame: an empty group (or made only of
// empty groups, or whose children are all HIDDEN) has no bounds, and whoever draws
// the selection frame must skip it instead of drawing a degenerate
// rectangle at the origin.
export function contentWorldBounds(scene: SceneState, n: NodeLite): Bounds | null {
  return contentIn(scene, n, new Set());
}

// The WORLD box of a node, CLIPPED to the ancestor frames with clipsContent. It is the
// same rule, identical, as the renderer's three descents: a FRAME with
// clipsContent hides children outside its own box, and that cut applies
// together to DRAWING (drawSiblings), HIT-TEST (pickIn) and MARQUEE
// (collectIn, which intersects the frame's world box -- the same intersectBounds
// used here). The selection frame and its 8 HANDLES read from here (via
// contentWorldBounds -> selectionWorldBounds): without the cut, a child that
// overflows a clipping frame would have handles drawn -- and GRABBABLE
// (selectTool.ts::handleUnderPointer uses the same box) -- on empty canvas beyond
// the frame's edge, where no pixel is drawn. It is the see-vs-select
// divergence that contentIn already avoids for the INVISIBLE children of a group,
// taken from the clip side.
//
// A node ENTIRELY outside the clip has no box (null): no frame, like a
// group with all children hidden. Nested clips compose -- every ancestor frame
// narrows further.
//
// The node's box is ROTATION-INCLUDED (worldAabbOfNode: the AABB of its
// rotated geometry, in the parent's space) then brought to the world with the
// parent's transform -- so the selection frame of a multiple selection
// encloses what a rotated node REALLY occupies, not its unrotated
// axis-aligned box (track 2). The clipping to frames stays
// axis-aligned (intersectBounds), like the renderer's three descents.
function clippedWorldBoundsOf(scene: SceneState, n: NodeLite): Bounds | null {
  let box: Bounds = mapBounds(worldTransformOf(scene, n.parentId), worldAabbOfNode(n));
  for (const anc of ancestorsOf(scene, n.id)) {
    if (anc.kind === "frame" && anc.clipsContent) {
      const next = intersectBounds(box, worldBoundsOfNode(scene, anc));
      if (!next) return null;
      box = next;
    }
  }
  return box;
}

function contentIn(scene: SceneState, n: NodeLite, seen: Set<string>): Bounds | null {
  // An INSTANCE derives its bounds from the MASTER, as a group derives them from its
  // children: the master's subtree mapped by the descent transform
  // (see instanceContentBounds). It has no box of its own to read -- x/y are its
  // translation, nobody reads width/height, as for a group.
  if (isInstance(n)) return instanceContentBounds(scene, n, new Set());
  if (!isGroup(n)) return clippedWorldBoundsOf(scene, n);
  // Cycle in a malformed document: already visited, revisiting it would never end
  // (same guard as tree.ts::subtreeOf).
  if (seen.has(n.id)) return null;
  seen.add(n.id);
  const boxes: Bounds[] = [];
  for (const c of childrenOf(scene, n.id)) {
    // An INVISIBLE child is not contained: the same rule, identical, as the
    // renderer's three descents -- drawSiblings, pickIn and collectIn do
    // `continue` on !visible BEFORE descending, so a hidden node (and with
    // it its whole subtree: you do not draw the child of something that
    // is not there) is not seen, not clicked and the marquee does not take it.
    // Including it here would give a group a frame and 8 handles on EMPTY
    // canvas -- the same see-vs-select divergence those three descents
    // exist to avoid -- and, worse, the properties panel (via
    // frameOriginOf) would report as X the edge of the hidden child: typing a number
    // into it would send the visible content somewhere else.
    // A group with ALL children hidden falls back to the empty-group branch
    // (unionBounds of nothing => null), which is exactly how it behaves.
    if (!c.visible) continue;
    const b = contentIn(scene, c, seen);
    if (b) boxes.push(b);
  }
  return unionBounds(boxes);
}

// The WORLD bounds of an instance's content: the box of the master's subtree,
// mapped by the descent transform. It follows the track's formula
// to the letter:
//
//   contentWorldBounds(instance)
//     = mapBounds( worldTransformOf(parent) ∘ localTransformOf(n) ∘ translate(-master.x,-master.y),
//                  <local bounds of the master's subtree> )
//
// The master's local bounds are the union of the boxes of its subtree in the
// space in which its root's x/y is written (accumulateMaster with an IDENTITY
// base); then a single mapBounds through the WORLD descent brings them where
// the instance draws them. This way the instance's OWN rotation composes by itself
// (it sits in localTransformOf(n) inside descentWorld, and mapBounds takes the AABB of the
// rotated box) -- drawing, hit-test and frame descend with the same matrix.
//
// `null` (no frame) when the master is missing or draws nothing, and when
// the component is already in `visited` (self-reference): exactly like an empty
// group.
function instanceContentBounds(scene: SceneState, n: NodeLite, visited: Set<string>): Bounds | null {
  const resolved = resolveInstance(scene, n);
  if (!resolved) return null;
  if (visited.has(resolved.componentId)) return null;
  const nextVisited = new Set(visited).add(resolved.componentId);
  const boxes: Bounds[] = [];
  accumulateMaster(scene, resolved.masterRoot, IDENTITY, boxes, new Set(), nextVisited);
  const local = unionBounds(boxes);
  if (!local) return null;
  const descentWorld = compose(worldTransformOf(scene, n.parentId), instanceDescentLocal(n, resolved.masterRoot));
  return mapBounds(descentWorld, local);
}

// Accumulates the boxes of a master's subtree in the space that `toBase`
// maps to. Mirrors the renderer's descent, to keep see-vs-select:
//   - an INVISIBLE node (or container) takes its whole subtree away with it;
//   - a GROUP and an INSTANCE have no OWN box (their bounds are derived);
//   - a NESTED instance contributes its own derived content, with the
//     same cycle guard by componentId;
//   - every other node contributes its box (rotated AABB) mapped into base.
// `seen` is the guard against STRUCTURAL cycles (malformed parents); `visited` the one
// against COMPONENT cycles. NB: the clipping of frames INSIDE the master is not
// applied to the bounds -- see the comment at the top of the file for the rationale.
function accumulateMaster(
  scene: SceneState,
  node: NodeLite,
  toBase: Transform,
  boxes: Bounds[],
  seen: Set<string>,
  visited: ReadonlySet<string>,
): void {
  if (!node.visible || seen.has(node.id)) return;
  seen.add(node.id);
  if (isInstance(node)) {
    const resolved = resolveInstance(scene, node);
    if (resolved && !visited.has(resolved.componentId)) {
      const nextVisited = new Set(visited).add(resolved.componentId);
      const inner: Bounds[] = [];
      accumulateMaster(scene, resolved.masterRoot, IDENTITY, inner, new Set(), nextVisited);
      const innerLocal = unionBounds(inner);
      if (innerLocal) boxes.push(mapBounds(compose(toBase, instanceDescentLocal(node, resolved.masterRoot)), innerLocal));
    }
    // An instance has no children in `nodes`: no descent beyond here.
    return;
  }
  // Group: no box of its own (its bounds are the union of the children, below).
  if (!isGroup(node)) boxes.push(mapBounds(toBase, worldAabbOfNode(node)));
  const childBase = compose(toBase, localTransformOf(node));
  for (const c of childrenOf(scene, node.id)) accumulateMaster(scene, c, childBase, boxes, seen, visited);
}

// The TOP-LEFT corner of a node's frame, in the PARENT's space --
// that is, the same space in which its x/y are written, and the one in which the
// properties panel (ui/PropertiesPanel.tsx) reads and writes X/Y.
//
// For any node that is not a group it is trivially its x/y: the model's box
// IS the frame. For a GROUP it is not, and without this function the panel
// would report a different number from the one the overlay draws: a group's x/y
// are the TRANSLATION that contributes to the children (0 at creation -- grouping
// does not move a pixel), while the frame is the union of the children and can be
// anywhere. "X" must mean for a group what it means for all the
// others: where the left edge is seen.
//
// An EMPTY group has no frame (contentWorldBounds null): its
// translation remains, which is the only coordinate it owns -- and which the panel
// then writes in absolute terms, as for any other node.
export function frameOriginOf(scene: SceneState, n: NodeLite): { x: number; y: number } {
  // An INSTANCE is like a group here: x/y are its translation, not the corner
  // of the frame (which is that of the master's content). See contentIn.
  if (!isGroup(n) && !isInstance(n)) return { x: n.x, y: n.y };
  const b = contentWorldBounds(scene, n);
  if (!b) return { x: n.x, y: n.y };
  // From the WORLD (in which contentWorldBounds answers) to the parent's space: the
  // same direction hit-test uses for the pointer, and the only space
  // in which the number is comparable with the node's x/y.
  return worldToLocal(scene, n.parentId, b.x, b.y);
}

// The containers the current selection has ENTERED. It is not a separate
// state, and deliberately: "being inside a group" is told by the selection itself
// -- if a child of the group is selected, we are inside that group. A separate
// state ("editing context") would have to be invalidated on every selection
// change, on every undo and on every remote op that deletes the container;
// deriving it can never go out of sync.
function enteredContainers(scene: SceneState, selection: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const id of selection) for (const a of ancestorsOf(scene, id)) out.add(a.id);
  return out;
}

// The path from the root to the node: the ancestors from the FARTHEST to the nearest,
// then the node itself.
function pathTo(scene: SceneState, id: string): string[] {
  const up = ancestorsOf(scene, id).map((n) => n.id);
  up.reverse();
  up.push(id);
  return up;
}

/**
 * The node that a CLICK on `id` must select.
 *
 * THE CONVENTION (the one users notice immediately):
 *  - a click selects the OUTERMOST group that contains what was
 *    clicked -- a group moves as a single object;
 *  - a double click ENTERS the group (see enterTargetOf) and from there on
 *    clicks select inside, one level at a time;
 *  - clicking outside the group that was entered exits it, with no dedicated
 *    gesture: the new selection no longer has that group among its ancestors.
 *
 * Only GROUPS capture the click. A container that is not a group (today any
 * node with children, tomorrow a frame) lets it through: its children are
 * selected directly, which is the frame/artboard convention.
 *
 * An `id` not present in the scene is returned unchanged: it is not this function's job to
 * decide whether an id is valid.
 */
export function selectionTargetOf(scene: SceneState, id: string, selection: readonly string[]): string {
  if (!scene.nodes.at(id)) return id;
  const path = pathTo(scene, id);
  const entered = enteredContainers(scene, selection);
  // The PREFIX of containers we have already entered is skipped: they are
  // transparent to the click, as the page is.
  let i = 0;
  while (i < path.length - 1 && entered.has(path[i])) i++;
  for (; i < path.length; i++) {
    if (path[i] === id) return id;
    if (isGroup(scene.nodes.at(path[i]))) return path[i];
  }
  return id;
}

// The same policy applied to a LIST (the nodes a marquee has taken),
// without duplicates and in the starting order: two children of the same group
// give the group only once. The marquee must select what a click
// would select, or the rubber band would be the only way to
// take the children of a group without entering it.
export function selectionTargetsOf(scene: SceneState, ids: readonly string[], selection: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const target = selectionTargetOf(scene, id, selection);
    if (seen.has(target)) continue;
    seen.add(target);
    out.push(target);
  }
  return out;
}

/**
 * The node that a DOUBLE CLICK on `id` must select: one level deeper
 * than what the simple click would select.
 *
 * null when there is nothing to enter (the click already selects `id`
 * itself). It is what leaves the double click free for its OTHER
 * meaning -- entering edit mode on a text node, see selectTool -- instead
 * of having to make them compete: first you enter groups, and when there are none
 * left the double click goes back to being the text one.
 */
export function enterTargetOf(scene: SceneState, id: string, selection: readonly string[]): string | null {
  if (!scene.nodes.at(id)) return null;
  const current = selectionTargetOf(scene, id, selection);
  if (current === id) return null;
  const path = pathTo(scene, id);
  const i = path.indexOf(current);
  if (i < 0 || i + 1 >= path.length) return null;
  return path[i + 1];
}

/**
 * The nodes that a TRANSFORM gesture (the resize) must actually touch: a
 * group is expanded into its children, recursively.
 *
 * Why resize yes and move no: moving a group is already expressed
 * by its transform -- the group's x/y translate the children, and a single
 * setProps moves them all (see transform.ts). A SCALE is not: a container's
 * transform is a translation, so writing width/height on a group
 * would scale nothing at all. Resizing a group is resizing its
 * content, and it is exactly this expansion.
 *
 * An empty group disappears from the list (nothing to transform); an id
 * that is not in the scene stays (not this function's job to validate it).
 */
export function transformTargetsOf(scene: SceneState, ids: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const n = scene.nodes.at(id);
    if (!isGroup(n)) {
      out.push(id);
      return;
    }
    for (const c of childrenOf(scene, id)) push(c.id);
  };
  for (const id of ids) push(id);
  return out;
}
