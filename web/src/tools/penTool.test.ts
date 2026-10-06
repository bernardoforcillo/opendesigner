import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createPenTool,
  penReduce,
  PEN_IDLE,
  PEN_CLICK_SLOP_PX,
  PEN_FILL,
  type PenState,
} from "./penTool";
import type { ToolContext } from "./types";
import type { Node as PbNode, Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { AnchorLite } from "../store/types";

// --- doubles ----------------------------------------------------------------

// Double of SyncClient (as in rectTool.test.ts): records the ops that end up
// ON THE WIRE and models a server that accepts and echoes immediately.
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

// toWorld is the identity on clientX/clientY: the tests reason directly in
// world coordinates (the real conversion is tested in canvas/camera.test.ts).
function fakeCtx(zoom = 1) {
  const sync = new FakeSync();
  useScene.getState().setSync(sync);
  const ctx = {
    sync,
    getScene: () => useScene.getState().scene,
    getCamera: () => ({ ...useScene.getState().camera, zoom }),
    setCamera: vi.fn(),
    canvas: {} as HTMLCanvasElement,
    toWorld: (e: PointerEvent) => ({ x: e.clientX, y: e.clientY }),
  } as unknown as ToolContext;
  return { ctx, submitted: sync.sent };
}

const at = (x: number, y: number) => ({ clientX: x, clientY: y }) as PointerEvent;
const key = (k: string) => ({ key: k }) as KeyboardEvent;

function createdNode(op: Op): PbNode {
  if (op.kind.case !== "createNode") throw new Error(`expected createNode, got ${op.kind.case}`);
  const n = op.kind.value.node;
  if (!n) throw new Error("createNode without node");
  return n;
}

// The outline inside the creation op. Fails loudly (does not return undefined)
// if the shape is not a vector: a pen tool that creates a rectangle must break
// the test that talks about its geometry, not pass it silently.
function createdSubpath(op: Op) {
  const shape = createdNode(op).shape;
  if (shape.case !== "vector") throw new Error(`expected a vector shape, got ${shape.case}`);
  const sp = shape.value.subpaths[0];
  if (!sp) throw new Error("vector node without subpaths");
  return sp;
}

const corner = (x: number, y: number): AnchorLite => ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0 });

// The anchors of a state that has them (placing/drawing). Kept here and not in the
// module: the tests must be able to look INSIDE the state without the tool exposing
// a shortcut that nobody else uses.
function anchorsOf(s: PenState): readonly AnchorLite[] {
  if (s.name === "idle") throw new Error("the idle state has no anchors");
  return s.anchors;
}

beforeEach(() => {
  useScene.setState({
    camera: { x: 0, y: 0, zoom: 1 },
    selection: [],
    marquee: null,
    penPreview: null,
    sync: null,
    gesture: null,
    undoStack: [],
    redoStack: [],
    canUndo: false,
    canRedo: false,
  });
  useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
});

// ============================================================================
// THE STATE MACHINE, on its own: pure function, no store, no DOM.
// ============================================================================

