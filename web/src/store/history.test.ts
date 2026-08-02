import { describe, it, expect } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema, TextStyleSchema, SetVectorPathSchema, TextAlign } from "../gen/brawt/v1/brawt_pb";
import type { Node as PbNode, Op } from "../gen/brawt/v1/brawt_pb";
import { applyOp } from "./applyOp";
import { emptyScene, toNodeLite, toPbNode, type NodeLite, type SceneState } from "./types";
import { invertOp } from "./history";

// Nodo "ricco": ogni campo diverso dal suo zero, così un inverso che ne
// dimentica uno si vede subito nel round-trip. I canali colore sono float32 nel
// proto: valori esattamente rappresentabili (multipli di 1/4) per non far
// dipendere il test dall'arrotondamento.
function richRect(id = "n1"): PbNode {
  return create(NodeSchema, {
    id, parentId: "page1", orderKey: "a3V", name: "Blob",
    visible: false, opacity: 0.25,
    x: 10, y: -20, width: 100, height: 80, rotation: 0.5,
    fills: [
      { kind: { case: "solid", value: { color: { r: 0.25, g: 0.5, b: 0.75, a: 1 } } } },
      { kind: { case: "solid", value: { color: { r: 1, g: 0, b: 0, a: 0.5 } } } },
    ],
    shape: { case: "rect", value: { cornerRadius: 12 } },
  });
}

function richEllipse(id = "e1"): PbNode {
  return create(NodeSchema, {
    id, parentId: "page1", orderKey: "a7", name: "Round",
    visible: true, opacity: 1,
    x: 3, y: 4, width: 60, height: 30, rotation: 0,
    fills: [{ kind: { case: "solid", value: { color: { r: 0, g: 0.5, b: 1, a: 1 } } } }],
    shape: { case: "ellipse", value: {} },
  });
}

function richText(id = "t1"): PbNode {
  return create(NodeSchema, {
    id, parentId: "page1", orderKey: "a5", name: "Titolo",
    visible: true, opacity: 0.75,
    x: 8, y: 9, width: 320, height: 48, rotation: 0,
    fills: [{ kind: { case: "solid", value: { color: { r: 0, g: 0, b: 0, a: 1 } } } }],
    shape: { case: "text", value: {
      content: "ciao\nmondo",
      style: { fontFamily: "Inter", fontSize: 24, fontWeight: "700", lineHeight: 1.5, align: TextAlign.RIGHT },
    } },
  });
}

// Un nodo vettoriale "ricco": due subpath che differiscono SOLO per `closed`, e
// maniglie bézier asimmetriche mai nulle (sono OFFSET relativi all'ancoraggio,
// vedi il proto: nulle significherebbe "nessuna maniglia"). Una conversione
// che perdesse `closed`, che scartasse in/out o che le ricavasse per
// specchiatura produrrebbe qui un round-trip diverso -- e in produzione
// distruggerebbe in silenzio le curve dell'utente al primo undo.
function richVector(id = "v1"): PbNode {
  const anchors = [
    { x: 0, y: 0, inX: -4, inY: -3, outX: 5, outY: 2 },
    { x: 40, y: 12, inX: -5, inY: -6, outX: 6, outY: 7 },
  ];
  return create(NodeSchema, {
    id, parentId: "page1", orderKey: "a9", name: "Path",
    visible: true, opacity: 0.5,
    x: 1, y: 2, width: 80, height: 40, rotation: 0,
    fills: [{ kind: { case: "solid", value: { color: { r: 0.25, g: 0.5, b: 0.75, a: 1 } } } }],
    shape: { case: "vector", value: { subpaths: [
      { anchors, closed: true },
      { anchors, closed: false },
    ] } },
  });
}

function setVectorPathOp(id: string, subpaths: MessageInitShape<typeof SetVectorPathSchema>["subpaths"]): Op {
  return create(OpSchema, {
    opId: "op-setvector", docId: "doc1",
    kind: { case: "setVectorPath", value: { id, subpaths } },
  });
}

