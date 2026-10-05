import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import { nextOrderKey } from "../store/orderKey";
import { useScene } from "../store/store";
import { normalizeVector } from "../store/vectorGeometry";
import type { PenPreview, PointLite } from "../store/vectorGeometry";
import { toPbFills, toPbSubPaths } from "../store/types";
import type { AnchorLite, FillLite } from "../store/types";
import { PEN_ANCHOR_GRAB_PX } from "../renderer/overlayRenderer";
import { makeCreateNodeOp, uuid } from "./ops";
import type { Tool, ToolContext } from "./types";

// THE PEN TOOL.
//
// It has more phases than any other tool in this editor, and for that reason it is
// written as an EXPLICIT STATE MACHINE -- a name plus its data -- and
// not as a handful of booleans ("dragging", "already clicked",
// "closing"). The difference is not stylistic: with booleans
// impossible states are representable (dragging AND closing AND with no anchors)
// and every handler must remember to check them all; with the type below
// a missing case is a compile error and the set of transitions can be
// read in one place.
//
// The machine (penReduce) is PURE: no store, no camera, no DOM.
// It receives points already in WORLD coordinates and tolerances already in world units, and
// returns the new state plus the EFFECT the caller must produce. All the
// I/O -- opening the gesture, creating the node, publishing the preview -- lives in
// the adapter (createPenTool) below. This way the drawing rules are
// tested as a table of transitions, without doubles.

// Under this threshold (SCREEN px, hence independent of zoom) a gesture is
// a CLICK and places a corner anchor; above it is a DRAG and pulls the
// handles. Same value and same reason as shapeTool.ts/textTool.ts: without it,
// at high zoom a half-pixel jitter would give every click a
// microscopic handle that nobody asked for.
export const PEN_CLICK_SLOP_PX = 3;

// The tint a path is born with. Explicit and not the 0.6 gray of shapes
// (shapeTool.ts): an OPEN outline has no area, it exists on screen only
// as a 1.5px stroke (renderer/shapes.ts::VECTOR_STROKE_PX) and takes its
// own color from the node's fill -- the gray meant for a solid
// area, reduced to a hairline on a white background, would be almost invisible. Same
// choice (and same reason) as the black of textTool.ts.
export const PEN_FILL: FillLite = { r: 0.15, g: 0.15, b: 0.2, a: 1 };

// --- the state machine -------------------------------------------------------

// Which handle the current drag is pulling:
//  - "new"   the anchor has just been placed: the drag pulls its
//            TWO handles symmetrically (the standard smooth anchor);
//  - "close" the pointerdown landed on the FIRST anchor: on release the
//            outline closes, and the drag pulls only the INCOMING handle --
//            that of the return segment. The outgoing one stays as it is:
//            it draws the FIRST segment, decided at the start, and deforming it
//            backwards would be a change the user did not ask for.
export type PenGrip = "new" | "close";

export type PenState =
  // No anchor placed: no open gesture, nothing to undo.
  | { readonly name: "idle" }
  // Button PRESSED on an anchor: until it is released, the cursor
  // defines its handles.
  //
  // TWO distinct points, and the distinction is the whole fix of round 2:
  //  - `base` is the anchor as it was at pointerdown. It is the ORIGIN OF THE
  //    handle VECTOR (handles are offsets from the anchor) and is recomputed from it
  //    on every move -- never from the last value, which would be an accumulation;
  //  - `origin` is the point where the POINTER went down. It is from it that we measure
  //    "is this gesture a click or a drag?".
  //
  // Confusing them is a real bug and not a detail: on the first anchor the closing
  // grab is 6px (PEN_ANCHOR_GRAB_PX) while the click threshold is 3px
  // (PEN_CLICK_SLOP_PX), so there is a ring of 3-6px in which it CLOSES but
  // we are beyond the threshold. Measuring from the anchor, a still click in there --
  // zero pointer movement -- would be read as a drag and
  // would curve the return segment that the preview had just drawn
  // straight. And it would curve it in WORLD units: at zoom 0.25 those 6px are 24 units,
  // which going back to zoom 4 become a ~96px bulge on screen.
  | {
      readonly name: "placing";
      readonly anchors: readonly AnchorLite[];
      readonly grip: PenGrip;
      readonly base: AnchorLite;
      readonly origin: PointLite;
    }
  // Button released, path in progress: the next click places an anchor (or
  // closes, if it lands on the first). `cursor` is where it would land: the overlay draws
  // the segment that follows the pointer there.
  | {
      readonly name: "drawing";
      readonly anchors: readonly AnchorLite[];
      readonly cursor: PointLite;
    };

