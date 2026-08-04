import { describe, it, expect } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  OpSchema, NodeSchema, SetTextSchema, SetVectorPathSchema, VectorNodeSchema, TextAlign,
} from "../gen/brawt/v1/brawt_pb";
import type { Node as PbNode } from "../gen/brawt/v1/brawt_pb";
import { applyOp } from "./applyOp";
import { emptyScene, toNodeLite, toPbNode } from "./types";

function createRectOp(id: string, x: number, y: number) {
  const node = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Rect", visible: true, opacity: 1,
    x, y, width: 100, height: 80,
    shape: { case: "rect", value: { cornerRadius: 0 } },
  });
  return create(OpSchema, { opId: "op-" + id, docId: "doc1", kind: { case: "createNode", value: { node } } });
}

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function createImageOp(id: string) {
  const node = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Image", visible: true, opacity: 1,
    x: 10, y: 20, width: 320, height: 180,
    shape: { case: "image", value: { assetHash: HASH } },
  });
  return create(OpSchema, { opId: "op-" + id, docId: "doc1", kind: { case: "createNode", value: { node } } });
}

describe("applyOp", () => {
  it("creates a rect node", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("n1", 10, 20));
    expect(s.nodes["n1"].x).toBe(10);
    expect(s.nodes["n1"].kind).toBe("rect");
  });

  it("creates an ellipse node", () => {
    const node = create(NodeSchema, {
      id: "n1", parentId: "page1", orderKey: "a0", name: "Ellipse", visible: true, opacity: 1,
      x: 10, y: 20, width: 100, height: 80,
      shape: { case: "ellipse", value: {} },
    });
    const op = create(OpSchema, { opId: "op-n1", docId: "doc1", kind: { case: "createNode", value: { node } } });
    const s = applyOp(emptyScene("doc1", "Untitled"), op);
    expect(s.nodes["n1"].kind).toBe("ellipse");
  });

  // Un gruppo è un CONTENITORE, non una forma: il oneof `shape` dice cosa un
  // nodo è, e "group" ci sta dentro come le altre (proto: GroupNode = 33).
  it("creates a group node", () => {
    const node = create(NodeSchema, {
      id: "g1", parentId: "page1", orderKey: "a0", name: "Gruppo", visible: true, opacity: 1,
      shape: { case: "group", value: {} },
    });
    const op = create(OpSchema, { opId: "op-g1", docId: "doc1", kind: { case: "createNode", value: { node } } });
    const s = applyOp(emptyScene("doc1", "Untitled"), op);
    expect(s.nodes["g1"].kind).toBe("group");
  });

  // Parità con core.applySetProps (Go), che risponde ErrNotRectNode su un
  // gruppo: un gruppo non ha niente da riempire, quindi nessun angolo da
  // arrotondare. L'op è rifiutato in BLOCCO -- nemmeno la "x" della stessa mask
  // si muove.
  it("rejects corner_radius on a group, x included", () => {
    const node = create(NodeSchema, {
      id: "g1", parentId: "page1", orderKey: "a0", name: "Gruppo", visible: true, opacity: 1,
      shape: { case: "group", value: {} },
    });
    let s = applyOp(emptyScene("doc1", "Untitled"),
      create(OpSchema, { opId: "c", docId: "doc1", kind: { case: "createNode", value: { node } } }));
    const before = s;
    s = applyOp(s, create(OpSchema, { opId: "r", docId: "doc1", kind: { case: "setProps", value: {
      id: "g1",
      patch: create(NodeSchema, { x: 42, shape: { case: "rect", value: { cornerRadius: 12 } } }),
      mask: { paths: ["x", "corner_radius"] },
    } } }));
    expect(s).toBe(before);
    expect(s.nodes["g1"].x).toBe(0);
    expect(s.nodes["g1"].kind).toBe("group");
  });

  it("moves via setProperties + mask", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("n1", 0, 0));
    const move = create(OpSchema, { opId: "m", docId: "doc1", kind: { case: "setProps", value: {
      id: "n1", patch: create(NodeSchema, { x: 42, y: 7 }), mask: { paths: ["x", "y"] } } } });
    s = applyOp(s, move);
    expect(s.nodes["n1"].x).toBe(42);
    expect(s.nodes["n1"].y).toBe(7);
  });

  it("deletes a node", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("n1", 0, 0));
    const del = create(OpSchema, { opId: "d", docId: "doc1", kind: { case: "deleteNode", value: { id: "n1" } } });
    s = applyOp(s, del);
    expect(s.nodes["n1"]).toBeUndefined();
  });

  it("rejects createNode on an id that already exists (parity with core.applyCreate: ErrNodeExists)", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("n1", 10, 20));
    // Go returns ErrNodeExists and mutates nothing, so the server would refuse
    // this op. Overwriting locally would silently diverge from the document
    // the server actually holds.
    const s2 = applyOp(s, createRectOp("n1", 999, 999));
    expect(s2).toEqual(s);
    expect(s2.nodes["n1"].x).toBe(10);
  });

  it("rejects a createNode whose node has an empty id (parity with core.applyCreate: ErrNilNode)", () => {
    const node = create(NodeSchema, { id: "", parentId: "page1", shape: { case: "rect", value: { cornerRadius: 0 } } });
    const op = create(OpSchema, { opId: "op-empty", docId: "doc1", kind: { case: "createNode", value: { node } } });
    const s = applyOp(emptyScene("doc1", "Untitled"), op);
    expect(Object.keys(s.nodes)).toEqual([]);
  });

  it("zeroes the masked fields when setProps carries no patch (parity with Go's nil-safe getters)", () => {
    const node = create(NodeSchema, {
      id: "n1", parentId: "page1", orderKey: "a0", name: "Rect", visible: true, opacity: 1,
      x: 10, y: 20, width: 100, height: 80,
      fills: [{ kind: { case: "solid", value: { color: { r: 0.5, g: 0.5, b: 0.5, a: 1 } } } }],
      shape: { case: "rect", value: { cornerRadius: 0 } },
    });
    let s = applyOp(emptyScene("doc1", "Untitled"),
      create(OpSchema, { opId: "op-n1", docId: "doc1", kind: { case: "createNode", value: { node } } }));
    expect(s.nodes["n1"].fills.length).toBe(1);
    // Go reads the patch through p.GetX() & co., which return the field's zero
    // value on a nil *Node: applySetProps ZEROES x and fills here, it does not
    // skip the op.
    const noPatch = create(OpSchema, { opId: "np", docId: "doc1", kind: { case: "setProps", value: {
      id: "n1", mask: { paths: ["x", "fills"] } } } });
    s = applyOp(s, noPatch);
    expect(s.nodes["n1"].x).toBe(0);
    expect(s.nodes["n1"].fills).toEqual([]);
    expect(s.nodes["n1"].y).toBe(20); // outside the mask: untouched
    expect(s.nodes["n1"].width).toBe(100);
  });

  it("rejects the whole setProps op atomically when the mask has an unsupported path (parity with core.applySetProps in Go)", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("n1", 0, 0));
    const badMove = create(OpSchema, { opId: "m2", docId: "doc1", kind: { case: "setProps", value: {
      id: "n1", patch: create(NodeSchema, { x: 42, y: 7 }), mask: { paths: ["x", "someFutureField"] } } } });
    s = applyOp(s, badMove);
    // Go's applySetProps validates the entire mask before mutating anything,
    // so an unsupported path rejects the op as a whole -- "x" must NOT be
    // partially applied here.
    expect(s.nodes["n1"].x).toBe(0);
    expect(s.nodes["n1"].y).toBe(0);
  });
});

