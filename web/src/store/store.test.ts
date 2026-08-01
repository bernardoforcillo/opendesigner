import { describe, it, expect, beforeEach } from "vitest";
import { create } from "@bufbuild/protobuf";
import { OpSchema, NodeSchema } from "../gen/brawt/v1/brawt_pb";
import { useScene } from "./store";
import { emptyScene } from "./types";

function createRectOp(id: string) {
  const node = create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Rect", visible: true, opacity: 1,
    x: 0, y: 0, width: 100, height: 80,
    shape: { case: "rect", value: { cornerRadius: 0 } },
  });
  return create(OpSchema, { opId: "op-" + id, docId: "doc1", kind: { case: "createNode", value: { node } } });
}

function deleteOp(id: string) {
  return create(OpSchema, { opId: "del-" + id, docId: "doc1", kind: { case: "deleteNode", value: { id } } });
}

describe("selection state", () => {
  beforeEach(() => {
    useScene.setState({ selection: [], marquee: null, gesture: null });
    // setScene e non setState({scene}): installa una scena COERENTE (vista e
    // confermato allineati, coda vuota), che è l'invariante su cui poggia la
    // riconciliazione (vedi store.ts).
    useScene.getState().setScene(emptyScene("doc1", "Untitled"));
  });

  it("setSelection replaces the current selection", () => {
    useScene.getState().setSelection(["a", "b"]);
    expect(useScene.getState().selection).toEqual(["a", "b"]);
    useScene.getState().setSelection(["c"]);
    expect(useScene.getState().selection).toEqual(["c"]);
  });

  it("toggleSelection adds an id when absent and removes it when present", () => {
    useScene.getState().toggleSelection("a");
    expect(useScene.getState().selection).toEqual(["a"]);
    useScene.getState().toggleSelection("b");
    expect(useScene.getState().selection).toEqual(["a", "b"]);
    useScene.getState().toggleSelection("a");
    expect(useScene.getState().selection).toEqual(["b"]);
  });

  it("clearSelection empties the selection", () => {
    useScene.getState().setSelection(["a", "b"]);
    useScene.getState().clearSelection();
    expect(useScene.getState().selection).toEqual([]);
  });

  it("setMarquee stores and clears the marquee bounds", () => {
    const b = { x: 0, y: 0, width: 10, height: 10 };
    useScene.getState().setMarquee(b);
    expect(useScene.getState().marquee).toEqual(b);
    useScene.getState().setMarquee(null);
    expect(useScene.getState().marquee).toBeNull();
  });

  it("REGRESSION: applying a deleteNode op for a selected node also removes it from the selection", () => {
    useScene.getState().apply(createRectOp("n1"));
    useScene.getState().apply(createRectOp("n2"));
    useScene.getState().setSelection(["n1", "n2"]);
    useScene.getState().apply(deleteOp("n1"));
    // Altrimenti le maniglie di resize restano appese a un nodo inesistente.
    expect(useScene.getState().selection).toEqual(["n2"]);
    expect(useScene.getState().scene?.nodes["n1"]).toBeUndefined();
  });

  it("leaves the selection untouched when the deleted node was not selected", () => {
    useScene.getState().apply(createRectOp("n1"));
    useScene.getState().apply(createRectOp("n2"));
    useScene.getState().setSelection(["n2"]);
    useScene.getState().apply(deleteOp("n1"));
    expect(useScene.getState().selection).toEqual(["n2"]);
  });

  it("removes a deleted node from a multi-id selection while keeping the rest, in order", () => {
    useScene.getState().apply(createRectOp("n1"));
    useScene.getState().apply(createRectOp("n2"));
    useScene.getState().apply(createRectOp("n3"));
    useScene.getState().setSelection(["n1", "n2", "n3"]);
    useScene.getState().apply(deleteOp("n2"));
    expect(useScene.getState().selection).toEqual(["n1", "n3"]);
  });
});