function setTextOp(id: string, content: string, style?: MessageInitShape<typeof TextStyleSchema>): Op {
  return create(OpSchema, {
    opId: "op-settext", docId: "doc1",
    kind: { case: "setText", value: { id, content, style, stylePresent: style !== undefined } },
  });
}

function createOp(node: PbNode): Op {
  return create(OpSchema, { opId: "op-create", docId: "doc1", kind: { case: "createNode", value: { node } } });
}

function deleteOp(id: string): Op {
  return create(OpSchema, { opId: "op-delete", docId: "doc1", kind: { case: "deleteNode", value: { id } } });
}

function setPropsOp(id: string, patch: MessageInitShape<typeof NodeSchema>, paths: string[]): Op {
  return create(OpSchema, {
    opId: "op-set", docId: "doc1",
    kind: { case: "setProps", value: { id, patch: create(NodeSchema, patch), mask: { paths } } },
  });
}

function sceneWith(...nodes: PbNode[]): SceneState {
  return nodes.reduce((s, n) => applyOp(s, createOp(n)), emptyScene("doc1", "Untitled"));
}

// LA proprietà: applicare un op e poi il suo inverso riporta la scena
// ESATTAMENTE allo stato di partenza. Asserire sul round-trip invece che sui
// singoli campi coglie anche i campi che nessuno si è ricordato di controllare.
function expectRoundTrip(scene: SceneState, op: Op): Op {
  const inv = invertOp(scene, op);
  expect(inv).not.toBeNull();
  expect(applyOp(applyOp(scene, op), inv as Op)).toEqual(scene);
  return inv as Op;
}

describe("toPbNode", () => {
  it("is the inverse of toNodeLite (rect, tutti i campi)", () => {
    const lite = toNodeLite(richRect());
    expect(toNodeLite(toPbNode(lite))).toEqual(lite);
  });

  it("is the inverse of toNodeLite (ellipse)", () => {
    const lite = toNodeLite(richEllipse());
    const back = toPbNode(lite);
    expect(back.shape.case).toBe("ellipse");
    expect(toNodeLite(back)).toEqual(lite);
  });

  it("is the inverse of toNodeLite (text: contenuto E stile)", () => {
    const lite = toNodeLite(richText());
    const back = toPbNode(lite);
    expect(back.shape.case).toBe("text");
    if (back.shape.case !== "text") throw new Error("wrong shape");
    expect(back.shape.value.content).toBe("ciao\nmondo");
    expect(back.shape.value.style?.fontSize).toBe(24);
    expect(back.shape.value.style?.fontWeight).toBe("700");
    expect(back.shape.value.style?.align).toBe(TextAlign.RIGHT);
    expect(toNodeLite(back)).toEqual(lite);
  });

  // La conversione della geometria è il punto in cui una perdita non fa rumore:
  // un campo dimenticato non rompe niente subito, cancella le curve dell'utente
  // al primo undo (l'inverso di una delete è la create del nodo com'era, e il
  // modello in memoria tiene solo NodeLite).
  it("is the inverse of toNodeLite (vector: subpath, ancoraggi E maniglie)", () => {
    const lite = toNodeLite(richVector());
    const back = toPbNode(lite);
    expect(back.shape.case).toBe("vector");
    if (back.shape.case !== "vector") throw new Error("wrong shape");

    // Esplicito prima del round-trip: `toEqual` da solo passerebbe anche se
    // ENTRAMBE le direzioni perdessero lo stesso campo nello stesso modo.
    expect(back.shape.value.subpaths).toHaveLength(2);
    expect(back.shape.value.subpaths.map((sp) => sp.closed)).toEqual([true, false]);
    const a = back.shape.value.subpaths[0].anchors[1];
    expect([a.x, a.y, a.inX, a.inY, a.outX, a.outY]).toEqual([40, 12, -5, -6, 6, 7]);

    expect(toNodeLite(back)).toEqual(lite);
  });

  // Un path SVUOTATO resta un nodo vettoriale: ricostruirlo come rettangolo
  // sarebbe un cambio di forma silenzioso dentro un undo (stessa ragione per
  // cui il ramo "text" non ricade su rect quando il contenuto manca).
  it("un vector senza subpath resta un vector (non ricade su rect)", () => {
    const lite: NodeLite = { ...toNodeLite(richVector()), vector: { subpaths: [] } };
    const back = toPbNode(lite);
    expect(back.shape.case).toBe("vector");
    expect(toNodeLite(back)).toEqual(lite);
  });
});

