import { describe, it, expect, beforeEach } from "vitest";
import { create } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "./store";
import { emptyScene, toNodeLite } from "./types";

// Il modello confermato/pending visto DALLO STORE, senza rete: `apply` è il
// record autorevole che arriva da Subscribe, `applyPending` è il submit
// ottimistico, `rejectPending` è il rifiuto. rpc/syncClient.test.ts copre il
// cablaggio degli stessi tre ingressi sul trasporto vero.

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

describe("riconciliazione confermato/pending", () => {
  beforeEach(() => {
    useScene.setState({
      selection: [], marquee: null, gesture: null, sync: null,
      undoStack: [], redoStack: [], canUndo: false, canRedo: false,
    });
    useScene.getState().setScene(sceneWith("n1", "n2"));
  });

  it("setScene allinea vista e confermato e svuota la coda", () => {
    const st = useScene.getState();
    expect(st.confirmed).toBe(st.scene);
    expect(st.pending).toEqual([]);
    expect(st.lastError).toBeNull();
  });

  it("un op in volo si vede subito ma NON entra nel confermato", () => {
    useScene.getState().applyPending(moveOp("op-1", "n1", 200, 0));

    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 200 });
    expect(useScene.getState().confirmed!.nodes.at("n1")).toMatchObject({ x: 0 });
    expect(useScene.getState().pending).toHaveLength(1);
  });

  it("un record remoto avanza il confermato e la coda viene RIAPPLICATA sopra (rebase)", () => {
    const st = useScene.getState();
    st.applyPending(moveOp("op-mine", "n1", 200, 0));
    // Il server ha ordinato PRIMA il record dell'altro client: senza rebase la
    // modifica ottimistica verrebbe schiacciata e non tornerebbe mai più.
    st.apply(moveOp("op-them-1", "n1", 100, 0));
    st.apply(moveOp("op-them-2", "n2", 333, 0));

    const scene = useScene.getState().scene!;
    expect(scene.nodes.at("n1")).toMatchObject({ x: 200 }); // pending riapplicato
    expect(scene.nodes.at("n2")).toMatchObject({ x: 333 }); // remoto non perso
    expect(useScene.getState().confirmed!.nodes.at("n1")).toMatchObject({ x: 100 });
  });

  it("il proprio eco toglie l'op dalla coda: da lì in poi non viene più riapplicato", () => {
    const st = useScene.getState();
    st.applyPending(moveOp("op-mine", "n1", 200, 0));
    st.apply(moveOp("op-mine", "n1", 200, 0)); // eco: stesso opId

    expect(useScene.getState().pending).toHaveLength(0);
    expect(useScene.getState().confirmed!.nodes.at("n1")).toMatchObject({ x: 200 });

    st.apply(moveOp("op-them", "n1", 50, 0));
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 50 });
  });

  it("un rifiuto toglie l'op dalla coda, ricalcola la vista e riporta l'errore", () => {
    const st = useScene.getState();
    st.applyPending(createOp("op-1", "n9", 10, 10));
    st.applyPending(moveOp("op-2", "n1", 200, 0));
    expect(useScene.getState().scene!.nodes.at("n9")).toBeDefined();

    st.rejectPending("op-1", "node already exists");

    expect(useScene.getState().scene!.nodes.at("n9")).toBeUndefined(); // rollback
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 200 }); // l'altro resta
    expect(useScene.getState().pending).toHaveLength(1);
    expect(useScene.getState().lastError).toBe("node already exists");
  });

  it("il rollback di una create toglie il nodo anche dalla selezione", () => {
    const st = useScene.getState();
    st.applyPending(createOp("op-1", "n9", 10, 10));
    st.setSelection(["n1", "n9"]);

    st.rejectPending("op-1", "boom");

    expect(useScene.getState().selection).toEqual(["n1"]);
  });

  it("il rifiuto di un op GIÀ confermato non annulla nulla e non inventa un errore", () => {
    const st = useScene.getState();
    st.applyPending(moveOp("op-1", "n1", 200, 0));
    st.apply(moveOp("op-1", "n1", 200, 0)); // eco arrivato prima della risposta HTTP

    st.rejectPending("op-1", "connection reset");

    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 200 });
    expect(useScene.getState().lastError).toBeNull();
  });

  it("clearError azzera l'errore mostrato", () => {
    const st = useScene.getState();
    st.applyPending(moveOp("op-1", "n1", 200, 0));
    st.rejectPending("op-1", "boom");
    expect(useScene.getState().lastError).toBe("boom");

    useScene.getState().clearError();
    expect(useScene.getState().lastError).toBeNull();
  });

  // --- interazione con i gesti ---------------------------------------------

  it("un record remoto a metà gesto non fa sparire l'anteprima del drag", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(moveOp("prev-1", "n1", 40, 40)); // anteprima locale, mai sul filo

    st.apply(moveOp("op-them", "n2", 333, 0)); // arriva mentre il dito è ancora giù

    const scene = useScene.getState().scene!;
    expect(scene.nodes.at("n1")).toMatchObject({ x: 40, y: 40 }); // anteprima intatta
    expect(scene.nodes.at("n2")).toMatchObject({ x: 333 });
  });

  it("un op ancora in volo sopravvive alla chiusura del gesto", () => {
    const st = useScene.getState();
    st.applyPending(moveOp("op-mine", "n2", 500, 0)); // submittato prima del drag
    st.beginGesture();
    st.applyLocal(moveOp("prev-1", "n1", 40, 40));
    st.endGesture([]); // gesto abortito: nessun op finale

    // L'anteprima sparisce (non è mai stata sul filo), l'op in volo NO.
    expect(useScene.getState().scene!.nodes.at("n1")).toMatchObject({ x: 0, y: 0 });
    expect(useScene.getState().scene!.nodes.at("n2")).toMatchObject({ x: 500 });
    expect(useScene.getState().pending).toHaveLength(1);
  });

  it("un delete remoto durante il gesto pota la selezione e non viene resuscitato", () => {
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