describe("penReduce: the state machine", () => {
  it("idle + down places the FIRST anchor, and asks NOTHING of the caller", () => {
    const step = penReduce(PEN_IDLE, { kind: "down", at: { x: 10, y: 20 }, grab: 6 });
    expect(step.state.name).toBe("placing");
    expect(anchorsOf(step.state)).toEqual([corner(10, 20)]);
    // No effect: the path in progress lives only in the preview, and the store's
    // gesture slot stays free for anyone else until the drawing
    // ends (see the test "does not occupy the gesture slot" below).
    expect(step.effect).toBe("none");
    expect(step.path).toBeUndefined();
  });

  it("a drag beyond the threshold pulls the SYMMETRIC handles of the just-placed anchor", () => {
    const down = penReduce(PEN_IDLE, { kind: "down", at: { x: 10, y: 10 }, grab: 6 });
    const move = penReduce(down.state, { kind: "move", at: { x: 30, y: 40 }, slop: 3 });
    // Outgoing TOWARDS the cursor, incoming mirrored: it is the standard
    // smooth anchor, the one that makes the tangent continuous at that point.
    expect(anchorsOf(move.state)).toEqual([
      { x: 10, y: 10, outX: 20, outY: 30, inX: -20, inY: -30 },
    ]);
    expect(move.effect).toBe("none");
  });

  it("a jitter BELOW the threshold leaves the CORNER anchor (no handle)", () => {
    const down = penReduce(PEN_IDLE, { kind: "down", at: { x: 10, y: 10 }, grab: 6 });
    const move = penReduce(down.state, { kind: "move", at: { x: 11, y: 11 }, slop: 3 });
    expect(anchorsOf(move.state)).toEqual([corner(10, 10)]);
  });

  it("the release ends the placing and goes to drawing, with the cursor at the release point", () => {
    const down = penReduce(PEN_IDLE, { kind: "down", at: { x: 10, y: 10 }, grab: 6 });
    const up = penReduce(down.state, { kind: "up", at: { x: 10, y: 10 }, slop: 3 });
    expect(up.state.name).toBe("drawing");
    if (up.state.name !== "drawing") throw new Error("unreachable");
    expect(up.state.cursor).toEqual({ x: 10, y: 10 });
    expect(up.effect).toBe("none"); // no op: the gesture is still open
  });

  it("a down FAR from the first anchor adds another at the end", () => {
    let s = penReduce(PEN_IDLE, { kind: "down", at: { x: 0, y: 0 }, grab: 6 }).state;
    s = penReduce(s, { kind: "up", at: { x: 0, y: 0 }, slop: 3 }).state;
    const step = penReduce(s, { kind: "down", at: { x: 100, y: 0 }, grab: 6 });
    expect(step.state.name).toBe("placing");
    expect(anchorsOf(step.state)).toEqual([corner(0, 0), corner(100, 0)]);
    expect(step.effect).toBe("none");
  });

  it("a down ON the first anchor (within the grab) closes the outline on release", () => {
    const s = drawn([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
    const down = penReduce(s, { kind: "down", at: { x: 2, y: 1 }, grab: 6 });
    expect(down.state.name).toBe("placing");
    if (down.state.name !== "placing") throw new Error("unreachable");
    expect(down.state.grip).toBe("close");
    // TWO points, two jobs. `base` is the ANCHOR: it is from there that the
    // handle is measured, because a handle is an offset from the anchor. `origin` is the
    // pixel actually CLICKED: it is from there that we measure whether the pointer
    // moved, i.e. whether there is a drag. Confusing them makes the grab's generosity
    // count as if it were a gesture (see the test on the 3-6px ring).
    expect(down.state.base).toEqual(corner(0, 0));
    expect(down.state.origin).toEqual({ x: 2, y: 1 });
    // No extra anchor: closing does not add one on top of the first.
    expect(anchorsOf(down.state)).toHaveLength(3);

    const up = penReduce(down.state, { kind: "up", at: { x: 2, y: 1 }, slop: 3 });
    expect(up.effect).toBe("finish");
    expect(up.path?.closed).toBe(true);
    expect(up.path?.anchors).toHaveLength(3);
    expect(up.state).toBe(PEN_IDLE);
  });

  // THE 3-6px RING. The grab that closes the outline is 6px SCREEN
  // (PEN_ANCHOR_GRAB_PX) while the click/drag threshold is 3
  // (PEN_CLICK_SLOP_PX): exactly double. There is therefore a ring around
  // the first anchor in which a click CLOSES and is already beyond the threshold if the
  // threshold is measured from the ANCHOR. In there a still click -- a pointer
  // that does not move a pixel -- would become a drag that never happened, and the
  // return segment would be born curved. That ring is precisely where the
  // generous grab INVITES clicking, so it is not an edge case: it is the
  // normal case of whoever misses the little square.
  it("a STILL click in the 3-6px ring of the grab gives NO handle", () => {
    const s = drawn([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
    // 5 world units from the first anchor: inside the grab (6), beyond the threshold
    // (3). The pointer, however, does not move: down and up at the same point.
    const down = penReduce(s, { kind: "down", at: { x: 5, y: 0 }, grab: 6 });
    const up = penReduce(down.state, { kind: "up", at: { x: 5, y: 0 }, slop: 3 });

    expect(up.effect).toBe("finish");
    expect(up.path?.closed).toBe(true);
    // The first anchor is still a CORNER: no incoming handle invented.
    expect(up.path?.anchors[0]).toEqual(corner(0, 0));
  });

  // WYSIWYG: the preview at pointerdown draws the return segment STRAIGHT
  // (penPreviewOf does not touch the anchors). If the commit curved it, the created
  // node would differ from the one being looked at -- the worst
  // of surprises in a drawing tool.
  it("in the ring, what you see at pointerdown is what you get at release", () => {
    const s = drawn([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
    const down = penReduce(s, { kind: "down", at: { x: 4, y: 3 }, grab: 6 }); // dist 5
    const shown = anchorsOf(down.state);
    const up = penReduce(down.state, { kind: "up", at: { x: 4, y: 3 }, slop: 3 });
    expect(up.path?.anchors).toEqual(shown);
  });

  it("but a REAL drag started in the ring pulls the handle, measured from the ANCHOR", () => {
    const s = drawn([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
    const down = penReduce(s, { kind: "down", at: { x: 5, y: 0 }, grab: 6 });
    // The pointer really moves (40 units from the down point): now it is a
    // drag, and the handle is the cursor-ANCHOR delta -- not
    // cursor-down point, because a handle is an offset from the anchor.
    const move = penReduce(down.state, { kind: "move", at: { x: 5, y: 40 }, slop: 3 });
    expect(anchorsOf(move.state)[0]).toEqual({ x: 0, y: 0, inX: 5, inY: 40, outX: 0, outY: 0 });
  });

  it("a drag that RE-ENTERS the threshold returns to the corner (no hysteresis)", () => {
    const s = drawn([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
    const down = penReduce(s, { kind: "down", at: { x: 5, y: 0 }, grab: 6 });
    let m = penReduce(down.state, { kind: "move", at: { x: 5, y: 40 }, slop: 3 }).state;
    m = penReduce(m, { kind: "move", at: { x: 6, y: 1 }, slop: 3 }).state; // within 3 of the down again
    expect(anchorsOf(m)[0]).toEqual(corner(0, 0));
  });

  it("dragging on the first anchor pulls its INCOMING handle and leaves the outgoing one alone", () => {
    // The first anchor is born SMOOTH (placed with a drag): its
    // outgoing already draws the first segment and must not be deformed backwards by
    // a CLOSING drag, which concerns the return segment.
    let s = penReduce(PEN_IDLE, { kind: "down", at: { x: 0, y: 0 }, grab: 6 }).state;
    s = penReduce(s, { kind: "move", at: { x: 0, y: -50 }, slop: 3 }).state;
    s = penReduce(s, { kind: "up", at: { x: 0, y: -50 }, slop: 3 }).state;
    s = penReduce(s, { kind: "down", at: { x: 100, y: 0 }, grab: 6 }).state;
    s = penReduce(s, { kind: "up", at: { x: 100, y: 0 }, slop: 3 }).state;

    const down = penReduce(s, { kind: "down", at: { x: 0, y: 0 }, grab: 6 });
    const move = penReduce(down.state, { kind: "move", at: { x: 0, y: 40 }, slop: 3 });
    expect(anchorsOf(move.state)[0]).toEqual({ x: 0, y: 0, inX: 0, inY: 40, outX: 0, outY: -50 });
  });

  it("Enter with the pointer pressed on the first anchor ends CLOSED, as the preview shows", () => {
    // The keyboard commit arrives before the release. The preview at that
    // moment is already drawing the return segment (grip "close"):
    // ending OPEN would give a node different from the one in front of you.
    const s = drawn([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
    const down = penReduce(s, { kind: "down", at: { x: 0, y: 0 }, grab: 6 });
    const move = penReduce(down.state, { kind: "move", at: { x: -40, y: 20 }, slop: 3 });
    const step = penReduce(move.state, { kind: "commit" });
    expect(step.effect).toBe("finish");
    expect(step.path?.closed).toBe(true);
    // And with the closing handle pulled up to there: the commit's anchors
    // are those of the state, which the drag has already updated.
    expect(step.path?.anchors[0]).toEqual({ x: 0, y: 0, inX: -40, inY: 20, outX: 0, outY: 0 });
  });

  it("a closing commit with a SINGLE anchor stays OPEN", () => {
    const s = drawn([{ x: 0, y: 0 }]);
    const down = penReduce(s, { kind: "down", at: { x: 0, y: 0 }, grab: 6 });
    const step = penReduce(down.state, { kind: "commit" });
    expect(step.path?.closed).toBe(false);
  });

  it("with a SINGLE anchor there is nothing to close: the path ends OPEN", () => {
    const s = drawn([{ x: 0, y: 0 }]);
    const down = penReduce(s, { kind: "down", at: { x: 0, y: 0 }, grab: 6 });
    const up = penReduce(down.state, { kind: "up", at: { x: 0, y: 0 }, slop: 3 });
    expect(up.effect).toBe("finish");
    // `closed` with a single anchor would be a lie: there is no
    // return segment to draw.
    expect(up.path?.closed).toBe(false);
    expect(up.path?.anchors).toHaveLength(1);
  });

  it("Enter/Escape (commit) end the path OPEN with what is there", () => {
    const s = drawn([{ x: 0, y: 0 }, { x: 50, y: 50 }]);
    const step = penReduce(s, { kind: "commit" });
    expect(step.effect).toBe("finish");
    expect(step.path).toEqual({ anchors: [corner(0, 0), corner(50, 50)], closed: false });
    expect(step.state).toBe(PEN_IDLE);
  });

  it("commit with the HAND UP (no anchor) creates nothing and touches no gesture", () => {
    const step = penReduce(PEN_IDLE, { kind: "commit" });
    expect(step.effect).toBe("none");
    expect(step.path).toBeUndefined();
    expect(step.state).toBe(PEN_IDLE);
  });

  it("abort abandons the path in progress without asking for any op", () => {
    const s = drawn([{ x: 0, y: 0 }, { x: 50, y: 0 }]);
    const step = penReduce(s, { kind: "abort" });
    // Nothing to undo in the store: the path never entered the
    // document, and a cancelGesture here would cancel SOMEONE ELSE's gesture.
    expect(step.effect).toBe("none");
    expect(step.path).toBeUndefined();
    expect(step.state).toBe(PEN_IDLE);
  });

  it("abort from idle has nothing to cancel", () => {
    const step = penReduce(PEN_IDLE, { kind: "abort" });
    expect(step.effect).toBe("none");
    expect(step.state).toBe(PEN_IDLE);
  });

  it("an idle movement (idle) produces no new state", () => {
    const step = penReduce(PEN_IDLE, { kind: "move", at: { x: 5, y: 5 }, slop: 3 });
    // SAME reference: it is what lets the tool avoid rewriting
    // the preview in the store on every pointermove outside drawing.
    expect(step.state).toBe(PEN_IDLE);
    expect(step.effect).toBe("none");
  });

  it("a SECOND pointer pressed during placing does not enter the path", () => {
    const down = penReduce(PEN_IDLE, { kind: "down", at: { x: 0, y: 0 }, grab: 6 });
    const second = penReduce(down.state, { kind: "down", at: { x: 500, y: 500 }, grab: 6 });
    expect(second.state).toBe(down.state);
    expect(second.effect).toBe("none");
  });

  // A "drawing" state with the given anchors, built by going through
  // EVENTS and not by hand: if the transitions change, these helpers change along
  // with them instead of describing a machine that no longer exists.
  function drawn(points: { x: number; y: number }[]): PenState {
    let s = PEN_IDLE;
    for (const p of points) {
      s = penReduce(s, { kind: "down", at: p, grab: 6 }).state;
      s = penReduce(s, { kind: "up", at: p, slop: 3 }).state;
    }
    return s;
  }
});

// ============================================================================
// THE TOOL: the machine attached to the store (ops, gesture, preview, selection).
// ============================================================================

describe("penTool", () => {
  it("three clicks and Enter: ONE SINGLE op on the wire, a vector createNode with three anchors", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();

    for (const [x, y] of [[0, 0], [100, 0], [100, 100]]) {
      tool.onPointerDown!(at(x, y), ctx);
      tool.onPointerUp!(at(x, y), ctx);
    }
    expect(submitted).toHaveLength(0); // no op PER ANCHOR

    tool.onKeyDown!(key("Enter"), ctx);

    expect(submitted).toHaveLength(1);
    const sp = createdSubpath(submitted[0]);
    expect(sp.anchors).toHaveLength(3);
    expect(sp.closed).toBe(false);
  });

  it("is a SINGLE undo entry, and undoing it removes the whole path", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();

    for (const [x, y] of [[0, 0], [100, 0], [100, 100]]) {
      tool.onPointerDown!(at(x, y), ctx);
      tool.onPointerUp!(at(x, y), ctx);
    }
    tool.onKeyDown!(key("Escape"), ctx);

    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().canUndo).toBe(true);
    const id = createdNode(submitted[0]).id;
    expect(useScene.getState().scene!.nodes.at(id)).toBeDefined();

    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at(id)).toBeUndefined();
  });

  // The gesture slot (store.gesture) is a SINGLE one for the whole application.
  // Keeping it occupied between one click and the next -- a window as long as
  // the user wants -- means the first panel that opens its own gesture
  // takes it and CLOSES it from under us (PropertiesPanel::scrubEnd,
  // LayersPanel), and the final createNode would end up in the misuse branch of
  // endGesture: submitted without rebasing on the gesture base.
  it("does NOT occupy the gesture slot between one click and the next", () => {
    const tool = createPenTool();
    const { ctx } = fakeCtx();

    expect(useScene.getState().gesture).toBeNull();
    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    expect(useScene.getState().gesture).toBeNull();
    tool.onPointerDown!(at(50, 0), ctx);
    tool.onPointerUp!(at(50, 0), ctx);
    expect(useScene.getState().gesture).toBeNull();

    tool.onKeyDown!(key("Enter"), ctx);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("SOMEONE ELSE's gesture mid-drawing does not break the creation (nor close it halfway)", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    tool.onPointerDown!(at(100, 0), ctx);
    tool.onPointerUp!(at(100, 0), ctx);

    // The properties panel mid-drawing: the previous selection is still
    // alive (the pen tool does not empty it), so scrub/scrubEnd are
    // perfectly reachable. It opens and closes ITS gesture.
    useScene.getState().beginGesture();
    useScene.getState().endGesture([]);

    tool.onKeyDown!(key("Enter"), ctx);

    // No misuse warning: the pen tool's gesture opens at finish, and at
    // that point the slot is free.
    expect(warn).not.toHaveBeenCalled();
    expect(submitted).toHaveLength(1);
    expect(createdSubpath(submitted[0]).anchors).toHaveLength(2);
    expect(useScene.getState().gesture).toBeNull();
    expect(useScene.getState().undoStack).toHaveLength(1);
    warn.mockRestore();
  });

  it("abandoning the path does not cancel SOMEONE ELSE's gesture", () => {
    const tool = createPenTool();
    const { ctx } = fakeCtx();

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    // Someone else's open gesture (a panel mid-scrub) while the pen tool
    // is deactivated: cancelGesture here would rewind THEIR work.
    useScene.getState().beginGesture();
    tool.onDeactivate!(ctx);

    expect(useScene.getState().gesture).not.toBeNull();
    expect(useScene.getState().penPreview).toBeNull();
  });

  it("Ctrl+Z mid-path does nothing: the drawing in progress is not yet document", () => {
    const tool = createPenTool();
    const { ctx } = fakeCtx();

    // An already concluded gesture to undo (a path finished before this one).
    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    tool.onKeyDown!(key("Enter"), ctx);
    expect(useScene.getState().undoStack).toHaveLength(1);

    // Now a NEW path in progress: undo is deferred, otherwise it
    // would undo something different from what the user is looking at.
    tool.onPointerDown!(at(200, 200), ctx);
    tool.onPointerUp!(at(200, 200), ctx);
    useScene.getState().undo();
    expect(useScene.getState().undoStack).toHaveLength(1);

    // Once the path is finished, undo works again.
    tool.onKeyDown!(key("Enter"), ctx);
    useScene.getState().undo();
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().redoStack).toHaveLength(1);
  });

  it("click-and-DRAG places a smooth anchor with symmetric handles", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerMove!(at(0, 40), ctx);
    tool.onPointerUp!(at(0, 40), ctx);
    tool.onPointerDown!(at(100, 0), ctx);
    tool.onPointerUp!(at(100, 0), ctx);
    tool.onKeyDown!(key("Enter"), ctx);

    const sp = createdSubpath(submitted[0]);
    // Handles are OFFSETS relative to the anchor (two-spaces rule):
    // the translation in local coordinates does not touch them.
    expect(sp.anchors[0].outY).toBe(40);
    expect(sp.anchors[0].inY).toBe(-40);
    expect(sp.anchors[1].outX).toBe(0);
    expect(sp.anchors[1].inX).toBe(0);
  });

  it("the click on the FIRST anchor closes the outline and finishes, without needing Enter", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();

    for (const [x, y] of [[0, 0], [100, 0], [100, 100]]) {
      tool.onPointerDown!(at(x, y), ctx);
      tool.onPointerUp!(at(x, y), ctx);
    }
    tool.onPointerDown!(at(1, 1), ctx); // on the first anchor
    tool.onPointerUp!(at(1, 1), ctx);

    expect(submitted).toHaveLength(1);
    const sp = createdSubpath(submitted[0]);
    expect(sp.closed).toBe(true);
    expect(sp.anchors).toHaveLength(3); // the closing click does not add one
  });

  // The 3-6px ring seen from the tool: the grab (6px) is DOUBLE the threshold
  // (3px), so a click that closes without hitting the little square lands
  // regularly where the threshold, measured wrongly, would read it as a
  // drag.
  it("an off-center (but still) closing click does NOT curve the return segment", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();

    for (const [x, y] of [[0, 0], [100, 0], [100, 100]]) {
      tool.onPointerDown!(at(x, y), ctx);
      tool.onPointerUp!(at(x, y), ctx);
    }
    // 5px from the first anchor: inside the grab (6), beyond the threshold (3).
    tool.onPointerDown!(at(5, 0), ctx);
    // The preview at this instant shows the return STRAIGHT: the anchor has not
    // been touched. It is the pact the commit must honor.
    expect(useScene.getState().penPreview!.anchors[0]).toEqual(corner(0, 0));
    tool.onPointerUp!(at(5, 0), ctx);

    const sp = createdSubpath(submitted[0]);
    expect(sp.closed).toBe(true);
    expect({ inX: sp.anchors[0].inX, inY: sp.anchors[0].inY }).toEqual({ inX: 0, inY: 0 });
  });

  // The error was not just "one extra handle": it was a handle in WORLD
  // units. The grab is 6px SCREEN, so at zoom 0.25 that is 24 world units of
  // curvature baked into the document, which going back to zoom 4 become a
  // ~96px bulge. The same click at zoom 1 would have left 6: the
  // severity of the bug depended on zoom, which is the worst way for a
  // document to be wrong.
  it("and at zoom 0.25 it does not bake 20 WORLD units of curvature into the document", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx(0.25);

    for (const [x, y] of [[0, 0], [100, 0], [100, 100]]) {
      tool.onPointerDown!(at(x, y), ctx);
      tool.onPointerUp!(at(x, y), ctx);
    }
    // grab = 6/0.25 = 24 world units, threshold = 3/0.25 = 12. A still click at
    // 20 units from the first anchor closes and is inside the ring.
    tool.onPointerDown!(at(20, 0), ctx);
    tool.onPointerUp!(at(20, 0), ctx);

    const sp = createdSubpath(submitted[0]);
    expect(sp.closed).toBe(true);
    expect({ inX: sp.anchors[0].inX, inY: sp.anchors[0].inY }).toEqual({ inX: 0, inY: 0 });
  });

  it("the closing grab is in SCREEN px: at zoom 4 the same click on empty space does NOT close", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx(4);

    for (const [x, y] of [[0, 0], [100, 0]]) {
      tool.onPointerDown!(at(x, y), ctx);
      tool.onPointerUp!(at(x, y), ctx);
    }
    // 3 world units = 12 screen px at zoom 4: outside the grab, so it is a
    // new anchor. At zoom 1 it would have been 3 px, i.e. a closure.
    tool.onPointerDown!(at(3, 0), ctx);
    tool.onPointerUp!(at(3, 0), ctx);
    expect(submitted).toHaveLength(0);
    tool.onKeyDown!(key("Enter"), ctx);
    const sp = createdSubpath(submitted[0]);
    expect(sp.closed).toBe(false);
    expect(sp.anchors).toHaveLength(3);
  });

  it("Escape with the hand up creates no node and leaves no open gestures", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();

    tool.onKeyDown!(key("Escape"), ctx);

    expect(submitted).toHaveLength(0);
    expect([...useScene.getState().scene!.nodes.ids()]).toHaveLength(0);
    expect(useScene.getState().gesture).toBeNull();
    expect(useScene.getState().penPreview).toBeNull();
  });

  it("the node box IS the geometry's bbox, and the anchors are LOCAL starting from (0,0)", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();

    for (const [x, y] of [[10, 10], [110, 10], [110, 60]]) {
      tool.onPointerDown!(at(x, y), ctx);
      tool.onPointerUp!(at(x, y), ctx);
    }
    tool.onKeyDown!(key("Enter"), ctx);

    const n = createdNode(submitted[0]);
    expect({ x: n.x, y: n.y, width: n.width, height: n.height })
      .toEqual({ x: 10, y: 10, width: 100, height: 50 });
    const sp = createdSubpath(submitted[0]);
    expect(sp.anchors.map((a) => ({ x: a.x, y: a.y })))
      .toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }]);
  });

  it("the newly created node stays selected", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    tool.onPointerDown!(at(50, 0), ctx);
    tool.onPointerUp!(at(50, 0), ctx);
    tool.onKeyDown!(key("Enter"), ctx);

    expect(useScene.getState().selection).toEqual([createdNode(submitted[0]).id]);
  });

  it("publishes the preview on the overlay: the placed path PLUS the segment following the cursor", () => {
    const tool = createPenTool();
    const { ctx } = fakeCtx();

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    tool.onPointerMove!(at(60, 20), ctx);

    const p = useScene.getState().penPreview;
    expect(p).not.toBeNull();
    expect(p!.anchors).toEqual([corner(0, 0)]);
    // The segment that would follow the cursor: it is the only piece of the preview that
    // is not yet geometry.
    expect(p!.next).toEqual({ x: 60, y: 20 });
    expect(p!.active).toBeNull();
  });

  it("during the drag the preview shows the HANDLES, not the pending segment", () => {
    const tool = createPenTool();
    const { ctx } = fakeCtx();

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerMove!(at(0, 40), ctx);

    const p = useScene.getState().penPreview;
    // The cursor is defining a handle, not a new point: drawing
    // the pending segment too would say something false.
    expect(p!.next).toBeNull();
    expect(p!.active).toBe(0);
    expect(p!.anchors[0].outY).toBe(40);
  });

  // The RETURN segment (last -> first) is the one the closing drag
  // is shaping: it pulls the incoming handle of the first anchor,
  // which is its second control point. Without telling the preview you
  // would only see a little stick and a dot, and the curve would appear only once the
  // node is created -- the worst of surprises in a drawing tool.
  it("pressing on the first anchor the preview CLOSES: the return segment is visible", () => {
    const tool = createPenTool();
    const { ctx } = fakeCtx();

    for (const [x, y] of [[0, 0], [100, 0], [100, 100]]) {
      tool.onPointerDown!(at(x, y), ctx);
      tool.onPointerUp!(at(x, y), ctx);
    }
    expect(useScene.getState().penPreview!.closed).toBe(false);

    tool.onPointerDown!(at(1, 1), ctx); // on the first anchor
    expect(useScene.getState().penPreview!.closed).toBe(true);

    // And the drag shapes precisely that segment's handle.
    tool.onPointerMove!(at(-30, 20), ctx);
    const p = useScene.getState().penPreview!;
    expect(p.closed).toBe(true);
    expect(p.active).toBe(0);
    expect(p.anchors[0]).toEqual({ x: 0, y: 0, inX: -30, inY: 20, outX: 0, outY: 0 });
  });

  it("with a single anchor the preview does not declare itself closed (there is no return)", () => {
    const tool = createPenTool();
    const { ctx } = fakeCtx();

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    tool.onPointerDown!(at(0, 0), ctx); // on the first again: closing nothing
    expect(useScene.getState().penPreview!.closed).toBe(false);
  });

  it("the preview disappears when the path is finished", () => {
    const tool = createPenTool();
    const { ctx } = fakeCtx();

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    expect(useScene.getState().penPreview).not.toBeNull();

    tool.onKeyDown!(key("Enter"), ctx);
    expect(useScene.getState().penPreview).toBeNull();
  });

  it("onDeactivate abandons the path: no op, no hanging gesture, no preview", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    tool.onPointerDown!(at(50, 0), ctx);
    tool.onPointerUp!(at(50, 0), ctx);
    tool.onDeactivate!(ctx);

    expect(submitted).toHaveLength(0);
    expect([...useScene.getState().scene!.nodes.ids()]).toHaveLength(0);
    expect(useScene.getState().gesture).toBeNull();
    expect(useScene.getState().penPreview).toBeNull();
  });

  // Moving the view while drawing is routine in any vector
  // editor, and with a gesture lasting several clicks it is even unavoidable: the
  // next point may be off screen. The temporary pan (space or middle
  // button) is not a tool change and must not cost the path.
  it("onSuspend (temporary pan) does NOT throw away the path: it resumes from where it was", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    tool.onPointerDown!(at(100, 0), ctx);
    tool.onPointerUp!(at(100, 0), ctx);

    tool.onSuspend!(ctx);
    // The preview stays on: during the pan the drawing is still visible.
    expect(useScene.getState().penPreview!.anchors).toHaveLength(2);

    // Resumed: the next click adds the THIRD anchor, not the first.
    tool.onPointerDown!(at(100, 100), ctx);
    tool.onPointerUp!(at(100, 100), ctx);
    tool.onKeyDown!(key("Enter"), ctx);

    expect(submitted).toHaveLength(1);
    expect(createdSubpath(submitted[0]).anchors).toHaveLength(3);
  });

  it("after an abandon the tool restarts clean (no ghost anchor in the next path)", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx();

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);
    tool.onDeactivate!(ctx);

    tool.onPointerDown!(at(200, 200), ctx);
    tool.onPointerUp!(at(200, 200), ctx);
    tool.onKeyDown!(key("Enter"), ctx);

    expect(submitted).toHaveLength(1);
    expect(createdSubpath(submitted[0]).anchors).toHaveLength(1);
  });

  it("the click/drag threshold is in SCREEN px: at zoom 10 two world units ARE a drag", () => {
    const tool = createPenTool();
    const { ctx, submitted } = fakeCtx(10);

    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerMove!(at(0, 2), ctx); // 20 screen px: beyond the threshold
    tool.onPointerUp!(at(0, 2), ctx);
    tool.onKeyDown!(key("Enter"), ctx);

    expect(createdSubpath(submitted[0]).anchors[0].outY).toBe(2);
    expect(PEN_CLICK_SLOP_PX).toBe(3);
  });

  it("is born with a tint of its own, not the gray of shapes", () => {
    // An OPEN outline exists on screen only as a 1.5px stroke
    // (renderer/shapes.ts): the gray meant for a solid area would make it
    // almost invisible.
    expect(PEN_FILL.a).toBe(1);
    expect(PEN_FILL.r).toBeLessThan(0.5);
  });

  it("declares the id and the cursor with which the toolbar registers it", () => {
    const tool = createPenTool();
    expect(tool.id).toBe("pen");
    expect(tool.cursor).toBe("crosshair");
  });
});
