import { describe, it, expect, beforeEach } from "vitest";
import { create } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "./store";
import { emptyScene, toNodeLite } from "./types";

// The confirmed/pending model seen FROM THE STORE, without network: `apply` is the
// authoritative record that arrives from Subscribe, `applyPending` is the optimistic
// submit, `rejectPending` is the rejection. rpc/syncClient.test.ts covers the
// wiring of the same three entry points onto the real transport.

function rectNode(id: string, x: number, y: number) {
  return create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: id, visible: true, opacity: 1,
    x, y, width: 100, height: 80,
    shape: { case: "rect", value: { cornerRadius: 0 } },
  });
}

function createOp(opId: string, id: string, x: number, y: number): Op {
  return create(OpSchema, {
    opId, docId: "doc1",
    kind: { case: "createNode", value: { node: rectNode(id, x, y) } },
  });
}

function moveOp(opId: string, id: string, x: number, y: number): Op {
  return create(OpSchema, {
    opId, docId: "doc1",
    kind: {
      case: "setProps",
      value: { id, patch: create(NodeSchema, { x, y }), mask: { paths: ["x", "y"] } },
    },
  });
}

function deleteOp(opId: string, id: string): Op {
  return create(OpSchema, { opId, docId: "doc1", kind: { case: "deleteNode", value: { id } } });
}

function sceneWith(...ids: string[]) {
  const scene = emptyScene("doc1", "Untitled");
  for (const id of ids) scene.nodes = scene.nodes.set(id, toNodeLite(rectNode(id, 0, 0)));
  return scene;
}

describe("confirmed/pending reconciliation", () => {
  beforeEach(() => {
    useScene.setState({
      selection: [], marquee: null, gesture: null, sync: null,
      undoStack: [], redoStack: [], canUndo: false, canRedo: false,
    });
    useScene.getState().setScene(sceneWith("n1", "n2"));
  });

  it("setScene aligns view and confirmed and empties the queue", () => {
    const st = useScene.getState();
    expect(st.confirmed).toBe(st.scene);
    expect(st.pending).toEqual([]);
    expect(st.lastError).toBeNull();
  });

  it("an in-flight op is seen immediately but does NOT enter the confirmed state", () => {
    useScene.getState().applyPending(moveOp("op-1", "n1", 200, 0));

    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 200 });
    expect(useScene.getState().confirmed!.nodes.at("n1")).toMatchObject({ x: 0 });
    expect(useScene.getState().pending).toHaveLength(1);
  });

  it("a remote record advances the confirmed state and the queue is RE-APPLIED on top (rebase)", () => {
    const st = useScene.getState();
    st.applyPending(moveOp("op-mine", "n1", 200, 0));
    // The server ordered the other client's record FIRST: without rebase the
    // optimistic change would be squashed and would never come back.
    st.apply(moveOp("op-them-1", "n1", 100, 0));
    st.apply(moveOp("op-them-2", "n2", 333, 0));

    const scene = useScene.getState().scene!;
    expect(scene.nodes.at("n1")).toMatchObject({ x: 200 }); // pending riapplicato
    expect(scene.nodes.at("n2")).toMatchObject({ x: 333 }); // remote not lost
    expect(useScene.getState().confirmed!.nodes.at("n1")).toMatchObject({ x: 100 });
  });

  it("our own echo removes the op from the queue: from then on it is no longer re-applied", () => {
    const st = useScene.getState();
    st.applyPending(moveOp("op-mine", "n1", 200, 0));
    st.apply(moveOp("op-mine", "n1", 200, 0)); // echo: same opId

    expect(useScene.getState().pending).toHaveLength(0);
    expect(useScene.getState().confirmed!.nodes.at("n1")).toMatchObject({ x: 200 });

    st.apply(moveOp("op-them", "n1", 50, 0));
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 50 });
  });

  it("a rejection removes the op from the queue, recomputes the view and reports the error", () => {
    const st = useScene.getState();
    st.applyPending(createOp("op-1", "n9", 10, 10));
    st.applyPending(moveOp("op-2", "n1", 200, 0));
    expect(useScene.getState().scene!.nodes.at("n9")).toBeDefined();

    st.rejectPending("op-1", "node already exists");

    expect(useScene.getState().scene!.nodes.at("n9")).toBeUndefined(); // rollback
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 200 }); // the other one stays
    expect(useScene.getState().pending).toHaveLength(1);
    expect(useScene.getState().lastError).toBe("node already exists");
  });

  it("the rollback of a create removes the node from the selection too", () => {
    const st = useScene.getState();
    st.applyPending(createOp("op-1", "n9", 10, 10));
    st.setSelection(["n1", "n9"]);

    st.rejectPending("op-1", "boom");

    expect(useScene.getState().selection).toEqual(["n1"]);
  });

  it("the rejection of an ALREADY confirmed op undoes nothing and does not invent an error", () => {
    const st = useScene.getState();
    st.applyPending(moveOp("op-1", "n1", 200, 0));
    st.apply(moveOp("op-1", "n1", 200, 0)); // echo arrived before the HTTP response

    st.rejectPending("op-1", "connection reset");

    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 200 });
    expect(useScene.getState().lastError).toBeNull();
  });

  it("clearError resets the displayed error", () => {
    const st = useScene.getState();
    st.applyPending(moveOp("op-1", "n1", 200, 0));
    st.rejectPending("op-1", "boom");
    expect(useScene.getState().lastError).toBe("boom");

    useScene.getState().clearError();
    expect(useScene.getState().lastError).toBeNull();
  });

  // --- interaction with gestures -------------------------------------------

  it("a remote record mid-gesture does not make the drag preview vanish", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(moveOp("prev-1", "n1", 40, 40)); // local preview, never on the wire

    st.apply(moveOp("op-them", "n2", 333, 0)); // arrives while the finger is still down

    const scene = useScene.getState().scene!;
    expect(scene.nodes.at("n1")).toMatchObject({ x: 40, y: 40 }); // anteprima intatta
    expect(scene.nodes.at("n2")).toMatchObject({ x: 333 });
  });

  it("an op still in flight survives the closing of the gesture", () => {
    const st = useScene.getState();
    st.applyPending(moveOp("op-mine", "n2", 500, 0)); // submitted before the drag
    st.beginGesture();
    st.applyLocal(moveOp("prev-1", "n1", 40, 40));
    st.endGesture([]); // aborted gesture: no final ops

    // The preview vanishes (it was never on the wire), the in-flight op does NOT.
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 0, y: 0 });
    expect(useScene.getState().scene!.nodes.at("n2")).toMatchObject({ x: 500 });
    expect(useScene.getState().pending).toHaveLength(1);
  });

  it("a remote delete during the gesture prunes the selection and is not resurrected", () => {
    const st = useScene.getState();
    st.setSelection(["n1", "n2"]);
    st.beginGesture();
    st.applyLocal(moveOp("prev-1", "n1", 40, 40));
    st.apply(deleteOp("op-them", "n2"));

    expect(useScene.getState().scene!.nodes.at("n2")).toBeUndefined();
    expect(useScene.getState().selection).toEqual(["n1"]);
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 40, y: 40 });
  });
});
