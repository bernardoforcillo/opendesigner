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
});