// --- albero: parent, cascata, riparentazione -------------------------------
// Speculari a internal/core/tree_test.go. Le fixture in testdata/golden/
// (cascade_delete, reparent, reparent_cycle_rejected, create_orphan_rejected)
// fanno girare gli STESSI casi da entrambi i lati; questi test coprono il lato
// TS con la granularità che una fixture non ha (quale stato resta invariato).

function createChildOp(id: string, parentId: string, orderKey = "a1") {
  const node = create(NodeSchema, {
    id, parentId, orderKey, name: id, visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10,
    shape: { case: "rect", value: { cornerRadius: 0 } },
  });
  return create(OpSchema, { opId: "op-" + id, docId: "doc1", kind: { case: "createNode", value: { node } } });
}

function reparentOp(id: string, newParentId: string, orderKey: string) {
  return create(OpSchema, {
    opId: `rp-${id}`, docId: "doc1",
    kind: { case: "reparentNode", value: { id, newParentId, orderKey } },
  });
}

//   page1
//   ├── g1
//   │   ├── c1
//   │   │   └── d1
//   │   └── c2
//   └── other
function treeScene() {
  return [
    createChildOp("g1", "page1", "a1"),
    createChildOp("c1", "g1", "a1"),
    createChildOp("d1", "c1", "a1"),
    createChildOp("c2", "g1", "a2"),
    createChildOp("other", "page1", "a2"),
  ].reduce((s, op) => applyOp(s, op), emptyScene("doc1", "Untitled"));
}

describe("applyOp: createNode e il parent", () => {
  it("accetta un parent che è un NODO (annidamento)", () => {
    const s = applyOp(applyOp(emptyScene("doc1", "Untitled"), createChildOp("g1", "page1")), createChildOp("c1", "g1"));
    expect(s.nodes["c1"].parentId).toBe("g1");
  });

  it("rifiuta un parent inesistente (parità con ErrParentNotFound in Go)", () => {
    const s = emptyScene("doc1", "Untitled");
    // Il server rifiuta l'op: crearlo qui vorrebbe dire tenere in locale un
    // nodo che nessuna pagina raggiunge e che il documento autorevole non ha.
    expect(applyOp(s, createChildOp("n1", "ghost"))).toEqual(s);
  });

  it("rifiuta un parent vuoto", () => {
    const s = emptyScene("doc1", "Untitled");
    expect(applyOp(s, createChildOp("n1", ""))).toEqual(s);
  });
});

