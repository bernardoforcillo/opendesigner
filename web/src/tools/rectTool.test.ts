import { nodesOf } from "../store/nodeMap";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRectTool, DEFAULT_RECT_HEIGHT, DEFAULT_RECT_WIDTH } from "./rectTool";
import type { ToolContext } from "./types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";

function node(id: string, orderKey: string): NodeLite {
  return { id, parentId: "page1", orderKey, name: id, visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10, rotation: 0, fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false };
}

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

// Double of ToolContext: toWorld is the identity on clientX/clientY, so the tests
// reason directly in world coordinates. The real conversion is tested in
// canvas/camera.test.ts.
// The transport must be registered ON THE STORE, not just on the context: creation
// goes through endGesture, which submits via the store (like every other gesture).
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

function createdNode(op: Op) {
  if (op.kind.case !== "createNode") throw new Error(`expected createNode, got ${op.kind.case}`);
  const n = op.kind.value.node;
  if (!n) throw new Error("createNode without node");
  return n;
}

beforeEach(() => {
  useScene.setState({
    camera: { x: 0, y: 0, zoom: 1 },
    selection: [],
    marquee: null,
    sync: null,
    gesture: null,
    undoStack: [],
    redoStack: [],
    canUndo: false,
    canRedo: false,
  });
  // setScene and not setState({scene}): installs a COHERENT scene (view and
  // confirmed aligned, empty queue) -- the invariant that the
  // confirmed/pending reconciliation relies on (see store/store.ts).
  useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
});

describe("rectTool", () => {
  it("down/move/up emits exactly one createNode op with the dragged bounds", () => {
    const tool = createRectTool();
    const { ctx, submitted } = fakeCtx();

    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerMove!(at(40, 50), ctx);
    tool.onPointerMove!(at(60, 80), ctx);
    expect(submitted).toHaveLength(0); // no ops during the drag

    tool.onPointerUp!(at(60, 80), ctx);
    expect(submitted).toHaveLength(1);
    const n = createdNode(submitted[0]);
    expect({ x: n.x, y: n.y, width: n.width, height: n.height }).toEqual({ x: 10, y: 20, width: 50, height: 60 });
    expect(n.shape.case).toBe("rect");
    expect(n.parentId).toBe("page1");
    expect(n.visible).toBe(true);
  });

  it("normalizes a backwards drag", () => {
    const tool = createRectTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(100, 100), ctx);
    tool.onPointerUp!(at(40, 60), ctx);
    const n = createdNode(submitted[0]);
    expect({ x: n.x, y: n.y, width: n.width, height: n.height }).toEqual({ x: 40, y: 60, width: 60, height: 40 });
  });

  it("uses the default size when the gesture is just a click", () => {
    const tool = createRectTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerUp!(at(10, 20), ctx);
    const n = createdNode(submitted[0]);
    expect({ x: n.x, y: n.y, width: n.width, height: n.height })
      .toEqual({ x: 10, y: 20, width: DEFAULT_RECT_WIDTH, height: DEFAULT_RECT_HEIGHT });
  });

  it("treats a sub-pixel drag as a click at any zoom (threshold is in screen px)", () => {
    const tool = createRectTool();
    const { ctx, submitted } = fakeCtx(64); // heavily zoomed: 0.02 world units = ~1px screen
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerMove!(at(10.02, 20.02), ctx);
    tool.onPointerUp!(at(10.02, 20.02), ctx);
    const n = createdNode(submitted[0]);
    expect(n.width).toBe(DEFAULT_RECT_WIDTH);
    expect(n.height).toBe(DEFAULT_RECT_HEIGHT);
  });

  it("derives the order key from the scene so it never collides after a reload", () => {
    useScene.getState().setScene({ ...emptyScene("doc-1", "u"), nodes: nodesOf({ a: node("a", "a000004") }) });
    const tool = createRectTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(10, 10), ctx);
    expect(createdNode(submitted[0]).orderKey).toBe("a000005");
  });

  it("shows a live preview while dragging and clears it on up", () => {
    const tool = createRectTool();
    const { ctx } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerMove!(at(60, 80), ctx);
    expect(useScene.getState().marquee).toEqual({ x: 10, y: 20, width: 50, height: 60 });
    tool.onPointerUp!(at(60, 80), ctx);
    expect(useScene.getState().marquee).toBeNull();
  });

  it("abandons the gesture on deactivate: no op, no preview, and the next up does nothing", () => {
    const tool = createRectTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerMove!(at(60, 80), ctx);
    tool.onDeactivate!(ctx);
    expect(submitted).toHaveLength(0);
    expect(useScene.getState().marquee).toBeNull();

    tool.onPointerUp!(at(60, 80), ctx);
    expect(submitted).toHaveLength(0);
  });

  // Drawing is a gesture like all the others: it goes through beginGesture/
  // endGesture, so it leaves ONE undo entry -- without changing the count
  // of ops on the wire, which stays just one (one gesture = one submit).
  it("records exactly one undo entry without adding ops to the wire", () => {
    const tool = createRectTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerMove!(at(60, 80), ctx);
    tool.onPointerUp!(at(60, 80), ctx);

    expect(submitted).toHaveLength(1);
    const st = useScene.getState();
    expect(st.undoStack).toHaveLength(1);
    expect(st.canUndo).toBe(true);
    expect(st.gesture).toBeNull(); // the gesture is closed: undo/redo are not blocked
  });

  it("undoing a freshly drawn rect removes the node (and redo puts it back)", () => {
    const tool = createRectTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerUp!(at(60, 80), ctx);
    const id = createdNode(submitted[0]).id;
    expect(useScene.getState().scene!.nodes.at(id)).toBeDefined();

    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at(id)).toBeUndefined();
    expect(useScene.getState().canUndo).toBe(false);
    expect(useScene.getState().canRedo).toBe(true);

    useScene.getState().redo();
    expect(useScene.getState().scene!.nodes.at(id)).toBeDefined();
    expect(useScene.getState().scene!.nodes.at(id).width).toBe(50);
  });

  it("an abandoned gesture leaves no undo entry", () => {
    const tool = createRectTool();
    const { ctx } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerMove!(at(60, 80), ctx);
    tool.onDeactivate!(ctx);
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().canUndo).toBe(false);
  });

  it("does not move or select anything: pointermove without a pending create is inert", () => {
    const tool = createRectTool();
    const { ctx, submitted } = fakeCtx();
    useScene.setState({ selection: [] });
    useScene.getState().setScene({ ...emptyScene("doc-1", "u"), nodes: nodesOf({ a: node("a", "a000000") }) });
    tool.onPointerMove!(at(5, 5), ctx);
    tool.onPointerUp!(at(5, 5), ctx);
    expect(submitted).toHaveLength(0);
    expect(useScene.getState().selection).toEqual([]);
  });

  // The node is born UNDER the current page, not always "page1": drawing
  // while on a second page creates the node there.
  it("creates the node under the CURRENT page", () => {
    useScene.getState().setScene({
      ...emptyScene("doc-1", "u"),
      pages: [{ id: "page1", name: "Page 1" }, { id: "page2", name: "Page 2" }],
    });
    useScene.getState().setCurrentPage("page2");
    const tool = createRectTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerUp!(at(60, 80), ctx);
    expect(createdNode(submitted[0]).parentId).toBe("page2");
    // And the node really landed under page2 in the scene.
    expect(useScene.getState().scene!.nodes.at(createdNode(submitted[0]).id).parentId).toBe("page2");
  });
});
