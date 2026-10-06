import { nodesOf , nodesWith } from "../store/nodeMap";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTextTool, DEFAULT_TEXT_HEIGHT, DEFAULT_TEXT_WIDTH } from "./textTool";
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
    editingNodeId: null,
  });
  // setScene and not setState({scene}): installs a COHERENT scene (view and
  // confirmed aligned, empty queue) -- the invariant that the
  // confirmed/pending reconciliation relies on (see store/store.ts).
  useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
});

describe("textTool", () => {
  it("click creates an empty text node with the default size in ONE gesture, and immediately enters editing", () => {
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx();

    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerUp!(at(10, 20), ctx);

    expect(submitted).toHaveLength(1);
    const n = createdNode(submitted[0]);
    expect(n.shape.case).toBe("text");
    if (n.shape.case !== "text") throw new Error("unreachable");
    expect(n.shape.value.content).toBe("");
    expect({ x: n.x, y: n.y, width: n.width, height: n.height })
      .toEqual({ x: 10, y: 20, width: DEFAULT_TEXT_WIDTH, height: DEFAULT_TEXT_HEIGHT });
    expect(n.parentId).toBe("page1");
    expect(n.visible).toBe(true);

    // it enters editing IMMEDIATELY: it is the behavior in the brief, different from
    // rect/ellipse (which remain creation-only tools).
    expect(useScene.getState().editingNodeId).toBe(n.id);

    // a single undo entry: creation goes through one gesture.
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().canUndo).toBe(true);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("the newly created node is born with an explicit style, not with zeros", () => {
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);

    const n = createdNode(submitted[0]);
    if (n.shape.case !== "text") throw new Error("unreachable");
    const style = n.shape.value.style;
    expect(style).toBeDefined();
    expect(style!.fontSize).toBeGreaterThan(0);
    expect(style!.fontFamily).not.toBe("");
    expect(style!.fontWeight).not.toBe("");
    expect(style!.lineHeight).toBeGreaterThan(0);
  });

  it("the newly created node has an explicit fill (readable, not the default gray of shapes)", () => {
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);

    const n = createdNode(submitted[0]);
    expect(n.fills).toHaveLength(1);
    expect(n.fills[0].kind.case).toBe("solid");
  });

  it("the drag creates a text node of the dragged width (the wrap will use that width)", () => {
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx();

    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerMove!(at(210, 60), ctx);
    expect(submitted).toHaveLength(0); // no ops during the drag

    tool.onPointerUp!(at(210, 60), ctx);
    expect(submitted).toHaveLength(1);
    const n = createdNode(submitted[0]);
    expect({ x: n.x, y: n.y, width: n.width, height: n.height }).toEqual({ x: 10, y: 20, width: 200, height: 40 });
    expect(useScene.getState().editingNodeId).toBe(n.id);
  });

  it("normalizes a backwards drag", () => {
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(210, 100), ctx);
    tool.onPointerUp!(at(10, 60), ctx);
    const n = createdNode(submitted[0]);
    expect({ x: n.x, y: n.y, width: n.width, height: n.height }).toEqual({ x: 10, y: 60, width: 200, height: 40 });
  });

  it("a drag under the threshold (in SCREEN px) stays a click at any zoom", () => {
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx(64); // heavily zoomed: 0.02 world units = ~1px screen
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerMove!(at(10.02, 20.02), ctx);
    tool.onPointerUp!(at(10.02, 20.02), ctx);
    const n = createdNode(submitted[0]);
    expect(n.width).toBe(DEFAULT_TEXT_WIDTH);
    expect(n.height).toBe(DEFAULT_TEXT_HEIGHT);
  });

  it("derives the order key from the scene, so it never collides after a reload", () => {
    useScene.getState().setScene({ ...emptyScene("doc-1", "u"), nodes: nodesOf({ a: node("a", "a000004") }) });
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(10, 10), ctx);
    expect(createdNode(submitted[0]).orderKey).toBe("a000005");
  });

  it("shows a live preview during the drag and clears it on up", () => {
    const tool = createTextTool();
    const { ctx } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerMove!(at(60, 80), ctx);
    expect(useScene.getState().marquee).toEqual({ x: 10, y: 20, width: 50, height: 60 });
    tool.onPointerUp!(at(60, 80), ctx);
    expect(useScene.getState().marquee).toBeNull();
  });

  it("the newly created node is selected", () => {
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerUp!(at(10, 20), ctx);
    const n = createdNode(submitted[0]);
    expect(useScene.getState().selection).toEqual([n.id]);
  });

  it("abandons the gesture on deactivate: no op, no preview, no editing, the next up does nothing", () => {
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerMove!(at(60, 80), ctx);
    tool.onDeactivate!(ctx);
    expect(submitted).toHaveLength(0);
    expect(useScene.getState().marquee).toBeNull();
    expect(useScene.getState().editingNodeId).toBeNull();

    tool.onPointerUp!(at(60, 80), ctx);
    expect(submitted).toHaveLength(0);
  });

  it("undoing the creation of a just-drawn text removes the node (and redo puts it back)", () => {
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerUp!(at(60, 80), ctx);
    const id = createdNode(submitted[0]).id;
    expect(useScene.getState().scene!.nodes.at(id).kind).toBe("text");

    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at(id)).toBeUndefined();

    useScene.getState().redo();
    expect(useScene.getState().scene!.nodes.at(id).kind).toBe("text");
  });

  // Concrete repro of the review bug (Task 4, fix round): two consecutive
  // creations with textTool, never explicitly leaving editing between
  // the two. onPointerUp calls beginTextEditing(id) UNCONDITIONALLY on every
  // click -- without the guard in store.ts, the first node (left empty)
  // would have been abandoned: never passed through endTextEditing, never cleaned up, a
  // permanent ghost node.
  it("a second text tool click closes/cleans up the editing of the first node (still empty) instead of abandoning it as a ghost", () => {
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx();

    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerUp!(at(10, 20), ctx);
    const first = createdNode(submitted[0]).id;
    expect(useScene.getState().editingNodeId).toBe(first);
    expect(useScene.getState().scene!.nodes.at(first)).toBeDefined();

    tool.onPointerDown!(at(300, 20), ctx);
    tool.onPointerUp!(at(300, 20), ctx);
    // The cleanup of the first node travels BEFORE the second creation (see
    // the order test below): the creation op is the last on the wire.
    const second = createdNode(submitted[submitted.length - 1]).id;

    expect(useScene.getState().editingNodeId).toBe(second);
    expect(useScene.getState().scene!.nodes.at(first)).toBeUndefined(); // no ghost node
    expect(useScene.getState().scene!.nodes.at(second)).toBeDefined();
  });

  // Second review finding (fix round): the cleanup of the previous node
  // left its undo entry AFTER that of the new creation -- the first
  // Ctrl+Z resurrected the just-cleaned empty node instead of undoing the
  // newly created one. The order must be the user's chronological one.
  it("the cleanup of the previous node enters history BEFORE the new creation (Ctrl+Z undoes the last thing done)", () => {
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx();

    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerUp!(at(10, 20), ctx);
    const first = createdNode(submitted[0]).id;

    tool.onPointerDown!(at(300, 20), ctx);
    tool.onPointerUp!(at(300, 20), ctx);

    // on the wire: create t1, delete t1 (left empty), create t2 -- in that order.
    expect(submitted.map((op) => op.kind.case)).toEqual(["createNode", "deleteNode", "createNode"]);
    const second = createdNode(submitted[2]).id;
    expect(useScene.getState().undoStack).toHaveLength(3);

    // the first Ctrl+Z undoes the creation just made...
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at(second)).toBeUndefined();
    expect(useScene.getState().scene!.nodes.at(first)).toBeUndefined();

    // ...and only the second brings back the cleaned-up node.
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at(first)).toBeDefined();
  });

  it("the second creation does not reuse the order key of the node just cleaned up", () => {
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx();

    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerUp!(at(10, 20), ctx);
    tool.onPointerDown!(at(300, 20), ctx);
    tool.onPointerUp!(at(300, 20), ctx);

    const firstKey = createdNode(submitted[0]).orderKey;
    const secondKey = createdNode(submitted[2]).orderKey;
    expect(secondKey > firstKey).toBe(true);
  });

  // Like rect/ellipse, the text is born UNDER the current page.
  it("creates the text node under the current page", () => {
    useScene.getState().setScene({
      ...emptyScene("doc-1", "u"),
      pages: [{ id: "page1", name: "Page 1" }, { id: "page2", name: "Page 2" }],
    });
    useScene.getState().setCurrentPage("page2");
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerUp!(at(10, 20), ctx);
    expect(createdNode(submitted[0]).parentId).toBe("page2");
  });
});