// SHARED reference and not a new object on every transition: it is how
// the adapter recognizes "nothing changed" with a `!==` and does not rewrite
// the preview in the store on every hands-free pointermove.
export const PEN_IDLE: PenState = { name: "idle" };

// The machine's events. `grab` and `slop` arrive already in WORLD units: the
// conversion from SCREEN px is done by the adapter, which is the only one that knows the
// camera (project rule: the transformation is not recomputed by hand, and whoever
// does not need the camera does not see it).
export type PenEvent =
  | { readonly kind: "down"; readonly at: PointLite; readonly grab: number }
  | { readonly kind: "move"; readonly at: PointLite; readonly slop: number }
  | { readonly kind: "up"; readonly at: PointLite; readonly slop: number }
  // Enter/Escape: ends the open path with what is there.
  | { readonly kind: "commit" }
  // Tool change, pointercancel, unmount: abandons without creating anything.
  | { readonly kind: "abort" };

// The finished outline, ready to become a node.
export interface PenPath {
  readonly anchors: readonly AnchorLite[];
  readonly closed: boolean;
}

// What the caller must do AFTER the transition. The effect is declared by the
// machine and produced by the adapter: it is what keeps the machine pure.
//  - "none"   nothing: the only consequence is the new state (and hence
//             the preview, which is derived from it). It also applies to abandoning --
//             the path in progress never touched the document, so
//             dropping it asks no work of the adapter;
//  - "finish" create the node with `path`: ONE op on the wire, ONE undo entry,
//             for the entire drawing.
//
// There is no "open the gesture" effect: the store's gesture is a SINGLE one for
// the whole application, and the pen tool does not occupy it for the minutes that pass
// between the first click and the last -- see finish() below.
export interface PenStep {
  readonly state: PenState;
  readonly effect: "none" | "finish";
  readonly path?: PenPath;
}

function corner(p: PointLite): AnchorLite {
  return { x: p.x, y: p.y, inX: 0, inY: 0, outX: 0, outY: 0 };
}

// The `base` anchor with the handles pulled to `cursor`. Below the threshold
// it returns base IDENTICAL: a click stays a corner, and a drag that goes back within
// the threshold returns exactly to where it started (no hysteresis, because
// the computation always restarts from base and not from the last value).
//
// The TWO points have two different jobs, and must be kept separate:
//  - `origin` (where the pointer went down) decides WHETHER there is a drag. A
//    click is a pointer that did not move, and this is true even when it
//    lands 5px from the center of the anchor being closed -- the grab is
//    generous ON PURPOSE to invite it, and cannot then charge for that distance
//    as if it were a gesture;
//  - `base` (the anchor) is the ORIGIN of the handle vector. Handles are
//    OFFSETS relative to the anchor (two-spaces rule, see the proto on
//    `Anchor`), so the cursor-anchor delta IS already the handle: no extra
//    subtraction, and the symmetry is a simple sign change.
function pulled(
  base: AnchorLite,
  origin: PointLite,
  cursor: PointLite,
  slop: number,
  grip: PenGrip,
): AnchorLite {
  if (Math.hypot(cursor.x - origin.x, cursor.y - origin.y) < slop) return base;
  const dx = cursor.x - base.x;
  const dy = cursor.y - base.y;
  return grip === "close"
    ? { ...base, inX: dx, inY: dy }
    : { ...base, outX: dx, outY: dy, inX: -dx, inY: -dy };
}

