import { describe, it, expect, beforeEach } from "vitest";
import { create } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema } from "../gen/brawt/v1/brawt_pb";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { useScene } from "./store";
import { emptyScene } from "./types";

// Stesso doppio di gesture.test.ts: conta gli op che finiscono SUL FILO e per
// il resto si comporta come SyncClient (apply ottimistico locale via apply()).
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().apply(op);
  }
}

function rectNode(id: string, x: number, y: number, width = 100, height = 80) {
  return create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Rect", visible: true, opacity: 1,
    x, y, width, height,
    shape: { case: "rect", value: { cornerRadius: 0 } },
  });
}

function createOp(id: string, x: number, y: number): Op {
  return create(OpSchema, {
    opId: "new-" + id, docId: "doc1",
    kind: { case: "createNode", value: { node: rectNode(id, x, y) } },
  });
}

function moveOp(id: string, x: number, y: number): Op {
  return create(OpSchema, {
    opId: `mv-${id}-${x}-${y}`, docId: "doc1",
    kind: {
      case: "setProps",
      value: { id, patch: create(NodeSchema, { x, y }), mask: { paths: ["x", "y"] } },
    },
  });
}

function resizeOp(id: string, width: number, height: number): Op {
  return create(OpSchema, {
    opId: `rs-${id}-${width}`, docId: "doc1",
    kind: {
      case: "setProps",
      value: { id, patch: create(NodeSchema, { width, height }), mask: { paths: ["width", "height"] } },
    },
  });
}

// Wrapper: apre e chiude un gesto in un colpo solo, come farebbe un tool a
// fine drag. È la forma con cui i test costruiscono "un gesto" per lo stack.
function gesture(finalOps: Op[]) {
  const st = useScene.getState();
  st.beginGesture();
  st.endGesture(finalOps);
}

describe("undo/redo", () => {
  let sync: FakeSync;

  beforeEach(() => {
    sync = new FakeSync();
    useScene.setState({
      scene: emptyScene("doc1", "Untitled"),
      selection: [],
      marquee: null,
      gesture: null,
      undoStack: [],
      redoStack: [],
    });
    useScene.getState().setSync(sync);
  });

  it("crea -> sposta -> resize: tre undo svuotano la scena, tre redo la ricostruiscono identica", () => {
    const st = useScene.getState();

    gesture([createOp("n1", 0, 0)]);
    gesture([moveOp("n1", 40, 40)]);
    gesture([resizeOp("n1", 200, 160)]);

    const finalScene = useScene.getState().scene;
    expect(finalScene!.nodes["n1"]).toMatchObject({ x: 40, y: 40, width: 200, height: 160 });
    expect(useScene.getState().undoStack).toHaveLength(3);
    expect(useScene.getState().canUndo).toBe(true);
    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().canRedo).toBe(false);

    st.undo();
    st.undo();
    st.undo();

    expect(useScene.getState().scene!.nodes["n1"]).toBeUndefined();
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().canUndo).toBe(false);
    expect(useScene.getState().redoStack).toHaveLength(3);
    expect(useScene.getState().canRedo).toBe(true);

    st.redo();
    st.redo();
    st.redo();

    expect(useScene.getState().scene).toEqual(finalScene);
    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(3);
  });

  it("undo manda l'inverso tramite sync.submit e sposta la voce nel redo stack", () => {
    gesture([createOp("n1", 0, 0)]);
    sync.sent = [];

    useScene.getState().undo();

    expect(sync.sent).toHaveLength(1);
    expect(sync.sent[0].kind.case).toBe("deleteNode");
    expect(useScene.getState().scene!.nodes["n1"]).toBeUndefined();
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().redoStack).toHaveLength(1);
  });

  it("un op ricevuto da un altro client non altera gli stack", () => {
    gesture([createOp("n1", 0, 0)]);
    expect(useScene.getState().undoStack).toHaveLength(1);

    // arriva via apply() (equivalente a SyncClient.consume() per un op REMOTO):
    // non passa da endGesture, quindi non deve toccare lo stack.
    useScene.getState().apply(createOp("n2", 500, 500));

    expect(useScene.getState().undoStack).toHaveLength(1);
    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().scene!.nodes["n2"]).toBeDefined();
  });

  it("un nuovo gesto dopo un undo svuota il redo stack", () => {
    gesture([createOp("n1", 0, 0)]);
    gesture([createOp("n2", 100, 100)]);

    useScene.getState().undo(); // annulla la creazione di n2
    expect(useScene.getState().redoStack).toHaveLength(1);

    gesture([createOp("n3", 200, 200)]);

    expect(useScene.getState().redoStack).toHaveLength(0);
    expect(useScene.getState().canRedo).toBe(false);
    expect(useScene.getState().undoStack).toHaveLength(2);
  });

  it("undo/redo su uno stack vuoto sono no-op silenziosi", () => {
    useScene.getState().undo();
    useScene.getState().redo();

    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().undoStack).toHaveLength(0);
    expect(useScene.getState().redoStack).toHaveLength(0);
  });

  it("un gesto senza op finali non lascia una voce nello stack undo", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(moveOp("n1", 7, 7));
    st.endGesture([]);

    expect(useScene.getState().undoStack).toHaveLength(0);
  });

  it("un gesto multi-nodo (drag di due nodi) si annulla in UN SOLO undo", () => {
    gesture([createOp("n1", 0, 0), createOp("n2", 300, 0)]);
    gesture([moveOp("n1", 10, 10), moveOp("n2", 310, 10)]);

    expect(useScene.getState().undoStack).toHaveLength(2);

    useScene.getState().undo(); // annulla il drag di ENTRAMBI i nodi in un colpo

    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 0, y: 0 });
    expect(useScene.getState().scene!.nodes["n2"]).toMatchObject({ x: 300, y: 0 });
  });
});
