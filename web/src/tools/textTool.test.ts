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
    editingNodeId: null,
  });
  // setScene e non setState({scene}): installa una scena COERENTE (vista e
  // confermato allineati, coda vuota) -- l'invariante su cui poggia la
  // riconciliazione confermato/pending (vedi store/store.ts).
  useScene.getState().setScene(emptyScene("doc-1", "Untitled"));
});

describe("textTool", () => {
  it("click crea un nodo testo vuoto con dimensione di default in UN gesto, ed entra subito in editing", () => {
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

    // entra SUBITO in editing: è il comportamento del brief, diverso da
    // rect/ellipse (che restano strumenti di sola creazione).
    expect(useScene.getState().editingNodeId).toBe(n.id);

    // una voce di undo sola: la creazione passa da un gesto.
    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().canUndo).toBe(true);
    expect(useScene.getState().gesture).toBeNull();
  });

  it("il nodo appena creato nasce con uno stile esplicito, non con gli zeri", () => {
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

  it("il nodo appena creato ha un fill esplicito (leggibile, non il grigio di default delle forme)", () => {
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(0, 0), ctx);

    const n = createdNode(submitted[0]);
    expect(n.fills).toHaveLength(1);
    expect(n.fills[0].kind.case).toBe("solid");
  });

  it("il drag crea un nodo testo della larghezza trascinata (il wrap userà quella larghezza)", () => {
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx();

    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerMove!(at(210, 60), ctx);
    expect(submitted).toHaveLength(0); // niente op durante il drag

    tool.onPointerUp!(at(210, 60), ctx);
    expect(submitted).toHaveLength(1);
    const n = createdNode(submitted[0]);
    expect({ x: n.x, y: n.y, width: n.width, height: n.height }).toEqual({ x: 10, y: 20, width: 200, height: 40 });
    expect(useScene.getState().editingNodeId).toBe(n.id);
  });

  it("normalizza un drag all'indietro", () => {
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(210, 100), ctx);
    tool.onPointerUp!(at(10, 60), ctx);
    const n = createdNode(submitted[0]);
    expect({ x: n.x, y: n.y, width: n.width, height: n.height }).toEqual({ x: 10, y: 60, width: 200, height: 40 });
  });

  it("un drag sotto la soglia (in px SCHERMO) resta un click a qualunque zoom", () => {
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx(64); // molto zoomato: 0.02 unità mondo = ~1px schermo
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerMove!(at(10.02, 20.02), ctx);
    tool.onPointerUp!(at(10.02, 20.02), ctx);
    const n = createdNode(submitted[0]);
    expect(n.width).toBe(DEFAULT_TEXT_WIDTH);
    expect(n.height).toBe(DEFAULT_TEXT_HEIGHT);
  });

  it("deriva l'order key dalla scena, così non collide mai dopo un reload", () => {
    useScene.getState().setScene({ ...emptyScene("doc-1", "u"), nodes: nodesOf({ a: node("a", "a000004") }) });
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(0, 0), ctx);
    tool.onPointerUp!(at(10, 10), ctx);
    expect(createdNode(submitted[0]).orderKey).toBe("a000005");
  });

  it("mostra un'anteprima live durante il drag e la pulisce all'up", () => {
    const tool = createTextTool();
    const { ctx } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerMove!(at(60, 80), ctx);
    expect(useScene.getState().marquee).toEqual({ x: 10, y: 20, width: 50, height: 60 });
    tool.onPointerUp!(at(60, 80), ctx);
    expect(useScene.getState().marquee).toBeNull();
  });

  it("il nodo appena creato è selezionato", () => {
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx();
    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerUp!(at(10, 20), ctx);
    const n = createdNode(submitted[0]);
    expect(useScene.getState().selection).toEqual([n.id]);
  });

  it("abbandona il gesto su deactivate: nessun op, nessuna anteprima, nessuna editing, il prossimo up non fa nulla", () => {
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

  it("annullare la creazione di un testo appena disegnato rimuove il nodo (e il redo lo rimette)", () => {
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

  // Repro concreto del bug di review (Task 4, fix round): due creazioni
  // consecutive con textTool, senza mai uscire esplicitamente dall'editing fra
  // le due. onPointerUp chiama beginTextEditing(id) INCONDIZIONATAMENTE a ogni
  // click -- senza la guardia in store.ts, il primo nodo (rimasto vuoto)
  // sarebbe stato abbandonato: mai passato da endTextEditing, mai ripulito, un
  // nodo fantasma permanente.
  it("un secondo click del tool testo chiude/pulisce l'editing del primo nodo (ancora vuoto) invece di abbandonarlo come fantasma", () => {
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx();

    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerUp!(at(10, 20), ctx);
    const first = createdNode(submitted[0]).id;
    expect(useScene.getState().editingNodeId).toBe(first);
    expect(useScene.getState().scene!.nodes.at(first)).toBeDefined();

    tool.onPointerDown!(at(300, 20), ctx);
    tool.onPointerUp!(at(300, 20), ctx);
    // La pulizia del primo nodo viaggia PRIMA della seconda creazione (vedi
    // il test sull'ordine qui sotto): l'op di creazione è l'ultimo del filo.
    const second = createdNode(submitted[submitted.length - 1]).id;

    expect(useScene.getState().editingNodeId).toBe(second);
    expect(useScene.getState().scene!.nodes.at(first)).toBeUndefined(); // niente nodo fantasma
    expect(useScene.getState().scene!.nodes.at(second)).toBeDefined();
  });

  // Secondo rilievo della review (fix round): la pulizia del nodo precedente
  // lasciava la sua voce di undo DOPO quella della nuova creazione -- il primo
  // Ctrl+Z resuscitava il nodo vuoto appena ripulito invece di annullare il
  // nodo appena creato. L'ordine deve essere quello cronologico dell'utente.
  it("la pulizia del nodo precedente entra nella storia PRIMA della nuova creazione (Ctrl+Z disfa l'ultima cosa fatta)", () => {
    const tool = createTextTool();
    const { ctx, submitted } = fakeCtx();

    tool.onPointerDown!(at(10, 20), ctx);
    tool.onPointerUp!(at(10, 20), ctx);
    const first = createdNode(submitted[0]).id;

    tool.onPointerDown!(at(300, 20), ctx);
    tool.onPointerUp!(at(300, 20), ctx);

    // sul filo: crea t1, cancella t1 (rimasto vuoto), crea t2 -- in quest'ordine.
    expect(submitted.map((op) => op.kind.case)).toEqual(["createNode", "deleteNode", "createNode"]);
    const second = createdNode(submitted[2]).id;
    expect(useScene.getState().undoStack).toHaveLength(3);

    // il primo Ctrl+Z annulla la creazione appena fatta...
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at(second)).toBeUndefined();
    expect(useScene.getState().scene!.nodes.at(first)).toBeUndefined();

    // ...e solo il secondo riporta indietro il nodo ripulito.
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at(first)).toBeDefined();
  });

  it("la seconda creazione non riusa l'order key del nodo appena ripulito", () => {
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

  // Come rect/ellipse, il testo nasce SOTTO la pagina corrente.
  it("crea il nodo testo sotto la pagina corrente", () => {
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

  it("beginTextEditing imposta editingNodeId", () => {
    useScene.getState().beginTextEditing("n1");
    expect(useScene.getState().editingNodeId).toBe("n1");
  });

  it("endTextEditing lo svuota", () => {
    useScene.getState().beginTextEditing("n1");
    useScene.getState().endTextEditing();
    expect(useScene.getState().editingNodeId).toBeNull();
  });

  it("endTextEditing senza editing aperto è un no-op silenzioso", () => {
    expect(() => useScene.getState().endTextEditing()).not.toThrow();
    expect(useScene.getState().editingNodeId).toBeNull();
  });

  it("un nodo testo VUOTO che esce dall'editing senza contenuto viene eliminato, in un gesto annullabile", () => {
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

    // annullabile: Ctrl+Z riporta il nodo (vuoto) sulla scena.
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at(id)).toBeDefined();
  });

  it("un nodo testo con contenuto NON viene eliminato uscendo dall'editing", () => {
    useScene.getState().setScene({
      ...emptyScene("doc-1", "u"),
      nodes: nodesOf({
        t1: {
          id: "t1", parentId: "page1", orderKey: "a000000", name: "Text", visible: true, opacity: 1,
          x: 0, y: 0, width: 100, height: 20, rotation: 0,
          fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false,
          text: { content: "ciao", style: { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" } },
        },
      }),
    });
    useScene.getState().beginTextEditing("t1");
    useScene.getState().endTextEditing();
    expect(useScene.getState().editingNodeId).toBeNull();
    expect(useScene.getState().scene!.nodes.at("t1")).toBeDefined();
  });

  it("uscendo dall'editing di un nodo NON di testo (misuso) non elimina nulla", () => {
    useScene.getState().setScene({ ...emptyScene("doc-1", "u"), nodes: nodesOf({ a: node("a", "a000000") }) });
    useScene.getState().beginTextEditing("a");
    useScene.getState().endTextEditing();
    expect(useScene.getState().scene!.nodes.at("a")).toBeDefined();
  });

  // Bug trovato in review: beginTextEditing sovrascriveva editingNodeId senza
  // MAI passare la sessione precedente da endTextEditing -- un secondo
  // beginTextEditing (doppio click su un altro nodo testo, o una seconda
  // creazione col tool testo) abbandonava in silenzio il nodo precedente, che
  // se rimasto vuoto restava fantasma sulla scena per sempre.
  describe("beginTextEditing chiude/pulisce una sessione già aperta", () => {
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

    it("passare da un nodo testo VUOTO a un altro lo elimina (nessun fantasma), in un gesto annullabile", () => {
      useScene.getState().beginTextEditing("t1");
      expect(useScene.getState().editingNodeId).toBe("t1");
      const undoDepthAfterFirstEdit = useScene.getState().undoStack.length;

      useScene.getState().beginTextEditing("t2");

      expect(useScene.getState().editingNodeId).toBe("t2");
      expect(useScene.getState().scene!.nodes.at("t1")).toBeUndefined(); // t1 ripulito, non fantasma
      expect(useScene.getState().scene!.nodes.at("t2")).toBeDefined();
      expect(useScene.getState().undoStack.length).toBe(undoDepthAfterFirstEdit + 1);

      // annullabile come qualunque altra pulizia (vedi endTextEditing).
      useScene.getState().undo();
      expect(useScene.getState().scene!.nodes.at("t1")).toBeDefined();
    });

    it("passare da un nodo testo CON contenuto a un altro non lo elimina", () => {
      useScene.getState().setScene({
        ...useScene.getState().scene!,
        nodes: nodesWith(useScene.getState().scene!.nodes, {
          t1: { ...useScene.getState().scene!.nodes.at("t1"), text: { content: "ciao", style: useScene.getState().scene!.nodes.at("t1").text!.style } },
        }),
      });

      useScene.getState().beginTextEditing("t1");
      useScene.getState().beginTextEditing("t2");

      expect(useScene.getState().editingNodeId).toBe("t2");
      expect(useScene.getState().scene!.nodes.at("t1")).toBeDefined();
      expect(useScene.getState().scene!.nodes.at("t1").text?.content).toBe("ciao");
    });

    it("richiamare beginTextEditing con lo STESSO nodo già in editing è un no-op (non lo cancella)", () => {
      useScene.getState().beginTextEditing("t1");
      const undoDepth = useScene.getState().undoStack.length;

      useScene.getState().beginTextEditing("t1");

      expect(useScene.getState().editingNodeId).toBe("t1");
      expect(useScene.getState().scene!.nodes.at("t1")).toBeDefined();
      expect(useScene.getState().undoStack.length).toBe(undoDepth); // nessuna cancellazione spuria
    });
  });
});
