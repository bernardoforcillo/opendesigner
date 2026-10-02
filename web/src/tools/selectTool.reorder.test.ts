import { nodesOf } from "../store/nodeMap";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSelectTool } from "./selectTool";
import type { ToolContext } from "./types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { AutoLayoutLite, NodeLite } from "../store/types";

const AL: AutoLayoutLite = {
  direction: "horizontal", spacing: 10, paddingLeft: 0, paddingTop: 0, paddingRight: 0, paddingBottom: 0,
  mainAlign: "start", crossAlign: "start", hugWidth: false, hugHeight: false,
};

function node(id: string, parentId: string, key: string, over: Partial<NodeLite> = {}): NodeLite {
  return {
    id, parentId, orderKey: key, name: id, visible: true, opacity: 1, x: 0, y: 0, width: 50, height: 50, rotation: 0,
    fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
  };
}

class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

function fakeCtx(): ToolContext {
  return {
    sync: { submit: vi.fn() },
    getScene: () => useScene.getState().scene,
    getCamera: () => useScene.getState().camera,
    setCamera: vi.fn(),
    canvas: { style: { cursor: "" } } as unknown as HTMLCanvasElement,
    toWorld: (e: PointerEvent) => ({ x: e.clientX, y: e.clientY }),
  } as unknown as ToolContext;
}
const at = (x: number, y: number) => ({ clientX: x, clientY: y, shiftKey: false }) as PointerEvent;

// Un frame 400x100 a (0,0) con auto layout: a, b, c da 50 a x = 0, 60, 120.
function install(autoLayout: AutoLayoutLite | null) {
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], marquee: null, snapGuides: [], gesture: null, sync: null, layoutDrop: null });
  useScene.getState().setScene({
    ...emptyScene("doc-1", "u"),
    nodes: nodesOf({
      f: node("f", "page1", "a0", { kind: "frame", width: 400, height: 100, ...(autoLayout ? { autoLayout } : {}) }),
      a: node("a", "f", "a"),
      b: node("b", "f", "b", { x: 60 }),
      c: node("c", "f", "c", { x: 120 }),
    }),
  });
}

const orderOf = () =>
  [...useScene.getState().scene!.nodes.values()]
    .filter((n) => n.parentId === "f")
    .sort((p, q) => (p.orderKey < q.orderKey ? -1 : 1))
    .map((n) => n.id);

