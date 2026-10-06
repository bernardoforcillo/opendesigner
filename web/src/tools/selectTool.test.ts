import { nodesOf } from "../store/nodeMap";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSelectTool, pickTarget, nodesInMarquee } from "./selectTool";
import type { ToolContext } from "./types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { worldBoundsOfNode } from "../canvas/transform";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";
import { worldAabbOfNode } from "../canvas/geometry";
import { selectionFrame } from "../renderer/overlayRenderer";
import { vectorBounds } from "../store/vectorGeometry";

function node(id: string, x: number, orderKey: string, extra: Partial<NodeLite> = {}): NodeLite {
  return { id, parentId: "page1", orderKey, name: id, visible: true, opacity: 1,
    x, y: 0, width: 50, height: 50, rotation: 0, fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...extra };
}

// A 50x50 vector node whose geometry FILLS the box, as the proto invariant
// requires: local bbox (0,0)-(50,50). The bezier handles are
// asymmetric and nonzero, so a scale forgotten on them cannot
// land on the right value by chance.
function curvyVector(): NodeLite {
  return node("v", 0, "a000000", {
    kind: "vector",
    vector: { subpaths: [{
      anchors: [
        { x: 0, y: 0, inX: 0, inY: 0, outX: 20, outY: 0 },
        { x: 50, y: 50, inX: 0, inY: -20, outX: 0, outY: 0 },
      ],
      closed: false,
    }] },
  });
}

function fakeCtx(): ToolContext {
  return {
    sync: { submit: vi.fn() },
    getScene: () => useScene.getState().scene,
    getCamera: () => useScene.getState().camera,
    setCamera: vi.fn(),
    // style.cursor: the tool writes the cursor of the handle under the
    // pointer there (Task 9, step 4); in tests it is any object.
    canvas: { style: { cursor: "" } } as unknown as HTMLCanvasElement,
    toWorld: (e: PointerEvent) => ({ x: e.clientX, y: e.clientY }),
  } as unknown as ToolContext;
}

const at = (x: number, y: number, shiftKey = false) => ({ clientX: x, clientY: y, shiftKey }) as PointerEvent;

// Like `at`, but with an explicit timeStamp: it is only needed for the double click
// (detected by ID + e.timeStamp, see selectTool.ts), and keeping it out of `at`
// avoids having to assign a timeStamp to ALL the other tests in this file.
const atT = (x: number, y: number, timeStamp: number, shiftKey = false) =>
  ({ clientX: x, clientY: y, shiftKey, timeStamp }) as PointerEvent;

// Double of SyncClient (see rpc/syncClient.ts): records the ops that end up
// ON THE WIRE and models a server that accepts and ECHOES immediately -- applyPending (op
// in flight, visible immediately) followed by apply (the echo that confirms it). Without
// the echo every op would stay queued forever and the tests would speak of a
// state the server never saw. The store depends only on the surface
// { submit }, so a real SyncClient is not needed (no network in tests).
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

// Like `at`, but with the modifiers that matter for SNAP: Alt turns it off
// for that gesture, Shift is already the resize aspect ratio.
const atMod = (x: number, y: number, mod: { altKey?: boolean; shiftKey?: boolean }) =>
  ({ clientX: x, clientY: y, shiftKey: false, ...mod }) as PointerEvent;

beforeEach(() => {
  useScene.setState({
    camera: { x: 0, y: 0, zoom: 1 },
    selection: [],
    marquee: null,
    snapGuides: [],
    gesture: null,
    sync: null,
  });
  // setScene and not setState({scene}): installs a COHERENT scene (view and
  // confirmed aligned, empty queue) -- the invariant that the
  // confirmed/pending reconciliation relies on (see store/store.ts).
  useScene.getState().setScene({
    ...emptyScene("doc-1", "u"),
    nodes: nodesOf({ a: node("a", 0, "a000000"), b: node("b", 100, "a000001") }),
  });
});