type Placing = Extract<PenState, { name: "placing" }>;

// The anchors with the DRAGGED one updated. Which one it is is given by the grip:
// "close" pulls the first (the one about to be closed), "new" the last (the
// one just placed).
function dragged(s: Placing, cursor: PointLite, slop: number): AnchorLite[] {
  const i = s.grip === "close" ? 0 : s.anchors.length - 1;
  const next = [...s.anchors];
  next[i] = pulled(s.base, s.origin, cursor, slop, s.grip);
  return next;
}

// THE TRANSITION TABLE. Each state responds to every event; those that
// make no sense in that state (an unpaired `up`, a second pointer pressed
// while the first is dragging) return the IDENTICAL state, which is also how
// the adapter knows it does not need to rewrite anything.
export function penReduce(state: PenState, ev: PenEvent): PenStep {
  switch (state.name) {
    case "idle": {
      if (ev.kind === "down") {
        const a = corner(ev.at);
        // Here `origin` and the position of `base` COINCIDE -- the anchor is born
        // under the pointer -- but they remain two different things, and on the "close" grip
        // they diverge. Carrying both even when they coincide is what makes
        // `dragged` a single rule instead of two cases.
        return {
          state: { name: "placing", anchors: [a], grip: "new", base: a, origin: ev.at },
          effect: "none",
        };
      }
      // Escape with the hand up: there is no path to end and no node to
      // create -- and that is precisely what must happen. Same for move/up
      // (the pointer passing by) and for abort (nothing to abandon).
      return { state, effect: "none" };
    }

    case "placing": {
      switch (ev.kind) {
        case "move":
          return { state: { ...state, anchors: dragged(state, ev.at, ev.slop) }, effect: "none" };
        case "up": {
          const anchors = dragged(state, ev.at, ev.slop);
          // Release on a closure: the path is finished. `closed` only with
          // at least two anchors -- with just one there is no return
          // segment to draw, and calling it closed would be a lie in the
          // document (see vectorGeometry::subpathFills).
          return state.grip === "close"
            ? { state: PEN_IDLE, effect: "finish", path: { anchors, closed: anchors.length >= 2 } }
            : { state: { name: "drawing", anchors, cursor: ev.at }, effect: "none" };
        }
        case "commit":
          // The key arrived before the release: ends the path with the
          // anchors as they are now (state.anchors already carries the handle
          // the drag is pulling). CLOSED if the pointer is pressed
          // on the first anchor: the preview at that moment is drawing the
          // return segment, and finishing open would give a node different from
          // the one being looked at. Same threshold as the release -- with a
          // single anchor there is no return segment.
          return {
            state: PEN_IDLE,
            effect: "finish",
            path: {
              anchors: state.anchors,
              closed: state.grip === "close" && state.anchors.length >= 2,
            },
          };
        case "abort":
          return { state: PEN_IDLE, effect: "none" };
        case "down":
          // A SECOND pointer pressed while the first is dragging: the path is already
          // committed, that point is not an anchor.
          return { state, effect: "none" };
      }
    }

    case "drawing": {
      switch (ev.kind) {
        case "move":
          return { state: { ...state, cursor: ev.at }, effect: "none" };
        case "down": {
          const first = state.anchors[0];
          // Within the grab of the FIRST anchor: it is a closure. It adds
          // no anchor -- the outline goes back to the one already there -- and
          // does not end here: the release can still pull its incoming
          // handle, which is the curve of the return segment.
          if (Math.hypot(ev.at.x - first.x, ev.at.y - first.y) <= ev.grab) {
            // The ONLY case where `origin` and `base` do not coincide: the closing click
            // went down NEAR the first anchor, not exactly on
            // it. The handle will be measured from the anchor (`base`), but if there is
            // a drag the pointer (`origin`) will say so -- otherwise the
            // grab generosity alone would pass for a gesture.
            return {
              state: {
                name: "placing",
                anchors: state.anchors,
                grip: "close",
                base: first,
                origin: ev.at,
              },
              effect: "none",
            };
          }
          const a = corner(ev.at);
          return {
            state: {
              name: "placing",
              anchors: [...state.anchors, a],
              grip: "new",
              base: a,
              origin: ev.at,
            },
            effect: "none",
          };
        }
        case "commit":
          return { state: PEN_IDLE, effect: "finish", path: { anchors: state.anchors, closed: false } };
        case "abort":
          return { state: PEN_IDLE, effect: "none" };
        case "up":
          // Unpaired release (the keyboard commit arrived with the button
          // still pressed): nothing to do.
          return { state, effect: "none" };
      }
    }
  }
}

