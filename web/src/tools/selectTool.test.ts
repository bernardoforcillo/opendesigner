import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSelectTool, pickTarget, nodesInMarquee } from "./selectTool";
import type { ToolContext } from "./types";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";

function node(id: string, x: number, orderKey: string, extra: Partial<NodeLite> = {}): NodeLite {
  return { id, parentId: "page1", orderKey, name: id, visible: true, opacity: 1,
    x, y: 0, width: 50, height: 50, rotation: 0, fills: [], kind: "rect", cornerRadius: 0, ...extra };
}

function fakeCtx(): ToolContext {
  return {
    sync: { submit: vi.fn() },
    getScene: () => useScene.getState().scene,
    getCamera: () => useScene.getState().camera,
    setCamera: vi.fn(),
    // style.cursor: il tool ci scrive il cursore della maniglia sotto il
    // puntatore (Task 9, step 4); nei test è un oggetto qualunque.
    canvas: { style: { cursor: "" } } as unknown as HTMLCanvasElement,
    toWorld: (e: PointerEvent) => ({ x: e.clientX, y: e.clientY }),
  } as unknown as ToolContext;
}

const at = (x: number, y: number, shiftKey = false) => ({ clientX: x, clientY: y, shiftKey }) as PointerEvent;

// Come `at`, ma con un timeStamp esplicito: serve solo al doppio click
// (rilevato per ID + e.timeStamp, vedi selectTool.ts), e tenerlo fuori da `at`
// evita di dover assegnare un timeStamp a TUTTI gli altri test di questo file.
const atT = (x: number, y: number, timeStamp: number, shiftKey = false) =>
  ({ clientX: x, clientY: y, shiftKey, timeStamp }) as PointerEvent;

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