describe("applyOp: deleteNode a cascata", () => {
  it("cancella il nodo E tutti i discendenti", () => {
    const s = applyOp(treeScene(), create(OpSchema, {
      opId: "del", docId: "doc1", kind: { case: "deleteNode", value: { id: "g1" } },
    }));
    expect(Object.keys(s.nodes)).toEqual(["other"]);
  });

  it("cancellare una foglia non tocca i fratelli", () => {
    const s = applyOp(treeScene(), create(OpSchema, {
      opId: "del", docId: "doc1", kind: { case: "deleteNode", value: { id: "c2" } },
    }));
    expect(Object.keys(s.nodes).sort()).toEqual(["c1", "d1", "g1", "other"]);
  });

  it("id inesistente: scena invariata (ErrNodeNotFound in Go)", () => {
    const s = treeScene();
    expect(applyOp(s, create(OpSchema, {
      opId: "del", docId: "doc1", kind: { case: "deleteNode", value: { id: "ghost" } },
    }))).toEqual(s);
  });
});

describe("applyOp: reparentNode", () => {
  it("sposta il nodo e riscrive la order key; il sottoalbero lo segue", () => {
    const s = applyOp(treeScene(), reparentOp("c1", "other", "a9"));
    expect(s.nodes["c1"].parentId).toBe("other");
    expect(s.nodes["c1"].orderKey).toBe("a9");
    // I figli puntano al nodo, non al nonno: nessuno li riscrive.
    expect(s.nodes["d1"].parentId).toBe("c1");
  });

  it("accetta una PAGINA come nuovo parent", () => {
    const s = applyOp(treeScene(), reparentOp("d1", "page1", "a3"));
    expect(s.nodes["d1"].parentId).toBe("page1");
  });

  it("stesso parent + nuova chiave = riordino fra pari", () => {
    const s = applyOp(treeScene(), reparentOp("c1", "g1", "a3"));
    expect(s.nodes["c1"].parentId).toBe("g1");
    expect(s.nodes["c1"].orderKey).toBe("a3");
  });

  it.each([
    ["se stesso", "g1", "g1"],
    ["un figlio diretto", "g1", "c1"],
    ["un discendente profondo", "g1", "d1"],
  ])("rifiuta il ciclo: %s (parità con ErrCycle in Go)", (_name, id, parent) => {
    const s = treeScene();
    // Rifiuto in BLOCCO: nemmeno la order key si muove.
    expect(applyOp(s, reparentOp(id, parent, "a9"))).toEqual(s);
  });

  it("rifiuta un nuovo parent inesistente", () => {
    const s = treeScene();
    expect(applyOp(s, reparentOp("c1", "ghost", "a9"))).toEqual(s);
  });

  it("rifiuta un nodo inesistente", () => {
    const s = treeScene();
    expect(applyOp(s, reparentOp("ghost", "page1", "a9"))).toEqual(s);
  });
});

// --- corner_radius ---------------------------------------------------------
// Speculari a internal/core/apply_test.go (TestApplySetPropertiesCornerRadius*).
// È l'unico path della mask che indirizza un campo DENTRO il oneof `shape`,
// quindi è anche l'unico che può trovare il nodo della forma SBAGLIATA -- e in
// quel caso Go risponde ErrNotRectNode e rifiuta l'op in blocco.

// `x` opzionale = "fai viaggiare anche una x nella STESSA mask", per provare
// che il rifiuto è in blocco e non parziale.
function setCornerRadiusOp(id: string, cornerRadius: number, x?: number) {
  return create(OpSchema, { opId: "op-cr", docId: "doc1", kind: { case: "setProps", value: {
    id,
    patch: create(NodeSchema, { x: x ?? 0, shape: { case: "rect", value: { cornerRadius } } }),
    mask: { paths: x === undefined ? ["corner_radius"] : ["x", "corner_radius"] },
  } } });
}