describe("store: editingNodeId / beginTextEditing / endTextEditing", () => {
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
      editingNodeId: null,
    });
    useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
  });

  it("beginTextEditing sets editingNodeId", () => {
    useScene.getState().beginTextEditing("n1");
    expect(useScene.getState().editingNodeId).toBe("n1");
  });

  it("endTextEditing clears it", () => {
    useScene.getState().beginTextEditing("n1");
    useScene.getState().endTextEditing();
    expect(useScene.getState().editingNodeId).toBeNull();
  });

  it("endTextEditing with no open editing is a silent no-op", () => {
    expect(() => useScene.getState().endTextEditing()).not.toThrow();
    expect(useScene.getState().editingNodeId).toBeNull();
  });

  it("an EMPTY text node that leaves editing without content is deleted, in an undoable gesture", () => {
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerUp!(at(10, 20), ctx);
    const id = createdNode(submitted[0]).id;
    expect(useScene.getState().scene!.nodes.at(id)).toBeDefined();
    expect(useScene.getState().editingNodeId).toBe(id);
    const undoDepthAfterCreate = useScene.getState().undoStack.length;

    useScene.getState().endTextEditing();

    expect(useScene.getState().editingNodeId).toBeNull();
    expect(useScene.getState().scene!.nodes.at(id)).toBeUndefined();
    expect(useScene.getState().undoStack.length).toBe(undoDepthAfterCreate + 1);

    // undoable: Ctrl+Z brings the (empty) node back onto the scene.
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at(id)).toBeDefined();
  });

  it("a text node with content is NOT deleted when leaving editing", () => {
    useScene.getState().setScene({
      ...emptyScene("doc-1", "u"),
      nodes: nodesOf({
        t1: {
          id: "t1", parentId: "page1", orderKey: "a000000", name: "Text", visible: true, opacity: 1,
          x: 0, y: 0, width: 100, height: 20, rotation: 0,
          fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false,
          text: { content: "hello", style: { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" } },
        },
      }),
    });
    useScene.getState().beginTextEditing("t1");
    useScene.getState().endTextEditing();
    expect(useScene.getState().editingNodeId).toBeNull();
    expect(useScene.getState().scene!.nodes.at("t1")).toBeDefined();
  });

  it("leaving the editing of a NON-text node (misuse) deletes nothing", () => {
    useScene.getState().setScene({ ...emptyScene("doc-1", "u"), nodes: nodesOf({ a: node("a", "a000000") }) });
    useScene.getState().beginTextEditing("a");
    useScene.getState().endTextEditing();
    expect(useScene.getState().scene!.nodes.at("a")).toBeDefined();
  });

  // Bug found in review: beginTextEditing overwrote editingNodeId without
  // EVER passing the previous session through endTextEditing -- a second
  // beginTextEditing (double-click on another text node, or a second
  // creation with the text tool) silently abandoned the previous node, which
  // if left empty stayed a ghost on the scene forever.
  describe("beginTextEditing closes/cleans up an already open session", () => {
    beforeEach(() => {
      useScene.getState().setScene({
        ...emptyScene("doc-1", "u"),
        nodes: nodesOf({
          t1: {
            id: "t1", parentId: "page1", orderKey: "a000000", name: "Text", visible: true, opacity: 1,
            x: 0, y: 0, width: 100, height: 20, rotation: 0,
            fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false,
            text: { content: "", style: { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" } },
          },
          t2: {
            id: "t2", parentId: "page1", orderKey: "a000001", name: "Text", visible: true, opacity: 1,
            x: 200, y: 0, width: 100, height: 20, rotation: 0,
            fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false,
            text: { content: "", style: { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" } },
          },
        }),
      });
    });

    it("switching from an EMPTY text node to another deletes it (no ghost), in an undoable gesture", () => {
      useScene.getState().beginTextEditing("t1");
      expect(useScene.getState().editingNodeId).toBe("t1");
      const undoDepthAfterFirstEdit = useScene.getState().undoStack.length;

      useScene.getState().beginTextEditing("t2");

      expect(useScene.getState().editingNodeId).toBe("t2");
      expect(useScene.getState().scene!.nodes.at("t1")).toBeUndefined(); // t1 cleaned up, not a ghost
      expect(useScene.getState().scene!.nodes.at("t2")).toBeDefined();
      expect(useScene.getState().undoStack.length).toBe(undoDepthAfterFirstEdit + 1);

      // undoable like any other cleanup (see endTextEditing).
      useScene.getState().undo();
      expect(useScene.getState().scene!.nodes.at("t1")).toBeDefined();
    });

    it("switching from a text node WITH content to another does not delete it", () => {
      useScene.getState().setScene({
        ...useScene.getState().scene!,
        nodes: nodesWith(useScene.getState().scene!.nodes, {
          t1: { ...useScene.getState().scene!.nodes.at("t1"), text: { content: "hello", style: useScene.getState().scene!.nodes.at("t1").text!.style } },
        }),
      });

      useScene.getState().beginTextEditing("t1");
      useScene.getState().beginTextEditing("t2");

      expect(useScene.getState().editingNodeId).toBe("t2");
      expect(useScene.getState().scene!.nodes.at("t1")).toBeDefined();
      expect(useScene.getState().scene!.nodes.at("t1").text?.content).toBe("hello");
    });

    it("calling beginTextEditing with the SAME node already in editing is a no-op (does not delete it)", () => {
      useScene.getState().beginTextEditing("t1");
      const undoDepth = useScene.getState().undoStack.length;

      useScene.getState().beginTextEditing("t1");

      expect(useScene.getState().editingNodeId).toBe("t1");
      expect(useScene.getState().scene!.nodes.at("t1")).toBeDefined();
      expect(useScene.getState().undoStack.length).toBe(undoDepth); // no spurious deletion
    });
  });
});