// What the OVERLAY must draw for this state. Derived, not a parallel
// state: the preview cannot diverge from the machine because it does not exist
// separately from it.
function penPreviewOf(state: PenState): PenPreview | null {
  switch (state.name) {
    case "idle":
      return null;
    case "drawing":
      return { anchors: state.anchors, next: state.cursor, active: null, closed: false };
    case "placing":
      return {
        anchors: state.anchors,
        // No pending segment: the cursor is pulling a handle.
        next: null,
        active: state.grip === "close" ? 0 : state.anchors.length - 1,
        // The pointer is pressed on the first anchor: the release (or Enter)
        // closes, so the preview ALREADY shows the return segment. It is
        // exactly what the drag is shaping, and the same
        // condition that decides `closed` in the finished path -- a single rule for
        // what you see and what you get.
        closed: state.grip === "close" && state.anchors.length >= 2,
      };
  }
}

// --- the adapter: the machine attached to the store --------------------------

export function createPenTool(): Tool {
  let state: PenState = PEN_IDLE;

  // SCREEN px -> WORLD units. It is the only point of the tool that touches the camera, and
  // it reads it from ToolContext instead of recomputing the transformation by hand.
  const slopOf = (ctx: ToolContext) => PEN_CLICK_SLOP_PX / ctx.getCamera().zoom;
  const grabOf = (ctx: ToolContext) => PEN_ANCHOR_GRAB_PX / ctx.getCamera().zoom;

  // The finished path becomes ONE node with ONE op. The node's box is the bbox of
  // its geometry and the anchors become LOCAL: it is the invariant the proto
  // declares on VectorNode, and whoever writes the subpaths is responsible for
  // maintaining it (see vectorGeometry::normalizeVector, which is also the only
  // implementation of that bbox -- a second copy of the cubic
  // math would diverge at the first edge case).
  //
  // The origin passed is (0,0) because the preview anchors are already in
  // WORLD coordinates: the node did not exist, so there was no origin to
  // measure them from.
  function finish(path: PenPath, ctx: ToolContext): void {
    const { subpaths, box } = normalizeVector({ x: 0, y: 0 }, [
      { anchors: [...path.anchors], closed: path.closed },
    ]);
    const id = uuid();
    const node = create(NodeSchema, {
      id,
      parentId: "page1",
      orderKey: nextOrderKey(ctx.getScene()),
      name: "Path",
      visible: true,
      opacity: 1,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      fills: toPbFills([PEN_FILL]),
      shape: { case: "vector", value: { subpaths: toPbSubPaths(subpaths) } },
    });
    const store = useScene.getState();
    // THE GESTURE OPENS HERE, not at the first anchor.
    //
    // The store's gesture is a SINGLE one for the whole application (store.gesture is
    // a single slot). All the other tools keep it open for as long as a
    // drag with the button pressed lasts, i.e. a window in which nothing else can
    // happen; the pen tool instead draws over several clicks, with pauses of
    // arbitrary length in between, during which the user may well use the
    // properties panel or the layers one -- which open and CLOSE their own
    // gesture (ui/PropertiesPanel.tsx::scrub/scrubEnd, ui/LayersPanel.tsx). A
    // gesture held open from the first click would be closed from under us: at
    // finish we would find the slot empty and store.ts::endGesture would fall into the
    // misuse branch ("ops sent without rebuild"), i.e. a createNode
    // submitted without rebasing on the gesture base.
    //
    // Opening and closing here still gives ONE undo entry for the whole
    // drawing (it is endGesture that pushes it, and the final ops are just one) and a
    // base recomputed at the right instant. It is the same scheme as
    // store.ts::endTextEditing.
    //
    // `if (!store.gesture)`: if someone else's gesture is open right now we
    // join it instead of opening a second one (same convention as
    // PropertiesPanel::scrub) -- opening it anyway would only print a
    // warning and use the same slot.
    if (!store.gesture) store.beginGesture();
    // The node is selected with the gesture OPEN: endGesture reconciles the selection
    // against the FINAL scene, so it can refer to an id that will exist only
    // after the op (same mechanism as textTool.ts). Selecting it is also what
    // makes its points immediately visible when anchor
    // editing arrives.
    store.setSelection([id]);
    // A single final op for the WHOLE drawing: one undo entry, one send on the
    // wire.
    store.endGesture([makeCreateNodeOp(node)]);
  }

  // One transition: computes, applies the effect, publishes the preview. It is
  // the ONLY point where `state` is reassigned.
  function step(ev: PenEvent, ctx: ToolContext): void {
    const before = state;
    const out = penReduce(state, ev);
    state = out.state;
    // Only if something changed: a hands-free pointermove returns the
    // identical state, and rewriting `null` over `null` would wake the store
    // subscribers at every pixel of the pointer.
    if (state !== before) useScene.getState().setPenPreview(penPreviewOf(state));
    switch (out.effect) {
      case "finish":
        // `path` is always there with "finish" (only penReduce produces it, and it
        // builds them together); the guard is for the type, not for a real case.
        if (out.path) finish(out.path, ctx);
        break;
      case "none":
        // Including abandoning: the path in progress lives ONLY in the preview (already
        // turned off above by the state change), not in the document. No
        // cancelGesture: there is no gesture of ours to cancel, and calling it
        // would cancel SOMEONE ELSE's -- the properties panel mid
        // scrub, for example.
        break;
    }
  }

  return {
    id: "pen",
    cursor: "crosshair",

    onPointerDown(e, ctx) {
      step({ kind: "down", at: ctx.toWorld(e), grab: grabOf(ctx) }, ctx);
    },

    onPointerMove(e, ctx) {
      step({ kind: "move", at: ctx.toWorld(e), slop: slopOf(ctx) }, ctx);
    },

    onPointerUp(e, ctx) {
      step({ kind: "up", at: ctx.toWorld(e), slop: slopOf(ctx) }, ctx);
    },

    onKeyDown(e, ctx) {
      // Enter and Escape end the OPEN path (brief and spec: they are the same
      // exit). With no anchor placed they create nothing -- the machine
      // says so on its own, without a special case here.
      if (e.key === "Enter" || e.key === "Escape") step({ kind: "commit" }, ctx);
    },

    // Abandoned gesture: tool change, pointercancel, unmount. No op.
    onDeactivate(ctx) {
      step({ kind: "abort" }, ctx);
    },

    // The TEMPORARY PAN (space held or middle button) is not a tool
    // change: the hand takes the pen tool's place for the length of a
    // drag and then gives it back. The path in progress stays where it is --
    // state and preview included, so during the pan it is still visible.
    //
    // It needs a callback of its own (toolManager calls it in place of onDeactivate
    // only for the temporary replacement) because the pen tool is the first
    // tool whose gesture lasts several clicks: for the others a mid-drag pan is
    // unreachable -- their gesture requires the button pressed -- and without
    // this distinction moving the view while drawing would throw away
    // every placed anchor, without warning and with nothing to undo to
    // recover them.
    onSuspend() {
      // Deliberately empty: suspending means doing NOTHING. The symmetric one
      // (resuming) does not exist for the same reason -- there is nothing to
      // rebuild, the tool receives the next event as it was left.
    },
  };
}

export const penTool = createPenTool();
