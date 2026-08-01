import { describe, it, expect } from "vitest";
import { create } from "@bufbuild/protobuf";
import { OpSchema, NodeSchema } from "../gen/brawt/v1/brawt_pb";
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
