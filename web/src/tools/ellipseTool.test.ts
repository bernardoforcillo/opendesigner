import { describe, it, expect, beforeEach, vi } from "vitest";
import { createEllipseTool, DEFAULT_ELLIPSE_HEIGHT, DEFAULT_ELLIPSE_WIDTH } from "./ellipseTool";
import type { ToolContext } from "./types";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";

function node(id: string, orderKey: string): NodeLite {
  return { id, parentId: "page1", orderKey, name: id, visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10, rotation: 0, fills: [], kind: "rect", cornerRadius: 0, clipsContent: false };
}

// Doppio di SyncClient (vedi rpc/syncClient.ts): registra gli op che finiscono
// SUL FILO e modella un server che accetta ed ECOA subito -- applyPending (op
// in volo, visibile subito) seguito da apply (l'eco che lo conferma). Senza
// l'eco ogni op resterebbe in coda per sempre e i test parlerebbero di uno
// stato che il server non ha mai visto. Lo store dipende solo dalla superficie
// { submit }, quindi non serve un SyncClient reale (niente rete nei test).
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

// Doppio del ToolContext: toWorld è l'identità su clientX/clientY, così i test
// ragionano direttamente in coordinate mondo. La conversione vera è testata in
// canvas/camera.test.ts.
// Il trasporto va registrato SULLO STORE, non solo sul contesto: la creazione
// passa da endGesture, che submitta tramite lo store (come ogni altro gesto).
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
  // setScene e non setState({scene}): installa una scena COERENTE (vista e
  // confermato allineati, coda vuota) -- l'invariante su cui poggia la
  // riconciliazione confermato/pending (vedi store/store.ts).
  useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
});

describe("ellipseTool", () => {
  it("down/move/up emits exactly one createNode op with the dragged bounds", () => {
    const tool = createEllipseTool();
    const { ctx, submitted } = fakeCtx();

    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerMove!(at(40, 50), ctx);
    tool.onPointerMove!(at(60, 80), ctx);
    expect(submitted).toHaveLength(0); // niente op durante il drag

    tool.onPointerUp!(at(60, 80), ctx);
    expect(submitted).toHaveLength(1);
    const n = createdNode(submitted[0]);
    expect({ x: n.x, y: n.y, width: n.width, height: n.height }).toEqual({ x: 10, y: 20, width: 50, height: 60 });
    expect(n.shape.case).toBe("ellipse");
    expect(n.parentId).toBe("page1");
    expect(n.visible).toBe(true);
  });

  it("normalizes a backwards drag", () => {
    const tool = createEllipseTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(100, 100), ctx);
    tool.onPointerUp!(at(40, 60), ctx);
    const n = createdNode(submitted[0]);
    expect({ x: n.x, y: n.y, width: n.width, height: n.height }).toEqual({ x: 40, y: 60, width: 60, height: 40 });
  });

  it("uses the default size when the gesture is just a click", () => {
    const tool = createEllipseTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerUp!(at(10, 20), ctx);
    const n = createdNode(submitted[0]);
    expect({ x: n.x, y: n.y, width: n.width, height: n.height })
      .toEqual({ x: 10, y: 20, width: DEFAULT_ELLIPSE_WIDTH, height: DEFAULT_ELLIPSE_HEIGHT });
  });

  it("treats a sub-pixel drag as a click at any zoom (threshold is in screen px)", () => {
    const tool = createEllipseTool();
    const { ctx, submitted } = fakeCtx(64); // molto zoomato: 0.02 unità mondo = ~1px schermo
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerMove!(at(10.02, 20.02), ctx);
    tool.onPointerUp!(at(10.02, 20.02), ctx);
    const n = createdNode(submitted[0]);
    expect(n.width).toBe(DEFAULT_ELLIPSE_WIDTH);
    expect(n.height).toBe(DEFAULT_ELLIPSE_HEIGHT);
  });

  it("derives the order key from the scene so it never collides after a reload", () => {
    useScene.getState().setScene({ ...emptyScene("doc-1", "u"), nodes: { a: node("a", "a000004") } });
    const tool = createEllipseTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(10, 10), ctx);
    expect(createdNode(submitted[0]).orderKey).toBe("a000005");
  });

  it("shows a live preview while dragging and clears it on up", () => {
    const tool = createEllipseTool();
    const { ctx } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerMove!(at(60, 80), ctx);
    expect(useScene.getState().marquee).toEqual({ x: 10, y: 20, width: 50, height: 60 });
    tool.onPointerUp!(at(60, 80), ctx);
    expect(useScene.getState().marquee).toBeNull();
  });

  it("abandons the gesture on deactivate: no op, no preview, and the next up does nothing", () => {
    const tool = createEllipseTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerMove!(at(60, 80), ctx);
    tool.onDeactivate!(ctx);
    expect(submitted).toHaveLength(0);
    expect(useScene.getState().marquee).toBeNull();

    tool.onPointerUp!(at(60, 80), ctx);
    expect(submitted).toHaveLength(0);
  });

  // Come per il rettangolo (rectTool.test.ts): il disegno è un gesto, quindi
  // UNA voce di undo e UN solo op sul filo.
  it("records exactly one undo entry without adding ops to the wire", () => {
    const tool = createEllipseTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerMove!(at(60, 80), ctx);
    tool.onPointerUp!(at(60, 80), ctx);

    expect(submitted).toHaveLength(1);
    const st = useScene.getState();
    expect(st.undoStack).toHaveLength(1);
    expect(st.canUndo).toBe(true);
    expect(st.gesture).toBeNull();
  });

  it("undoing a freshly drawn ellipse removes the node (and redo puts it back)", () => {
    const tool = createEllipseTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerUp!(at(60, 80), ctx);
    const id = createdNode(submitted[0]).id;
    expect(useScene.getState().scene!.nodes[id].kind).toBe("ellipse");

    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes[id]).toBeUndefined();

    useScene.getState().redo();
    expect(useScene.getState().scene!.nodes[id].kind).toBe("ellipse");
  });

  it("does not move or select anything: pointermove without a pending create is inert", () => {
    const tool = createEllipseTool();
    const { ctx, submitted } = fakeCtx();
    useScene.setState({ selection: [] });
    useScene.getState().setScene({ ...emptyScene("doc-1", "u"), nodes: { a: node("a", "a000000") } });
    tool.onPointerMove!(at(5, 5), ctx);
    tool.onPointerUp!(at(5, 5), ctx);
    expect(submitted).toHaveLength(0);
    expect(useScene.getState().selection).toEqual([]);
  });
});