describe("invertOp: createNode", () => {
  it("round-trips: create + inverso = scena vuota di partenza", () => {
    const scene = emptyScene("doc1", "Untitled");
    const inv = expectRoundTrip(scene, createOp(richRect()));
    expect(inv.kind.case).toBe("deleteNode");
    expect(inv.kind.case === "deleteNode" && inv.kind.value.id).toBe("n1");
  });

  it("null quando l'id esiste già: l'op diretto è rifiutato (ErrNodeExists in Go)", () => {
    // core.applyCreate (Go) rifiuta un id già presente e applyOp lo mirrora:
    // l'op diretto non cambia NIENTE, quindi non c'è niente da annullare.
    // Generare un inverso qui manderebbe al server l'undo di un op che il
    // server ha respinto.
    const scene = sceneWith(richRect());
    const op = createOp(richEllipse("n1"));
    expect(applyOp(scene, op)).toEqual(scene);
    expect(invertOp(scene, op)).toBeNull();
  });
});

describe("invertOp: setProps", () => {
  it("round-trips su una mask multipla (x,y,width,height)", () => {
    const scene = sceneWith(richRect());
    const inv = expectRoundTrip(
      scene,
      setPropsOp("n1", { x: 999, y: 888, width: 7, height: 6 }, ["x", "y", "width", "height"]),
    );
    expect(inv.kind.case).toBe("setProps");
    if (inv.kind.case !== "setProps") throw new Error("wrong kind");
    // stessa mask dell'op diretto: cambia solo ciò che l'op aveva cambiato.
    expect(inv.kind.value.mask?.paths).toEqual(["x", "y", "width", "height"]);
    expect(inv.kind.value.patch?.x).toBe(10);
    expect(inv.kind.value.patch?.y).toBe(-20);
  });

  it("round-trips su fills / name / visible / opacity / rotation", () => {
    const scene = sceneWith(richRect());
    expectRoundTrip(
      scene,
      setPropsOp(
        "n1",
        {
          name: "Altro", visible: true, opacity: 1, rotation: 1.25,
          fills: [{ kind: { case: "solid", value: { color: { r: 0, g: 0, b: 0, a: 1 } } } }],
        },
        ["fills", "name", "visible", "opacity", "rotation"],
      ),
    );
  });

  it("round-trips una mask a un solo path senza toccare il resto", () => {
    const scene = sceneWith(richRect(), richEllipse());
    expectRoundTrip(scene, setPropsOp("e1", { x: 42 }, ["x"]));
  });

  it("round-trips un op SENZA patch, che AZZERA i campi in mask (getter nil-safe di Go)", () => {
    // Go legge il patch con p.GetX() & co.: su un patch nil ritornano lo zero
    // del campo, quindi l'op azzera x e fills invece di essere un no-op.
    // Verifico prima che l'op diretto morda davvero -- se fosse un no-op il
    // round-trip passerebbe per finta.
    const scene = sceneWith(richRect());
    const op = create(OpSchema, {
      opId: "op-set", docId: "doc1",
      kind: { case: "setProps", value: { id: "n1", mask: { paths: ["x", "fills"] } } },
    });
    const after = applyOp(scene, op);
    expect(after.nodes["n1"].x).toBe(0);
    expect(after.nodes["n1"].fills).toEqual([]);
    expect(after.nodes["n1"].y).toBe(-20); // fuori mask: intatto

    expectRoundTrip(scene, op);
  });
});