beforeEach(() => {
  useScene.setState({
    camera: { x: 0, y: 0, zoom: 1 },
    selection: [],
    marquee: null,
    gesture: null,
    sync: null,
  });
  // setScene e non setState({scene}): installa una scena COERENTE (vista e
  // confermato allineati, coda vuota) -- l'invariante su cui poggia la
  // riconciliazione confermato/pending (vedi store/store.ts).
  useScene.getState().setScene({
    ...emptyScene("doc-1", "u"),
    nodes: { a: node("a", 0, "a000000"), b: node("b", 100, "a000001") },
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

  // --- pura logica: pickTarget ---------------------------------------------

  describe("pickTarget", () => {
    it("picks the topmost node when two overlap", () => {
      const scene = { ...emptyScene("doc-1", "u"), nodes: {
        under: node("under", 0, "a000000"),
        over: node("over", 0, "a000001"), // orderKey più alto = disegnato sopra
      } };
      expect(pickTarget(scene, { x: 10, y: 10 }, false, [])).toEqual({ mode: "single", id: "over" });
    });

    it("plain click on an unselected node returns single with its id", () => {
      const scene = useScene.getState().scene!;
      expect(pickTarget(scene, { x: 120, y: 10 }, false, [])).toEqual({ mode: "single", id: "b" });
    });

    it("plain click on an already-selected node returns single WITHOUT an id (keeps the current selection for a group drag)", () => {
      const scene = useScene.getState().scene!;
      expect(pickTarget(scene, { x: 120, y: 10 }, false, ["b"])).toEqual({ mode: "single" });
    });

    it("shift-click always returns toggle with the id, selected or not", () => {
      const scene = useScene.getState().scene!;
      expect(pickTarget(scene, { x: 120, y: 10 }, true, [])).toEqual({ mode: "toggle", id: "b" });
      expect(pickTarget(scene, { x: 120, y: 10 }, true, ["b"])).toEqual({ mode: "toggle", id: "b" });
    });

    it("clicking empty space returns marquee", () => {
      const scene = useScene.getState().scene!;
      expect(pickTarget(scene, { x: 900, y: 900 }, false, [])).toEqual({ mode: "marquee" });
    });
  });

  // --- pura logica: nodesInMarquee -----------------------------------------

  describe("nodesInMarquee", () => {
    it("includes only nodes whose bounds intersect the marquee", () => {
      const scene = { ...emptyScene("doc-1", "u"), nodes: {
        inside: node("inside", 5, "a000000"),
        outside: node("outside", 500, "a000001"),
      } };
      expect(nodesInMarquee(scene, { x: 0, y: 0, width: 20, height: 20 })).toEqual(["inside"]);
    });

    it("excludes nodes that only touch the marquee at an edge", () => {
      const scene = { ...emptyScene("doc-1", "u"), nodes: {
        touching: node("touching", 50, "a000000", { width: 50, height: 50 }),
      } };
      // marquee = [0,0,50,50]; touching = [50,0,50,50] -> tocca solo il bordo x=50
      expect(nodesInMarquee(scene, { x: 0, y: 0, width: 50, height: 50 })).toEqual([]);
    });

    it("excludes invisible nodes even when their bounds intersect", () => {
      const scene = { ...emptyScene("doc-1", "u"), nodes: {
        hidden: node("hidden", 5, "a000000", { visible: false }),
        shown: node("shown", 5, "a000001"),
      } };
      expect(nodesInMarquee(scene, { x: 0, y: 0, width: 20, height: 20 })).toEqual(["shown"]);
    });
  });

  // --- marquee collegato allo store ----------------------------------------

  describe("marquee gesture", () => {
    it("drags a marquee over empty space and selects the nodes it intersects, visible in store.marquee while dragging", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(-10, -10), ctx); // vuoto
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

    // Un CLICK sul vuoto non è un marquee 0x0: il marquee seleziona per AABB,
    // e l'angolo vuoto del bounding box di un'ellisse cadrebbe dentro quell'AABB
    // pur essendo fuori dall'ellisse (è esattamente ciò che hitTest evita).
    it("a click on empty space inside an ellipse's bounding box selects nothing", () => {
      useScene.setState({ selection: [] });
      useScene.getState().setScene({ ...emptyScene("doc-1", "u"), nodes: {
        e: node("e", 0, "a000000", { width: 100, height: 100, kind: "ellipse" }),
      } });
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(2, 2), ctx); // angolo dell'AABB, FUORI dall'ellisse
      tool.onPointerUp!(at(2, 2), ctx);
      expect(useScene.getState().selection).toEqual([]);
      expect(useScene.getState().marquee).toBeNull();
    });

    it("a sub-slop jitter is still a click, but a real drag selects by bounds", () => {
      useScene.setState({ selection: [] });
      useScene.getState().setScene({ ...emptyScene("doc-1", "u"), nodes: {
        e: node("e", 0, "a000000", { width: 100, height: 100, kind: "ellipse" }),
      } });
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(2, 2), ctx);
      tool.onPointerMove!(at(4, 4), ctx); // 2px: sotto la soglia
      tool.onPointerUp!(at(4, 4), ctx);
      expect(useScene.getState().selection).toEqual([]);

      tool.onPointerDown!(at(2, 2), ctx);
      tool.onPointerMove!(at(10, 10), ctx); // 8px: marquee vero
      tool.onPointerUp!(at(10, 10), ctx);
      expect(useScene.getState().selection).toEqual(["e"]);
    });

    it("the click threshold is in screen px, so it scales with the zoom", () => {
      useScene.setState({
        camera: { x: 0, y: 0, zoom: 0.1 }, // 20 unità mondo = 2px schermo
        selection: [],
      });
      useScene.getState().setScene({ ...emptyScene("doc-1", "u"), nodes: { a: node("a", 0, "a000000") } });
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
      tool.onPointerDown!(at(-10, -10), ctx); // niente shift: azzera subito
      expect(useScene.getState().selection).toEqual([]);
      tool.onPointerMove!(at(60, 60), ctx);

      tool.onKeyDown!({ key: "Escape" } as KeyboardEvent, ctx);
      expect(useScene.getState().selection).toEqual(["b"]);
      expect(useScene.getState().marquee).toBeNull();
    });
  });

  // --- spostamento della selezione -----------------------------------------

  describe("moving the selection", () => {
    it("dragging a selected node moves the WHOLE selection with one setProps op per node", () => {
      useScene.getState().setSelection(["a", "b"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(10, 10), ctx); // sopra "a", già selezionato: niente cambio selezione
      tool.onPointerMove!(at(30, 25), ctx); // dx=20 dy=15, anteprima locale
      expect(useScene.getState().scene!.nodes["a"]).toMatchObject({ x: 20, y: 15 });
      expect(useScene.getState().scene!.nodes["b"]).toMatchObject({ x: 120, y: 15 });
      expect(sync.sent).toHaveLength(0); // niente sul filo durante il drag

      tool.onPointerUp!(at(30, 25), ctx);
      expect(sync.sent).toHaveLength(2); // un op per nodo
      expect(useScene.getState().scene!.nodes["a"]).toMatchObject({ x: 20, y: 15 });
      expect(useScene.getState().scene!.nodes["b"]).toMatchObject({ x: 120, y: 15 });
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

      tool.onPointerDown!(at(120, 10), ctx); // "b", non selezionato: sostituisce
      expect(useScene.getState().selection).toEqual(["b"]);
      tool.onPointerMove!(at(140, 20), ctx);
      tool.onPointerUp!(at(140, 20), ctx);

      expect(sync.sent).toHaveLength(1);
      expect(useScene.getState().scene!.nodes["a"]).toMatchObject({ x: 0, y: 0 }); // "a" non si è mosso
      expect(useScene.getState().scene!.nodes["b"]).toMatchObject({ x: 120, y: 10 });
    });

    it("Esc during a drag reverts the moved node(s) and sends nothing", () => {
      useScene.getState().setSelection(["a"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(10, 10), ctx);
      tool.onPointerMove!(at(90, 90), ctx);
      expect(useScene.getState().scene!.nodes["a"]).toMatchObject({ x: 80, y: 80 });

      tool.onKeyDown!({ key: "Escape" } as KeyboardEvent, ctx);
      expect(useScene.getState().scene!.nodes["a"]).toMatchObject({ x: 0, y: 0 });
      expect(sync.sent).toHaveLength(0);

      // e il prossimo up non manda più nulla (il gesto è stato abbandonato)
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

      expect(useScene.getState().scene!.nodes["a"]).toMatchObject({ x: 0, y: 0 });
      expect(sync.sent).toHaveLength(0);
    });
  });

  // --- resize con le maniglie ------------------------------------------------
  // I nodi del beforeEach sono 50x50: "a" a (0,0), "b" a (100,0). Con camera
  // identità le coordinate schermo dell'evento coincidono con quelle mondo,
  // quindi le maniglie di "a" stanno a (0,0) nw ... (50,50) se.

  describe("resizing with the handles", () => {
    it("dragging the se handle resizes the selected node with ONE setProps op", () => {
      useScene.getState().setSelection(["a"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(50, 50), ctx); // maniglia se
      tool.onPointerMove!(at(70, 80), ctx); // dx=20 dy=30
      expect(useScene.getState().scene!.nodes["a"]).toMatchObject({ x: 0, y: 0, width: 70, height: 80 });
      expect(sync.sent).toHaveLength(0); // niente sul filo durante il gesto

      tool.onPointerUp!(at(70, 80), ctx);
      expect(sync.sent).toHaveLength(1);
      expect(sync.sent[0].kind.case).toBe("setProps");
      expect(useScene.getState().scene!.nodes["a"]).toMatchObject({ x: 0, y: 0, width: 70, height: 80 });
    });

    it("the nw handle moves the origin while resizing", () => {
      useScene.getState().setSelection(["a"]);
      useScene.getState().setSync(new FakeSync());
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(0, 0), ctx); // maniglia nw
      tool.onPointerMove!(at(10, 20), ctx);
      tool.onPointerUp!(at(10, 20), ctx);
      expect(useScene.getState().scene!.nodes["a"]).toMatchObject({ x: 10, y: 20, width: 40, height: 30 });
    });

    it("handles win over the node under the pointer (no move, no selection change)", () => {
      useScene.getState().setSelection(["a"]);
      useScene.getState().setSync(new FakeSync());
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(50, 25), ctx); // maniglia e, DENTRO i bounds di "a"
      expect(useScene.getState().selection).toEqual(["a"]);
      tool.onPointerMove!(at(90, 45), ctx);
      // resize sull'asse x soltanto: se avesse vinto il nodo, "a" si sarebbe MOSSO
      expect(useScene.getState().scene!.nodes["a"]).toMatchObject({ x: 0, y: 0, width: 90, height: 50 });
    });

    it("flips through the gesture keeping a positive width", () => {
      useScene.getState().setSelection(["a"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(0, 25), ctx); // maniglia w
      tool.onPointerMove!(at(100, 25), ctx); // oltre il bordo destro (x=50)
      tool.onPointerUp!(at(100, 25), ctx);
      expect(useScene.getState().scene!.nodes["a"]).toMatchObject({ x: 50, y: 0, width: 50, height: 50 });
    });

    it("shift keeps the aspect ratio", () => {
      useScene.getState().setSelection(["a"]);
      useScene.getState().setSync(new FakeSync());
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(50, 50, true), ctx); // maniglia se
      tool.onPointerMove!(at(150, 50, true), ctx); // solo dx: senza shift sarebbe 150x50
      tool.onPointerUp!(at(150, 50, true), ctx);
      expect(useScene.getState().scene!.nodes["a"]).toMatchObject({ width: 150, height: 150 });
    });

    it("shift keeps the aspect ratio while SHRINKING from a corner", () => {
      useScene.getState().setSelection(["a"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(50, 50, true), ctx); // maniglia se
      tool.onPointerMove!(at(30, 50, true), ctx); // dx=-20 verso l'interno, dy=0
      // 50x50 * 0.6: il drag deve rimpicciolire, non lasciare il nodo com'è
      expect(useScene.getState().scene!.nodes["a"]).toMatchObject({ x: 0, y: 0, width: 30, height: 30 });
      tool.onPointerUp!(at(30, 50, true), ctx);
      expect(useScene.getState().scene!.nodes["a"]).toMatchObject({ width: 30, height: 30 });
    });

    it("resizes a MULTIPLE selection as a group, one op per node", () => {
      useScene.getState().setSelection(["a", "b"]); // bbox di gruppo (0,0,150,50)
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(150, 50), ctx); // maniglia se del gruppo
      tool.onPointerMove!(at(300, 50), ctx); // larghezza x2, altezza invariata
      tool.onPointerUp!(at(300, 50), ctx);

      expect(sync.sent).toHaveLength(2);
      expect(useScene.getState().scene!.nodes["a"]).toMatchObject({ x: 0, y: 0, width: 100, height: 50 });
      expect(useScene.getState().scene!.nodes["b"]).toMatchObject({ x: 200, y: 0, width: 100, height: 50 });
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
      expect(useScene.getState().scene!.nodes["a"]).toMatchObject({ x: 0, y: 0, width: 50, height: 50 });
    });

    it("Esc during a resize restores the original size and sends nothing", () => {
      useScene.getState().setSelection(["a"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(50, 50), ctx);
      tool.onPointerMove!(at(150, 150), ctx);
      expect(useScene.getState().scene!.nodes["a"]).toMatchObject({ width: 150, height: 150 });

      tool.onKeyDown!({ key: "Escape" } as KeyboardEvent, ctx);
      expect(useScene.getState().scene!.nodes["a"]).toMatchObject({ x: 0, y: 0, width: 50, height: 50 });
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
      expect(useScene.getState().scene!.nodes["a"]).toMatchObject({ x: 0, y: 0, width: 50, height: 50 });
      expect(sync.sent).toHaveLength(0);
    });

    it("with nothing selected there are no handles: the pointer falls through to the node", () => {
      useScene.getState().setSync(new FakeSync());
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(25, 25), ctx);
      tool.onPointerMove!(at(35, 35), ctx);
      tool.onPointerUp!(at(35, 35), ctx);
      // spostato, NON ridimensionato
      expect(useScene.getState().scene!.nodes["a"]).toMatchObject({ x: 10, y: 10, width: 50, height: 50 });
    });

    it("the canvas cursor reflects the handle under the pointer", () => {
      useScene.getState().setSelection(["a"]);
      const tool = createSelectTool();
      const ctx = fakeCtx();
      const cursor = () => (ctx.canvas as unknown as { style: { cursor: string } }).style.cursor;

      tool.onPointerMove!(at(0, 0), ctx); // sopra nw
      expect(cursor()).toBe("nwse-resize");
      tool.onPointerMove!(at(50, 25), ctx); // sopra e
      expect(cursor()).toBe("ew-resize");
      tool.onPointerMove!(at(25, 25), ctx); // dentro il box, nessuna maniglia
      expect(cursor()).toBe("default");
    });

    it("keeps the handle cursor for the whole resize drag", () => {
      useScene.getState().setSelection(["a"]);
      useScene.getState().setSync(new FakeSync());
      const tool = createSelectTool();
      const ctx = fakeCtx();
      const cursor = () => (ctx.canvas as unknown as { style: { cursor: string } }).style.cursor;

      tool.onPointerDown!(at(50, 50), ctx);
      tool.onPointerMove!(at(400, 400), ctx); // lontano da ogni maniglia iniziale
      expect(cursor()).toBe("nwse-resize");
      tool.onPointerUp!(at(400, 400), ctx);
    });
  });

  // --- cancellazione ---------------------------------------------------------

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
      expect(useScene.getState().scene!.nodes["a"]).toBeUndefined();
      expect(useScene.getState().scene!.nodes["b"]).toBeUndefined();
      expect(useScene.getState().selection).toEqual([]);
    });

    // deleteNode cancella un SOTTOALBERO (applyOp / core.applyDelete): un
    // figlio selezionato insieme al suo gruppo non ha bisogno di un op suo --
    // e non può averlo, perché quando arriverebbe il nodo è già sparito.
    it("Delete su un gruppo E un suo discendente manda UN solo op, e il gesto resta annullabile", () => {
      useScene.getState().setScene({
        ...emptyScene("doc-1", "u"),
        nodes: {
          g1: node("g1", 0, "a000000"),
          c1: node("c1", 0, "a000000", { parentId: "g1" }),
          d1: node("d1", 0, "a000000", { parentId: "c1" }),
          other: node("other", 200, "a000001"),
        },
      });
      useScene.getState().setSelection(["g1", "d1", "other"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const undoBefore = useScene.getState().undoStack.length;

      createSelectTool().onKeyDown!({ key: "Delete" } as KeyboardEvent, fakeCtx());

      // d1 sparisce nella cascata di g1: un suo op sarebbe stato rifiutato dal
      // server (ErrNodeNotFound) e avrebbe fatto saltare la voce di undo
      // dell'INTERO gesto (invertOp -> null su un nodo già cancellato).
      const deleted = sync.sent.map((op) => (op.kind.case === "deleteNode" ? op.kind.value.id : ""));
      expect(deleted).toEqual(["g1", "other"]);
      expect(Object.keys(useScene.getState().scene!.nodes)).toEqual([]);
      // UNA voce di undo, e completa: quattro nodi da ricreare.
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
      expect(useScene.getState().scene!.nodes["a"]).toBeUndefined();
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
      tool.onPointerMove!(at(90, 90), ctx); // apre il gesto di drag nello store, anteprima x:80 y:80

      tool.onKeyDown!({ key: "Delete" } as KeyboardEvent, ctx);
      expect(sync.sent).toHaveLength(1);
      expect(sync.sent[0].kind.case).toBe("deleteNode");
      expect(useScene.getState().scene!.nodes["a"]).toBeUndefined();
      expect(useScene.getState().gesture).toBeNull();

      // Il pulsante è ancora giù nel mondo reale: arrivano ancora move/up per
      // il drag che Delete ha interrotto. Non devono fare nulla -- in
      // particolare NON un secondo setProps fasullo per "a" (ormai cancellato).
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

      tool.onPointerDown!(at(-10, -10), ctx); // vuoto: azzera la selezione, apre il marquee
      tool.onPointerMove!(at(60, 60), ctx);
      expect(useScene.getState().marquee).not.toBeNull();

      tool.onKeyDown!({ key: "Delete" } as KeyboardEvent, ctx);
      // Il marquee viene abbandonato (selezione ripristinata a "b" prima della
      // cancellazione), quindi è "b" (non nulla, non un id fantasma) a essere
      // cancellato con un solo op.
      expect(sync.sent).toHaveLength(1);
      expect(sync.sent[0].kind.case).toBe("deleteNode");
      expect(useScene.getState().scene!.nodes["b"]).toBeUndefined();
      expect(useScene.getState().marquee).toBeNull();
      expect(useScene.getState().selection).toEqual([]);

      // Il pointerup del marquee interrotto non deve rimettere "b" in
      // selezione (sarebbe un id di un nodo ormai cancellato).
      tool.onPointerUp!(at(60, 60), ctx);
      expect(useScene.getState().selection).toEqual([]);
    });
  });

  // --- doppio click su un nodo testo: entra in editing (Task 4, step 3) ----

  describe("double click on a text node enters editing", () => {
    beforeEach(() => {
      useScene.getState().setScene({
        ...emptyScene("doc-1", "u"),
        nodes: {
          t: node("t", 0, "a000000", {
            kind: "text",
            text: { content: "", style: { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" } },
          }),
        },
      });
      useScene.setState({ editingNodeId: null });
    });

    it("enters editing on the RELEASE of the second click, not on its pointerdown", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(atT(10, 10, 0), ctx);
      tool.onPointerUp!(atT(10, 10, 0), ctx);
      expect(useScene.getState().editingNodeId).toBeNull(); // il primo click seleziona soltanto

      // Il secondo pointerdown da solo NON decide: fino al rilascio quel
      // pointer può ancora diventare un drag (vedi il test qui sotto).
      tool.onPointerDown!(atT(10, 10, 200), ctx);
      expect(useScene.getState().editingNodeId).toBeNull();

      tool.onPointerUp!(atT(10, 10, 200), ctx);
      expect(useScene.getState().editingNodeId).toBe("t");
      expect(useScene.getState().selection).toEqual(["t"]);
    });

    // Il difetto: un secondo click RAPIDO seguito da un trascinamento veniva
    // inghiottito dall'editing e il nodo non si spostava più. Il puntatore, non
    // il solo pointerdown, decide: superata la soglia è un drag come un altro.
    it("a quick second click that then DRAGS moves the node and does not open editing", () => {
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(atT(10, 10, 0), ctx);
      tool.onPointerUp!(atT(10, 10, 0), ctx);
      tool.onPointerDown!(atT(10, 10, 200), ctx); // secondo click, entro soglia
      tool.onPointerMove!(atT(40, 40, 210), ctx); // ma si muove: dx=30 dy=30
      expect(useScene.getState().scene!.nodes["t"]).toMatchObject({ x: 30, y: 30 }); // anteprima
      tool.onPointerUp!(atT(40, 40, 220), ctx);

      expect(useScene.getState().editingNodeId).toBeNull(); // niente editing
      expect(useScene.getState().scene!.nodes["t"]).toMatchObject({ x: 30, y: 30 });
      expect(sync.sent).toHaveLength(1); // un solo setProps, come un move normale
      expect(sync.sent[0].kind.case).toBe("setProps");
    });

    // Rilasciare il secondo click FERMO (a meno di un tremolio sotto soglia)
    // resta un doppio click: apre l'editing e non muove nulla.
    it("a sub-slop jitter on the second click still opens editing and moves nothing", () => {
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(atT(10, 10, 0), ctx);
      tool.onPointerUp!(atT(10, 10, 0), ctx);
      tool.onPointerDown!(atT(10, 10, 200), ctx);
      tool.onPointerMove!(atT(12, 12, 210), ctx); // 2px: sotto la soglia
      tool.onPointerUp!(atT(12, 12, 220), ctx);

      expect(useScene.getState().editingNodeId).toBe("t");
      expect(sync.sent).toHaveLength(0); // nessun setProps: non si è mosso nulla
      expect(useScene.getState().scene!.nodes["t"]).toMatchObject({ x: 0, y: 0 });
    });

    // La soglia è in px SCHERMO come quella del marquee: a zoom 10 UN'unità
    // mondo vale 10px ed è già un drag, mentre a zoom 1 la stessa unità
    // resterebbe sotto i 3px (il test qui sopra ne muove 2 e resta un click).
    it("the drag threshold is in screen px, so it scales with the zoom", () => {
      useScene.setState({ camera: { x: 0, y: 0, zoom: 10 } });
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(atT(10, 10, 0), ctx);
      tool.onPointerUp!(atT(10, 10, 0), ctx);
      tool.onPointerDown!(atT(10, 10, 200), ctx);
      tool.onPointerMove!(atT(11, 11, 210), ctx); // 1 unità mondo = 10px schermo
      tool.onPointerUp!(atT(11, 11, 220), ctx);

      expect(useScene.getState().editingNodeId).toBeNull();
      expect(useScene.getState().scene!.nodes["t"]).toMatchObject({ x: 1, y: 1 });
      expect(sync.sent).toHaveLength(1);
    });

    // Esc fra il pointerdown e il rilascio abbandona il gesto: il pointerup che
    // arriva comunque dopo non deve aprire un editing "in ritardo".
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
        nodes: {
          t: node("t", 0, "a000000", {
            kind: "text",
            text: { content: "", style: { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" } },
          }),
          t2: node("t2", 200, "a000001", {
            kind: "text",
            text: { content: "", style: { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" } },
          }),
        },
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
        nodes: { r: node("r", 0, "a000000") }, // kind: "rect" di default
      });
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(atT(10, 10, 0), ctx);
      tool.onPointerUp!(atT(10, 10, 0), ctx);
      tool.onPointerDown!(atT(10, 10, 50), ctx);
      tool.onPointerUp!(atT(10, 10, 50), ctx);
      expect(useScene.getState().editingNodeId).toBeNull();
      expect(useScene.getState().selection).toEqual(["r"]); // il click normale continua a selezionare
    });

    it("shift+double click does not enter editing (resta il toggle multi-selezione)", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(atT(10, 10, 0, true), ctx);
      tool.onPointerUp!(atT(10, 10, 0, true), ctx);
      tool.onPointerDown!(atT(10, 10, 50, true), ctx);
      tool.onPointerUp!(atT(10, 10, 50, true), ctx);
      expect(useScene.getState().editingNodeId).toBeNull();
    });

    // Repro concreto del bug di review (Task 4, fix round): due nodi testo
    // VUOTI preesistenti, doppio click sul primo poi sul secondo. Senza la
    // guardia in store.ts::beginTextEditing, il primo nodo non passava MAI da
    // endTextEditing -- editingNodeId veniva sovrascritto in silenzio e il
    // nodo restava fantasma (vuoto, mai ripulito) per sempre.
    it("un doppio click su un ALTRO nodo testo chiude/pulisce l'editing del primo (vuoto), senza lasciarlo fantasma", () => {
      useScene.getState().setScene({
        ...emptyScene("doc-1", "u"),
        nodes: {
          t1: node("t1", 0, "a000000", {
            kind: "text",
            text: { content: "", style: { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" } },
          }),
          t2: node("t2", 200, "a000001", {
            kind: "text",
            text: { content: "", style: { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" } },
          }),
        },
      });
      const tool = createSelectTool();
      const ctx = fakeCtx();

      // doppio click su t1: entra in editing (al rilascio del secondo click).
      tool.onPointerDown!(atT(10, 10, 0), ctx);
      tool.onPointerUp!(atT(10, 10, 0), ctx);
      tool.onPointerDown!(atT(10, 10, 200), ctx);
      tool.onPointerUp!(atT(10, 10, 200), ctx);
      expect(useScene.getState().editingNodeId).toBe("t1");
      expect(useScene.getState().scene!.nodes["t1"]).toBeDefined();

      // doppio click su t2 (ben oltre la soglia dei 400ms dal precedente, ma è
      // un doppio click NUOVO: due click su t2 entro soglia fra loro).
      tool.onPointerDown!(atT(210, 10, 1000), ctx);
      tool.onPointerUp!(atT(210, 10, 1000), ctx);
      tool.onPointerDown!(atT(210, 10, 1200), ctx);
      tool.onPointerUp!(atT(210, 10, 1200), ctx);

      expect(useScene.getState().editingNodeId).toBe("t2");
      expect(useScene.getState().scene!.nodes["t1"]).toBeUndefined(); // niente nodo fantasma
      expect(useScene.getState().scene!.nodes["t2"]).toBeDefined();
    });
  });
});