describe("applyOp: corner_radius", () => {
  it("scrive il raggio di un rettangolo", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("n1", 0, 0));
    s = applyOp(s, setCornerRadiusOp("n1", 12));
    expect(s.nodes["n1"].cornerRadius).toBe(12);
  });

  it("un patch senza rect AZZERA il raggio (parità con i getter nil-safe di Go)", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("n1", 0, 0));
    s = applyOp(s, setCornerRadiusOp("n1", 8));
    const nilPatch = create(OpSchema, { opId: "op-cr2", docId: "doc1", kind: { case: "setProps", value: {
      id: "n1", mask: { paths: ["corner_radius"] } } } });
    s = applyOp(s, nilPatch);
    expect(s.nodes["n1"].cornerRadius).toBe(0);
  });

  it("su un'ellisse rifiuta l'INTERO op (parità con ErrNotRectNode)", () => {
    const node = create(NodeSchema, {
      id: "n1", parentId: "page1", orderKey: "a0", name: "Ellipse", visible: true, opacity: 1,
      x: 0, y: 0, width: 100, height: 80, shape: { case: "ellipse", value: {} },
    });
    const s = applyOp(emptyScene("doc1", "Untitled"),
      create(OpSchema, { opId: "op-n1", docId: "doc1", kind: { case: "createNode", value: { node } } }));
    // "x" viaggia nella STESSA mask: come per un path ignoto, il rifiuto è in
    // blocco e nemmeno la x si muove.
    const after = applyOp(s, setCornerRadiusOp("n1", 12, 42));
    expect(after).toEqual(s);
    expect(after.nodes["n1"].x).toBe(0);
    expect(after.nodes["n1"].kind).toBe("ellipse");
  });

  it("su un nodo di testo rifiuta l'INTERO op", () => {
    const node = create(NodeSchema, {
      id: "t1", parentId: "page1", orderKey: "a0", name: "Text", visible: true, opacity: 1,
      x: 0, y: 0, width: 200, height: 24,
      shape: { case: "text", value: { content: "ciao" } },
    });
    const s = applyOp(emptyScene("doc1", "Untitled"),
      create(OpSchema, { opId: "op-t1", docId: "doc1", kind: { case: "createNode", value: { node } } }));
    expect(applyOp(s, setCornerRadiusOp("t1", 12, 42))).toEqual(s);
  });

  // La metà TS della riga "vector" di TestApplySetPropertiesCornerRadiusOnNonRectFails.
  // Questo lato rifiutava già (`cur.kind !== "rect"`); era GO ad accettare,
  // perché la sua guardia elencava le forme da rifiutare ({Ellipse, Text}) e
  // una forma nuova ci passava attraverso -- finendo nel ramo che materializza
  // il rettangolo implicito e SOSTITUENDO lo shape del nodo. Risultato: il
  // client teneva il path, il documento autorevole diventava un rettangolo. È
  // la divergenza esatta che questa coppia di test esiste per impedire, quindi
  // il caso sta su ENTRAMBI i lati anche se solo uno dei due era rotto.
  it("su un nodo VETTORIALE rifiuta l'INTERO op e non tocca la geometria", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"),
      createVectorOp("v1", [{ anchors: RICH_ANCHORS, closed: true }]));
    const after = applyOp(s, setCornerRadiusOp("v1", 12, 42));
    expect(after).toEqual(s);
    expect(after.nodes["v1"].x).toBe(0);
    expect(after.nodes["v1"].kind).toBe("vector");
    expect(after.nodes["v1"].vector?.subpaths).toEqual([{ anchors: RICH_ANCHORS, closed: true }]);
  });
});

// --- una forma SCONOSCIUTA non è un rettangolo -----------------------------
//
// core.applySetProps (Go) accetta `nil` o `*brawtv1.Node_Rect` e rifiuta tutto
// il resto: una WHITELIST, così una forma aggiunta domani è rifiutata di default
// invece di finire nel ramo che materializza il rettangolo implicito e ne
// distrugge la geometria. Questo lato aveva la guardia speculare (`cur.kind !==
// "rect"`) ma la derivava da un `kind` che RIPIEGAVA su "rect" per ogni forma
// sconosciuta: la stessa divergenza, semplicemente specchiata -- op accettato
// qui, ErrNotRectNode di là. Le altre tre tracce stanno aggiungendo forme al
// oneof adesso (33 Group, 34 Frame, 35 Image, 37 Instance), quindi il caso non è
// ipotetico: è il giorno del merge.

// Una forma PRESENTE nel oneof che questo modello non conosce. Il cast è l'unico
// modo di scriverla oggi (il generato non ha ancora GroupNode) ed è fedele a ciò
// che il decoder produrrà il giorno in cui ce l'avrà: `shape.case` valorizzato
// con un nome che store/types.ts non elenca.
// Un Node con una forma che QUESTO build non sa mappare su un NodeLite["kind"].
// group/frame sono ORA forme conosciute (traccia 1), quindi non servono più da
// esempio di "sconosciuto": si fabbrica un ramo del oneof che il modello non
// nomina (`instance`, riservato nel proto per una traccia futura). kindOf ci
// ricade su "unknown" e toNodeLite/toPbNode lo devono conservare OPACO, senza
// appiattirlo su un rettangolo.
function nodeWithUnknownShape(id: string) {
  const n = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Sconosciuto", visible: true, opacity: 1,
    x: 10, y: 20, width: 100, height: 80,
  });
  (n as unknown as { shape: unknown }).shape = { case: "instance", value: { children: ["c1"] } };
  return n;
}

function createNodeOp(node: PbNode) {
  return create(OpSchema, {
    opId: "op-" + node.id, docId: "doc1", kind: { case: "createNode", value: { node } },
  });
}

