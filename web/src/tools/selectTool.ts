import { hitTest, nodesIntersecting } from "../renderer/canvasRenderer";
import { normalizeRect, boundsOfNode, type Bounds } from "../canvas/geometry";
import {
  type Transform,
  invertTransform,
  mapBounds,
  mapVector,
  worldBoundsOfNode,
  worldTransformOf,
} from "../canvas/transform";
import { worldToScreen } from "../canvas/camera";
import { angleOf, centerOf, normalizeDegrees, rotateAround, snapDegrees } from "../canvas/transform";
import { selectionFrame, selectionWorldBounds } from "../renderer/overlayRenderer";
import { resizeVector } from "../store/vectorGeometry";
import type { SubPathLite } from "../store/types";
import {
  applyFrameResize,
  applyFrameResizeToNode,
  cursorForFrameHit,
  cursorForHandle,
  hitTestFrame,
  movingEdgeLines,
  resizeFrame,
  ROTATING_CURSOR,
  type FrameHit,
  type HandleId,
  type SelectionFrame,
} from "../selection/handles";
import { type SnapIndex, prepareSnapTargets, snapBounds, snapMoving, snapTargets, worldThreshold, type SnapGuide } from "../selection/snap";
import { useScene } from "../store/store";
import { enterTargetOf, selectionTargetOf, selectionTargetsOf, transformTargetsOf } from "../store/groups";
import { subtreeOf, topmostOf } from "../store/tree";
import { groupOps, ungroupOps } from "./grouping";
import { wrapSelectionInFrame } from "./wrapFrame";
import { computeLayoutDrop, layoutDropOps, reorderableParent, type LayoutDrop } from "./layoutDrop";
import { makeCreateComponentOp, makeDeleteOp, makeSetPropsOp, makeSetVectorPathOp, uuid } from "./ops";
import type { SceneState } from "../store/types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Tool, ToolContext } from "./types";

const DEFAULT_CURSOR = "default";

// Below this threshold (SCREEN px, like shapeTool's CLICK_SLOP_PX) a
// "marquee" is not a marquee: it is a CLICK on empty space. The distinction matters because
// the marquee selects by BOUNDS intersection (AABB), while a click goes
// through hitTest (which for an ellipse is the true ellipse equation). Without a
// threshold, a click in the empty corner of an ellipse's bounding box opens a
// 0x0 marquee that "intersects" that bounding box and selects the ellipse: the
// same AABB selection that hitTest exists precisely to avoid. A click on
// empty space should only clear the selection (or leave it intact with shift).
const MARQUEE_SLOP_PX = 3;

// Double-click threshold, in ms between the two pointerdown timeStamps (Task 4,
// step 3: double-click with Select on a text node enters editing).
// toolManager.ts does not forward a native "dblclick" event: detecting it here by
// ID + time (instead of introducing a second event channel) remains
// testable without fake timers, two PointerEvents with different timeStamps suffice.
const DOUBLE_CLICK_MS = 400;

// How far the pointer may move (SCREEN px, like MARQUEE_SLOP_PX above
// and shapeTool's CLICK_SLOP_PX) between the second click's pointerdown and its
// release without ceasing to be a double-click. Above the threshold that
// pointer is just a DRAG: see the comment on pendingTextEdit.
const DOUBLE_CLICK_SLOP_PX = 3;

// With Shift held rotation snaps to multiples of 15° (the design
// editor convention: 15 divides 45, 90 and 360).
const ROTATE_SNAP_DEG = 15;

// The cursor lives on the canvas DOM (as toolManager does when the tool changes).
// Duck-typing on style: in tests ctx.canvas is a double, not an HTMLCanvasElement.
function setCursor(ctx: ToolContext, cursor: string): void {
  const style = (ctx.canvas as unknown as { style?: { cursor: string } } | undefined)?.style;
  if (style) style.cursor = cursor;
}

// Handles are tested in SCREEN px (grab area constant at every zoom),
// but ToolContext exposes only toWorld: we go back to screen by going AGAIN through
// canvas/camera.ts, never recomputing the transformation by hand. The world -> screen
// round-trip is the exact inverse of toWorld, so there is no need to know the
// canvas rectangle here.
//
// Returns the COMPLETE overlay hit: one of the 8 resize handles
// or one of the 4 rotation zones just outside the corners (the precedence order
// is in selection/handles.ts::hitTestFrame).
function frameUnderPointer(ctx: ToolContext, world: { x: number; y: number }): FrameHit | null {
  const frame = frameOfSelection(ctx);
  if (!frame) return null;
  const cam = ctx.getCamera();
  const p = worldToScreen(cam, world.x, world.y);
  return hitTestFrame(frame, cam, p.x, p.y);
}

function frameOfSelection(ctx: ToolContext): SelectionFrame | null {
  const scene = ctx.getScene();
  if (!scene) return null;
  return selectionFrame(scene, useScene.getState().selection);
}

// From the WORLD to the space in which a node's coordinates are written, i.e. the
// local space of its parent. It is the conversion every gesture must do
// before writing into the model: the pointer speaks world, the document speaks
// relative to the parent. For a child of a page it is the identity -- and that is
// why an already existing document does not move by a pixel.
function parentToLocal(scene: SceneState, parentId: string): Transform {
  return invertTransform(worldTransformOf(scene, parentId));
}

// The ids to EXCLUDE from the snap targets: not only the selected nodes but
// their whole SUBTREE. A group being dragged (or resized) carries
// its children with it, which therefore move together and are not targets to
// snap to -- otherwise the group's frame would snap against its own
// content. For a flat selection subtreeOf(id) is [id], so it coincides with
// the selection itself and the snap stays identical to before.
function snapExclude(scene: SceneState, selection: readonly string[]): string[] {
  return selection.flatMap((id) => subtreeOf(scene, id).map((n) => n.id));
}

export type PickResult =
  | { mode: "marquee" }
  | { mode: "single"; id?: string }
  | { mode: "toggle"; id: string };

