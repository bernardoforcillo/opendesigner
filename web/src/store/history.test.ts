import { describe, it, expect } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema, TextStyleSchema, TextAlign } from "../gen/brawt/v1/brawt_pb";
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
//
// L'inverso è una LISTA da applicare in ordine: la cancellazione di un
// sottoalbero si annulla ricreando ogni nodo, e nell'ordine giusto (vedi
// invertOp). Per tutti gli altri op è una lista di uno.
function expectRoundTrip(scene: SceneState, op: Op): Op[] {
  const inv = invertOp(scene, op);
  expect(inv).not.toBeNull();
  const ops = inv as Op[];
  expect(ops.length).toBeGreaterThan(0);
  let after = applyOp(scene, op);
  for (const i of ops) after = applyOp(after, i);
  expect(after).toEqual(scene);
  return ops;
}

// Comodità per gli op il cui inverso è UNO solo.
function expectSingleRoundTrip(scene: SceneState, op: Op): Op {
  const ops = expectRoundTrip(scene, op);
  expect(ops.length).toBe(1);
  return ops[0];
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
});

describe("invertOp: createNode", () => {
  it("round-trips: create + inverso = scena vuota di partenza", () => {
    const scene = emptyScene("doc1", "Untitled");
    const inv = expectSingleRoundTrip(scene, createOp(richRect()));
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
    const inv = expectSingleRoundTrip(
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
    const [inv] = expectRoundTrip(scene, deleteOp("n1"));
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
    const inv = expectSingleRoundTrip(scene, deleteOp("e1"));
    expect(inv.kind.case === "createNode" && inv.kind.value.node?.shape.case).toBe("ellipse");
  });
});

// --- l'albero: cascata e riparentazione ------------------------------------

function childNode(id: string, parentId: string, orderKey = "a1"): PbNode {
  return create(NodeSchema, {
    id, parentId, orderKey, name: id, visible: true, opacity: 1,
    x: 1, y: 2, width: 10, height: 10,
    shape: { case: "rect", value: { cornerRadius: 3 } },
  });
}

function reparentOp(id: string, newParentId: string, orderKey: string): Op {
  return create(OpSchema, {
    opId: "op-reparent", docId: "doc1",
    kind: { case: "reparentNode", value: { id, newParentId, orderKey } },
  });
}

//   page1
//   ├── g1
//   │   ├── c1
//   │   │   └── d1
//   │   └── c2
//   └── other
function treeScene(): SceneState {
  return sceneWith(
    childNode("g1", "page1", "a1"),
    childNode("c1", "g1", "a1"),
    childNode("d1", "c1", "a1"),
    childNode("c2", "g1", "a2"),
    childNode("other", "page1", "a2"),
  );
}

describe("invertOp: deleteNode a cascata", () => {
  it("ripristina TUTTO il sottoalbero (round-trip esatto)", () => {
    const scene = treeScene();
    const inv = expectRoundTrip(scene, deleteOp("g1"));
    expect(inv.length).toBe(4);
    expect(inv.every((o) => o.kind.case === "createNode")).toBe(true);
  });

  it("ricrea i PARENT prima dei figli (altrimenti ogni figlio sarebbe rifiutato)", () => {
    const scene = treeScene();
    const inv = invertOp(scene, deleteOp("g1")) as Op[];
    const ids = inv.map((o) => (o.kind.case === "createNode" ? o.kind.value.node?.id : undefined));
    expect(ids).toEqual(["g1", "c1", "d1", "c2"]);
    // La prova vera non è l'ordine in sé ma che l'invariante regga a ogni
    // passo: applicati uno a uno, nessuno viene scartato.
    let s = applyOp(scene, deleteOp("g1"));
    for (const o of inv) {
      const before = Object.keys(s.nodes).length;
      s = applyOp(s, o);
      expect(Object.keys(s.nodes).length).toBe(before + 1);
    }
  });

  it("l'ordine INVERSO verrebbe rifiutato — è il motivo per cui l'ordine conta", () => {
    const scene = treeScene();
    const inv = (invertOp(scene, deleteOp("g1")) as Op[]).slice().reverse();
    let s = applyOp(scene, deleteOp("g1"));
    for (const o of inv) s = applyOp(s, o);
    // Solo la radice atterra: i figli, mandati per primi, trovano il parent
    // ancora inesistente (ErrParentNotFound in Go).
    expect(Object.keys(s.nodes).sort()).toEqual(["g1", "other"]);
  });
});

describe("invertOp: reparentNode", () => {
  it("round-trips: rimette il nodo sotto il vecchio parent con la vecchia chiave", () => {
    const scene = treeScene();
    const inv = expectSingleRoundTrip(scene, reparentOp("c1", "other", "a9"));
    expect(inv.kind.case).toBe("reparentNode");
    if (inv.kind.case !== "reparentNode") throw new Error("wrong kind");
    expect(inv.kind.value.newParentId).toBe("g1");
    expect(inv.kind.value.orderKey).toBe("a1");
  });

  it("round-trips un riordino fra pari (stesso parent, chiave nuova)", () => {
    expectRoundTrip(treeScene(), reparentOp("c1", "g1", "a5"));
  });

  it("null quando l'op diretto sarebbe rifiutato (ciclo, parent o nodo inesistente)", () => {
    const scene = treeScene();
    for (const op of [
      reparentOp("g1", "d1", "a9"),   // ciclo
      reparentOp("g1", "g1", "a9"),   // se stesso
      reparentOp("c1", "ghost", "a9"),
      reparentOp("ghost", "page1", "a9"),
    ]) {
      expect(applyOp(scene, op)).toEqual(scene);
      expect(invertOp(scene, op)).toBeNull();
    }
  });
});

describe("invertOp: setText", () => {
  it("round-trips un cambio di solo contenuto", () => {
    const scene = sceneWith(richText());
    const inv = expectSingleRoundTrip(scene, setTextOp("t1", "altro contenuto"));
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

  it("null per createNode con un parent inesistente (ErrParentNotFound in Go)", () => {
    const scene = emptyScene("doc1", "Untitled");
    const op = createOp(childNode("n1", "ghost"));
    expect(applyOp(scene, op)).toEqual(scene);
    expect(invertOp(scene, op)).toBeNull();
  });

  it("null per un op senza kind", () => {
    expect(invertOp(emptyScene("doc1", "Untitled"), create(OpSchema, { opId: "x", docId: "doc1" }))).toBeNull();
  });
});

describe("invertOp: identità dell'op", () => {
  it("eredita il docId dell'op diretto e riceve un opId nuovo e unico", () => {
    const scene = sceneWith(richRect());
    const op = deleteOp("n1");
    const [a] = invertOp(scene, op) as Op[];
    const [b] = invertOp(scene, op) as Op[];
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
