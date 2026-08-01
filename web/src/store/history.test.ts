import { describe, it, expect } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema } from "../gen/brawt/v1/brawt_pb";
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
});

describe("invertOp: createNode", () => {
  it("round-trips: create + inverso = scena vuota di partenza", () => {
    const scene = emptyScene("doc1", "Untitled");
    const inv = expectRoundTrip(scene, createOp(richRect()));
    expect(inv.kind.case).toBe("deleteNode");
    expect(inv.kind.case === "deleteNode" && inv.kind.value.id).toBe("n1");
  });

  it("round-trips anche quando l'id esiste già (createNode sovrascrive)", () => {
    // applyOp tratta createNode su un id esistente come una sovrascrittura:
    // l'inverso non può essere una delete, deve ripristinare il nodo di prima.
    const scene = sceneWith(richRect());
    expectRoundTrip(scene, createOp(richEllipse("n1")));
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