describe("trascinare un figlio di un auto layout", () => {
  beforeEach(() => install(AL));

  it("non scrive x/y: mostra la linea d'inserimento e il contorno che segue il puntatore", () => {
    const sync = new FakeSync();
    useScene.getState().setSync(sync);
    const tool = createSelectTool();
    const ctx = fakeCtx();
    tool.onPointerDown!(at(25, 25), ctx);
    expect(useScene.getState().selection).toEqual(["a"]);
    tool.onPointerMove!(at(170, 30), ctx);

    const scene = useScene.getState().scene!;
    expect(scene.nodes.at("a")).toMatchObject({ x: 0, y: 0 }); // il nodo non si è mosso
    expect(sync.sent).toHaveLength(0);
    const drop = useScene.getState().layoutDrop;
    expect(drop).not.toBeNull();
    // Il contorno è il riquadro di partenza di a traslato dello spostamento del puntatore.
    expect(drop!.ghost).toMatchObject({ x: 145, y: 5, width: 50, height: 50 });
    expect(drop!.indicator.height).toBe(100); // alta quanto il frame
  });

  it("al rilascio riordina con UN op di order_key e il layout rimette le posizioni", () => {
    const sync = new FakeSync();
    useScene.getState().setSync(sync);
    const tool = createSelectTool();
    const ctx = fakeCtx();
    tool.onPointerDown!(at(25, 25), ctx);
    tool.onPointerMove!(at(170, 30), ctx);
    tool.onPointerUp!(at(170, 30), ctx);

    expect(sync.sent).toHaveLength(1);
    const op = sync.sent[0].kind;
    expect(op.case).toBe("setProps");
    expect(op.case === "setProps" && op.value.mask?.paths).toEqual(["order_key"]);
    expect(orderOf()).toEqual(["b", "c", "a"]);
    const n = useScene.getState().scene!.nodes;
    expect([n.at("b").x, n.at("c").x, n.at("a").x]).toEqual([0, 60, 120]);
    expect(useScene.getState().layoutDrop).toBeNull();
    expect(useScene.getState().gesture).toBeNull();
  });

  it("l'intero riordino è UN passo di undo", () => {
    const sync = new FakeSync();
    useScene.getState().setSync(sync);
    const tool = createSelectTool();
    const ctx = fakeCtx();
    tool.onPointerDown!(at(25, 25), ctx);
    tool.onPointerMove!(at(100, 30), ctx);
    tool.onPointerMove!(at(170, 30), ctx);
    tool.onPointerUp!(at(170, 30), ctx);
    expect(orderOf()).toEqual(["b", "c", "a"]);
    useScene.getState().undo();
    expect(orderOf()).toEqual(["a", "b", "c"]);
    expect(useScene.getState().scene!.nodes.at("a").x).toBe(0);
  });

  it("rilasciare dov'era non manda nulla e non lascia un gesto aperto", () => {
    const sync = new FakeSync();
    useScene.getState().setSync(sync);
    const tool = createSelectTool();
    const ctx = fakeCtx();
    tool.onPointerDown!(at(25, 25), ctx);
    tool.onPointerMove!(at(40, 30), ctx);
    expect(useScene.getState().layoutDrop).not.toBeNull();
    tool.onPointerUp!(at(40, 30), ctx);
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().gesture).toBeNull();
    expect(useScene.getState().layoutDrop).toBeNull();
    expect(orderOf()).toEqual(["a", "b", "c"]);
  });

  it("Esc a metà trascinamento annulla tutto: niente op, anteprima spenta", () => {
    const sync = new FakeSync();
    useScene.getState().setSync(sync);
    const tool = createSelectTool();
    const ctx = fakeCtx();
    tool.onPointerDown!(at(25, 25), ctx);
    tool.onPointerMove!(at(170, 30), ctx);
    expect(useScene.getState().layoutDrop).not.toBeNull();
    tool.onKeyDown!({ key: "Escape", preventDefault: vi.fn() } as unknown as KeyboardEvent, ctx);
    expect(useScene.getState().layoutDrop).toBeNull();
    expect(useScene.getState().gesture).toBeNull();
    // Il pointerup che arriva comunque dopo Esc non deve riordinare.
    tool.onPointerUp!(at(170, 30), ctx);
    expect(sync.sent).toHaveLength(0);
    expect(orderOf()).toEqual(["a", "b", "c"]);
  });

  it("un click senza movimento non apre nessun riordino", () => {
    const sync = new FakeSync();
    useScene.getState().setSync(sync);
    const tool = createSelectTool();
    const ctx = fakeCtx();
    tool.onPointerDown!(at(25, 25), ctx);
    tool.onPointerUp!(at(25, 25), ctx);
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().layoutDrop).toBeNull();
  });
});

describe("trascinare un figlio di un frame SENZA auto layout", () => {
  it("si sposta con x/y come sempre (nessun riordino)", () => {
    install(null);
    const sync = new FakeSync();
    useScene.getState().setSync(sync);
    const tool = createSelectTool();
    const ctx = fakeCtx();
    tool.onPointerDown!(at(25, 25), ctx);
    tool.onPointerMove!(at(45, 40), ctx);
    expect(useScene.getState().layoutDrop).toBeNull();
    expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ x: 20, y: 15 });
    tool.onPointerUp!(at(45, 40), ctx);
    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("setProps");
    expect(useScene.getState().scene!.nodes.at("a")).toMatchObject({ x: 20, y: 15 });
  });
});