describe("applyOp: forma sconosciuta", () => {
  it("non ricade su rect -- ma una forma ASSENTE sì", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createNodeOp(nodeWithUnknownShape("g1")));
    expect(s.nodes["g1"].kind).toBe("unknown");
    // Shape ASSENTE resta "rect", e non è un'eccezione alla regola ma la regola
    // stessa: Go la accetta come rettangolo implicito (il ramo `case nil` della
    // whitelist), quindi trattarla diversamente qui sarebbe la divergenza.
    const noShape = create(NodeSchema, {
      id: "r1", parentId: "page1", orderKey: "a0", name: "Node", visible: true, opacity: 1,
      x: 0, y: 0, width: 10, height: 10,
    });
    const s2 = applyOp(s, createNodeOp(noShape));
    expect(s2.nodes["r1"].kind).toBe("rect");
  });

  it("corner_radius su una forma sconosciuta rifiuta l'INTERO op (parità con ErrNotRectNode)", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createNodeOp(nodeWithUnknownShape("g1")));
    // "x" viaggia nella STESSA mask: il rifiuto è in blocco, nemmeno la x si
    // muove. Prima del fix questo op passava (kind ricadeva su "rect") e
    // scriveva un cornerRadius su un nodo che Go rifiuta.
    const after = applyOp(s, setCornerRadiusOp("g1", 12, 42));
    expect(after).toEqual(s);
    expect(after.nodes["g1"].x).toBe(10);
    expect(after.nodes["g1"].cornerRadius).toBe(0);
  });

  it("setVectorPath e setText la rifiutano come rifiutano un rettangolo", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createNodeOp(nodeWithUnknownShape("g1")));
    const setVector = create(OpSchema, {
      opId: "op-sv", docId: "doc1",
      kind: { case: "setVectorPath", value: { id: "g1", subpaths: [{ anchors: [], closed: true }] } },
    });
    expect(applyOp(s, setVector)).toEqual(s);
    const setText = create(OpSchema, {
      opId: "op-st", docId: "doc1", kind: { case: "setText", value: { id: "g1", content: "x" } },
    });
    expect(applyOp(s, setText)).toEqual(s);
  });

  it("toPbNode la rimette dov'era: un undo non converte una forma sconosciuta in rettangolo", () => {
    // history.invertOp ricostruisce il Node da NodeLite per invertire una
    // delete. Con il ripiego su "rect" il nodo tornava in vita come RETTANGOLO
    // -- un cambio di forma silenzioso dentro un Ctrl+Z, e nessun modo di
    // accorgersene se non guardando il documento del server. Il ramo opaco
    // (NodeLite.unknownShape) lo rimette esattamente dov'era.
    const pb = nodeWithUnknownShape("g1");
    const back = toPbNode(toNodeLite(pb));
    expect(back.shape.case).toBe("instance");
    expect(back.shape.value).toEqual({ children: ["c1"] });
    // ...e il resto del nodo sopravvive al giro come per ogni altra forma.
    expect(back).toMatchObject({ id: "g1", x: 10, y: 20, width: 100, height: 80 });
  });
});

// --- setText ---------------------------------------------------------------
// Speculari a internal/core/apply_test.go (TestApplySetText*): stessa scena,
// stesse asserzioni. applyOp e core.applySetText devono restare semanticamente
// identici, e questa è la metà TS della guardia (l'altra è testdata/golden/text.json).

function createTextOp(id: string, content: string) {
  const node = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Text", visible: true, opacity: 1,
    x: 0, y: 0, width: 200, height: 24,
    shape: { case: "text", value: {
      content,
      style: { fontFamily: "Inter", fontSize: 16, fontWeight: "400", lineHeight: 1.2, align: TextAlign.LEFT },
    } },
  });
  return create(OpSchema, { opId: "op-" + id, docId: "doc1", kind: { case: "createNode", value: { node } } });
}

function setTextOp(value: MessageInitShape<typeof SetTextSchema>) {
  return create(OpSchema, { opId: "op-settext", docId: "doc1", kind: { case: "setText", value } });
}