describe("invertOp: deleteNode", () => {
  it("ripristina TUTTI i campi del rect (fills, orderKey, kind, cornerRadius)", () => {
    const scene = sceneWith(richRect());
    const inv = expectRoundTrip(scene, deleteOp("n1"));
    expect(inv.kind.case).toBe("createNode");
    if (inv.kind.case !== "createNode") throw new Error("wrong kind");
    const restored = inv.kind.value.node as PbNode;
    expect(restored.orderKey).toBe("a3V");
    expect(restored.name).toBe("Blob");
    expect(restored.visible).toBe(false);
    expect(restored.opacity).toBe(0.25);
    expect(restored.rotation).toBe(0.5);
    expect(restored.fills.length).toBe(2);
    expect(restored.shape.case).toBe("rect");
    expect(restored.shape.case === "rect" && restored.shape.value.cornerRadius).toBe(12);
  });

  it("ripristina un ellipse mantenendo il discriminante di forma", () => {
    const scene = sceneWith(richRect(), richEllipse());
    const inv = expectRoundTrip(scene, deleteOp("e1"));
    expect(inv.kind.case === "createNode" && inv.kind.value.node?.shape.case).toBe("ellipse");
  });
});

describe("invertOp: setText", () => {
  it("round-trips un cambio di solo contenuto", () => {
    const scene = sceneWith(richText());
    const inv = expectRoundTrip(scene, setTextOp("t1", "altro contenuto"));
    expect(inv.kind.case).toBe("setText");
    if (inv.kind.case !== "setText") throw new Error("wrong kind");
    expect(inv.kind.value.content).toBe("ciao\nmondo");
    // L'inverso porta SEMPRE stylePresent=true: rimettere lo stile precedente è
    // un no-op quando l'op diretto non l'aveva toccato, mentre ometterlo
    // lascerebbe in piedi lo stile NUOVO dopo l'undo di un op che l'aveva
    // cambiato. Un solo ramo, sempre esatto.
    expect(inv.kind.value.stylePresent).toBe(true);
    expect(inv.kind.value.style?.fontSize).toBe(24);
  });

  it("round-trips un cambio di stile (stylePresent=true)", () => {
    const scene = sceneWith(richText());
    const op = setTextOp("t1", "ciao\nmondo", { fontFamily: "Inter", fontSize: 12, fontWeight: "400", lineHeight: 1, align: TextAlign.CENTER });
    // L'op diretto morde davvero: senza questo, il round-trip passerebbe per finta.
    expect(applyOp(scene, op).nodes["t1"].text?.style.fontSize).toBe(12);
    expectRoundTrip(scene, op);
  });

  it("null su un id inesistente", () => {
    expect(invertOp(sceneWith(richText()), setTextOp("ghost", "x"))).toBeNull();
  });

  it("null su un nodo NON di testo: l'op diretto è rifiutato (ErrNotTextNode in Go)", () => {
    const scene = sceneWith(richRect());
    const op = setTextOp("n1", "x");
    expect(applyOp(scene, op)).toEqual(scene);
    expect(invertOp(scene, op)).toBeNull();
  });
});