describe("selectTool", () => {
  it("selects the node under the pointer", () => {
    createSelectTool().onPointerDown!(at(120, 10), fakeCtx());
    expect(useScene.getState().selection).toEqual(["b"]);
  });

  it("shift-click toggles, plain click replaces", () => {
    const tool = createSelectTool();
    const ctx = fakeCtx();
    tool.onPointerDown!(at(10, 10), ctx);
    tool.onPointerDown!(at(120, 10, true), ctx);
    expect(useScene.getState().selection).toEqual(["a", "b"]);

    tool.onPointerDown!(at(120, 10, true), ctx);
    expect(useScene.getState().selection).toEqual(["a"]);

    tool.onPointerDown!(at(120, 10), ctx);
    expect(useScene.getState().selection).toEqual(["b"]);
  });

  it("clicking empty space clears, shift-clicking it keeps the selection", () => {
    const tool = createSelectTool();
    const ctx = fakeCtx();
    tool.onPointerDown!(at(10, 10), ctx);

    tool.onPointerDown!(at(900, 900, true), ctx);
    expect(useScene.getState().selection).toEqual(["a"]);

    tool.onPointerDown!(at(900, 900), ctx);
    expect(useScene.getState().selection).toEqual([]);
  });

  // --- pure logic: pickTarget ----------------------------------------------

  describe("pickTarget", () => {
    it("picks the topmost node when two overlap", () => {
      const scene = { ...emptyScene("doc-1", "u"), nodes: nodesOf({
        under: node("under", 0, "a000000"),
        over: node("over", 0, "a000001"), // higher orderKey = drawn on top
      }) };
      expect(pickTarget(scene, { x: 10, y: 10 }, false, [], 1)).toEqual({ mode: "single", id: "over" });
    });

    it("plain click on an unselected node returns single with its id", () => {
      const scene = useScene.getState().scene!;
      expect(pickTarget(scene, { x: 120, y: 10 }, false, [], 1)).toEqual({ mode: "single", id: "b" });
    });

    it("plain click on an already-selected node returns single WITHOUT an id (keeps the current selection for a group drag)", () => {
      const scene = useScene.getState().scene!;
      expect(pickTarget(scene, { x: 120, y: 10 }, false, ["b"], 1)).toEqual({ mode: "single" });
    });

    it("shift-click always returns toggle with the id, selected or not", () => {
      const scene = useScene.getState().scene!;
      expect(pickTarget(scene, { x: 120, y: 10 }, true, [], 1)).toEqual({ mode: "toggle", id: "b" });
      expect(pickTarget(scene, { x: 120, y: 10 }, true, ["b"], 1)).toEqual({ mode: "toggle", id: "b" });
    });

    it("clicking empty space returns marquee", () => {
      const scene = useScene.getState().scene!;
      expect(pickTarget(scene, { x: 900, y: 900 }, false, [], 1)).toEqual({ mode: "marquee" });
    });
  });

  // --- pure logic: nodesInMarquee ------------------------------------------

  describe("nodesInMarquee", () => {
    it("includes only nodes whose bounds intersect the marquee", () => {
      const scene = { ...emptyScene("doc-1", "u"), nodes: nodesOf({
        inside: node("inside", 5, "a000000"),
        outside: node("outside", 500, "a000001"),
      }) };
      expect(nodesInMarquee(scene, { x: 0, y: 0, width: 20, height: 20 })).toEqual(["inside"]);
    });

    it("excludes nodes that only touch the marquee at an edge", () => {
      const scene = { ...emptyScene("doc-1", "u"), nodes: nodesOf({
        touching: node("touching", 50, "a000000", { width: 50, height: 50 }),
      }) };
      // marquee = [0,0,50,50]; touching = [50,0,50,50] -> touches only the edge x=50
      expect(nodesInMarquee(scene, { x: 0, y: 0, width: 50, height: 50 })).toEqual([]);
    });

    it("measures a rotated node by what it really occupies, not by its unrotated box", () => {
      // 100x50 at 90°: the resting box is y in [0,50], but the node occupies y in [-25,75].
      const scene = { ...emptyScene("doc-1", "u"), nodes: nodesOf({
        turned: node("turned", 0, "a000000", { width: 100, height: 50, rotation: 90 }),
      }) };
      expect(nodesInMarquee(scene, { x: 20, y: 60, width: 10, height: 10 })).toEqual(["turned"]);
    });

    it("excludes invisible nodes even when their bounds intersect", () => {
      const scene = { ...emptyScene("doc-1", "u"), nodes: nodesOf({
        hidden: node("hidden", 5, "a000000", { visible: false }),
        shown: node("shown", 5, "a000001"),
      }) };
      expect(nodesInMarquee(scene, { x: 0, y: 0, width: 20, height: 20 })).toEqual(["shown"]);
    });

    it("a marquee that touches ONLY the stroke still takes the node", () => {
      // 50x50 at (100,0) with a 20 outer stroke: paints from x=80.
      // A marquee reaching x=85 does not touch the geometry, but touches
      // what is SEEN -- and dragging a selection around what you see is
      // all the marquee promises.
      const scene = { ...emptyScene("doc-1", "u"), nodes: nodesOf({
        outlined: node("outlined", 100, "a000000", {
          strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 20, align: "outside" }],
        }),
      }) };
      expect(nodesInMarquee(scene, { x: 0, y: 0, width: 85, height: 50 })).toEqual(["outlined"]);
      // And a marquee that stops BEFORE the band still does not take it.
      expect(nodesInMarquee(scene, { x: 0, y: 0, width: 79, height: 50 })).toEqual([]);
    });

    it("an INNER stroke does not widen the marquee target", () => {
      const scene = { ...emptyScene("doc-1", "u"), nodes: nodesOf({
        outlined: node("outlined", 100, "a000000", {
          strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 20, align: "inside" }],
        }),
      }) };
      expect(nodesInMarquee(scene, { x: 0, y: 0, width: 85, height: 50 })).toEqual([]);
    });

    it("takes a VECTOR with a degenerate axis, which its raw box would not be enough to take", () => {
      // The box of a vector is the EXACT bbox of the geometry (proto
      // invariant), so a horizontal segment really has height 0. With the raw
      // box a marquee would take it only by strictly STRADDLING it
      // (boundsIntersect compares with < and >): passing next to it would not be enough,
      // even though it is a node you can see and click. Here the marquee sits entirely
      // BELOW the line, and VECTOR_MIN_GRAB makes it take it.
      //
      // The geometry is REAL (two anchors), not `subpaths: []`: the tolerance
      // talks about a path that exists. A vector without anchors cannot be seen,
      // cannot be clicked and the marquee does not take it either -- test below.
      const scene = { ...emptyScene("doc-1", "u"), nodes: nodesOf({
        line: node("line", 5, "a000000", {
          kind: "vector", height: 0,
          vector: { subpaths: [{
            anchors: [
              { x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
              { x: 50, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 },
            ],
            closed: false,
          }] },
        }),
        flatRect: node("flatRect", 5, "a000001", { height: 0 }),
      }) };
      expect(nodesInMarquee(scene, { x: 0, y: 1, width: 60, height: 9 })).toEqual(["line"]);
      // ...and one that straddles both takes both: the tolerance
      // ADDS a case, it does not remove one.
      expect(nodesInMarquee(scene, { x: 0, y: -10, width: 60, height: 20 }))
        .toEqual(["line", "flatRect"]);
    });

    it("does NOT take a vector without geometry, which cannot be seen or clicked", () => {
      // The marquee works on bounds and on its own would not notice: an emptied
      // vector node keeps the width/height it had, so a
      // selection rectangle would take it despite producing no path and
      // no hit (renderer/shapes.ts::hasInk, hitTestNode). It would be the only
      // way to select something invisible: click and marquee cannot
      // be the same function, but on this they must agree.
      const scene = { ...emptyScene("doc-1", "u"), nodes: nodesOf({
        ghost: node("ghost", 5, "a000000", { kind: "vector", vector: { subpaths: [] } }),
        real: node("real", 5, "a000001"),
      }) };
      expect(nodesInMarquee(scene, { x: 0, y: 0, width: 100, height: 100 })).toEqual(["real"]);
    });
  });

  // --- marquee connected to the store --------------------------------------

  describe("marquee gesture", () => {
    it("drags a marquee over empty space and selects the nodes it intersects, visible in store.marquee while dragging", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(-10, -10), ctx); // empty
      tool.onPointerMove!(at(60, 60), ctx);
      expect(useScene.getState().marquee).toEqual({ x: -10, y: -10, width: 70, height: 70 });

      tool.onPointerUp!(at(60, 60), ctx);
      expect(useScene.getState().selection).toEqual(["a"]);
      expect(useScene.getState().marquee).toBeNull();
    });

    it("unions with the current selection when shift is held", () => {
      useScene.getState().setSelection(["b"]);
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(-10, -10, true), ctx);
      tool.onPointerMove!(at(60, 60, true), ctx);
      tool.onPointerUp!(at(60, 60, true), ctx);
      expect(useScene.getState().selection).toEqual(["b", "a"]);
    });

    // A CLICK on empty space is not a 0x0 marquee: the marquee selects by AABB,
    // and the empty corner of an ellipse's bounding box would fall inside that AABB
    // while being outside the ellipse (it is exactly what hitTest avoids).
    it("a click on empty space inside an ellipse's bounding box selects nothing", () => {
      useScene.setState({ selection: [] });
      useScene.getState().setScene({ ...emptyScene("doc-1", "u"), nodes: nodesOf({
        e: node("e", 0, "a000000", { width: 100, height: 100, kind: "ellipse" }),
      }) });
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(2, 2), ctx); // corner of the AABB, OUTSIDE the ellipse
      tool.onPointerUp!(at(2, 2), ctx);
      expect(useScene.getState().selection).toEqual([]);
      expect(useScene.getState().marquee).toBeNull();
    });

    it("a sub-slop jitter is still a click, but a real drag selects by bounds", () => {
      useScene.setState({ selection: [] });
      useScene.getState().setScene({ ...emptyScene("doc-1", "u"), nodes: nodesOf({
        e: node("e", 0, "a000000", { width: 100, height: 100, kind: "ellipse" }),
      }) });
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(2, 2), ctx);
      tool.onPointerMove!(at(4, 4), ctx); // 2px: below the threshold
      tool.onPointerUp!(at(4, 4), ctx);
      expect(useScene.getState().selection).toEqual([]);

      tool.onPointerDown!(at(2, 2), ctx);
      tool.onPointerMove!(at(10, 10), ctx); // 8px: a real marquee
      tool.onPointerUp!(at(10, 10), ctx);
      expect(useScene.getState().selection).toEqual(["e"]);
    });

    it("the click threshold is in screen px, so it scales with the zoom", () => {
      useScene.setState({
        camera: { x: 0, y: 0, zoom: 0.1 }, // 20 world units = 2px screen
        selection: [],
      });
      useScene.getState().setScene({ ...emptyScene("doc-1", "u"), nodes: nodesOf({ a: node("a", 0, "a000000") }) });
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(-10, -10), ctx);
      tool.onPointerMove!(at(10, 10), ctx);
      tool.onPointerUp!(at(10, 10), ctx);
      expect(useScene.getState().selection).toEqual([]);
    });

    it("shift-clicking empty space keeps the selection instead of re-selecting by bounds", () => {
      useScene.getState().setSelection(["b"]);
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(900, 900, true), ctx);
      tool.onPointerUp!(at(900, 900, true), ctx);
      expect(useScene.getState().selection).toEqual(["b"]);
    });

    it("Esc during a marquee restores the pre-marquee selection", () => {
      useScene.getState().setSelection(["b"]);
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(-10, -10), ctx); // no shift: clears immediately
      expect(useScene.getState().selection).toEqual([]);
      tool.onPointerMove!(at(60, 60), ctx);

      tool.onKeyDown!({ key: "Escape" } as KeyboardEvent, ctx);
      expect(useScene.getState().selection).toEqual(["b"]);
      expect(useScene.getState().marquee).toBeNull();
    });
  });

  // --- moving the selection ------------------------------------------------

  describe("moving the selection", () => {
    it("dragging a selected node moves the WHOLE selection with one setProps op per node", () => {
      useScene.getState().setSelection(["a", "b"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(10, 10), ctx); // on "a", already selected: no selection change
      tool.onPointerMove!(at(30, 25), ctx); // dx=20 dy=15, local preview
      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ x: 20, y: 15 });
      expect(useScene.getState().scene!.nodes.at("b")).toMatchObject({ x: 120, y: 15 });
      expect(sync.sent).toHaveLength(0); // nothing on the wire during the drag

      tool.onPointerUp!(at(30, 25), ctx);
      expect(sync.sent).toHaveLength(2); // one op per node
      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ x: 20, y: 15 });
      expect(useScene.getState().scene!.nodes.at("b")).toMatchObject({ x: 120, y: 15 });
      expect(useScene.getState().selection).toEqual(["a", "b"]);
    });

    it("a plain click on a node (down/up, no move) selects it and sends no op", () => {
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(10, 10), ctx);
      tool.onPointerUp!(at(10, 10), ctx);
      expect(sync.sent).toHaveLength(0);
      expect(useScene.getState().selection).toEqual(["a"]);
    });

    it("clicking an unselected node replaces the selection before moving just that node", () => {
      useScene.getState().setSelection(["a"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(120, 10), ctx); // "b", not selected: replaces
      expect(useScene.getState().selection).toEqual(["b"]);
      tool.onPointerMove!(at(140, 20), ctx);
      tool.onPointerUp!(at(140, 20), ctx);

      expect(sync.sent).toHaveLength(1);
      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ x: 0, y: 0 }); // "a" did not move
      expect(useScene.getState().scene!.nodes.at("b")).toMatchObject({ x: 120, y: 10 });
    });

    it("Esc during a drag reverts the moved node(s) and sends nothing", () => {
      useScene.getState().setSelection(["a"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(10, 10), ctx);
      // Alt: here the ABANDONMENT of the gesture is measured, not the snap (which has its own
      // tests below) -- without it, the moved box would snap to the edge of
      // "b" and the intermediate position would no longer be the pointer's.
      tool.onPointerMove!(atMod(90, 90, { altKey: true }), ctx);
      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ x: 80, y: 80 });

      tool.onKeyDown!({ key: "Escape" } as KeyboardEvent, ctx);
      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ x: 0, y: 0 });
      expect(sync.sent).toHaveLength(0);

      // and the next up sends nothing anymore (the gesture was abandoned)
      tool.onPointerUp!(at(90, 90), ctx);
      expect(sync.sent).toHaveLength(0);
    });

    it("onDeactivate abandons an in-progress drag without emitting an op", () => {
      useScene.getState().setSelection(["a"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(10, 10), ctx);
      tool.onPointerMove!(at(90, 90), ctx);
      tool.onDeactivate!(ctx);

      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ x: 0, y: 0 });
      expect(sync.sent).toHaveLength(0);
    });
  });

  // --- resize with the handles -----------------------------------------------
  // The beforeEach nodes are 50x50: "a" at (0,0), "b" at (100,0). With an identity
  // camera the event's screen coordinates coincide with the world ones,
  // so the handles of "a" are at (0,0) nw ... (50,50) se.

  describe("resizing with the handles", () => {
    it("dragging the se handle resizes the selected node with ONE setProps op", () => {
      useScene.getState().setSelection(["a"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(50, 50), ctx); // se handle
      tool.onPointerMove!(at(70, 80), ctx); // dx=20 dy=30
      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ x: 0, y: 0, width: 70, height: 80 });
      expect(sync.sent).toHaveLength(0); // nothing on the wire during the gesture

      tool.onPointerUp!(at(70, 80), ctx);
      expect(sync.sent).toHaveLength(1);
      expect(sync.sent[0].kind.case).toBe("setProps");
      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ x: 0, y: 0, width: 70, height: 80 });
    });

    it("the nw handle moves the origin while resizing", () => {
      useScene.getState().setSelection(["a"]);
      useScene.getState().setSync(new FakeSync());
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(0, 0), ctx); // nw handle
      // Alt: here the resize math is measured, not the snap -- the top
      // edge at 20 would otherwise fall on the center of "b" (25), which is correct
      // but is another matter (see "selectTool — snap" below).
      tool.onPointerMove!(atMod(10, 20, { altKey: true }), ctx);
      tool.onPointerUp!(atMod(10, 20, { altKey: true }), ctx);
      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ x: 10, y: 20, width: 40, height: 30 });
    });

    it("handles win over the node under the pointer (no move, no selection change)", () => {
      useScene.getState().setSelection(["a"]);
      useScene.getState().setSync(new FakeSync());
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(50, 25), ctx); // e handle, INSIDE the bounds of "a"
      expect(useScene.getState().selection).toEqual(["a"]);
      tool.onPointerMove!(at(90, 45), ctx);
      // resize on the x axis only: if the node had won, "a" would have MOVED
      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ x: 0, y: 0, width: 90, height: 50 });
    });

    it("flips through the gesture keeping a positive width", () => {
      useScene.getState().setSelection(["a"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(0, 25), ctx); // w handle
      tool.onPointerMove!(at(100, 25), ctx); // past the right edge (x=50)
      tool.onPointerUp!(at(100, 25), ctx);
      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ x: 50, y: 0, width: 50, height: 50 });
    });

    it("shift keeps the aspect ratio", () => {
      useScene.getState().setSelection(["a"]);
      useScene.getState().setSync(new FakeSync());
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(50, 50, true), ctx); // se handle
      tool.onPointerMove!(at(150, 50, true), ctx); // only dx: without shift it would be 150x50
      tool.onPointerUp!(at(150, 50, true), ctx);
      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ width: 150, height: 150 });
    });

    it("shift keeps the aspect ratio while SHRINKING from a corner", () => {
      useScene.getState().setSelection(["a"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(50, 50, true), ctx); // se handle
      tool.onPointerMove!(at(30, 50, true), ctx); // dx=-20 inwards, dy=0
      // 50x50 * 0.6: the drag must shrink, not leave the node as it is
      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ x: 0, y: 0, width: 30, height: 30 });
      tool.onPointerUp!(at(30, 50, true), ctx);
      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ width: 30, height: 30 });
    });

    it("resizes a MULTIPLE selection as a group, one op per node", () => {
      useScene.getState().setSelection(["a", "b"]); // group bbox (0,0,150,50)
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(150, 50), ctx); // se handle of the group
      tool.onPointerMove!(at(300, 50), ctx); // width x2, height unchanged
      tool.onPointerUp!(at(300, 50), ctx);

      expect(sync.sent).toHaveLength(2);
      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ x: 0, y: 0, width: 100, height: 50 });
      expect(useScene.getState().scene!.nodes.at("b")).toMatchObject({ x: 200, y: 0, width: 100, height: 50 });
    });

    // The box invariant (proto, on VectorNode) in the direction that costs: after a
    // SetVectorPath the geometry's local bbox is (0,0)-(width,height), and
    // therefore not even the BOX can move on its own. The 8 resize handles are
    // shipped since M1 and send a kind-agnostic setProps{x,y,width,height}: without
    // the second op the box would grow and the ink would stay the size it was
    // before, violating the invariant with an ordinary gesture and with no
    // SetVectorPath in sight.
    it("resizing a VECTOR node rewrites its geometry in the SAME gesture", () => {
      useScene.getState().setScene({ ...emptyScene("doc-1", "u"), nodes: nodesOf({ v: curvyVector() }) });
      useScene.getState().setSelection(["v"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(50, 50), ctx);  // se handle
      tool.onPointerMove!(at(100, 50), ctx); // width x2, height unchanged
      const mid = useScene.getState().scene!.nodes.at("v");
      expect(mid).toMatchObject({ x: 0, y: 0, width: 100, height: 50 });
      // Already in PREVIEW the invariant holds: the two coalescing keys
      // (`s|v|...` and `v|v`) are distinct, so the geometry does not crush the
      // box nor vice versa.
      expect(vectorBounds(mid.vector!.subpaths)).toEqual({ x: 0, y: 0, width: 100, height: 50 });

      tool.onPointerUp!(at(100, 50), ctx);
      expect(sync.sent.map((o) => o.kind.case)).toEqual(["setProps", "setVectorPath"]);
      const after = useScene.getState().scene!.nodes.at("v");
      expect(after).toMatchObject({ x: 0, y: 0, width: 100, height: 50 });
      expect(vectorBounds(after.vector!.subpaths)).toEqual({ x: 0, y: 0, width: 100, height: 50 });
      // The bezier handles are OFFSETS and scale with the linear part: if
      // they stayed still the curvature would not follow the path, and the bbox above
      // would not add up.
      expect(after.vector!.subpaths[0].anchors[0].outX).toBe(40);
      expect(after.vector!.subpaths[0].anchors[1].inY).toBe(-20); // axis not scaled

      // ONE gesture: a single undo entry, and undoing puts BOTH back.
      expect(useScene.getState().undoStack).toHaveLength(1);
      useScene.getState().undo();
      const undone = useScene.getState().scene!.nodes.at("v");
      expect(undone).toMatchObject({ x: 0, y: 0, width: 50, height: 50 });
      expect(undone.vector!.subpaths).toEqual(curvyVector().vector!.subpaths);
    });

    it("resizing a NON-vector node still sends exactly one op", () => {
      // The second op is the vector's alone: a rectangle must not gain
      // a setVectorPath (which Go would reject with ErrNotVectorNode).
      useScene.getState().setSelection(["a"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(50, 50), ctx);
      tool.onPointerMove!(at(100, 100), ctx);
      tool.onPointerUp!(at(100, 100), ctx);
      expect(sync.sent.map((o) => o.kind.case)).toEqual(["setProps"]);
    });

    it("a click on a handle without moving sends nothing", () => {
      useScene.getState().setSelection(["a"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(50, 50), ctx);
      tool.onPointerUp!(at(50, 50), ctx);
      expect(sync.sent).toHaveLength(0);
      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ x: 0, y: 0, width: 50, height: 50 });
    });

    it("Esc during a resize restores the original size and sends nothing", () => {
      useScene.getState().setSelection(["a"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(50, 50), ctx);
      tool.onPointerMove!(at(150, 150), ctx);
      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ width: 150, height: 150 });

      tool.onKeyDown!({ key: "Escape" } as KeyboardEvent, ctx);
      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ x: 0, y: 0, width: 50, height: 50 });
      expect(sync.sent).toHaveLength(0);

      tool.onPointerUp!(at(150, 150), ctx);
      expect(sync.sent).toHaveLength(0);
    });

    it("onDeactivate abandons an in-progress resize without emitting an op", () => {
      useScene.getState().setSelection(["a"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(50, 50), ctx);
      tool.onPointerMove!(at(150, 150), ctx);
      tool.onDeactivate!(ctx);
      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ x: 0, y: 0, width: 50, height: 50 });
      expect(sync.sent).toHaveLength(0);
    });

    it("with nothing selected there are no handles: the pointer falls through to the node", () => {
      useScene.getState().setSync(new FakeSync());
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(25, 25), ctx);
      tool.onPointerMove!(at(35, 35), ctx);
      tool.onPointerUp!(at(35, 35), ctx);
      // moved, NOT resized
      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ x: 10, y: 10, width: 50, height: 50 });
    });

    it("the canvas cursor reflects the handle under the pointer", () => {
      useScene.getState().setSelection(["a"]);
      const tool = createSelectTool();
      const ctx = fakeCtx();
      const cursor = () => (ctx.canvas as unknown as { style: { cursor: string } }).style.cursor;

      tool.onPointerMove!(at(0, 0), ctx); // over nw
      expect(cursor()).toBe("nwse-resize");
      tool.onPointerMove!(at(50, 25), ctx); // over e
      expect(cursor()).toBe("ew-resize");
      tool.onPointerMove!(at(25, 25), ctx); // inside the box, no handle
      expect(cursor()).toBe("default");
    });

    it("keeps the handle cursor for the whole resize drag", () => {
      useScene.getState().setSelection(["a"]);
      useScene.getState().setSync(new FakeSync());
      const tool = createSelectTool();
      const ctx = fakeCtx();
      const cursor = () => (ctx.canvas as unknown as { style: { cursor: string } }).style.cursor;

      tool.onPointerDown!(at(50, 50), ctx);
      tool.onPointerMove!(at(400, 400), ctx); // far from any initial handle
      expect(cursor()).toBe("nwse-resize");
      tool.onPointerUp!(at(400, 400), ctx);
    });
  });

  // --- rotation --------------------------------------------------------------
  // The rotation grab zone is the ring just OUTSIDE each corner
  // (selection/handles.ts). With "a" (0,0,50,50) selected the center is (25,25)
  // and the se corner is at (50,50): (58,58) falls in the zone, at 45° from the center.
  // The tests' arrival point is the starting one rotated by 90° around the
  // center, so the expected delta is exactly a quarter turn.

  describe("rotating from the corner zones", () => {
    const rotationOf = (id: string) => useScene.getState().scene!.nodes.at(id).rotation;

    it("dragging outside a corner rotates the node about its centre: one gesture, one op", () => {
      useScene.getState().setSelection(["a"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(58, 58), ctx);   // rotation zone of the se corner
      expect(useScene.getState().selection).toEqual(["a"]); // no marquee, no deselection
      tool.onPointerMove!(at(-8, 58), ctx);   // same radius, +90°
      expect(rotationOf("a")).toBeCloseTo(90, 9);
      expect(sync.sent).toHaveLength(0);      // local preview, nothing on the wire

      tool.onPointerUp!(at(-8, 58), ctx);
      expect(sync.sent).toHaveLength(1);
      expect(sync.sent[0].kind.case).toBe("setProps");
      expect(rotationOf("a")).toBeCloseTo(90, 9);
      // the node does NOT move: it rotates around its own center
      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ x: 0, y: 0, width: 50, height: 50 });
    });

    it("undoes in ONE step", () => {
      useScene.getState().setSelection(["a"]);
      useScene.getState().setSync(new FakeSync());
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(58, 58), ctx);
      tool.onPointerMove!(at(20, 60), ctx);
      tool.onPointerMove!(at(-8, 58), ctx);
      tool.onPointerUp!(at(-8, 58), ctx);
      expect(rotationOf("a")).toBeCloseTo(90, 9);

      useScene.getState().undo();
      expect(rotationOf("a")).toBe(0);
    });

    it("shift snaps the angle to 15 degrees", () => {
      useScene.getState().setSelection(["a"]);
      useScene.getState().setSync(new FakeSync());
      const tool = createSelectTool();
      const ctx = fakeCtx();

      // start at 45°, arrival at 100°: delta 55° -> snaps to 60°
      const a = (100 * Math.PI) / 180;
      const to = at(25 + 40 * Math.cos(a), 25 + 40 * Math.sin(a), true);
      tool.onPointerDown!(at(58, 58, true), ctx);
      tool.onPointerMove!(to, ctx);
      expect(rotationOf("a")).toBeCloseTo(60, 9);
      tool.onPointerUp!(to, ctx);
      expect(rotationOf("a")).toBeCloseTo(60, 9);
    });

    it("keeps the angle in [0, 360) instead of piling up turns", () => {
      useScene.getState().setSelection(["a"]);
      useScene.getState().setSync(new FakeSync());
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(58, 58), ctx);
      tool.onPointerMove!(at(58, -8), ctx); // -90°
      tool.onPointerUp!(at(58, -8), ctx);
      expect(rotationOf("a")).toBeCloseTo(270, 9);
    });

    it("rotates a MULTIPLE selection rigidly about the group centre", () => {
      // group (0,0,150,50), center (75,25); se corner at (150,50)
      useScene.getState().setSelection(["a", "b"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(158, 58), ctx);
      tool.onPointerMove!(at(42, 108), ctx); // the previous point rotated by +90°
      tool.onPointerUp!(at(42, 108), ctx);

      expect(sync.sent).toHaveLength(2); // one op per node, a single gesture
      const a = useScene.getState().scene!.nodes.at("a");
      const b = useScene.getState().scene!.nodes.at("b");
      expect(a.rotation).toBeCloseTo(90, 9);
      expect(b.rotation).toBeCloseTo(90, 9);
      // the centers rotate around the group's: a (25,25) -> (75,-25), b (125,25) -> (75,75)
      expect(a.x).toBeCloseTo(50, 9);
      expect(a.y).toBeCloseTo(-50, 9);
      expect(b.x).toBeCloseTo(50, 9);
      expect(b.y).toBeCloseTo(50, 9);
    });

    it("a click on the rotate zone without moving sends nothing", () => {
      useScene.getState().setSelection(["a"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(58, 58), ctx);
      tool.onPointerUp!(at(58, 58), ctx);
      expect(sync.sent).toHaveLength(0);
      expect(rotationOf("a")).toBe(0);
    });

    it("Esc during a rotation restores the original angle and sends nothing", () => {
      useScene.getState().setSelection(["a"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(58, 58), ctx);
      tool.onPointerMove!(at(-8, 58), ctx);
      expect(rotationOf("a")).toBeCloseTo(90, 9);

      tool.onKeyDown!({ key: "Escape" } as KeyboardEvent, ctx);
      expect(rotationOf("a")).toBe(0);
      expect(sync.sent).toHaveLength(0);

      tool.onPointerUp!(at(-8, 58), ctx);
      expect(sync.sent).toHaveLength(0);
    });

    it("onDeactivate abandons an in-progress rotation", () => {
      useScene.getState().setSelection(["a"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(58, 58), ctx);
      tool.onPointerMove!(at(-8, 58), ctx);
      tool.onDeactivate!(ctx);
      expect(rotationOf("a")).toBe(0);
      expect(sync.sent).toHaveLength(0);
    });

    it("the cursor announces the rotate zone, and holds through the drag", () => {
      useScene.getState().setSelection(["a"]);
      useScene.getState().setSync(new FakeSync());
      const tool = createSelectTool();
      const ctx = fakeCtx();
      const cursor = () => (ctx.canvas as unknown as { style: { cursor: string } }).style.cursor;

      tool.onPointerMove!(at(58, 58), ctx); // hover just outside the corner
      expect(cursor()).toBe("grab");
      tool.onPointerMove!(at(50, 50), ctx); // on the corner: the resize wins
      expect(cursor()).toBe("nwse-resize");

      tool.onPointerDown!(at(58, 58), ctx);
      tool.onPointerMove!(at(-8, 58), ctx);
      expect(cursor()).toBe("grabbing");
      tool.onPointerUp!(at(-8, 58), ctx);
    });
  });

  // --- resize of an ALREADY rotated node -------------------------------------

  describe("resizing a rotated node", () => {
    function selectRotated(deg: number) {
      useScene.getState().setScene({
        ...emptyScene("doc-1", "u"),
        nodes: nodesOf({ a: node("a", 0, "a000000", { rotation: deg }) }),
      });
      useScene.getState().setSelection(["a"]);
      useScene.getState().setSync(new FakeSync());
    }

    it("widens along the node's OWN axis: the e handle follows a vertical drag at 90 degrees", () => {
      selectRotated(90);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      // the node is (0,0,50,50) at 90°: the e handle is at (25,50), not (50,25)
      tool.onPointerDown!(at(25, 50), ctx);
      tool.onPointerMove!(at(25, 70), ctx); // 20px DOWN = 20px along its x axis
      tool.onPointerUp!(at(25, 70), ctx);

      const a = useScene.getState().scene!.nodes.at("a");
      expect(a.width).toBeCloseTo(70, 9);
      expect(a.height).toBeCloseTo(50, 9);
      // the anchored side stays pinned in the WORLD: the box slides to compensate
      expect(a.x).toBeCloseTo(-10, 9);
      expect(a.y).toBeCloseTo(10, 9);
      expect(a.rotation).toBe(90); // the resize does not touch the angle
    });

    it("ignores the drag across that axis", () => {
      selectRotated(90);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(25, 50), ctx);
      tool.onPointerMove!(at(45, 50), ctx); // 20px to the RIGHT: transverse
      tool.onPointerUp!(at(45, 50), ctx);

      const a = useScene.getState().scene!.nodes.at("a");
      expect(a.width).toBeCloseTo(50, 9);
      expect(a.height).toBeCloseTo(50, 9);
    });
  });

  // --- resize of a GROUP containing a rotated node -----------------------------
  // The group box is axis-aligned around what the nodes OCCUPY:
  // the scale applies along the SCREEN axes, and a rotated member must be mapped
  // by axes -- scaling its local box stretched it in the wrong
  // direction and made it stick out of the box.
  describe("resizing a MULTIPLE selection containing a rotated node", () => {
    beforeEach(() => {
      // A: 100x50 at (0,0) at 90° -> occupies x [25,75], y [-25,75]
      // B: 50x50 at (200,0)      -> the group spans x [25,250], y [-25,75]
      useScene.getState().setScene({
        ...emptyScene("doc-1", "u"),
        nodes: nodesOf({
          a: node("a", 0, "a000000", { width: 100, height: 50, rotation: 90 }),
          b: node("b", 200, "a000001"),
        }),
      });
      useScene.getState().setSelection(["a", "b"]);
    });

    it("stretches the rotated member along the SCREEN axis the pointer is dragging", () => {
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(250, 75), ctx); // se handle of the group
      tool.onPointerMove!(at(475, 75), ctx); // +225 horizontally: scale x2
      tool.onPointerUp!(at(475, 75), ctx);

      const a = useScene.getState().scene!.nodes.at("a");
      // the model box: the width (VERTICAL local axis on screen)
      // stays, the height (HORIZONTAL local axis) doubles
      expect(a.width).toBeCloseTo(100, 9);
      expect(a.height).toBeCloseTo(100, 9);
      expect(a.rotation).toBeCloseTo(90, 9);
      expect(a.x).toBeCloseTo(25, 9);
      expect(a.y).toBeCloseTo(-25, 9);

      const b = useScene.getState().scene!.nodes.at("b");
      expect(b).toMatchObject({ y: 0, width: 100, height: 50 });
      expect(b.x).toBeCloseTo(375, 9);
      expect(sync.sent).toHaveLength(2); // one op per node, a single gesture
    });

    it("keeps the rotated member inside the group frame it started in", () => {
      useScene.getState().setSync(new FakeSync());
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(250, 75), ctx);
      tool.onPointerMove!(at(475, 75), ctx);
      tool.onPointerUp!(at(475, 75), ctx);

      // The box after the resize: x [25,475], y [-25,75] (the height was not
      // touched). What the node REALLY occupies must fit inside it --
      // before it became 200 tall and burst the box above and below.
      const aabb = worldAabbOfNode(useScene.getState().scene!.nodes.at("a"));
      expect(aabb.y).toBeGreaterThanOrEqual(-25 - 1e-6);
      expect(aabb.y + aabb.height).toBeLessThanOrEqual(75 + 1e-6);
      expect(aabb.height).toBeCloseTo(100, 6);
      expect(aabb.width).toBeCloseTo(100, 6);
    });

    it("sends the new angle only when it really changes", () => {
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      // UNIFORM scale (shift): no angle changes, and the mask stays the usual
      // one -- no extra `rotation` on the wire.
      tool.onPointerDown!(at(250, 75, true), ctx);
      tool.onPointerMove!(at(475, 300, true), ctx);
      tool.onPointerUp!(at(475, 300, true), ctx);

      expect(useScene.getState().scene!.nodes.at("a").rotation).toBe(90);
      for (const op of sync.sent) {
        expect(op.kind.case === "setProps" && op.kind.value.mask?.paths)
          .toEqual(["x", "y", "width", "height"]);
      }
    });

    it("MIRRORS the angle of a rotated member when the group flips, and says so in the mask", () => {
      // 30° instead of 90: a horizontal mirror at 90° would leave the angle
      // where it is (the local x axis points down), and nothing would show.
      useScene.getState().setScene({
        ...emptyScene("doc-1", "u"),
        nodes: nodesOf({
          a: node("a", 0, "a000000", { width: 100, height: 50, rotation: 30 }),
          b: node("b", 200, "a000001"),
        }),
      });
      useScene.getState().setSelection(["a", "b"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      // Where the group's e handle is is told by the frame itself (at 30° the
      // edges are not round numbers): here the RESIZE is tested, not where the
      // handles are -- that is covered by handles.test.ts.
      const f = selectionFrame(useScene.getState().scene!, ["a", "b"])!;
      const east = { x: f.bounds.x + f.bounds.width, y: f.bounds.y + f.bounds.height / 2 };
      const past = east.x - 2 * f.bounds.width; // past the anchor: flip

      tool.onPointerDown!(at(east.x, east.y), ctx);
      tool.onPointerMove!(at(past, east.y), ctx);
      tool.onPointerUp!(at(past, east.y), ctx);

      const a = useScene.getState().scene!.nodes.at("a");
      expect(a.rotation).toBeCloseTo(150, 3); // 30 mirrored
      // a mirror does not deform: the measurements stay the same
      expect(a.width).toBeCloseTo(100, 3);
      expect(a.height).toBeCloseTo(50, 3);

      const forA = sync.sent.find((op) => op.kind.case === "setProps" && op.kind.value.id === "a");
      expect(forA!.kind.case === "setProps" && forA!.kind.value.mask?.paths)
        .toEqual(["x", "y", "width", "height", "rotation"]);
      // the NON-rotated member travels with the usual mask
      const forB = sync.sent.find((op) => op.kind.case === "setProps" && op.kind.value.id === "b");
      expect(forB!.kind.case === "setProps" && forB!.kind.value.mask?.paths)
        .toEqual(["x", "y", "width", "height"]);
    });

    // 90° is the EASY case (the axes swap and the math works out on its own). At
    // 45° with a NON-uniform scale it does not: the exact image is a
    // parallelogram, and the rectangle with those axes was 33% taller than the
    // box. Here we check the constraint the user SEES -- only dragging
    // horizontally, so vertically nothing must move.
    it("keeps a 45-degree member inside the frame when the group is stretched sideways", () => {
      useScene.getState().setScene({
        ...emptyScene("doc-1", "u"),
        nodes: nodesOf({
          a: node("a", 0, "a000000", { width: 100, height: 50, rotation: 45 }),
          b: node("b", 200, "a000001"),
        }),
      });
      useScene.getState().setSelection(["a", "b"]);
      useScene.getState().setSync(new FakeSync());
      const tool = createSelectTool();
      const ctx = fakeCtx();

      const f = selectionFrame(useScene.getState().scene!, ["a", "b"])!;
      const top = f.bounds.y;
      const bottom = f.bounds.y + f.bounds.height;
      const east = { x: f.bounds.x + f.bounds.width, y: f.bounds.y + f.bounds.height / 2 };

      tool.onPointerDown!(at(east.x, east.y), ctx);
      tool.onPointerMove!(at(east.x + f.bounds.width, east.y), ctx); // x2 in width, y untouched
      tool.onPointerUp!(at(east.x + f.bounds.width, east.y), ctx);

      const aabb = worldAabbOfNode(useScene.getState().scene!.nodes.at("a"));
      expect(aabb.y).toBeGreaterThanOrEqual(top - 1e-6);
      expect(aabb.y + aabb.height).toBeLessThanOrEqual(bottom + 1e-6);
      // the box height was not dragged: neither must the
      // member's change (before it went from 106.07 to 141.42)
      expect(aabb.height).toBeCloseTo(106.06601717798212, 6);
      expect(bottom - top).toBeCloseTo(106.06601717798212, 6);
    });
  });

  // --- deletion --------------------------------------------------------------

  describe("deleting the selection", () => {
    it("Delete removes every selected node with one deleteNode op per node, in a single gesture", () => {
      useScene.getState().setSelection(["a", "b"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onKeyDown!({ key: "Delete" } as KeyboardEvent, ctx);

      expect(sync.sent).toHaveLength(2);
      expect(sync.sent.every((op) => op.kind.case === "deleteNode")).toBe(true);
      expect(useScene.getState().scene!.nodes.at("a")).toBeUndefined();
      expect(useScene.getState().scene!.nodes.at("b")).toBeUndefined();
      expect(useScene.getState().selection).toEqual([]);
    });

    // deleteNode deletes a SUBTREE (applyOp / core.applyDelete): a
    // child selected together with its group needs no op of its own --
    // and cannot have one, because when it would arrive the node is already gone.
    it("Delete on a group AND one of its descendants sends ONE op, and the gesture stays undoable", () => {
      useScene.getState().setScene({
        ...emptyScene("doc-1", "u"),
        nodes: nodesOf({
          g1: node("g1", 0, "a000000"),
          c1: node("c1", 0, "a000000", { parentId: "g1" }),
          d1: node("d1", 0, "a000000", { parentId: "c1" }),
          other: node("other", 200, "a000001"),
        }),
      });
      useScene.getState().setSelection(["g1", "d1", "other"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const undoBefore = useScene.getState().undoStack.length;

      createSelectTool().onKeyDown!({ key: "Delete" } as KeyboardEvent, fakeCtx());

      // d1 vanishes in the cascade of g1: an op of its own would have been rejected by the
      // server (ErrNodeNotFound) and would have blown up the undo entry
      // of the WHOLE gesture (invertOp -> null on an already deleted node).
      const deleted = sync.sent.map((op) => (op.kind.case === "deleteNode" ? op.kind.value.id : ""));
      expect(deleted).toEqual(["g1", "other"]);
      expect([...useScene.getState().scene!.nodes.ids()]).toEqual([]);
      // ONE undo entry, and a complete one: four nodes to recreate.
      const stack = useScene.getState().undoStack;
      expect(stack).toHaveLength(undoBefore + 1);
      expect(stack[stack.length - 1]).toHaveLength(4);
    });

    it("Backspace does the same as Delete", () => {
      useScene.getState().setSelection(["a"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      tool.onKeyDown!({ key: "Backspace" } as KeyboardEvent, fakeCtx());
      expect(useScene.getState().scene!.nodes.at("a")).toBeUndefined();
    });

    it("Delete with nothing selected sends nothing", () => {
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      createSelectTool().onKeyDown!({ key: "Delete" } as KeyboardEvent, fakeCtx());
      expect(sync.sent).toHaveLength(0);
    });

    it("Delete mid-drag deletes the node, does not leave a stale drag, and the eventual pointerup sends nothing more", () => {
      useScene.getState().setSelection(["a"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(10, 10), ctx);
      tool.onPointerMove!(at(90, 90), ctx); // opens the drag gesture in the store, preview x:80 y:80

      tool.onKeyDown!({ key: "Delete" } as KeyboardEvent, ctx);
      expect(sync.sent).toHaveLength(1);
      expect(sync.sent[0].kind.case).toBe("deleteNode");
      expect(useScene.getState().scene!.nodes.at("a")).toBeUndefined();
      expect(useScene.getState().gesture).toBeNull();

      // The button is still down in the real world: move/up still arrive for
      // the drag that Delete interrupted. They must do nothing -- in
      // particular NOT a second bogus setProps for "a" (now deleted).
      tool.onPointerMove!(at(95, 95), ctx);
      tool.onPointerUp!(at(95, 95), ctx);
      expect(sync.sent).toHaveLength(1);
      expect(sync.sent.every((op) => op.kind.case === "deleteNode")).toBe(true);
    });

    it("Delete mid-marquee cancels the marquee (restoring the pre-marquee selection) before deleting", () => {
      useScene.getState().setSelection(["b"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(-10, -10), ctx); // empty: clears the selection, opens the marquee
      tool.onPointerMove!(at(60, 60), ctx);
      expect(useScene.getState().marquee).not.toBeNull();

      tool.onKeyDown!({ key: "Delete" } as KeyboardEvent, ctx);
      // The marquee is abandoned (selection restored to "b" before
      // deletion), so it is "b" (not null, not a ghost id) that gets
      // deleted with a single op.
      expect(sync.sent).toHaveLength(1);
      expect(sync.sent[0].kind.case).toBe("deleteNode");
      expect(useScene.getState().scene!.nodes.at("b")).toBeUndefined();
      expect(useScene.getState().marquee).toBeNull();
      expect(useScene.getState().selection).toEqual([]);

      // The marquee's pointerup must not put "b" back in the
      // selection (it would be an id of a node that is now deleted).
      tool.onPointerUp!(at(60, 60), ctx);
      expect(useScene.getState().selection).toEqual([]);
    });
  });

  // --- double click on a text node: enters editing (Task 4, step 3) -------

  describe("double click on a text node enters editing", () => {
    beforeEach(() => {
      useScene.getState().setScene({
        ...emptyScene("doc-1", "u"),
        nodes: nodesOf({
          t: node("t", 0, "a000000", {
            kind: "text",
            text: { content: "", style: { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" } },
          }),
        }),
      });
      useScene.setState({ editingNodeId: null });
    });

    it("enters editing on the RELEASE of the second click, not on its pointerdown", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(atT(10, 10, 0), ctx);
      tool.onPointerUp!(atT(10, 10, 0), ctx);
      expect(useScene.getState().editingNodeId).toBeNull(); // the first click only selects

      // The second pointerdown alone does NOT decide: until release that
      // pointer can still become a drag (see the test below).
      tool.onPointerDown!(atT(10, 10, 200), ctx);
      expect(useScene.getState().editingNodeId).toBeNull();

      tool.onPointerUp!(atT(10, 10, 200), ctx);
      expect(useScene.getState().editingNodeId).toBe("t");
      expect(useScene.getState().selection).toEqual(["t"]);
    });

    // The defect: a QUICK second click followed by a drag was
    // swallowed by editing and the node no longer moved. The pointer, not
    // the pointerdown alone, decides: once past the threshold it is a drag like any other.
    it("a quick second click that then DRAGS moves the node and does not open editing", () => {
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(atT(10, 10, 0), ctx);
      tool.onPointerUp!(atT(10, 10, 0), ctx);
      tool.onPointerDown!(atT(10, 10, 200), ctx); // second click, within the threshold
      tool.onPointerMove!(atT(40, 40, 210), ctx); // but it moves: dx=30 dy=30
      expect(useScene.getState().scene!.nodes.at("t")).toMatchObject({ x: 30, y: 30 }); // preview
      tool.onPointerUp!(atT(40, 40, 220), ctx);

      expect(useScene.getState().editingNodeId).toBeNull(); // no editing
      expect(useScene.getState().scene!.nodes.at("t")).toMatchObject({ x: 30, y: 30 });
      expect(sync.sent).toHaveLength(1); // a single setProps, like a normal move
      expect(sync.sent[0].kind.case).toBe("setProps");
    });

    // Releasing the second click STILL (within a sub-threshold jitter)
    // remains a double click: it opens editing and moves nothing.
    it("a sub-slop jitter on the second click still opens editing and moves nothing", () => {
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(atT(10, 10, 0), ctx);
      tool.onPointerUp!(atT(10, 10, 0), ctx);
      tool.onPointerDown!(atT(10, 10, 200), ctx);
      tool.onPointerMove!(atT(12, 12, 210), ctx); // 2px: below the threshold
      tool.onPointerUp!(atT(12, 12, 220), ctx);

      expect(useScene.getState().editingNodeId).toBe("t");
      expect(sync.sent).toHaveLength(0); // no setProps: nothing moved
      expect(useScene.getState().scene!.nodes.at("t")).toMatchObject({ x: 0, y: 0 });
    });

    // The threshold is in SCREEN px like the marquee's: at zoom 10 ONE world
    // unit is 10px and already a drag, while at zoom 1 the same unit
    // would stay under 3px (the test above moves 2 and stays a click).
    it("the drag threshold is in screen px, so it scales with the zoom", () => {
      useScene.setState({ camera: { x: 0, y: 0, zoom: 10 } });
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(atT(10, 10, 0), ctx);
      tool.onPointerUp!(atT(10, 10, 0), ctx);
      tool.onPointerDown!(atT(10, 10, 200), ctx);
      tool.onPointerMove!(atT(11, 11, 210), ctx); // 1 world unit = 10px screen
      tool.onPointerUp!(atT(11, 11, 220), ctx);

      expect(useScene.getState().editingNodeId).toBeNull();
      expect(useScene.getState().scene!.nodes.at("t")).toMatchObject({ x: 1, y: 1 });
      expect(sync.sent).toHaveLength(1);
    });

    // Esc between the pointerdown and the release abandons the gesture: the pointerup that
    // arrives anyway afterwards must not open a "late" editing.
    it("Esc between the second pointerdown and its release cancels the pending editing", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(atT(10, 10, 0), ctx);
      tool.onPointerUp!(atT(10, 10, 0), ctx);
      tool.onPointerDown!(atT(10, 10, 200), ctx);
      tool.onKeyDown!({ key: "Escape" } as KeyboardEvent, ctx);
      tool.onPointerUp!(atT(10, 10, 200), ctx);
      expect(useScene.getState().editingNodeId).toBeNull();
    });

    it("does not enter editing when the second click arrives too late", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(atT(10, 10, 0), ctx);
      tool.onPointerUp!(atT(10, 10, 0), ctx);
      tool.onPointerDown!(atT(10, 10, 5000), ctx);
      tool.onPointerUp!(atT(10, 10, 5000), ctx);
      expect(useScene.getState().editingNodeId).toBeNull();
    });

    it("does not enter editing when the second click lands on a different node", () => {
      useScene.getState().setScene({
        ...emptyScene("doc-1", "u"),
        nodes: nodesOf({
          t: node("t", 0, "a000000", {
            kind: "text",
            text: { content: "", style: { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" } },
          }),
          t2: node("t2", 200, "a000001", {
            kind: "text",
            text: { content: "", style: { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" } },
          }),
        }),
      });
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(atT(10, 10, 0), ctx);
      tool.onPointerUp!(atT(10, 10, 0), ctx);
      tool.onPointerDown!(atT(210, 10, 50), ctx);
      tool.onPointerUp!(atT(210, 10, 50), ctx);
      expect(useScene.getState().editingNodeId).toBeNull();
    });

    it("a double click on a NON-text node does nothing special", () => {
      useScene.getState().setScene({
        ...emptyScene("doc-1", "u"),
        nodes: nodesOf({ r: node("r", 0, "a000000") }), // kind: "rect" by default
      });
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(atT(10, 10, 0), ctx);
      tool.onPointerUp!(atT(10, 10, 0), ctx);
      tool.onPointerDown!(atT(10, 10, 50), ctx);
      tool.onPointerUp!(atT(10, 10, 50), ctx);
      expect(useScene.getState().editingNodeId).toBeNull();
      expect(useScene.getState().selection).toEqual(["r"]); // the normal click keeps selecting
    });

    it("shift+double click does not enter editing (the multi-selection toggle remains)", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(atT(10, 10, 0, true), ctx);
      tool.onPointerUp!(atT(10, 10, 0, true), ctx);
      tool.onPointerDown!(atT(10, 10, 50, true), ctx);
      tool.onPointerUp!(atT(10, 10, 50, true), ctx);
      expect(useScene.getState().editingNodeId).toBeNull();
    });

    // Concrete repro of the review bug (Task 4, fix round): two pre-existing EMPTY
    // text nodes, double click on the first then on the second. Without the
    // guard in store.ts::beginTextEditing, the first node NEVER went through
    // endTextEditing -- editingNodeId was silently overwritten and the
    // node stayed a ghost (empty, never cleaned up) forever.
    it("a double click on ANOTHER text node closes/cleans up the editing of the first (empty), without leaving it a ghost", () => {
      useScene.getState().setScene({
        ...emptyScene("doc-1", "u"),
        nodes: nodesOf({
          t1: node("t1", 0, "a000000", {
            kind: "text",
            text: { content: "", style: { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" } },
          }),
          t2: node("t2", 200, "a000001", {
            kind: "text",
            text: { content: "", style: { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" } },
          }),
        }),
      });
      const tool = createSelectTool();
      const ctx = fakeCtx();

      // double click on t1: enters editing (on release of the second click).
      tool.onPointerDown!(atT(10, 10, 0), ctx);
      tool.onPointerUp!(atT(10, 10, 0), ctx);
      tool.onPointerDown!(atT(10, 10, 200), ctx);
      tool.onPointerUp!(atT(10, 10, 200), ctx);
      expect(useScene.getState().editingNodeId).toBe("t1");
      expect(useScene.getState().scene!.nodes.at("t1")).toBeDefined();

      // double click on t2 (well beyond the 400ms threshold from the previous one, but it is
      // a NEW double click: two clicks on t2 within the threshold of each other).
      tool.onPointerDown!(atT(210, 10, 1000), ctx);
      tool.onPointerUp!(atT(210, 10, 1000), ctx);
      tool.onPointerDown!(atT(210, 10, 1200), ctx);
      tool.onPointerUp!(atT(210, 10, 1200), ctx);

      expect(useScene.getState().editingNodeId).toBe("t2");
      expect(useScene.getState().scene!.nodes.at("t1")).toBeUndefined(); // no ghost node
      expect(useScene.getState().scene!.nodes.at("t2")).toBeDefined();
    });
  });
});

// --- SNAP DURING THE GESTURE -------------------------------------------------
//
// The snap DECISION is tested where it lives, as a pure function
// (selection/snap.test.ts). Here we only verify the link to the gesture: that
// the snap enters the preview AND the final op (not two different values), that
// Alt turns it off, that the threshold is in SCREEN px and that the guides appear and
// disappear together with the gesture.
describe("selectTool — snap", () => {
  let sync: FakeSync;

  beforeEach(() => {
    sync = new FakeSync();
    useScene.setState({ sync });
  });

  const lastPatch = () => sync.sent[sync.sent.length - 1].kind.value as {
    id: string; patch?: { x: number; y: number; width: number; height: number };
  };

  describe("dragging", () => {
    it("snaps the dragged edge onto another node's edge", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(10, 10), ctx); // selects "a" (0..50)
      // dx = 48: the right edge ends at 98, 2 units from the left edge of
      // "b" (100) -- within the threshold, so it snaps to 100.
      tool.onPointerMove!(at(58, 10), ctx);
      expect(useScene.getState().scene!.nodes.at("a").x).toBe(50);
    });

    it("shows a guide on the line it snapped to", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(10, 10), ctx);
      tool.onPointerMove!(at(58, 10), ctx);
      expect(useScene.getState().snapGuides).toContainEqual({ axis: "x", pos: 100, from: 0, to: 50 });
    });

    it("the op that lands on the wire carries the SNAPPED value, not the pointer's", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(10, 10), ctx);
      tool.onPointerMove!(at(58, 10), ctx);
      tool.onPointerUp!(at(58, 10), ctx);
      expect(lastPatch().patch?.x).toBe(50);
      // One gesture, one op per node: the snap does not add a second.
      expect(sync.sent).toHaveLength(1);
      expect(useScene.getState().undoStack).toHaveLength(1);
    });

    it("clears the guides when the gesture ends", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(10, 10), ctx);
      tool.onPointerMove!(at(58, 10), ctx);
      expect(useScene.getState().snapGuides.length).toBeGreaterThan(0);
      tool.onPointerUp!(at(58, 10), ctx);
      expect(useScene.getState().snapGuides).toEqual([]);
    });

    it("clears the guides when the gesture is abandoned (Esc)", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(10, 10), ctx);
      tool.onPointerMove!(at(58, 10), ctx);
      tool.onKeyDown!({ key: "Escape" } as KeyboardEvent, ctx);
      expect(useScene.getState().snapGuides).toEqual([]);
    });

    it("Alt turns snapping off for that drag", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(10, 10), ctx);
      tool.onPointerMove!(atMod(58, 10, { altKey: true }), ctx);
      expect(useScene.getState().scene!.nodes.at("a").x).toBe(48);
      expect(useScene.getState().snapGuides).toEqual([]);
    });

    it("measures the threshold in SCREEN pixels: the same drag snaps at 100% and not at 200%", () => {
      // dx = 46 -> right edge at 96, i.e. 4 world units from the edge of "b".
      // At zoom 1 that is 4 screen px (within the threshold), at zoom 2 it is 8 (outside).
      const run = (zoom: number) => {
        useScene.getState().setScene({
          ...emptyScene("doc-1", "u"),
          nodes: nodesOf({ a: node("a", 0, "a000000"), b: node("b", 100, "a000001") }),
        });
        useScene.setState({ camera: { x: 0, y: 0, zoom }, selection: [] });
        const tool = createSelectTool();
        const ctx = fakeCtx();
        tool.onPointerDown!(at(10, 10), ctx);
        tool.onPointerMove!(at(56, 10), ctx);
        return useScene.getState().scene!.nodes.at("a").x;
      };
      expect(run(1)).toBe(50);
      expect(run(2)).toBe(46);
    });

    it("never snaps to a node that is being dragged along", () => {
      useScene.getState().setSelection(["a", "b"]);
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(10, 10), ctx); // "a" is already selected: the pair stays
      tool.onPointerMove!(at(58, 10), ctx);
      expect(useScene.getState().scene!.nodes.at("a").x).toBe(48);
      expect(useScene.getState().scene!.nodes.at("b").x).toBe(148);
      expect(useScene.getState().snapGuides).toEqual([]);
    });
  });

  // --- THE MODIFIERS ARE THOSE OF THE LAST PREVIEW -----------------------------
  //
  // The final op is recomputed from the pointerup POSITION, but the modifiers
  // come from the last pointermove. Reading them from the release event makes
  // a gesture snap at commit that the user had kept free the whole
  // time: fingers release Alt an instant before the button -- it is the normal
  // gesture of someone about to finish -- and the node jumps by SNAP_THRESHOLD_PX/zoom
  // world units. endGesture rebuilds the scene from those ops, so the jump
  // is what ends up on the wire AND in the undo entry, and Alt is precisely the way
  // out of snapping: the bug undoes the feature at the only moment
  // it is needed.
  describe("the modifiers of the last preview", () => {
    it("Alt released BEFORE the button does not make the commit snap", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(10, 10), ctx);
      tool.onPointerMove!(atMod(58, 10, { altKey: true }), ctx);
      expect(useScene.getState().scene!.nodes.at("a").x).toBe(48); // the preview is at 48
      // The fingers release Alt, then the button: the pointerup arrives with altKey
      // false. Without the latch the commit would snap to 50 -- a 2 world-unit
      // jump that no preview ever showed.
      tool.onPointerUp!(atMod(58, 10, {}), ctx);
      expect(lastPatch().patch?.x).toBe(48);
      expect(useScene.getState().scene!.nodes.at("a").x).toBe(48);
      expect(useScene.getState().snapGuides).toEqual([]);
    });

    it("Alt pressed BEFORE the button does not undo a snap already shown", () => {
      // The opposite direction, equally reachable: the preview snapped to
      // 50, Alt goes down an instant before the release. The commit must stay
      // what was seen.
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(10, 10), ctx);
      tool.onPointerMove!(at(58, 10), ctx);
      expect(useScene.getState().scene!.nodes.at("a").x).toBe(50);
      tool.onPointerUp!(atMod(58, 10, { altKey: true }), ctx);
      expect(lastPatch().patch?.x).toBe(50);
      expect(useScene.getState().scene!.nodes.at("a").x).toBe(50);
    });

    it("the UNDO ENTRY carries what was seen, not an extra jump", () => {
      // The jump does not only end up on the wire: endGesture rebuilds the scene
      // from the final ops, so the undo entry (and its redo) is that of the
      // snapped value. The full undo -> redo round trip proves it.
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(10, 10), ctx);
      tool.onPointerMove!(atMod(58, 10, { altKey: true }), ctx);
      tool.onPointerUp!(atMod(58, 10, {}), ctx);
      expect(useScene.getState().undoStack).toHaveLength(1);
      useScene.getState().undo();
      expect(useScene.getState().scene!.nodes.at("a").x).toBe(0);
      useScene.getState().redo();
      expect(useScene.getState().scene!.nodes.at("a").x).toBe(48);
    });

    // THE COUNTER-PROOF of the latch: the LAST preview is captured, not the state
    // of the keys at the start of the gesture. Pressing or releasing Alt mid-drag must
    // keep changing the preview immediately -- if the latch were at the
    // pointerdown, this test would stay at 50 forever.
    it("Alt pressed MID-gesture changes the preview immediately, and the commit with it", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(10, 10), ctx);
      tool.onPointerMove!(at(58, 10), ctx);
      expect(useScene.getState().scene!.nodes.at("a").x).toBe(50); // snapped
      tool.onPointerMove!(atMod(58, 10, { altKey: true }), ctx);
      expect(useScene.getState().scene!.nodes.at("a").x).toBe(48); // Alt: released
      expect(useScene.getState().snapGuides).toEqual([]);
      tool.onPointerUp!(atMod(58, 10, {}), ctx);
      expect(lastPatch().patch?.x).toBe(48);
    });

    it("and released mid-gesture it re-snaps it, always immediately", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(10, 10), ctx);
      tool.onPointerMove!(atMod(58, 10, { altKey: true }), ctx);
      expect(useScene.getState().scene!.nodes.at("a").x).toBe(48);
      tool.onPointerMove!(at(58, 10), ctx);
      expect(useScene.getState().scene!.nodes.at("a").x).toBe(50);
      tool.onPointerUp!(at(58, 10), ctx);
      expect(lastPatch().patch?.x).toBe(50);
    });

    it("ROTATION commits the snapped angle that the preview showed, even if Shift goes up first", () => {
      // The same defect on the third gesture: Shift released before the button
      // would commit 55° after a 60° preview.
      useScene.getState().setSelection(["a"]);
      const tool = createSelectTool();
      const ctx = fakeCtx();
      const a = (100 * Math.PI) / 180;
      const to = at(25 + 40 * Math.cos(a), 25 + 40 * Math.sin(a), true);
      tool.onPointerDown!(at(58, 58, true), ctx); // rotation zone of the se corner
      tool.onPointerMove!(to, ctx);
      expect(useScene.getState().scene!.nodes.at("a").rotation).toBeCloseTo(60, 9);
      tool.onPointerUp!(at(to.clientX, to.clientY, false), ctx);
      expect(useScene.getState().scene!.nodes.at("a").rotation).toBeCloseTo(60, 9);
      const v = sync.sent[sync.sent.length - 1].kind.value as { patch?: { rotation: number } };
      expect(v.patch?.rotation).toBeCloseTo(60, 9);
    });
  });

  describe("resizing", () => {
    // Grabs the "e" handle of "a" (right edge, mid height) after having
    // selected it with a click.
    function grabEast(tool: ReturnType<typeof createSelectTool>, ctx: ToolContext) {
      tool.onPointerDown!(at(10, 10), ctx);
      tool.onPointerUp!(at(10, 10), ctx);
      tool.onPointerDown!(at(50, 25), ctx);
    }

    it("snaps the edge being dragged, and leaves the opposite edge alone", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      grabEast(tool, ctx);
      tool.onPointerMove!(at(98, 25), ctx); // right edge at 98, snaps to 100
      expect(useScene.getState().scene!.nodes.at("a").width).toBe(100);
      expect(useScene.getState().scene!.nodes.at("a").x).toBe(0);
      expect(useScene.getState().snapGuides).toContainEqual({ axis: "x", pos: 100, from: 0, to: 50 });
    });

    it("sends the snapped size, not the pointer's", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      grabEast(tool, ctx);
      tool.onPointerMove!(at(98, 25), ctx);
      tool.onPointerUp!(at(98, 25), ctx);
      expect(lastPatch().patch?.width).toBe(100);
      expect(useScene.getState().snapGuides).toEqual([]);
    });

    it("Alt turns it off here too", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      grabEast(tool, ctx);
      tool.onPointerMove!(atMod(98, 25, { altKey: true }), ctx);
      expect(useScene.getState().scene!.nodes.at("a").width).toBe(98);
      expect(useScene.getState().snapGuides).toEqual([]);
    });

    it("stands aside when Shift is keeping the aspect ratio", () => {
      // The aspect ratio is a stronger constraint: snapping one axis
      // would break the other, and the user asked EXPLICITLY for the ratio.
      const tool = createSelectTool();
      const ctx = fakeCtx();
      grabEast(tool, ctx);
      tool.onPointerMove!(atMod(98, 25, { shiftKey: true }), ctx);
      expect(useScene.getState().scene!.nodes.at("a").width).toBe(98);
      expect(useScene.getState().snapGuides).toEqual([]);
    });

    it("snaps the LEFT edge when it is the w handle being dragged", () => {
      // The counter-proof of the "e" handle: here the edge that moves is the
      // MINIMUM. With left/right swapped in movingEdgeLines 150 would be offered
      // (the fixed edge), which is near no target: no snap.
      useScene.getState().setScene({
        ...emptyScene("doc-1", "u"),
        nodes: nodesOf({ a: node("a", 100, "a000001"), c: node("c", 0, "a000000") }),
      });
      useScene.getState().setSelection(["a"]);
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(100, 25), ctx); // "w" handle of "a" (100..150)
      tool.onPointerMove!(at(52, 25), ctx); // left edge at 52, snaps to 50
      expect(useScene.getState().scene!.nodes.at("a").x).toBe(50);
      expect(useScene.getState().scene!.nodes.at("a").width).toBe(100);
      expect(useScene.getState().snapGuides).toContainEqual({ axis: "x", pos: 50, from: 0, to: 50 });
    });

    // THE FLIP. Past the anchor, in a normalized box the min and max
    // have swapped: movingEdgeLines -- which reasons on the box, not on the
    // gesture -- would indicate the FIXED edge, i.e. the ANCHOR. Snapping it would move
    // the only point that resizing promises not to move.
    describe("flip", () => {
      // "a" at 0..50 on both axes; "c" offers lines at 2 (and 27, 52) on
      // both axes, i.e. two units from the anchor of "e" and of "s".
      function flipScene() {
        useScene.getState().setScene({
          ...emptyScene("doc-1", "u"),
          nodes: nodesOf({
            a: node("a", 0, "a000001"),
            c: node("c", 2, "a000000", { y: 2 }),
          }),
        });
        useScene.getState().setSelection(["a"]);
      }

      it("does not snap the ANCHOR when the x axis flips (e dragged past the left edge)", () => {
        flipScene();
        const tool = createSelectTool();
        const ctx = fakeCtx();
        tool.onPointerDown!(at(50, 25), ctx); // "e" handle
        tool.onPointerMove!(at(-2, 25), ctx); // 2 past the anchor (x = 0)
        // Without the guard the anchor (0) would snap to the edge of "c" (2):
        // width 0 instead of 2, and a red guide on a line that the
        // dragged edge never touched.
        expect(useScene.getState().scene!.nodes.at("a").x).toBe(-2);
        expect(useScene.getState().scene!.nodes.at("a").width).toBe(2);
        expect(useScene.getState().snapGuides).toEqual([]);
      });

      it("does not snap the ANCHOR when the y axis flips (s dragged past the top edge)", () => {
        flipScene();
        const tool = createSelectTool();
        const ctx = fakeCtx();
        tool.onPointerDown!(at(25, 50), ctx); // "s" handle
        tool.onPointerMove!(at(25, -2), ctx); // 2 past the anchor (y = 0)
        expect(useScene.getState().scene!.nodes.at("a").y).toBe(-2);
        expect(useScene.getState().scene!.nodes.at("a").height).toBe(2);
        expect(useScene.getState().snapGuides).toEqual([]);
      });

      it("silences ONLY the axis that flipped — the other one still snaps", () => {
        useScene.getState().setScene({
          ...emptyScene("doc-1", "u"),
          nodes: nodesOf({
            a: node("a", 0, "a000001"),
            c: node("c", 2, "a000000", { y: 2 }), // x line at 2, next to the anchor
            d: node("d", 200, "a000002", { y: 100 }), // y line at 100, below
          }),
        });
        useScene.getState().setSelection(["a"]);
        const tool = createSelectTool();
        const ctx = fakeCtx();
        tool.onPointerDown!(at(50, 50), ctx); // "se" handle
        // x flipped (2 past the anchor), y not: the bottom edge reaches 98 and
        // must snap to 100 as usual.
        tool.onPointerMove!(at(-2, 98), ctx);
        expect(useScene.getState().scene!.nodes.at("a").height).toBe(100); // y snaps
        expect(useScene.getState().scene!.nodes.at("a").width).toBe(2); // x does not
        const guides = useScene.getState().snapGuides;
        expect(guides).toContainEqual({ axis: "y", pos: 100, from: -2, to: 250 });
        expect(guides.every((g) => g.axis === "y")).toBe(true);
      });
    });

    it("commits the size the preview showed when Alt is released before the button", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      grabEast(tool, ctx);
      tool.onPointerMove!(atMod(98, 25, { altKey: true }), ctx);
      expect(useScene.getState().scene!.nodes.at("a").width).toBe(98);
      tool.onPointerUp!(atMod(98, 25, {}), ctx); // Alt released before the button
      expect(lastPatch().patch?.width).toBe(98);
      expect(useScene.getState().scene!.nodes.at("a").width).toBe(98);
    });

    it("keeps the ASPECT RATIO the preview showed when Shift is released before the button", () => {
      // The twin of the Alt case on a different modifier: e.shiftKey read at
      // release would commit a FREE resize (150x50) after a constrained
      // preview (150x150). Same cause, same remedy, another key.
      useScene.getState().setSelection(["a"]);
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(50, 50, true), ctx); // se handle
      tool.onPointerMove!(at(150, 50, true), ctx);
      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ width: 150, height: 150 });
      tool.onPointerUp!(at(150, 50, false), ctx); // Shift released before the button
      expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ width: 150, height: 150 });
      expect(lastPatch().patch?.height).toBe(150);
    });

    it("stands aside on a ROTATED frame — its edges are not lines of the screen", () => {
      useScene.getState().setScene({
        ...emptyScene("doc-1", "u"),
        nodes: nodesOf({ a: node("a", 0, "a000000", { rotation: 90 }), b: node("b", 100, "a000001") }),
      });
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(10, 10), ctx);
      tool.onPointerUp!(at(10, 10), ctx);
      // The "e" handle of a 50x50 square rotated by 90° is at (25, 50).
      tool.onPointerDown!(at(25, 50), ctx);
      tool.onPointerMove!(at(25, 98), ctx);
      expect(useScene.getState().scene!.nodes.at("a").width).toBeCloseTo(98, 9);
      expect(useScene.getState().snapGuides).toEqual([]);
    });
  });
});
// --- nesting -----------------------------------------------------------------
// The pointer speaks WORLD (screen px converted by the camera), the model
// speaks LOCAL (coordinates relative to the parent). Everything in between --
// hit-test, marquee, handles -- must do the conversion in the right direction and
// write back into the model coordinates that are still local.
describe("selectTool with nesting", () => {
  // page1 > g(100,50, 400x400) > c(10,10, 50x50): "c" in the WORLD occupies
  // (110,60)-(160,110).
  function nestedScene() {
    useScene.getState().setScene({
      ...emptyScene("doc-1", "u"),
      nodes: nodesOf({
        g: node("g", 100, "a000000", { y: 50, width: 400, height: 400 }),
        c: node("c", 10, "a000000", { parentId: "g", y: 10 }),
      }),
    });
  }

  beforeEach(nestedScene);

  it("nodesInMarquee compares the marquee with the WORLD box of a nested node", () => {
    const scene = useScene.getState().scene!;
    // Around the world corner of "c".
    expect(nodesInMarquee(scene, { x: 105, y: 55, width: 20, height: 20 })).toContain("c");
    // Around its LOCAL coordinates: there is nothing there, not even "g".
    expect(nodesInMarquee(scene, { x: 5, y: 5, width: 10, height: 10 })).toEqual([]);
  });

  // The marquee must obey the SAME tree rules as the renderer: what
  // is not drawn is not selected. Otherwise the selection ends up with
  // a frame and 8 handles on an empty canvas, and the first drag sends setProps
  // for a geometry the user does not see.
  it("a marquee over a hidden container does not select its (visible) children", () => {
    useScene.getState().setScene({
      ...emptyScene("doc-1", "u"),
      nodes: nodesOf({
        g: node("g", 100, "a000000", { y: 50, width: 400, height: 400, visible: false }),
        c: node("c", 10, "a000000", { parentId: "g", y: 10 }), // visible: true
      }),
    });
    const scene = useScene.getState().scene!;
    expect(nodesInMarquee(scene, { x: 105, y: 55, width: 20, height: 20 })).toEqual([]);
  });

  it("a marquee over a node unreachable from any page selects nothing", () => {
    useScene.getState().setScene({
      ...emptyScene("doc-1", "u"),
      nodes: nodesOf({ orfano: node("orfano", 0, "a000000", { parentId: "sparito" }) }),
    });
    const scene = useScene.getState().scene!;
    expect(nodesInMarquee(scene, { x: -10, y: -10, width: 100, height: 100 })).toEqual([]);
  });

  it("dragging a marquee over a hidden subtree leaves the selection (and the handles) empty", () => {
    useScene.getState().setScene({
      ...emptyScene("doc-1", "u"),
      nodes: nodesOf({
        g: node("g", 100, "a000000", { y: 50, width: 400, height: 400, visible: false }),
        c: node("c", 10, "a000000", { parentId: "g", y: 10 }),
      }),
    });
    const tool = createSelectTool();
    const ctx = fakeCtx();
    tool.onPointerDown!(at(100, 50), ctx);
    tool.onPointerMove!(at(200, 150), ctx);
    tool.onPointerUp!(at(200, 150), ctx);
    expect(useScene.getState().selection).toEqual([]);
  });

  it("dragging a nested node writes coordinates that stay LOCAL", () => {
    useScene.getState().setSync(new FakeSync());
    const tool = createSelectTool();
    const ctx = fakeCtx();

    tool.onPointerDown!(at(135, 85), ctx); // world center of "c"
    expect(useScene.getState().selection).toEqual(["c"]);
    tool.onPointerMove!(at(155, 95), ctx); // +20, +10 in the world
    tool.onPointerUp!(at(155, 95), ctx);
    // The model stays relative to the parent: 10+20, 10+10 -- not 130,80.
    expect(useScene.getState().scene!.nodes.at("c")).toMatchObject({ x: 30, y: 20 });
  });

  it("the se handle of a nested node sits at its WORLD corner and resizes it", () => {
    useScene.getState().setSelection(["c"]);
    useScene.getState().setSync(new FakeSync());
    const tool = createSelectTool();
    const ctx = fakeCtx();

    tool.onPointerDown!(at(160, 110), ctx); // se handle, in world coordinates
    tool.onPointerMove!(at(210, 110), ctx); // dx=50
    tool.onPointerUp!(at(210, 110), ctx);
    // Width doubled, origin still: and the origin is the LOCAL one.
    expect(useScene.getState().scene!.nodes.at("c")).toMatchObject({ x: 10, y: 10, width: 100, height: 50 });
  });

  it("the nw handle of a nested node moves its LOCAL origin", () => {
    useScene.getState().setSelection(["c"]);
    useScene.getState().setSync(new FakeSync());
    const tool = createSelectTool();
    const ctx = fakeCtx();

    tool.onPointerDown!(at(110, 60), ctx); // nw handle, in world coordinates
    tool.onPointerMove!(at(120, 70), ctx);
    tool.onPointerUp!(at(120, 70), ctx);
    // In the world the node goes from (120,70) to (160,110): locally (20,20) 40x40.
    expect(useScene.getState().scene!.nodes.at("c")).toMatchObject({ x: 20, y: 20, width: 40, height: 40 });
  });

  // --- container AND descendant selected together ----------------------------
  // A child's coordinates are relative to its container: transforming the
  // container ALREADY transforms the child. An op for the child as well transforms it
  // twice -- and it is the same pruning (topmostOf) that deletion does
  // for another reason.

  it("moving a container and a descendant selected together transforms the descendant ONCE", () => {
    useScene.getState().setSelection(["g", "c"]);
    const sync = new FakeSync();
    useScene.getState().setSync(sync);
    const tool = createSelectTool();
    const ctx = fakeCtx();

    const before = worldBoundsOfNode(useScene.getState().scene!, useScene.getState().scene!.nodes.at("c"));
    tool.onPointerDown!(at(400, 400), ctx); // inside "g", outside "c": selection unchanged
    expect(useScene.getState().selection).toEqual(["g", "c"]);
    tool.onPointerMove!(at(420, 410), ctx); // +20, +10 in the world
    tool.onPointerUp!(at(420, 410), ctx);

    expect(sync.sent).toHaveLength(1); // a single op: the topmost node
    const scene = useScene.getState().scene!;
    expect(scene.nodes.at("g")).toMatchObject({ x: 120, y: 60 });
    expect(scene.nodes.at("c")).toMatchObject({ x: 10, y: 10 }); // the local is not touched
    // In the WORLD the child moved by the delta, not double: 110 -> 130.
    const after = worldBoundsOfNode(scene, scene.nodes.at("c"));
    expect(after).toMatchObject({ x: before.x + 20, y: before.y + 10 });
  });

  it("resizing a container and a descendant selected together does not rescale the descendant twice", () => {
    useScene.getState().setSelection(["g", "c"]);
    const sync = new FakeSync();
    useScene.getState().setSync(sync);
    const tool = createSelectTool();
    const ctx = fakeCtx();

    // The group bbox is that of the ENTIRE selection -- (100,50) 400x400,
    // "c" fits inside it -- so the se handle sits at its world corner.
    tool.onPointerDown!(at(500, 450), ctx);
    tool.onPointerMove!(at(900, 850), ctx); // doubles the bbox around the nw anchor
    tool.onPointerUp!(at(900, 850), ctx);

    expect(sync.sent).toHaveLength(1);
    const scene = useScene.getState().scene!;
    expect(scene.nodes.at("g")).toMatchObject({ x: 100, y: 50, width: 800, height: 800 });
    // Without the pruning "c" would receive (20,20) 100x100: its world box
    // rescaled by the same t while the container's origin shifts
    // under it.
    expect(scene.nodes.at("c")).toMatchObject({ x: 10, y: 10, width: 50, height: 50 });
  });

  it("the pruning is about the ops, not about the selection: both stay selected", () => {
    useScene.getState().setSelection(["g", "c"]);
    useScene.getState().setSync(new FakeSync());
    const tool = createSelectTool();
    const ctx = fakeCtx();

    tool.onPointerDown!(at(400, 400), ctx);
    tool.onPointerMove!(at(420, 410), ctx);
    tool.onPointerUp!(at(420, 410), ctx);
    expect(useScene.getState().selection).toEqual(["g", "c"]);
  });

  it("a descendant selected WITHOUT its container still gets its own op", () => {
    useScene.getState().setSelection(["c"]);
    const sync = new FakeSync();
    useScene.getState().setSync(sync);
    const tool = createSelectTool();
    const ctx = fakeCtx();

    tool.onPointerDown!(at(135, 85), ctx); // world center of "c"
    tool.onPointerMove!(at(155, 95), ctx);
    tool.onPointerUp!(at(155, 95), ctx);

    expect(sync.sent).toHaveLength(1);
    expect(useScene.getState().scene!.nodes.at("c")).toMatchObject({ x: 30, y: 20 });
  });
});