// Decides the TYPE of gesture without touching the store: a pure function of scene +
// input (`zoom` included: the grab around an open vector path is in SCREEN
// px, see renderer/shapes.ts::VECTOR_HIT_PX), testable without DOM
// (Task 8, step 1). An absent id in mode "single"
// means "the node is already selected, do not touch the selection" -- it is the
// reading of "single selection (IF NOT already selected)" from the brief: this way a
// subsequent drag moves the ENTIRE selection (even a multiple one) instead of
// collapsing it prematurely onto a single node.
export function pickTarget(
  scene: SceneState,
  world: { x: number; y: number },
  shiftKey: boolean,
  selection: string[],
  zoom: number,
  currentPageId?: string | null,
): PickResult {
  // Scoped to the current page, like drawing (T1): a click does not hit a
  // node of ANOTHER page (which the canvas does not show). `zoom` goes down to
  // hitTestNode for the grab of an open vector path (T4, SCREEN px).
  // An absent currentPageId falls back to the first page -- see canvasRenderer::rootsOf.
  const hit = hitTest(scene, world.x, world.y, zoom, currentPageId);
  if (!hit) return { mode: "marquee" };
  // hitTest answers "which node is under the pointer" -- the INNERMOST,
  // always. Which node gets SELECTED is another question, and the answer is the
  // group policy (store/groups.ts): the outermost group, unless
  // the current selection says we have already entered it. It also applies to
  // shift-click: the same thing a click would select is added to the selection,
  // or shift would become the way to grab a child without
  // entering the group.
  const id = selectionTargetOf(scene, hit, selection);
  if (shiftKey) return { mode: "toggle", id };
  return selection.includes(id) ? { mode: "single" } : { mode: "single", id };
}

// Ids of the nodes the marquee selects: the VISIBLE ones (along the whole path
// from the page down) whose WORLD box intersects the rectangle, in draw
// order.
//
// The marquee is in WORLD coordinates (it comes from the pointer) and the
// model coordinates are relative to the parent: the conversion, together with the
// tree rules (invisible container that takes the subtree away, frame
// clipping), lives in renderer/canvasRenderer.ts::nodesIntersecting -- the SAME
// descent as drawScene and hitTest, so what you see is what you select.
//
// The order is that of the tree (containers before children, siblings by order
// key) and not a flat comparison of order keys: for a flat scene they are the
// same list, for a nested one only the first has a meaning.
export function nodesInMarquee(scene: SceneState, bounds: Bounds, currentPageId?: string | null): string[] {
  return nodesIntersecting(scene, bounds, currentPageId);
}

function union(base: string[], extra: string[]): string[] {
  const seen = new Set(base);
  return [...base, ...extra.filter((id) => !seen.has(id))];
}

// The MODIFIERS that decide the shape of a gesture: Alt turns snap off, Shift
// keeps the aspect ratio (in resize) and snaps the angle (in rotation).
interface Mods { alt: boolean; shift: boolean }

function modsOf(e: { altKey?: boolean; shiftKey?: boolean }): Mods {
  return { alt: e.altKey === true, shift: e.shiftKey === true };
}