describe("invertOp: setVectorPath", () => {
  it("round-trips una sostituzione di path portando i subpath PRECEDENTI", () => {
    const scene = sceneWith(richVector());
    const op = setVectorPathOp("v1", [{ anchors: [{ x: 5, y: 5, inX: 1, inY: 1, outX: 9, outY: 9 }], closed: false }]);
    // L'op diretto morde davvero: senza questo, il round-trip passerebbe per finta.
    expect(applyOp(scene, op).nodes["v1"].vector?.subpaths).toHaveLength(1);
    const inv = expectRoundTrip(scene, op);

    expect(inv.kind.case).toBe("setVectorPath");
    if (inv.kind.case !== "setVectorPath") throw new Error("wrong kind");
    // I due subpath precedenti, `closed` compreso: è il campo che distingue i
    // due contorni di richVector, altrimenti identici.
    expect(inv.kind.value.subpaths.map((sp) => sp.closed)).toEqual([true, false]);
    const a = inv.kind.value.subpaths[0].anchors[1];
    expect([a.x, a.y, a.inX, a.inY, a.outX, a.outY]).toEqual([40, 12, -5, -6, 6, 7]);
  });

  // Il caso che l'op dedicato rende banale: SVUOTARE un path è annullabile
  // esattamente come riempirlo, perché l'inverso è sempre "i subpath di prima".
  it("round-trips lo SVUOTAMENTO di un path", () => {
    const scene = sceneWith(richVector());
    const op = setVectorPathOp("v1", []);
    expect(applyOp(scene, op).nodes["v1"].vector?.subpaths).toEqual([]);
    expectRoundTrip(scene, op);
  });

  it("round-trips il RIEMPIMENTO di un path prima vuoto (inverso = lista vuota)", () => {
    const empty = create(NodeSchema, {
      id: "v0", parentId: "page1", orderKey: "a1", name: "Vuoto", visible: true, opacity: 1,
      shape: { case: "vector", value: {} },
    });
    const scene = sceneWith(empty);
    const inv = expectRoundTrip(scene, setVectorPathOp("v0", [{ anchors: [{ x: 1, y: 2 }], closed: false }]));
    expect(inv.kind.case === "setVectorPath" && inv.kind.value.subpaths).toEqual([]);
  });

  it("null su un id inesistente", () => {
    expect(invertOp(sceneWith(richVector()), setVectorPathOp("ghost", []))).toBeNull();
  });

  it("null su un nodo NON vettoriale: l'op diretto è rifiutato (ErrNotVectorNode in Go)", () => {
    const scene = sceneWith(richRect());
    const op = setVectorPathOp("n1", [{ anchors: [{ x: 1, y: 2 }], closed: true }]);
    expect(applyOp(scene, op)).toEqual(scene);
    expect(invertOp(scene, op)).toBeNull();
  });
});

describe("invertOp: nessun inverso possibile", () => {
  it("null per setProps su un id inesistente", () => {
    expect(invertOp(sceneWith(richRect()), setPropsOp("ghost", { x: 1 }, ["x"]))).toBeNull();
  });

  it("null per deleteNode su un id inesistente", () => {
    expect(invertOp(sceneWith(richRect()), deleteOp("ghost"))).toBeNull();
  });

  it("null per createNode senza nodo", () => {
    const op = create(OpSchema, { opId: "x", docId: "doc1", kind: { case: "createNode", value: {} } });
    expect(invertOp(emptyScene("doc1", "Untitled"), op)).toBeNull();
  });

  it("null per createNode con id vuoto (ErrNilNode in Go)", () => {
    const op = createOp(create(NodeSchema, { id: "", parentId: "page1" }));
    expect(invertOp(emptyScene("doc1", "Untitled"), op)).toBeNull();
  });

  it("null per un op senza kind", () => {
    expect(invertOp(emptyScene("doc1", "Untitled"), create(OpSchema, { opId: "x", docId: "doc1" }))).toBeNull();
  });
});

describe("invertOp: identità dell'op", () => {
  it("eredita il docId dell'op diretto e riceve un opId nuovo e unico", () => {
    const scene = sceneWith(richRect());
    const op = deleteOp("n1");
    const a = invertOp(scene, op) as Op;
    const b = invertOp(scene, op) as Op;
    expect(a.docId).toBe("doc1");
    expect(a.opId).not.toBe("");
    expect(a.opId).not.toBe(op.opId);
    expect(a.opId).not.toBe(b.opId);
  });

  it("non muta la scena né l'op passati", () => {
    const scene = sceneWith(richRect());
    const before: NodeLite = { ...scene.nodes["n1"] };
    const op = setPropsOp("n1", { x: 5 }, ["x"]);
    invertOp(scene, op);
    expect(scene.nodes["n1"]).toEqual(before);
    expect(op.kind.case === "setProps" && op.kind.value.patch?.x).toBe(5);
  });
});