describe("applyOp: setText", () => {
  it("creates a text node", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createTextOp("t1", "ciao"));
    expect(s.nodes["t1"].kind).toBe("text");
    expect(s.nodes["t1"].text).toEqual({
      content: "ciao",
      style: { fontFamily: "Inter", fontSize: 16, fontWeight: "400", lineHeight: 1.2, align: "left" },
    });
  });

  it("changes the content of a text node", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createTextOp("t1", "ciao"));
    s = applyOp(s, setTextOp({ id: "t1", content: "nuovo testo" }));
    expect(s.nodes["t1"].text?.content).toBe("nuovo testo");
  });

  it("is a no-op on a non-text node (parity with core.applySetText: ErrNotTextNode)", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("n1", 10, 20));
    const s2 = applyOp(s, setTextOp({ id: "n1", content: "x" }));
    // Go rifiuta l'op e non tocca il documento: scrivere qui un `text` dentro
    // un rettangolo lo trasformerebbe in un nodo che il server non ha.
    expect(s2).toEqual(s);
    expect(s2.nodes["n1"].kind).toBe("rect");
    expect(s2.nodes["n1"].text).toBeUndefined();
  });

  it("is a no-op on a missing id (parity with core.applySetText: ErrNodeNotFound)", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createTextOp("t1", "ciao"));
    expect(applyOp(s, setTextOp({ id: "ghost", content: "x" }))).toEqual(s);
  });

  it("leaves the existing style alone when stylePresent is false", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createTextOp("t1", "ciao"));
    s = applyOp(s, setTextOp({ id: "t1", content: "altro" }));
    expect(s.nodes["t1"].text?.style.fontSize).toBe(16);
    expect(s.nodes["t1"].text?.style.fontFamily).toBe("Inter");
    // È il FLAG a decidere, non la presenza del sotto-messaggio: uno `style`
    // esplicito con stylePresent=false va ignorato lo stesso.
    s = applyOp(s, setTextOp({ id: "t1", content: "terzo", style: { fontSize: 99 } }));
    expect(s.nodes["t1"].text?.style.fontSize).toBe(16);
    expect(s.nodes["t1"].text?.content).toBe("terzo");
  });

  it("replaces the style when stylePresent is true", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createTextOp("t1", "ciao"));
    s = applyOp(s, setTextOp({
      id: "t1", content: "ciao", stylePresent: true,
      style: { fontFamily: "Inter", fontSize: 32, fontWeight: "700", lineHeight: 1.5, align: TextAlign.CENTER },
    }));
    expect(s.nodes["t1"].text?.style).toEqual({
      fontFamily: "Inter", fontSize: 32, fontWeight: "700", lineHeight: 1.5, align: "center",
    });
  });

  it("clears the style when stylePresent is true and no style is carried (parity with Go's nil style)", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createTextOp("t1", "ciao"));
    s = applyOp(s, setTextOp({ id: "t1", content: "ciao", stylePresent: true }));
    // Go assegna nil e legge poi i campi con i getter nil-safe (tutti a zero);
    // NodeLite appiattisce, quindi la controparte è uno stile tutto a zero.
    expect(s.nodes["t1"].text?.style).toEqual({
      fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left",
    });
  });

});

// --- ImageNode (traccia 3) ---------------------------------------------------
describe("applyOp: image", () => {
  //
  // Le fixture golden NON coprono questo: confrontano `scene.nodes` con
  // `fromDocument(expected).nodes`, cioè fanno passare entrambi i lati dalla
  // STESSA toNodeLite -- un'immagine degradata a rettangolo da tutte e due le
  // parti si confronta uguale a sé stessa. Il tipo del nodo e il suo hash vanno
  // quindi asseriti qui, esplicitamente.

  it("crea un nodo immagine tenendo l'hash dell'asset (e NON i byte)", () => {
    const node = create(NodeSchema, {
      id: "i1", parentId: "page1", orderKey: "a0", name: "logo.png", visible: true, opacity: 1,
      x: 10, y: 20, width: 320, height: 180,
      shape: { case: "image", value: { assetHash: HASH } },
    });
    const op = create(OpSchema, { opId: "op-i1", docId: "doc1", kind: { case: "createNode", value: { node } } });
    const s = applyOp(emptyScene("doc1", "Untitled"), op);
    expect(s.nodes["i1"].kind).toBe("image");
    expect(s.nodes["i1"].image?.assetHash).toBe(HASH);
  });

  it("sposta e ridimensiona un'immagine senza toccare l'hash", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createImageOp("i1"));
    const move = create(OpSchema, { opId: "m", docId: "doc1", kind: { case: "setProps", value: {
      id: "i1", patch: create(NodeSchema, { x: 300, y: 400 }), mask: { paths: ["x", "y"] } } } });
    s = applyOp(s, move);
    expect(s.nodes["i1"].x).toBe(300);
    expect(s.nodes["i1"].image?.assetHash).toBe(HASH);
    expect(s.nodes["i1"].kind).toBe("image");
  });

  // Parità con core.applySetProps: l'immagine è nell'elenco delle forme che
  // rifiutano corner_radius, e per la ragione più forte -- il ramo che applica
  // il raggio SOSTITUISCE la forma con un rettangolo, cioè butterebbe via il
  // riferimento all'asset.
  it("rifiuta corner_radius su un'immagine, mask mista compresa (parità: ErrNotRectNode)", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createImageOp("i1"));
    const op = create(OpSchema, { opId: "r", docId: "doc1", kind: { case: "setProps", value: {
      id: "i1",
      patch: create(NodeSchema, { x: 42, shape: { case: "rect", value: { cornerRadius: 12 } } }),
      mask: { paths: ["x", "corner_radius"] },
    } } });
    const after = applyOp(s, op);
    expect(after).toEqual(s);
    expect(after.nodes["i1"].kind).toBe("image");
    expect(after.nodes["i1"].image?.assetHash).toBe(HASH);
    expect(after.nodes["i1"].x).toBe(10);
  });

  it("rifiuta un setText su un'immagine (parità: ErrNotTextNode)", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createImageOp("i1"));
    const after = applyOp(s, setTextOp({ id: "i1", content: "x" }));
    expect(after).toEqual(s);
    expect(after.nodes["i1"].kind).toBe("image");
  });
});

