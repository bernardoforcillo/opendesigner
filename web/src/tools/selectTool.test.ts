import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSelectTool, pickTarget, nodesInMarquee } from "./selectTool";
import type { ToolContext } from "./types";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { useScene } from "../store/store";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";
import { worldAabbOfNode } from "../canvas/geometry";
import { selectionFrame } from "../renderer/overlayRenderer";

function node(id: string, x: number, orderKey: string, extra: Partial<NodeLite> = {}): NodeLite {
  return { id, parentId: "page1", orderKey, name: id, visible: true, opacity: 1,
    x, y: 0, width: 50, height: 50, rotation: 0, fills: [], strokes: [], kind: "rect", cornerRadius: 0, ...extra };
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

// Come `at`, ma con i modificatori che valgono per lo SNAP: Alt lo disattiva
// per quel gesto, Shift è già il rapporto d'aspetto del resize.
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

    it("measures a rotated node by what it really occupies, not by its unrotated box", () => {
      // 100x50 a 90°: il box fermo è y in [0,50], ma il nodo occupa y in [-25,75].
      const scene = { ...emptyScene("doc-1", "u"), nodes: {
        turned: node("turned", 0, "a000000", { width: 100, height: 50, rotation: 90 }),
      } };
      expect(nodesInMarquee(scene, { x: 20, y: 60, width: 10, height: 10 })).toEqual(["turned"]);
    });

    it("excludes invisible nodes even when their bounds intersect", () => {
      const scene = { ...emptyScene("doc-1", "u"), nodes: {
        hidden: node("hidden", 5, "a000000", { visible: false }),
        shown: node("shown", 5, "a000001"),
      } };
      expect(nodesInMarquee(scene, { x: 0, y: 0, width: 20, height: 20 })).toEqual(["shown"]);
    });

    it("un marquee che tocca SOLO il tratto prende comunque il nodo", () => {
      // 50x50 in (100,0) con un tratto esterno da 20: dipinge da x=80.
      // Un marquee che arriva a x=85 non tocca la geometria, ma tocca quello
      // che si VEDE -- e trascinare una selezione attorno a ciò che si vede è
      // tutto quello che il marquee promette.
      const scene = { ...emptyScene("doc-1", "u"), nodes: {
        outlined: node("outlined", 100, "a000000", {
          strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 20, align: "outside" }],
        }),
      } };
      expect(nodesInMarquee(scene, { x: 0, y: 0, width: 85, height: 50 })).toEqual(["outlined"]);
      // E un marquee che si ferma PRIMA della fascia continua a non prenderlo.
      expect(nodesInMarquee(scene, { x: 0, y: 0, width: 79, height: 50 })).toEqual([]);
    });

    it("un tratto INTERNO non allarga il bersaglio del marquee", () => {
      const scene = { ...emptyScene("doc-1", "u"), nodes: {
        outlined: node("outlined", 100, "a000000", {
          strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 20, align: "inside" }],
        }),
      } };
      expect(nodesInMarquee(scene, { x: 0, y: 0, width: 85, height: 50 })).toEqual([]);
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
      // Alt: qui si misura l'ABBANDONO del gesto, non lo snap (che ha i suoi
      // test più sotto) -- senza, il riquadro mosso scatterebbe sul bordo di
      // "b" e la posizione intermedia non sarebbe più quella del puntatore.
      tool.onPointerMove!(atMod(90, 90, { altKey: true }), ctx);
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
      // Alt: qui si misura la matematica del resize, non lo snap -- il bordo
      // alto a 20 cadrebbe altrimenti sul centro di "b" (25), che è corretto
      // ma è un'altra cosa (vedi "selectTool — snap" più sotto).
      tool.onPointerMove!(atMod(10, 20, { altKey: true }), ctx);
      tool.onPointerUp!(atMod(10, 20, { altKey: true }), ctx);
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

  // --- rotazione -------------------------------------------------------------
  // La zona di presa della rotazione è l'anello appena FUORI da ogni angolo
  // (selection/handles.ts). Con "a" (0,0,50,50) selezionato il centro è (25,25)
  // e l'angolo se sta a (50,50): (58,58) cade nella zona, a 45° dal centro.
  // Il punto d'arrivo dei test è quello di partenza ruotato di 90° attorno al
  // centro, così il delta atteso è esattamente un quarto di giro.

  describe("rotating from the corner zones", () => {
    const rotationOf = (id: string) => useScene.getState().scene!.nodes[id].rotation;

    it("dragging outside a corner rotates the node about its centre: one gesture, one op", () => {
      useScene.getState().setSelection(["a"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(58, 58), ctx);   // zona di rotazione dell'angolo se
      expect(useScene.getState().selection).toEqual(["a"]); // niente marquee, niente deselezione
      tool.onPointerMove!(at(-8, 58), ctx);   // stesso raggio, +90°
      expect(rotationOf("a")).toBeCloseTo(90, 9);
      expect(sync.sent).toHaveLength(0);      // anteprima locale, niente sul filo

      tool.onPointerUp!(at(-8, 58), ctx);
      expect(sync.sent).toHaveLength(1);
      expect(sync.sent[0].kind.case).toBe("setProps");
      expect(rotationOf("a")).toBeCloseTo(90, 9);
      // il nodo NON si sposta: ruota attorno al proprio centro
      expect(useScene.getState().scene!.nodes["a"]).toMatchObject({ x: 0, y: 0, width: 50, height: 50 });
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

      // partenza a 45°, arrivo a 100°: delta 55° -> scatta a 60°
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
      // gruppo (0,0,150,50), centro (75,25); angolo se a (150,50)
      useScene.getState().setSelection(["a", "b"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(158, 58), ctx);
      tool.onPointerMove!(at(42, 108), ctx); // il punto di prima ruotato di +90°
      tool.onPointerUp!(at(42, 108), ctx);

      expect(sync.sent).toHaveLength(2); // un op per nodo, un gesto solo
      const a = useScene.getState().scene!.nodes["a"];
      const b = useScene.getState().scene!.nodes["b"];
      expect(a.rotation).toBeCloseTo(90, 9);
      expect(b.rotation).toBeCloseTo(90, 9);
      // i centri girano attorno a quello di gruppo: a (25,25) -> (75,-25), b (125,25) -> (75,75)
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

      tool.onPointerMove!(at(58, 58), ctx); // hover appena fuori dall'angolo
      expect(cursor()).toBe("grab");
      tool.onPointerMove!(at(50, 50), ctx); // sull'angolo: è il resize a vincere
      expect(cursor()).toBe("nwse-resize");

      tool.onPointerDown!(at(58, 58), ctx);
      tool.onPointerMove!(at(-8, 58), ctx);
      expect(cursor()).toBe("grabbing");
      tool.onPointerUp!(at(-8, 58), ctx);
    });
  });

  // --- resize di un nodo GIÀ ruotato -----------------------------------------

  describe("resizing a rotated node", () => {
    function selectRotated(deg: number) {
      useScene.getState().setScene({
        ...emptyScene("doc-1", "u"),
        nodes: { a: node("a", 0, "a000000", { rotation: deg }) },
      });
      useScene.getState().setSelection(["a"]);
      useScene.getState().setSync(new FakeSync());
    }

    it("widens along the node's OWN axis: the e handle follows a vertical drag at 90 degrees", () => {
      selectRotated(90);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      // il nodo è (0,0,50,50) a 90°: la maniglia e sta a (25,50), non a (50,25)
      tool.onPointerDown!(at(25, 50), ctx);
      tool.onPointerMove!(at(25, 70), ctx); // 20px in GIÙ = 20px lungo il suo asse x
      tool.onPointerUp!(at(25, 70), ctx);

      const a = useScene.getState().scene!.nodes["a"];
      expect(a.width).toBeCloseTo(70, 9);
      expect(a.height).toBeCloseTo(50, 9);
      // il lato ancorato resta inchiodato nel MONDO: il box scivola per compensare
      expect(a.x).toBeCloseTo(-10, 9);
      expect(a.y).toBeCloseTo(10, 9);
      expect(a.rotation).toBe(90); // il resize non tocca l'angolo
    });

    it("ignores the drag across that axis", () => {
      selectRotated(90);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(25, 50), ctx);
      tool.onPointerMove!(at(45, 50), ctx); // 20px a DESTRA: trasversale
      tool.onPointerUp!(at(45, 50), ctx);

      const a = useScene.getState().scene!.nodes["a"];
      expect(a.width).toBeCloseTo(50, 9);
      expect(a.height).toBeCloseTo(50, 9);
    });
  });

  // --- resize di un GRUPPO che contiene un nodo ruotato -----------------------
  // Il riquadro di gruppo è asse-allineato attorno a ciò che i nodi OCCUPANO:
  // la scala vale lungo gli assi dello SCHERMO, e un membro girato va mappato
  // per assi -- scalare il suo box locale lo allungava nella direzione
  // sbagliata e lo faceva uscire dal riquadro.
  describe("resizing a MULTIPLE selection containing a rotated node", () => {
    beforeEach(() => {
      // A: 100x50 in (0,0) a 90° -> occupa x [25,75], y [-25,75]
      // B: 50x50 in (200,0)      -> il gruppo sta su x [25,250], y [-25,75]
      useScene.getState().setScene({
        ...emptyScene("doc-1", "u"),
        nodes: {
          a: node("a", 0, "a000000", { width: 100, height: 50, rotation: 90 }),
          b: node("b", 200, "a000001"),
        },
      });
      useScene.getState().setSelection(["a", "b"]);
    });

    it("stretches the rotated member along the SCREEN axis the pointer is dragging", () => {
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(250, 75), ctx); // maniglia se del gruppo
      tool.onPointerMove!(at(475, 75), ctx); // +225 in orizzontale: scala x2
      tool.onPointerUp!(at(475, 75), ctx);

      const a = useScene.getState().scene!.nodes["a"];
      // il box del modello: la larghezza (asse locale VERTICALE sullo schermo)
      // resta, l'altezza (asse locale ORIZZONTALE) raddoppia
      expect(a.width).toBeCloseTo(100, 9);
      expect(a.height).toBeCloseTo(100, 9);
      expect(a.rotation).toBeCloseTo(90, 9);
      expect(a.x).toBeCloseTo(25, 9);
      expect(a.y).toBeCloseTo(-25, 9);

      const b = useScene.getState().scene!.nodes["b"];
      expect(b).toMatchObject({ y: 0, width: 100, height: 50 });
      expect(b.x).toBeCloseTo(375, 9);
      expect(sync.sent).toHaveLength(2); // un op per nodo, un gesto solo
    });

    it("keeps the rotated member inside the group frame it started in", () => {
      useScene.getState().setSync(new FakeSync());
      const tool = createSelectTool();
      const ctx = fakeCtx();

      tool.onPointerDown!(at(250, 75), ctx);
      tool.onPointerMove!(at(475, 75), ctx);
      tool.onPointerUp!(at(475, 75), ctx);

      // Il riquadro dopo il resize: x [25,475], y [-25,75] (l'altezza non è
      // stata toccata). Quello che il nodo occupa DAVVERO deve starci dentro --
      // prima diventava alto 200 e sfondava il riquadro sopra e sotto.
      const aabb = worldAabbOfNode(useScene.getState().scene!.nodes["a"]);
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

      // Scala UNIFORME (shift): nessun angolo cambia, e la mask resta quella di
      // sempre -- niente `rotation` di troppo sul filo.
      tool.onPointerDown!(at(250, 75, true), ctx);
      tool.onPointerMove!(at(475, 300, true), ctx);
      tool.onPointerUp!(at(475, 300, true), ctx);

      expect(useScene.getState().scene!.nodes["a"].rotation).toBe(90);
      for (const op of sync.sent) {
        expect(op.kind.case === "setProps" && op.kind.value.mask?.paths)
          .toEqual(["x", "y", "width", "height"]);
      }
    });

    it("MIRRORS the angle of a rotated member when the group flips, and says so in the mask", () => {
      // 30° invece di 90: uno specchio orizzontale a 90° lascerebbe l'angolo
      // dov'è (l'asse locale x punta in giù), e non si vedrebbe niente.
      useScene.getState().setScene({
        ...emptyScene("doc-1", "u"),
        nodes: {
          a: node("a", 0, "a000000", { width: 100, height: 50, rotation: 30 }),
          b: node("b", 200, "a000001"),
        },
      });
      useScene.getState().setSelection(["a", "b"]);
      const sync = new FakeSync();
      useScene.getState().setSync(sync);
      const tool = createSelectTool();
      const ctx = fakeCtx();

      // Dove sia la maniglia e del gruppo lo dice il frame stesso (a 30° i
      // bordi non sono numeri tondi): qui si testa il RESIZE, non dove stanno
      // le maniglie -- quello è coperto da handles.test.ts.
      const f = selectionFrame(useScene.getState().scene!, ["a", "b"])!;
      const east = { x: f.bounds.x + f.bounds.width, y: f.bounds.y + f.bounds.height / 2 };
      const past = east.x - 2 * f.bounds.width; // oltre l'ancora: ribaltamento

      tool.onPointerDown!(at(east.x, east.y), ctx);
      tool.onPointerMove!(at(past, east.y), ctx);
      tool.onPointerUp!(at(past, east.y), ctx);

      const a = useScene.getState().scene!.nodes["a"];
      expect(a.rotation).toBeCloseTo(150, 3); // 30 specchiato
      // uno specchio non deforma: le misure restano quelle
      expect(a.width).toBeCloseTo(100, 3);
      expect(a.height).toBeCloseTo(50, 3);

      const forA = sync.sent.find((op) => op.kind.case === "setProps" && op.kind.value.id === "a");
      expect(forA!.kind.case === "setProps" && forA!.kind.value.mask?.paths)
        .toEqual(["x", "y", "width", "height", "rotation"]);
      // il membro NON ruotato viaggia con la mask di sempre
      const forB = sync.sent.find((op) => op.kind.case === "setProps" && op.kind.value.id === "b");
      expect(forB!.kind.case === "setProps" && forB!.kind.value.mask?.paths)
        .toEqual(["x", "y", "width", "height"]);
    });

    // 90° è il caso FACILE (gli assi si scambiano e il conto torna da sé). A
    // 45° con una scala NON uniforme non torna: l'immagine esatta è un
    // parallelogramma, e il rettangolo con quegli assi era il 33% più alto del
    // riquadro. Qui si controlla il vincolo che l'utente VEDE -- si trascina
    // solo in orizzontale, quindi in verticale non si deve muovere niente.
    it("keeps a 45-degree member inside the frame when the group is stretched sideways", () => {
      useScene.getState().setScene({
        ...emptyScene("doc-1", "u"),
        nodes: {
          a: node("a", 0, "a000000", { width: 100, height: 50, rotation: 45 }),
          b: node("b", 200, "a000001"),
        },
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
      tool.onPointerMove!(at(east.x + f.bounds.width, east.y), ctx); // x2 in larghezza, y intatta
      tool.onPointerUp!(at(east.x + f.bounds.width, east.y), ctx);

      const aabb = worldAabbOfNode(useScene.getState().scene!.nodes["a"]);
      expect(aabb.y).toBeGreaterThanOrEqual(top - 1e-6);
      expect(aabb.y + aabb.height).toBeLessThanOrEqual(bottom + 1e-6);
      // l'altezza del riquadro non è stata trascinata: nemmeno quella del
      // membro deve cambiare (prima passava da 106.07 a 141.42)
      expect(aabb.height).toBeCloseTo(106.06601717798212, 6);
      expect(bottom - top).toBeCloseTo(106.06601717798212, 6);
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

// --- SNAP DURANTE IL GESTO ---------------------------------------------------
//
// La DECISIONE dello snap è testata dov'è, come funzione pura
// (selection/snap.test.ts). Qui si verifica solo il collegamento al gesto: che
// lo scatto entri nell'anteprima E nell'op finale (non due valori diversi), che
// Alt lo spenga, che la soglia sia in px SCHERMO e che le guide compaiano e
// spariscano insieme al gesto.
describe("selectTool — snap", () => {
  let sync: FakeSync;

  beforeEach(() => {
    sync = new FakeSync();
    useScene.setState({ sync });
  });

  const lastPatch = () => sync.sent[sync.sent.length - 1].kind.value as {
    id: string; patch?: { x: number; y: number; width: number; height: number };
  };

  describe("trascinamento", () => {
    it("snaps the dragged edge onto another node's edge", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(10, 10), ctx); // seleziona "a" (0..50)
      // dx = 48: il bordo destro finisce a 98, a 2 unità dal bordo sinistro di
      // "b" (100) -- dentro la soglia, quindi scatta a 100.
      tool.onPointerMove!(at(58, 10), ctx);
      expect(useScene.getState().scene!.nodes.a.x).toBe(50);
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
      // Un gesto, un op per nodo: lo scatto non ne aggiunge un secondo.
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
      expect(useScene.getState().scene!.nodes.a.x).toBe(48);
      expect(useScene.getState().snapGuides).toEqual([]);
    });

    it("measures the threshold in SCREEN pixels: the same drag snaps at 100% and not at 200%", () => {
      // dx = 46 -> bordo destro a 96, cioè 4 unità mondo dal bordo di "b".
      // A zoom 1 sono 4 px schermo (dentro la soglia), a zoom 2 sono 8 (fuori).
      const run = (zoom: number) => {
        useScene.getState().setScene({
          ...emptyScene("doc-1", "u"),
          nodes: { a: node("a", 0, "a000000"), b: node("b", 100, "a000001") },
        });
        useScene.setState({ camera: { x: 0, y: 0, zoom }, selection: [] });
        const tool = createSelectTool();
        const ctx = fakeCtx();
        tool.onPointerDown!(at(10, 10), ctx);
        tool.onPointerMove!(at(56, 10), ctx);
        return useScene.getState().scene!.nodes.a.x;
      };
      expect(run(1)).toBe(50);
      expect(run(2)).toBe(46);
    });

    it("never snaps to a node that is being dragged along", () => {
      useScene.getState().setSelection(["a", "b"]);
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(10, 10), ctx); // "a" è già selezionato: resta la coppia
      tool.onPointerMove!(at(58, 10), ctx);
      expect(useScene.getState().scene!.nodes.a.x).toBe(48);
      expect(useScene.getState().scene!.nodes.b.x).toBe(148);
      expect(useScene.getState().snapGuides).toEqual([]);
    });
  });

  describe("ridimensionamento", () => {
    // Afferra la maniglia "e" di "a" (bordo destro, a metà altezza) dopo averlo
    // selezionato con un click.
    function grabEast(tool: ReturnType<typeof createSelectTool>, ctx: ToolContext) {
      tool.onPointerDown!(at(10, 10), ctx);
      tool.onPointerUp!(at(10, 10), ctx);
      tool.onPointerDown!(at(50, 25), ctx);
    }

    it("snaps the edge being dragged, and leaves the opposite edge alone", () => {
      const tool = createSelectTool();
      const ctx = fakeCtx();
      grabEast(tool, ctx);
      tool.onPointerMove!(at(98, 25), ctx); // bordo destro a 98, scatta a 100
      expect(useScene.getState().scene!.nodes.a.width).toBe(100);
      expect(useScene.getState().scene!.nodes.a.x).toBe(0);
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
      expect(useScene.getState().scene!.nodes.a.width).toBe(98);
      expect(useScene.getState().snapGuides).toEqual([]);
    });

    it("stands aside when Shift is keeping the aspect ratio", () => {
      // Il rapporto d'aspetto è un vincolo più forte: scattare un asse
      // romperebbe l'altro, e l'utente ha chiesto ESPLICITAMENTE il rapporto.
      const tool = createSelectTool();
      const ctx = fakeCtx();
      grabEast(tool, ctx);
      tool.onPointerMove!(atMod(98, 25, { shiftKey: true }), ctx);
      expect(useScene.getState().scene!.nodes.a.width).toBe(98);
      expect(useScene.getState().snapGuides).toEqual([]);
    });

    it("stands aside on a ROTATED frame — its edges are not lines of the screen", () => {
      useScene.getState().setScene({
        ...emptyScene("doc-1", "u"),
        nodes: { a: node("a", 0, "a000000", { rotation: 90 }), b: node("b", 100, "a000001") },
      });
      const tool = createSelectTool();
      const ctx = fakeCtx();
      tool.onPointerDown!(at(10, 10), ctx);
      tool.onPointerUp!(at(10, 10), ctx);
      // La maniglia "e" di un quadrato 50x50 ruotato di 90° sta in (25, 50).
      tool.onPointerDown!(at(25, 50), ctx);
      tool.onPointerMove!(at(25, 98), ctx);
      expect(useScene.getState().scene!.nodes.a.width).toBeCloseTo(98, 9);
      expect(useScene.getState().snapGuides).toEqual([]);
    });
  });
});