export function createSelectTool(): Tool {
  // --- THE MODIFIERS OF THE LAST PREVIEW ------------------------------------
  //
  // The final op is recomputed from the POINTERUP position, but the modifiers
  // are NOT: those of the last pointermove are used, i.e. those that produced
  // the preview the user is looking at when they release the button.
  //
  // Reading them from the pointerup event is a bug that only shows when it matters:
  // Alt held for a whole drag (previews exactly under the finger,
  // to place a node 2 px from its neighbor), Alt released an instant BEFORE the
  // button -- and the pointerup arrives with altKey false, the snap kicks in at
  // commit and the node jumps by up to SNAP_THRESHOLD_PX/zoom. endGesture rebuilds
  // the scene from those ops, so the jump is what ends up on the wire and in the
  // undo entry. The opposite direction (pressing Alt just before releasing, to
  // escape a snap already shown) is equally reachable. Alt is
  // precisely the way out of snapping: reading it on release undoes the feature
  // at the only moment it is needed.
  //
  // The same applies to Shift: releasing it before the button would commit an
  // UNconstrained resize after a constrained preview, and an unsnapped angle
  // after a snapped preview.
  //
  // It LATCHES to the last preview (not to the pointerdown) because pressing or
  // releasing a modifier mid-gesture must keep changing the preview
  // immediately, as in every editor: the rule is "commit what was seen",
  // not "commit what was pressed at the start". A single latch for all
  // three gestures: at most one is open at a time.
  let lastMods: Mods = { alt: false, shift: false };

  // --- move drag ------------------------------------------------------------
  // WORLD anchor and starting position (WORLD) of each dragged node,
  // captured at pointerdown. The store gesture (beginGesture) is opened
  // LAZILY at the first real pointermove: a plain click (down+up
  // with no move in between) must never open/close an empty gesture --
  // otherwise every click on an already selected node would spam a
  // "misuse" beginGesture in tests that only test onPointerDown (see
  // store.ts: beginGesture with a gesture already open warns and does not nest).
  //
  // `toLocal` is the inverse of the node's PARENT transformation, captured
  // at pointerdown (nobody reparents during a gesture): the pointer moves
  // in the WORLD, but the model's x/y are relative to the parent, and for a nested
  // node the two displacements are not the same number. As long as containers
  // contribute only translations the linear part is the identity and the two
  // coincide; the day rotation arrives (another track) it is this conversion
  // that keeps dragging a child of a rotated container from sending it
  // sideways.
  let dragAnchor: { x: number; y: number } | null = null;
  let dragStart: Record<string, { x: number; y: number; toLocal: Transform }> | null = null;
  let dragStarted = false;
  // The drag SNAP, captured at pointerdown: the box the
  // selection occupies (IT is what snaps, not the individual nodes -- otherwise a
  // multiple selection would fall apart, each node pulled by its own guide) and the
  // rectangles it can snap to. Computed once per gesture and not on every
  // pointermove: the targets do not move during the drag, and
  // recomputing them 60 times a second would mean re-reading the whole scene.
  let dragBox: Bounds | null = null;
  let dragTargets: SnapIndex | null = null;
  // REORDERING in an auto layout (tools/layoutDrop.ts). Decided at the first real move:
  // if the dragged nodes are children of an auto layout frame the gesture does NOT
  // write x/y (the server would recompute them and the node would snap back),
  // it instead chooses where to put them in the row. `box` is the starting box
  // of the selection, from which the outline following the pointer is drawn.
  let reorder: { originId: string; ids: string[]; box: Bounds | null } | null = null;

  // --- resize with the handles ------------------------------------------------
  // Same structure as the move drag: WORLD anchor + initial state, and
  // LAZY opening of the gesture at the first real move (a click on a handle
  // must produce no op). resizeStartBox is the GROUP bbox at the start of the
  // gesture: each node is then mapped with the same transformation, so a
  // multiple selection scales (and mirrors) as a block.
  //
  // The group bbox is in WORLD coordinates (the handles and the
  // pointer live there), so the starting boxes of the individual nodes are too:
  // mapping a LOCAL box with a transformation computed in the world would give
  // a meaningless rectangle. The return to local happens at the end, when
  // writing into the model -- see resizeOps.
  let resizeHandle: HandleId | null = null;
  let resizeAnchor: { x: number; y: number } | null = null;
  let resizeStartFrame: SelectionFrame | null = null;
  // The starting box of each node in WORLD coordinates (the same one in which the
  // frame and the pointer live), its angle, and `toLocal` to rewrite the
  // result in the PARENT space -- where x/y/width/height really live.
  // world+toLocal (nesting, T1) and rotation (T2) together: a rotated node
  // inside a multiple selection is not mapped like the others (handles.ts::
  // applyFrameResizeToNode), and a flip also changes its angle.
  let resizeStartNodes:
    | Record<string, { bounds: Bounds; rotation: number; toLocal: Transform }>
    | null = null;
  // The starting GEOMETRY of only the selected vector nodes (T4). Captured
  // at pointerdown like the bounds and for the same reason: the preview ops are
  // absolute and are always recomputed from the initial state.
  let resizeStartVectors: Record<string, SubPathLite[]> | null = null;
  let resizeStarted = false;
  // The snap targets for resizing, captured like those of the
  // drag (same reason).
  let resizeTargets: SnapIndex | null = null;

  // --- rotation from the corner zones -----------------------------------------
  // Same shape as the other two gestures (anchor + initial state + LAZY
  // opening of the gesture at the first real move). The anchor here is ANGULAR: the angle of the
  // center->pointer ray at pointerdown, from which the delta is measured.
  //
  // rotateCenter is the center of the FRAME, which for a multiple selection is not the
  // center of any node: the nodes rotate around it (their centers
  // move) and each also turns on itself by the same delta -- i.e. the
  // selection rotates as a RIGID BODY.
  let rotateCenter: { x: number; y: number } | null = null;
  let rotateStartAngle = 0;
  // The reference angle the Shift snap applies to: that of the
  // FIRST selected node. Snapping each node's angle separately
  // would break the group's rigidity (nodes with different initial angles
  // would converge); snapping the DELTA of a single node would never give a
  // round angle. The reference's total is snapped and the resulting delta
  // is used for all.
  let rotateRef = 0;
  let rotateStartNodes: Record<string, { bounds: Bounds; rotation: number }> | null = null;
  let rotateStarted = false;

  // --- marquee ---------------------------------------------------------------
  let marqueeAnchor: { x: number; y: number } | null = null;
  let marqueeBase: string[] | null = null;
  let preMarqueeSelection: string[] | null = null;

  // --- double-click on a text node --------------------------------------------
  let lastClick: { id: string; time: number } | null = null;

  // Id of the text node CANDIDATE for editing: the second click within the threshold
  // arrived, but the decision is deferred to release. The pointerdown alone
  // is not enough to say "double-click" -- a quick re-click that then DRAGS is a
  // normal move, and deciding at down swallowed it into an
  // editing session leaving the node stuck where it was (same shape as the 0x0 marquee
  // cured in M1a: do not commit until there is enough evidence).
  // While it is set the drag is PREPARED but not started (dragStarted stays
  // false, no gesture open on the store): on pointerup editing opens, and
  // if instead the pointer exceeds DOUBLE_CLICK_SLOP_PX the candidate drops and the
  // drag proceeds exactly like any other move -- delta computed from
  // dragAnchor, so the px "spent" to exceed the threshold count too.
  let pendingTextEdit: string | null = null;

  // The guides live as long as the GESTURE that produced them: they turn off wherever a
  // gesture ends -- release, Esc, Delete, tool change -- because all those
  // paths go through a reset.
  function clearGuides() {
    useScene.getState().setSnapGuides([]);
  }

  function resetDrag() {
    dragAnchor = null;
    dragStart = null;
    dragStarted = false;
    dragBox = null;
    dragTargets = null;
    reorder = null;
    useScene.getState().setLayoutDrop(null);
    clearGuides();
  }

  // Where the reorder would land with the pointer at `e`, and its look on the overlay.
  function reorderStep(e: PointerEvent, ctx: ToolContext): LayoutDrop | null {
    const scene = ctx.getScene();
    if (!reorder || !scene || !dragAnchor) return null;
    const p = ctx.toWorld(e);
    const drop = computeLayoutDrop(scene, reorder.ids, reorder.originId, p);
    const ghost = reorder.box
      ? { ...reorder.box, x: reorder.box.x + (p.x - dragAnchor.x), y: reorder.box.y + (p.y - dragAnchor.y) }
      : null;
    useScene.getState().setLayoutDrop(drop ? { indicator: drop.indicator, ghost } : null);
    return drop;
  }

  function resetResize() {
    resizeHandle = null;
    resizeAnchor = null;
    resizeStartFrame = null;
    resizeStartNodes = null;
    resizeStartVectors = null;
    resizeStarted = false;
    resizeTargets = null;
    clearGuides();
  }

  function resetRotate() {
    rotateCenter = null;
    rotateStartAngle = 0;
    rotateRef = 0;
    rotateStartNodes = null;
    rotateStarted = false;
  }

  // --- SNAP, INSIDE THE GESTURE ---------------------------------------------
  //
  // The snap is NOT another change: it corrects the pointer position
  // BEFORE the gesture uses it, so it enters the preview and the final op
  // in exactly the same way. The gesture stays one, the op stays one per node,
  // the undo entry stays one. It is the point where the implementation could
  // have gone astray: a snap applied "after" would have wanted an op of its own.
  //
  // ALT turns it off for that gesture: it is the convention, and without a way out a
  // node would become impossible to place 2 px from another.

  // The DRAG delta, snap included. The selection box
  // is moved by the raw delta and the snap is asked of it there: it is its
  // six lines (edges and centers, on both axes) that compete.
  function dragDelta(e: PointerEvent, ctx: ToolContext, mods: Mods): { dx: number; dy: number; guides: SnapGuide[] } {
    const world = ctx.toWorld(e);
    const dx = world.x - dragAnchor!.x;
    const dy = world.y - dragAnchor!.y;
    if (mods.alt || !dragBox || !dragTargets || dragTargets.targets.length === 0) return { dx, dy, guides: [] };
    const moved = { ...dragBox, x: dragBox.x + dx, y: dragBox.y + dy };
    const s = snapBounds(moved, dragTargets, worldThreshold(ctx.getCamera()));
    return { dx: dx + s.dx, dy: dy + s.dy, guides: s.guides };
  }

  // The RESIZE delta, snap included. Three cases in which the snap
  // steps aside, and none of the three is a renunciation out of laziness:
  //
  //  - ALT: explicit deactivation, as in the drag.
  //  - SHIFT: the user asked for the ASPECT RATIO, which is a stronger
  //    constraint -- snapping one axis would break the other, i.e. it would disobey
  //    the one thing they asked for out loud.
  //  - ROTATED FRAME: its edges are not screen lines, and a guide
  //    that is not a screen line aligns nothing (see the choice
  //    declared in selection/snap.ts). The targets remain AABB even for
  //    rotated nodes; it is the box being PULLED that must be straight.
  //
  // Correcting the pointer delta (instead of the result) is what keeps the
  // snap inside the existing math: resizeFrame remains the only one to
  // compute the resize, flip and anchor included.
  function resizeDelta(e: PointerEvent, ctx: ToolContext, mods: Mods): { dx: number; dy: number; guides: SnapGuide[] } {
    const world = ctx.toWorld(e);
    const dx = world.x - resizeAnchor!.x;
    const dy = world.y - resizeAnchor!.y;
    const frame = resizeStartFrame;
    if (
      mods.alt || mods.shift || !frame || !resizeHandle
      || !resizeTargets || resizeTargets.targets.length === 0
      || frame.rotation % 360 !== 0
    ) {
      return { dx, dy, guides: [] };
    }
    const r = resizeFrame(frame, resizeHandle, dx, dy);
    const box = applyFrameResize(frame.bounds, r);
    const lines = movingEdgeLines(box, resizeHandle);
    // FLIP in progress: the moving edge has passed the anchor, so in
    // `box` (normalized) the min and max have swapped and
    // movingEdgeLines would be pointing at the FIXED edge. On that axis we do not
    // snap: doing so would move the anchor, the only point the resize
    // promises not to move.
    if (r.transform.signedW < 0) lines.x = [];
    if (r.transform.signedH < 0) lines.y = [];
    const s = snapMoving(box, lines, resizeTargets, worldThreshold(ctx.getCamera()));
    return { dx: dx + s.dx, dy: dy + s.dy, guides: s.guides };
  }

  // The resize ops for the current pointer position, ALWAYS recomputed
  // from the initial bounds (never from the last move's delta): no
  // accumulation of errors, and the final op is identical to the last preview.
  function resizeOps(e: PointerEvent, ctx: ToolContext, mods: Mods): { ops: Op[]; guides: SnapGuide[] } {
    if (!resizeHandle || !resizeAnchor || !resizeStartFrame || !resizeStartNodes) {
      return { ops: [], guides: [] };
    }
    const { dx, dy, guides } = resizeDelta(e, ctx, mods);
    // resizeFrame brings the pointer delta into the frame's LOCAL space
    // (so the `e` handle widens the node along ITS axis, however it is
    // rotated) and computes the offset that keeps the anchor still in the WORLD. The
    // resize math -- flip and keepAspect included -- remains that of
    // resizeTransform, unchanged: here it is wrapped, not rewritten.
    const r = resizeFrame(resizeStartFrame, resizeHandle, dx, dy, { keepAspect: mods.shift });
    const ops: Op[] = [];
    for (const [id, start] of Object.entries(resizeStartNodes)) {
      const next = applyFrameResizeToNode(start.bounds, start.rotation, r);
      // The computation happens in the WORLD (where the frame is), then the box goes back into the
      // PARENT space before ending up in an op (T1 nesting): in the model
      // x/y/width/height are relative to the parent, and writing a world box there
      // would shift a nested node by its container's offset. For a node
      // child of a page toLocal is the identity and localBounds === next.bounds.
      const localBounds = mapBounds(start.toLocal, next.bounds);
      // The angle enters the mask ONLY when it really changes (a node aligned
      // with the frame -- the normal case -- sends exactly the op as before). It changes
      // when a non-uniform scale or a flip turns the node's
      // axes: without sending it, the node would be seen with the new shape and the old
      // angle, i.e. outside the box.
      ops.push(
        next.rotation === start.rotation
          ? makeSetPropsOp(id, localBounds, ["x", "y", "width", "height"])
          : makeSetPropsOp(
              id,
              { ...localBounds, rotation: next.rotation },
              ["x", "y", "width", "height", "rotation"],
            ),
      );
      // A VECTOR node carries its geometry inside the SAME gesture: the
      // anchors are lengths in local coordinates, not fractions of the box,
      // so without this second op the box would grow and the ink
      // would stay its size -- violating the proto invariant (after a
      // SetVectorPath the geometry's local bbox is (0,0)-(width,height)). The
      // scale comes from the group transformation (r.transform), the same that
      // just mapped the box; in preview the two coalescing keys
      // (`s|id|...` and `v|id`, see store.ts::previewKey) do not crush each
      // other, and it is a single undo entry.
      const start0 = resizeStartVectors?.[id];
      if (!start0) continue;
      // resizeVector measures the anchors against the box in the node's LOCAL space
      // (anchors are local). For a child of a page it is identical to the
      // world box; for a nested node it is brought back to local as above.
      const localStart = mapBounds(start.toLocal, start.bounds);
      ops.push(makeSetVectorPathOp(id, resizeVector(
        start0,
        localStart,
        { signed: r.transform.signedW, start: r.transform.startW },
        { signed: r.transform.signedH, start: r.transform.startH },
      )));
    }
    return { ops, guides };
  }

  // The DRAG ops for the current pointer position. Like the
  // resize: recomputed from the initial state, never from the last delta.
  function dragOps(e: PointerEvent, ctx: ToolContext, mods: Mods): { ops: Op[]; guides: SnapGuide[] } {
    if (!dragAnchor || !dragStart) return { ops: [], guides: [] };
    const { dx, dy, guides } = dragDelta(e, ctx, mods);
    const ops = Object.entries(dragStart).map(([id, start]) => {
      // The displacement (world, snap included) goes through only the LINEAR part
      // of the parent's transformation (mapVector): it is a delta, not a point,
      // so the container's translation does not touch it. For a child of a page
      // toLocal is the identity and (d.x, d.y) === (dx, dy).
      const d = mapVector(start.toLocal, dx, dy);
      return makeSetPropsOp(id, { x: start.x + d.x, y: start.y + d.y }, ["x", "y"]);
    });
    return { ops, guides };
  }

  // The rotation ops for the current pointer position. Like the
  // resize: ALWAYS recomputed from the initial state, never from the last delta.
  function rotateOps(e: PointerEvent, ctx: ToolContext, mods: Mods): Op[] {
    if (!rotateCenter || !rotateStartNodes) return [];
    const world = ctx.toWorld(e);
    const raw = angleOf(rotateCenter, world) - rotateStartAngle;
    // With Shift the snap is on the reference's TOTAL, not on the delta: you
    // get a round angle (0, 15, 30...) instead of a round displacement
    // starting from an arbitrary angle.
    const delta = mods.shift ? snapDegrees(rotateRef + raw, ROTATE_SNAP_DEG) - rotateRef : raw;
    return Object.entries(rotateStartNodes).map(([id, start]) => {
      // The node's center rotates around that of the frame (for a single
      // selection the two coincide and this is exactly the identity), and the node turns
      // on itself by the same delta: together, a rigid rotation.
      const c = rotateAround(centerOf(start.bounds), rotateCenter!, delta);
      return makeSetPropsOp(id, {
        x: c.x - start.bounds.width / 2,
        y: c.y - start.bounds.height / 2,
        rotation: normalizeDegrees(start.rotation + delta),
      }, ["x", "y", "rotation"]);
    });
  }

  function resetMarquee() {
    marqueeAnchor = null;
    marqueeBase = null;
    preMarqueeSelection = null;
    useScene.getState().setMarquee(null);
  }

  // Abandons ANY local gesture in progress (move, marquee or resize),
  // bringing both the store and the tool state back to the starting point -- without
  // sending anything on the wire. Shared by Esc, Delete/Backspace and onDeactivate:
  // all three points where the tool must be able to detach "cleanly" from a
  // half-done gesture. Crucial for Delete/Backspace in particular -- without this
  // call BEFORE deleting, a Delete pressed mid-drag would close the
  // STORE's gesture (via its own beginGesture/endGesture for the
  // deletion) but leave the tool's dragAnchor/dragStart/dragStarted
  // stale: the next pointerup would find them still valid and call
  // endGesture() a second time WITHOUT an open gesture, which (misuse expected
  // by store.ts) still sends a bogus setProps over the wire for a node that has
  // since been deleted.
  function cancelActiveGesture() {
    // The editing candidate is also a "gesture in progress": without resetting it, the
    // pointerup that arrives anyway after Esc/Delete would open an editing
    // session late (on a node that Delete may have deleted).
    pendingTextEdit = null;
    if (marqueeAnchor) {
      useScene.getState().setSelection(preMarqueeSelection ?? []);
      resetMarquee();
    }
    if (dragAnchor) {
      if (dragStarted) useScene.getState().cancelGesture();
      resetDrag();
    }
    if (resizeHandle) {
      if (resizeStarted) useScene.getState().cancelGesture();
      resetResize();
    }
    if (rotateCenter) {
      if (rotateStarted) useScene.getState().cancelGesture();
      resetRotate();
    }
  }

  return {
    id: "select",
    cursor: "default",

    onPointerDown(e, ctx) {
      const scene = ctx.getScene();
      if (!scene) return;
      // The latch restarts from the gesture about to begin, so it does not carry in
      // the modifiers of a hover or of a previous gesture. (It is not enough on its own
      // to decide anything: without at least one pointermove no gesture opens.)
      lastMods = modsOf(e);
      const world = ctx.toWorld(e);
      const store = useScene.getState();
      // Every new pointerdown restarts without candidates: an unresolved down (a
      // second finger, an up that never arrived) must not be able to open editing long
      // after. Before the handles, which leave the method by their own path.
      pendingTextEdit = null;

      // The handles have PRIORITY over nodes: a rectangle's e handle
      // falls inside (or on the edge of) the rectangle itself, and the outer ones
      // fall on empty space -- without priority a pointerdown there would move it or
      // start a marquee clearing the selection.
      const overlay = frameUnderPointer(ctx, world);
      if (overlay?.kind === "resize") {
        // One op per TOPMOST node with GROUPS EXPANDED into their children
        // (transformTargetsOf ∘ topmostOf, T1): a group has no box of its own
        // to rewrite -- resizing it is resizing the content -- and a
        // descendant selected with its container would be transformed twice,
        // because transforming the container already transforms the child. The GROUP
        // bbox remains instead that of the ENTIRE selection (frameOfSelection),
        // on which the overlay drew the handles just grabbed.
        const start: Record<string, { bounds: Bounds; rotation: number; toLocal: Transform }> = {};
        // The starting geometry of only the vector nodes (T4): used by
        // resizeOps to scale the anchors together with the box.
        const startVectors: Record<string, SubPathLite[]> = {};
        for (const sid of transformTargetsOf(scene, topmostOf(scene, store.selection))) {
          const n = scene.nodes.at(sid);
          if (!n) continue;
          // bounds in WORLD (like the frame and the pointer) + toLocal to go back
          // to parent-local when writing the op -- see resizeStartNodes.
          start[sid] = {
            bounds: worldBoundsOfNode(scene, n),
            rotation: n.rotation,
            toLocal: parentToLocal(scene, n.parentId),
          };
          if (n.kind === "vector" && n.vector) startVectors[sid] = n.vector.subpaths;
        }
        resizeHandle = overlay.handle;
        resizeAnchor = world;
        resizeStartFrame = frameOfSelection(ctx);
        resizeStartNodes = start;
        resizeStartVectors = startVectors;
        resizeTargets = prepareSnapTargets(snapTargets(scene, snapExclude(scene, store.selection)));
        resizeStarted = false;
        setCursor(ctx, cursorForHandle(overlay.handle));
        return;
      }
      // ROTATION, from the zone just outside the corner. It has the same
      // priority as the handles over the node under the pointer (in reality it always falls
      // on empty space around the selection: without this branch a
      // pointerdown there would open a marquee clearing the selection).
      if (overlay?.kind === "rotate") {
        const frame = frameOfSelection(ctx);
        if (frame) {
          const start: Record<string, { bounds: Bounds; rotation: number }> = {};
          for (const sid of store.selection) {
            const n = scene.nodes.at(sid);
            if (n) start[sid] = { bounds: boundsOfNode(n), rotation: n.rotation };
          }
          rotateCenter = centerOf(frame.bounds);
          rotateStartAngle = angleOf(rotateCenter, world);
          rotateRef = scene.nodes.at(store.selection[0])?.rotation ?? 0;
          rotateStartNodes = start;
          rotateStarted = false;
          setCursor(ctx, ROTATING_CURSOR);
          return;
        }
      }

      // Double-click on a TEXT node: enters editing instead of starting a
      // drag (Task 4, step 3). Detected by ID + e.timeStamp: it recomputes
      // hitTest instead of reading it from pickTarget below, which for a node
      // ALREADY selected does not return it (pickTarget returns "single" without
      // an id on purpose, see its comment) -- and here it is ALWAYS needed, selected or
      // not. Shift-click stays reserved for the multi-selection toggle, not for
      // this: a shift+double-click does nothing special.
      //
      // The second click only marks a CANDIDATE (pendingTextEdit) and goes on:
      // selection and drag are prepared as for any click, so if the
      // pointer moves the gesture is already armed and the move starts from
      // this same down. The one who decides is the release (onPointerUp), not the down.
      const zoom = ctx.getCamera().zoom;
      const hitId = hitTest(scene, world.x, world.y, zoom, store.currentPageId);
      if (hitId && !e.shiftKey) {
        const isDoubleClick =
          lastClick !== null &&
          lastClick.id === hitId &&
          e.timeStamp - lastClick.time <= DOUBLE_CLICK_MS;
        if (isDoubleClick) {
          // lastClick cleared: a third click does not chain another double.
          lastClick = null;
          // The two meanings of double-click are IN SEQUENCE, not in
          // competition: first you ENTER groups (one level per double
          // click, see store/groups.ts::enterTargetOf), and only when there is no
          // more to enter does the double-click go back to being the text
          // one. On a text inside a group two double
          // clicks are therefore needed: the first enters, the second types -- which is also the order
          // in which the user thinks of them.
          const enter = enterTargetOf(scene, hitId, store.selection);
          if (enter) {
            // IMMEDIATELY, not at pointerup: the drag prepared below must act
            // on the node just entered (double-click and drag
            // moves the child, not the group).
            store.setSelection([enter]);
          } else if (scene.nodes.at(hitId)?.kind === "text") {
            pendingTextEdit = hitId;
          }
        } else {
          lastClick = { id: hitId, time: e.timeStamp };
        }
      } else {
        lastClick = null;
      }

      // Selection READ NOW and not from `store`: entering a group (above)
      // has just changed it, and `store` is the snapshot from before. `zoom`
      // (T4) and currentPageId (T1) both, as in hitTest above.
      const target = pickTarget(scene, world, e.shiftKey, useScene.getState().selection, zoom, store.currentPageId);

      if (target.mode === "marquee") {
        // shift+click on empty space does not clear: it is the start of an addition (union
        // with the current selection at pointerup).
        const base = e.shiftKey ? store.selection : [];
        preMarqueeSelection = store.selection;
        if (!e.shiftKey) store.clearSelection();
        marqueeBase = base;
        marqueeAnchor = world;
        store.setMarquee({ x: world.x, y: world.y, width: 0, height: 0 });
        return;
      }

      if (target.mode === "toggle") store.toggleSelection(target.id);
      else if (target.id) store.setSelection([target.id]);
      // target.mode === "single" without an id: node already selected, no
      // change -- the drag below will use the existing (multiple) selection.

      // topmostOf as in the resize above (and in deletion): a
      // descendant moves ALREADY because its container moves, so an
      // op of its own would bring it to 2*delta from the starting point.
      const selection = useScene.getState().selection;
      const start: Record<string, { x: number; y: number; toLocal: Transform }> = {};
      for (const sid of topmostOf(scene, selection)) {
        const n = scene.nodes.at(sid);
        if (n) start[sid] = { x: n.x, y: n.y, toLocal: parentToLocal(scene, n.parentId) };
      }
      dragAnchor = world;
      dragStart = start;
      dragStarted = false;
      // It is the selection BOX that snaps, not the individual nodes: with a
      // multiple selection each node pulled by its own guide would break it apart.
      dragBox = selectionWorldBounds(scene, selection);
      dragTargets = prepareSnapTargets(snapTargets(scene, snapExclude(scene, selection)));
    },

    onPointerMove(e, ctx) {
      // Every preview LATCHES its modifiers: it is this pair, and not
      // the pointerup's, that the final op will use (see lastMods).
      lastMods = modsOf(e);
      if (rotateCenter) {
        setCursor(ctx, ROTATING_CURSOR);
        if (!rotateStarted) {
          rotateStarted = true;
          useScene.getState().beginGesture();
        }
        for (const op of rotateOps(e, ctx, lastMods)) useScene.getState().applyLocal(op);
        return;
      }
      if (resizeHandle) {
        // The cursor stays that of the grabbed handle for the whole drag,
        // even when the pointer moves away from where the handle was.
        setCursor(ctx, cursorForHandle(resizeHandle));
        if (!resizeStarted) {
          resizeStarted = true;
          useScene.getState().beginGesture();
        }
        const step = resizeOps(e, ctx, lastMods);
        useScene.getState().setSnapGuides(step.guides);
        for (const op of step.ops) useScene.getState().applyLocal(op);
        return;
      }
      if (marqueeAnchor) {
        const world = ctx.toWorld(e);
        useScene.getState().setMarquee(normalizeRect(marqueeAnchor.x, marqueeAnchor.y, world.x, world.y));
        return;
      }
      if (!dragAnchor || !dragStart) {
        // No gesture in progress: it is a simple hover. The cursor anticipates
        // what can be grabbed under the pointer -- resize handle or rotation
        // zone (step 4 of the brief, extended to rotation).
        const hover = frameUnderPointer(ctx, ctx.toWorld(e));
        setCursor(ctx, hover ? cursorForFrameHit(hover) : DEFAULT_CURSOR);
        return;
      }
      if (pendingTextEdit) {
        // screen px -> world units, so the threshold does not depend on zoom
        // (same conversion as the marquee click threshold).
        const p = ctx.toWorld(e);
        const slop = DOUBLE_CLICK_SLOP_PX / ctx.getCamera().zoom;
        if (Math.abs(p.x - dragAnchor.x) < slop && Math.abs(p.y - dragAnchor.y) < slop) {
          return; // jitter: it stays a double-click, no gesture open
        }
        pendingTextEdit = null; // threshold exceeded: from here it is a drag like any other
      }
      if (!dragStarted) {
        dragStarted = true;
        useScene.getState().beginGesture();
        const scene = ctx.getScene();
        const ids = Object.keys(dragStart);
        if (scene && reorderableParent(scene, ids) !== null) {
          reorder = {
            originId: reorderableParent(scene, ids) as string,
            ids,
            box: selectionWorldBounds(scene, ids),
          };
        }
      }
      if (reorder) {
        reorderStep(e, ctx);
        return;
      }
      const step = dragOps(e, ctx, lastMods);
      useScene.getState().setSnapGuides(step.guides);
      for (const op of step.ops) useScene.getState().applyLocal(op);
    },

    // POSITION from the release event, MODIFIERS from the last preview
    // (lastMods): what was seen is committed. See the comment on lastMods
    // for the reason -- reading e.altKey here makes a gesture snap at commit that
    // the user had kept free the whole time.
    onPointerUp(e, ctx) {
      if (rotateCenter) {
        if (rotateStarted) useScene.getState().endGesture(rotateOps(e, ctx, lastMods));
        resetRotate();
        return;
      }
      if (resizeHandle) {
        if (resizeStarted) useScene.getState().endGesture(resizeOps(e, ctx, lastMods).ops);
        resetResize();
        return;
      }
      if (marqueeAnchor) {
        const scene = ctx.getScene();
        const world = ctx.toWorld(e);
        const box = normalizeRect(marqueeAnchor.x, marqueeAnchor.y, world.x, world.y);
        // screen px -> world units, so the threshold does not depend on zoom.
        const slop = MARQUEE_SLOP_PX / ctx.getCamera().zoom;
        const isClick = box.width < slop && box.height < slop;
        // Same policy as the click (store/groups.ts): the rubber band
        // selects the group, not its children -- otherwise it would be the only
        // way to grab a group's content without entering it. The
        // context is the PRE-marquee selection: the current one was
        // cleared at pointerdown.
        const inside =
          scene && !isClick
            ? selectionTargetsOf(scene, nodesInMarquee(scene, box, useScene.getState().currentPageId), preMarqueeSelection ?? [])
            : [];
        useScene.getState().setSelection(union(marqueeBase ?? [], inside));
        resetMarquee();
        return;
      }
      // The second click arrived at release without exceeding the threshold: NOW
      // it is a double-click, and it opens editing. dragStarted is false by
      // construction (onPointerMove opens no gesture while the candidate is
      // alive), so there is nothing to close or to send over the wire.
      if (pendingTextEdit) {
        const id = pendingTextEdit;
        pendingTextEdit = null;
        resetDrag();
        const store = useScene.getState();
        store.setSelection([id]);
        store.beginTextEditing(id);
        return; // the editing session (Task 5) takes over from here
      }
      if (!dragAnchor || !dragStart) return;
      // The final ops carry the SNAPPED position, the same as the last
      // preview: the snap corrects the delta, it does not add a second op.
      if (dragStarted && reorder) {
        const scene = ctx.getScene();
        const drop = reorderStep(e, ctx);
        const ops = scene && drop ? layoutDropOps(scene, reorder.ids, drop) : [];
        // No change (same position in the row, or nothing to
        // land on): the gesture is cancelled, without an undo entry that does nothing.
        if (ops.length > 0) useScene.getState().endGesture(ops);
        else useScene.getState().cancelGesture();
        resetDrag();
        return;
      }
      if (dragStarted) useScene.getState().endGesture(dragOps(e, ctx, lastMods).ops);
      resetDrag();
    },

    onKeyDown(e) {
      if (e.key === "Escape") {
        cancelActiveGesture();
        return;
      }
      // Ctrl/Cmd+G groups the selection, Ctrl/Cmd+Shift+G ungroups it. One
      // GESTURE each: the ops (createNode + N reparentNode, or N
      // reparentNode + deleteNode) all go into a single endGesture, so a
      // single send over the network and ONE undo entry -- one Ctrl+Z undoes the
      // whole grouping, not the last reparented child.
      //
      // On the tool and not on the window like undo/redo (ui/App.tsx): grouping
      // is an operation on the SELECTION, i.e. this tool's business, exactly
      // like Delete below -- and toolManager already filters keys when
      // focus is in a text field.
      // Wrap in a frame: Shift+A with auto layout, Ctrl/Cmd+Alt+G without (as
      // in other design editors). BEFORE Ctrl+G, which would otherwise
      // also catch Ctrl+Alt+G.
      const wrapAuto = e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "a";
      const wrapPlain = (e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === "g";
      if (wrapAuto || wrapPlain) {
        e.preventDefault();
        cancelActiveGesture();
        wrapSelectionInFrame(wrapAuto);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g") {
        // Always preventDefault: in a browser Ctrl+G is "find next".
        e.preventDefault();
        // A drag or marquee in progress must be abandoned FIRST, for the same
        // reason as Delete below: an open gesture would make another one
        // nested (beginGesture warns and keeps the first) and the next
        // pointerup would find a now-stale tool state.
        cancelActiveGesture();
        const store = useScene.getState();
        const scene = store.scene;
        if (!scene) return;
        const res = e.shiftKey ? ungroupOps(scene, store.selection) : groupOps(scene, store.selection);
        // Nothing to group (empty selection) or nothing to ungroup (no
        // group selected): no gesture, no op, no undo entry.
        if (!res) return;
        store.beginGesture();
        // The intended selection BEFORE closing: endGesture reconciles it
        // against the final scene, so it can already name the group the ops
        // are about to create.
        store.setSelection(res.selection);
        store.endGesture(res.ops);
        return;
      }
      // Ctrl/Cmd+Alt+K creates a COMPONENT from the selected node: that node
      // becomes the MASTER (it stays exactly where it is, no op moves it) and a
      // single CreateComponent registers it. ONE gesture, one op. Not undoable in M4:
      // the proto has no DeleteComponent and invertOp returns null (store/
      // history.ts), so the gesture pushes no undo entry -- the
      // master was already in `nodes`, and the undo of ITS creation remains that of the
      // node, not of the component.
      //
      // Only with EXACTLY one node selected: wrapping a multi-selection
      // in a new master is later work, so zero or more than one is a
      // NO-OP -- no gesture, no op (opening beginGesture and then not
      // closing anything would leave an empty gesture hanging). The core rejects
      // an already-taken componentId or a missing root anyway: a fresh uuid and
      // the guarantee that the node exists suffice to avoid sending a known-invalid op.
      //
      // e.code in addition to e.key: with Alt held many layouts map "k" to a
      // different character (e.key), while e.code stays "KeyK". preventDefault
      // always, as for Ctrl+G: the combination may have a meaning in the
      // browser.
      if ((e.ctrlKey || e.metaKey) && e.altKey && (e.code === "KeyK" || e.key.toLowerCase() === "k")) {
        e.preventDefault();
        cancelActiveGesture();
        const store = useScene.getState();
        const scene = store.scene;
        if (!scene) return;
        if (store.selection.length !== 1) return;
        const rootNodeId = store.selection[0];
        const master = scene.nodes.at(rootNodeId);
        if (!master) return;
        const name =
          master.name.trim() !== ""
            ? master.name
            : `Component ${Object.keys(scene.components).length + 1}`;
        store.beginGesture();
        store.endGesture([makeCreateComponentOp(uuid(), rootNodeId, name)]);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        // A drag or marquee may be mid-way (button still pressed)
        // when the key arrives: they must be abandoned BEFORE deleting, so
        // dragAnchor/dragStart/dragStarted (or marqueeAnchor) do not stay stale
        // and the pointerup that will arrive anyway finds nothing to do
        // (see the comment on cancelActiveGesture above).
        cancelActiveGesture();
        const store = useScene.getState();
        const scene = store.scene;
        if (!scene) return;
        // One op per TOPMOST node, not per selected id: deleteNode cascades
        // over the subtree, so a child selected together with its group
        // is already gone when its op arrives. See topmostOf -- without the
        // pruning the second op is rejected by the server AND the whole gesture
        // is left without an undo entry.
        const ids = topmostOf(scene, store.selection);
        if (ids.length === 0) return;
        store.beginGesture();
        store.endGesture(ids.map((id) => makeDeleteOp(id)));
      }
    },

    // Abandoned gesture (tool change, pointercancel, unmount): no op.
    onDeactivate() {
      cancelActiveGesture();
    },
  };
}

export const selectTool = createSelectTool();