// --- setVectorPath ---------------------------------------------------------
// Speculari a internal/core/apply_test.go (TestApplySetVectorPath*): stessa
// scena, stesse asserzioni. applyOp e core.applySetVectorPath devono restare
// semanticamente identici, e questa è la metà TS della guardia (l'altra è
// testdata/golden/vector_path.json).

// Maniglie bézier ASIMMETRICHE e mai nulle: un lato che le scartasse (o le
// ricavasse per specchiatura) non può passare per caso. Sono OFFSET relativi
// all'ancoraggio (vedi il proto), quindi piccoli e centrati sullo zero: nulle
// significherebbe "nessuna maniglia".
const RICH_ANCHORS = [
  { x: 10, y: 20, inX: -2, inY: -1, outX: 4, outY: 6 },
  { x: 60, y: 70, inX: -5, inY: -8, outX: 6, outY: 1 },
];

function createVectorOp(id: string, subpaths: MessageInitShape<typeof VectorNodeSchema>["subpaths"]) {
  const node = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Path", visible: true, opacity: 1,
    x: 0, y: 0, width: 100, height: 80,
    shape: { case: "vector", value: { subpaths } },
  });
  return create(OpSchema, { opId: "op-" + id, docId: "doc1", kind: { case: "createNode", value: { node } } });
}

function setVectorPathOp(value: MessageInitShape<typeof SetVectorPathSchema>) {
  return create(OpSchema, { opId: "op-setvector", docId: "doc1", kind: { case: "setVectorPath", value } });
}

describe("applyOp: setVectorPath", () => {
  const base = () =>
    applyOp(emptyScene("doc1", "Untitled"), createVectorOp("v1", [{ anchors: RICH_ANCHORS, closed: false }]));

  it("creates a vector node carrying anchors and bezier handles", () => {
    const n = base().nodes["v1"];
    expect(n.kind).toBe("vector");
    expect(n.vector?.subpaths).toEqual([{ anchors: RICH_ANCHORS, closed: false }]);
  });

  it("replaces the subpaths wholesale (no merge, no append)", () => {
    const next = [
      { anchors: RICH_ANCHORS, closed: true },
      { anchors: [{ x: 1, y: 2, inX: 0, inY: 0, outX: 0, outY: 0 }], closed: false },
    ];
    const s = applyOp(base(), setVectorPathOp({ id: "v1", subpaths: next }));
    expect(s.nodes["v1"].vector?.subpaths).toEqual(next);
  });

  // Una lista VUOTA è legittima: è il path che l'utente ha svuotato, non un
  // "non specificato" da ignorare (a differenza di setText senza stylePresent).
  it("an empty subpath list empties the path and keeps the node a vector", () => {
    const s = applyOp(base(), setVectorPathOp({ id: "v1" }));
    expect(s.nodes["v1"].vector?.subpaths).toEqual([]);
    expect(s.nodes["v1"].kind).toBe("vector");
  });

  it("is a no-op on a non-vector node (parity with core: ErrNotVectorNode)", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createRectOp("n1", 0, 0));
    const after = applyOp(s, setVectorPathOp({ id: "n1", subpaths: [{ anchors: RICH_ANCHORS, closed: true }] }));
    expect(after).toEqual(s);
    // In particolare la FORMA non cambia: scriverci dentro trasformerebbe il
    // rettangolo in un path in locale mentre il server ha respinto l'op.
    expect(after.nodes["n1"].kind).toBe("rect");
  });

  it("is a no-op on a missing id (parity with core: ErrNodeNotFound)", () => {
    const s = base();
    expect(applyOp(s, setVectorPathOp({ id: "ghost" }))).toEqual(s);
  });

  it("does not mutate the previous state (applyOp is pure)", () => {
    const s = base();
    const before = s.nodes["v1"].vector?.subpaths;
    applyOp(s, setVectorPathOp({ id: "v1", subpaths: [{ anchors: [], closed: true }] }));
    expect(s.nodes["v1"].vector?.subpaths).toBe(before);
    expect(before).toEqual([{ anchors: RICH_ANCHORS, closed: false }]);
  });
});

// ---------------------------------------------------------------------------
// FRAME (proto: FrameNode = 34) — un contenitore CON geometria propria.
// ---------------------------------------------------------------------------

function createFrameOp(id: string, clipsContent: boolean, parentId = "page1") {
  const node = create(NodeSchema, {
    id, parentId, orderKey: "a0", name: "Frame", visible: true, opacity: 1,
    x: 10, y: 10, width: 200, height: 150,
    shape: { case: "frame", value: { clipsContent } },
  });
  return create(OpSchema, { opId: "op-" + id, docId: "doc1", kind: { case: "createNode", value: { node } } });
}