// --- groups ------------------------------------------------------------------
// The convention: a click selects the OUTERMOST group, a double click
// enters and selects the child (see store/groups.ts). Grouping and ungrouping
// are ONE gesture each: one send, one undo entry.
describe("selectTool and groups", () => {
  //   page1
  //   ├── g  (group, no geometry of its own)
  //   │   ├── c1 (10,10 50x50)  -> world (10,10)-(60,60)
  //   │   └── c2 (100,0 20x20)  -> world (100,0)-(120,20)
  //   └── solo (200,200 50x50)
  // The group's bounds are the union: (10,0) 110x60.
  function groupedScene() {
    // editingNodeId is not in the global beforeEach: an editing session
    // left open by another test would wrongly make the assertion
    // "not yet in editing" below true.
    useScene.setState({ editingNodeId: null });
    useScene.getState().setScene({
      ...emptyScene("doc-1", "u"),
      nodes: nodesOf({
        g: node("g", 0, "a000001", { kind: "group", width: 0, height: 0 }),
        c1: node("c1", 10, "a000001", { parentId: "g", y: 10 }),
        c2: node("c2", 100, "a000002", { parentId: "g", y: 0, width: 20, height: 20 }),
        solo: node("solo", 200, "a000002", { y: 200 }),
      }),
    });
  }

  const ctrl = (key: string, shiftKey = false) =>
    ({ key, ctrlKey: true, metaKey: false, shiftKey, preventDefault: vi.fn() }) as unknown as KeyboardEvent;

  beforeEach(groupedScene);

  it("a click on a child of a group selects the GROUP", () => {
    createSelectTool().onPointerDown!(at(30, 30), fakeCtx()); // inside c1
    expect(useScene.getState().selection).toEqual(["g"]);
  });

  it("a double click enters the group and selects the child", () => {
    const tool = createSelectTool();
    const ctx = fakeCtx();
    tool.onPointerDown!(atT(30, 30, 1000), ctx);
    expect(useScene.getState().selection).toEqual(["g"]);
    tool.onPointerDown!(atT(30, 30, 1100), ctx);
    expect(useScene.getState().selection).toEqual(["c1"]);
    // Having entered the group, a click on a sibling selects the sibling.
    tool.onPointerUp!(atT(30, 30, 1110), ctx);
    tool.onPointerDown!(atT(110, 10, 2000), ctx);
    expect(useScene.getState().selection).toEqual(["c2"]);
  });

  it("a click outside the entered group leaves it", () => {
    const tool = createSelectTool();
    const ctx = fakeCtx();
    useScene.getState().setSelection(["c1"]);
    tool.onPointerDown!(at(220, 220), ctx); // "solo", outside the group
    expect(useScene.getState().selection).toEqual(["solo"]);
    tool.onPointerDown!(at(30, 30), ctx);   // inside c1 again: the group
    expect(useScene.getState().selection).toEqual(["g"]);
  });

  // A double click on a text already has a meaning (editing). Inside a
  // group the two are put in sequence instead of in competition: first you enter,
  // then you type.
  it("on a text node inside a group, the first double click enters and the second opens the editor", () => {
    useScene.getState().setScene({
      ...emptyScene("doc-1", "u"),
      nodes: nodesOf({
        g: node("g", 0, "a000001", { kind: "group", width: 0, height: 0 }),
        t: node("t", 10, "a000001", { parentId: "g", y: 10, kind: "text",
          text: { content: "hello", style: { fontFamily: "", fontSize: 16, fontWeight: "400", lineHeight: 1.2, align: "left" } } }),
      }),
    });
    const tool = createSelectTool();
    const ctx = fakeCtx();
    tool.onPointerDown!(atT(30, 30, 1000), ctx);
    tool.onPointerDown!(atT(30, 30, 1100), ctx);
    tool.onPointerUp!(atT(30, 30, 1110), ctx);
    expect(useScene.getState().selection).toEqual(["t"]);
    expect(useScene.getState().editingNodeId).toBeNull();

    tool.onPointerDown!(atT(30, 30, 2000), ctx);
    tool.onPointerDown!(atT(30, 30, 2100), ctx);
    tool.onPointerUp!(atT(30, 30, 2110), ctx);
    expect(useScene.getState().editingNodeId).toBe("t");
  });

  it("a marquee over a child of a group selects the group, once", () => {
    const tool = createSelectTool();
    const ctx = fakeCtx();
    tool.onPointerDown!(at(-5, -5), ctx);
    tool.onPointerMove!(at(130, 70), ctx); // takes c1 AND c2
    tool.onPointerUp!(at(130, 70), ctx);
    expect(useScene.getState().selection).toEqual(["g"]);
  });

  // The opposite direction, and the reason the group NEVER enters the marquee on its own:
  // "g" is born 0x0 at (0,0), i.e. at the origin of its parent. A
  // band around the origin touches no child (c1 starts at 10,10 and c2 at
  // 100,0), so it must select nothing. Taking the group's own box
  // the selection would end up with a frame and 8 handles around
  // content entirely outside the band -- and the next drag would send
  // setProps for a geometry the user did not frame.
  it("a marquee that misses every child does NOT select the group by its own 0x0 box at the origin", () => {
    const tool = createSelectTool();
    const ctx = fakeCtx();
    tool.onPointerDown!(at(-5, -5), ctx);
    tool.onPointerMove!(at(5, 5), ctx);
    tool.onPointerUp!(at(5, 5), ctx);
    expect(useScene.getState().selection).toEqual([]);
  });

  // ...and the group remains reachable with the marquee even when its own
  // box is OUTSIDE the band: what puts it in the selection is the policy
  // that climbs up from the children, not an invisible rectangle at the origin.
  it("a marquee on one child alone still selects the group, whose own box is outside the band", () => {
    const tool = createSelectTool();
    const ctx = fakeCtx();
    tool.onPointerDown!(at(95, -5), ctx);
    tool.onPointerMove!(at(125, 25), ctx); // only c2: (100,0)-(120,20)
    tool.onPointerUp!(at(125, 25), ctx);
    expect(useScene.getState().selection).toEqual(["g"]);
  });

  // The group has no box of its own: the frame (and thus the handles) sit
  // on the union of the children, and it is from there that the resize must start.
  it("moving a group moves its children, with ONE op", () => {
    useScene.getState().setSelection(["g"]);
    const sync = new FakeSync();
    useScene.getState().setSync(sync);
    const tool = createSelectTool();
    const ctx = fakeCtx();
    const before = worldBoundsOfNode(useScene.getState().scene!, useScene.getState().scene!.nodes.at("c1"));

    tool.onPointerDown!(at(30, 30), ctx);
    tool.onPointerMove!(at(50, 40), ctx); // +20, +10
    tool.onPointerUp!(at(50, 40), ctx);

    expect(sync.sent).toHaveLength(1);
    const scene = useScene.getState().scene!;
    expect(scene.nodes.at("g")).toMatchObject({ x: 20, y: 10 });
    expect(scene.nodes.at("c1")).toMatchObject({ x: 10, y: 10 }); // the local is not touched
    expect(worldBoundsOfNode(scene, scene.nodes.at("c1"))).toMatchObject({ x: before.x + 20, y: before.y + 10 });
  });

  it("resizing a group resizes its children: the group has no box of its own to rewrite", () => {
    useScene.getState().setSelection(["g"]);
    const sync = new FakeSync();
    useScene.getState().setSync(sync);
    const tool = createSelectTool();
    const ctx = fakeCtx();

    // se handle of the UNION (10,0)-(120,60), dragged to double. Alt
    // turns snap off: here the group resize MATH is tested, and without
    // Alt the moving edge (x=230) would snap to the center of `solo` (x=225, within
    // the threshold) -- snap has its own dedicated tests, this one does not.
    tool.onPointerDown!(at(120, 60), ctx);
    tool.onPointerMove!(atMod(230, 120, { altKey: true }), ctx);
    tool.onPointerUp!(atMod(230, 120, { altKey: true }), ctx);

    const scene = useScene.getState().scene!;
    expect(sync.sent).toHaveLength(2); // one op per child, none for the group
    expect(scene.nodes.at("g")).toMatchObject({ x: 0, y: 0, width: 0, height: 0 });
    expect(scene.nodes.at("c1")).toMatchObject({ x: 10, y: 20, width: 100, height: 100 });
    expect(scene.nodes.at("c2")).toMatchObject({ x: 190, y: 0, width: 40, height: 40 });
  });

  // THE TRAP of task 1: with nesting a selection containing an
  // ancestor AND one of its descendants would produce a second deleteNode that the
  // server rejects (the descendant is already gone in the cascade) -- and invertChain
  // would return null for the WHOLE gesture: a deleted, non-undoable group.
  it("Delete on a group AND one of its children sends ONE op, and the gesture stays undoable", () => {
    useScene.getState().setSelection(["g", "c1"]);
    const sync = new FakeSync();
    useScene.getState().setSync(sync);
    const undoBefore = useScene.getState().undoStack.length;

    createSelectTool().onKeyDown!({ key: "Delete" } as KeyboardEvent, fakeCtx());

    const deleted = sync.sent.map((op) => (op.kind.case === "deleteNode" ? op.kind.value.id : ""));
    expect(deleted).toEqual(["g"]);
    expect(useScene.getState().scene!.nodes.at("c1")).toBeUndefined();
    const stack = useScene.getState().undoStack;
    expect(stack).toHaveLength(undoBefore + 1);
    expect(stack[stack.length - 1]).toHaveLength(3); // g + c1 + c2 to recreate

    useScene.getState().undo();
    const scene = useScene.getState().scene!;
    expect(scene.nodes.at("g")?.kind).toBe("group");
    expect(scene.nodes.at("c1")?.parentId).toBe("g");
    expect(scene.nodes.at("c2")?.parentId).toBe("g");
  });

  describe("Ctrl+G / Ctrl+Shift+G", () => {
    beforeEach(() => {
      useScene.getState().setScene({
        ...emptyScene("doc-1", "u"),
        nodes: nodesOf({
          r1: node("r1", 0, "a000001"),
          r2: node("r2", 100, "a000002"),
          r3: node("r3", 200, "a000003"),
        }),
      });
    });

    it("Ctrl+G groups the selection in ONE gesture, and one Ctrl+Z undoes the whole thing", () => {
      useScene.getState().setSelection(["r1", "r3"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const undoBefore = useScene.getState().undoStack.length;

      createSelectTool().onKeyDown!(ctrl("g"), fakeCtx());

      expect(sync.sent.map((o) => o.kind.case)).toEqual(["createNode", "reparentNode", "reparentNode"]);
      const gid = useScene.getState().selection[0];
      const scene = useScene.getState().scene!;
      expect(scene.nodes.at(gid).kind).toBe("group");
      expect(scene.nodes.at("r1").parentId).toBe(gid);
      expect(scene.nodes.at("r3").parentId).toBe(gid);
      expect(scene.nodes.at("r2").parentId).toBe("page1"); // not selected, not touched
      // A SINGLE undo entry for the three ops.
      expect(useScene.getState().undoStack).toHaveLength(undoBefore + 1);

      useScene.getState().undo();
      const after = useScene.getState().scene!;
      expect(after.nodes.at(gid)).toBeUndefined();
      expect(after.nodes.at("r1")).toMatchObject({ parentId: "page1", orderKey: "a000001" });
      expect(after.nodes.at("r3")).toMatchObject({ parentId: "page1", orderKey: "a000003" });

      useScene.getState().redo();
      expect(useScene.getState().scene!.nodes.at("r1").parentId).toBe(gid);
    });

    it("Ctrl+Shift+G ungroups in one gesture, and one Ctrl+Z puts the group back", () => {
      useScene.getState().setSelection(["r1", "r3"]);
      useScene.getState().setSync(new FakeSync());
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onKeyDown!(ctrl("g"), ctx);
      const gid = useScene.getState().selection[0];
      const undoAfterGroup = useScene.getState().undoStack.length;

      tool.onKeyDown!(ctrl("g", true), ctx);

      const scene = useScene.getState().scene!;
      expect(scene.nodes.at(gid)).toBeUndefined();
      expect(scene.nodes.at("r1").parentId).toBe("page1");
      expect(scene.nodes.at("r3").parentId).toBe("page1");
      // The freed children stay selected, and in their order.
      expect(useScene.getState().selection).toEqual(["r1", "r3"]);
      expect(useScene.getState().undoStack).toHaveLength(undoAfterGroup + 1);

      useScene.getState().undo();
      const after = useScene.getState().scene!;
      expect(after.nodes.at(gid)?.kind).toBe("group");
      expect(after.nodes.at("r1").parentId).toBe(gid);
      expect(after.nodes.at("r3").parentId).toBe(gid);
    });

    it("Ctrl+G keeps the world position of a node that comes from another group", () => {
      useScene.getState().setScene({
        ...emptyScene("doc-1", "u"),
        nodes: nodesOf({
          g: node("g", 100, "a000001", { kind: "group", width: 0, height: 0, y: 100 }),
          inner: node("inner", 10, "a000001", { parentId: "g", y: 10 }),
          solo: node("solo", 300, "a000002", { y: 300 }),
        }),
      });
      useScene.getState().setSelection(["inner", "solo"]);
      useScene.getState().setSync(new FakeSync());
      const before = worldBoundsOfNode(useScene.getState().scene!, useScene.getState().scene!.nodes.at("inner"));

      createSelectTool().onKeyDown!(ctrl("g"), fakeCtx());

      const scene = useScene.getState().scene!;
      const gid = useScene.getState().selection[0];
      expect(scene.nodes.at(gid).kind).toBe("group");
      // "inner" left the space of "g" (which translated by 100,100) to
      // enter the new group, which sits under the page: without rewriting its
      // coordinates it would shift by 100px.
      expect(scene.nodes.at("inner")).toMatchObject({ parentId: gid, x: 110, y: 110 });
      expect(worldBoundsOfNode(scene, scene.nodes.at("inner"))).toEqual(before);
    });

    it("Ctrl+G with nothing selected, and Ctrl+Shift+G with no group selected, send nothing", () => {
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onKeyDown!(ctrl("g"), ctx);
      useScene.getState().setSelection(["r1"]);
      tool.onKeyDown!(ctrl("g", true), ctx);
      expect(sync.sent).toHaveLength(0);
      expect(useScene.getState().undoStack).toHaveLength(0);
    });

    it("Ctrl+G abandons a gesture in progress instead of nesting one inside it", () => {
      useScene.getState().setSelection(["r1"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(10, 10), ctx);
      tool.onPointerMove!(at(30, 10), ctx); // drag open
      tool.onKeyDown!(ctrl("g"), ctx);
      // The drag was abandoned (no setProps on the wire) and the
      // grouping went through.
      expect(sync.sent.map((o) => o.kind.case)).toEqual(["createNode", "reparentNode"]);
      // The pointerup that arrives anyway afterwards sends nothing else.
      tool.onPointerUp!(at(30, 10), ctx);
      expect(sync.sent).toHaveLength(2);
    });
  });
});

// COMPONENT CREATION (Ctrl/Cmd+Alt+K). The selected node becomes the
// MASTER: it stays where it is (no op moves it) and a single CreateComponent
// registers it. Only with EXACTLY one node selected -- wrapping a
// multi-selection is later work, so zero or more than one is a no-op.
describe("creating a component (Ctrl+Alt+K)", () => {
  const cmk = () =>
    ({
      key: "k", code: "KeyK", ctrlKey: true, metaKey: false, altKey: true, shiftKey: false,
      preventDefault: vi.fn(),
    }) as unknown as KeyboardEvent;

  it("with ONE node selected it emits a single CreateComponent with that node as root", () => {
    const sync = new FakeSync();
    useScene.getState().setSync(sync);
    useScene.getState().setSelection(["a"]);

    createSelectTool().onKeyDown!(cmk(), fakeCtx());

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0];
    expect(op.kind.case).toBe("createComponent");
    if (op.kind.case === "createComponent") {
      expect(op.kind.value.rootNodeId).toBe("a");
      expect(op.kind.value.componentId).not.toBe("");
    }
    const comps = Object.values(useScene.getState().scene!.components);
    expect(comps).toHaveLength(1);
    expect(comps[0].rootNodeId).toBe("a");
    // createComponent is NOT undoable in M4: the proto has no DeleteComponent
    // and invertOp returns null (see store/history.ts), so the op goes out and
    // registers the component but pushes no undo entry. The node does NOT
    // move: it becomes the master where it is.
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().scene!.nodes.at("a").x).toBe(0);
  });

  it("preventDefault always (in a browser the combination may have a meaning of its own)", () => {
    const e = cmk();
    useScene.getState().setSync(new FakeSync());
    useScene.getState().setSelection(["b"]);
    createSelectTool().onKeyDown!(e, fakeCtx());
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("is a NO-OP with zero or more than one node selected (no gesture left open)", () => {
    const sync = new FakeSync();
    useScene.getState().setSync(sync);
    const tool = createSelectTool();

    useScene.getState().setSelection([]);
    tool.onKeyDown!(cmk(), fakeCtx());
    useScene.getState().setSelection(["a", "b"]);
    tool.onKeyDown!(cmk(), fakeCtx());

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().scene!.components).toEqual({});
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().gesture).toBeNull();
  });
});

// SCOPING TO THE CURRENT PAGE. Click and marquee answer on the roots of the
// CURRENT page ONLY, exactly as the renderer draws them: see-vs-
// select. pickTarget/nodesInMarquee receive currentPageId (absent =
// first page, the store default); the tool reads it from the store.
describe("scoping to the current page", () => {
  // Two pages, one node per page, overlapping in the world (both 50x50 at
  // (0,0)): the point (25,25) and the band (0,0)-(50,50) fall on both.
  function twoPages() {
    const s = emptyScene("doc-1", "u");
    s.pages = [{ id: "page1", name: "P1" }, { id: "page2", name: "P2" }];
    s.nodes = s.nodes.set("a", node("a", 0, "a000000"));
    s.nodes = s.nodes.set("b", node("b", 0, "a000001", { parentId: "page2" }));
    return s;
  }

  it("pickTarget hits only the node of the current page", () => {
    const s = twoPages();
    expect(pickTarget(s, { x: 25, y: 25 }, false, [], 1, "page1")).toEqual({ mode: "single", id: "a" });
    expect(pickTarget(s, { x: 25, y: 25 }, false, [], 1, "page2")).toEqual({ mode: "single", id: "b" });
  });

  it("nodesInMarquee takes only the nodes of the current page", () => {
    const s = twoPages();
    const band = { x: 0, y: 0, width: 50, height: 50 };
    expect(nodesInMarquee(s, band, "page1")).toEqual(["a"]);
    expect(nodesInMarquee(s, band, "page2")).toEqual(["b"]);
  });

  it("a click with Select on the second page selects ITS node, not the one of the first page", () => {
    useScene.getState().setScene(twoPages());
    useScene.getState().setCurrentPage("page2");
    const tool = createSelectTool();
    const ctx = fakeCtx();
    tool.onPointerDown!(at(25, 25), ctx);
    tool.onPointerUp!(at(25, 25), ctx);
    expect(useScene.getState().selection).toEqual(["b"]);
  });
});
