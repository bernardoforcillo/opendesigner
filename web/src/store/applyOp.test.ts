import { describe, it, expect } from "vitest";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { OpSchema, NodeSchema, SetTextSchema, TextAlign } from "../gen/brawt/v1/brawt_pb";
import { applyOp } from "./applyOp";
import { emptyScene } from "./types";

function createRectOp(id: string, x: number, y: number) {
  const node = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Rect", visible: true, opacity: 1,
    x, y, width: 100, height: 80,
    shape: { case: "rect", value: { cornerRadius: 0 } },
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