describe("applyOp — frame", () => {
  it("crea un frame con il suo box e il suo clipping", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createFrameOp("f1", true));
    expect(s.nodes["f1"].kind).toBe("frame");
    expect(s.nodes["f1"].clipsContent).toBe(true);
    // Il box è SUO (a differenza di un gruppo, i cui bounds sono l'unione dei
    // figli): arriva dal createNode e resta lì.
    expect(s.nodes["f1"].width).toBe(200);
  });

  it("clipsContent false è un valore legittimo, non 'non impostato'", () => {
    const s = applyOp(emptyScene("doc1", "Untitled"), createFrameOp("f1", false));
    expect(s.nodes["f1"].kind).toBe("frame");
    expect(s.nodes["f1"].clipsContent).toBe(false);
  });

  // Parità con core.applySetProps (Go), che risponde ErrNotRectNode: un frame è
  // disegnato come una forma ma la sua forma è il FrameNode, e corner_radius
  // vive dentro RectNode. L'op è rifiutato in BLOCCO, "x" compresa.
  it("rifiuta corner_radius su un frame, x inclusa", () => {
    const before = applyOp(emptyScene("doc1", "Untitled"), createFrameOp("f1", true));
    const after = applyOp(before, create(OpSchema, { opId: "r", docId: "doc1", kind: { case: "setProps", value: {
      id: "f1",
      patch: create(NodeSchema, { x: 999, shape: { case: "rect", value: { cornerRadius: 12 } } }),
      mask: { paths: ["x", "corner_radius"] },
    } } }));
    expect(after).toEqual(before);
    expect(after.nodes["f1"].kind).toBe("frame");
  });
});

// ---------------------------------------------------------------------------
// PAGINE — i container RADICE del documento (parità con core.applyCreatePage /
// applyDeletePage / applyRenamePage). Le fixture golden provano la parità
// end-to-end; questi test fissano il comportamento visto dal client, compresa
// l'identità dell'oggetto restituito su un op rifiutato (un oggetto nuovo
// sveglierebbe i selettori per niente).
// ---------------------------------------------------------------------------

function createPageOp(id: string, name: string) {
  return create(OpSchema, { opId: "op-" + id, docId: "doc1", kind: { case: "createPage", value: { page: { id, name } } } });
}

function deletePageOp(id: string) {
  return create(OpSchema, { opId: "del-" + id, docId: "doc1", kind: { case: "deletePage", value: { id } } });
}

function renamePageOp(id: string, name: string) {
  return create(OpSchema, { opId: "ren-" + id, docId: "doc1", kind: { case: "renamePage", value: { id, name } } });
}

describe("applyOp — pagine", () => {
  it("aggiunge la pagina IN CODA e la rende un parent valido", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createPageOp("page2", "Page 2"));
    expect(s.pages).toEqual([{ id: "page1", name: "Page 1" }, { id: "page2", name: "Page 2" }]);
    s = applyOp(s, createChildOp("n1", "page2"));
    expect(s.nodes["n1"]?.parentId).toBe("page2");
  });

  it("rifiuta un id già preso da una pagina o da un NODO (parità: ErrPageExists)", () => {
    const base = applyOp(applyOp(emptyScene("doc1", "Untitled"), createPageOp("page2", "Page 2")), createChildOp("n1", "page1"));
    // Stesso OGGETTO, non solo stesso contenuto: un op rifiutato non deve
    // svegliare i sottoscrittori dello store.
    expect(applyOp(base, createPageOp("page2", "Doppione"))).toBe(base);
    expect(applyOp(base, createPageOp("n1", "Id di un nodo"))).toBe(base);
    expect(applyOp(base, createPageOp("", "Senza id"))).toBe(base);
  });

  it("cancella la pagina e TUTTI i suoi nodi a cascata, lasciando in pace le altre", () => {
    let s = applyOp(emptyScene("doc1", "Untitled"), createPageOp("page2", "Page 2"));
    s = applyOp(s, createChildOp("g1", "page1"));
    s = applyOp(s, createChildOp("c1", "g1"));
    s = applyOp(s, createChildOp("d1", "c1"));
    s = applyOp(s, createChildOp("keep", "page2"));
    s = applyOp(s, deletePageOp("page1"));
    expect(s.pages).toEqual([{ id: "page2", name: "Page 2" }]);
    expect(Object.keys(s.nodes)).toEqual(["keep"]);
  });

  it("non cancella l'ULTIMA pagina (parità: ErrLastPage) né una inesistente", () => {
    const base = applyOp(emptyScene("doc1", "Untitled"), createChildOp("n1", "page1"));
    expect(applyOp(base, deletePageOp("page1"))).toBe(base);
    expect(applyOp(base, deletePageOp("ghost"))).toBe(base);
  });

  it("rinomina una pagina, e ignora un id inesistente (parità: ErrPageNotFound)", () => {
    const base = applyOp(emptyScene("doc1", "Untitled"), createPageOp("page2", "Page 2"));
    const renamed = applyOp(base, renamePageOp("page2", "Copertina"));
    expect(renamed.pages).toEqual([{ id: "page1", name: "Page 1" }, { id: "page2", name: "Copertina" }]);
    expect(applyOp(base, renamePageOp("ghost", "x"))).toBe(base);
    // Il nome vuoto è un valore come un altro: il ripiego è della UI.
    expect(applyOp(base, renamePageOp("page2", "")).pages[1].name).toBe("");
  });
});
