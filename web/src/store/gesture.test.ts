import { describe, it, expect, beforeEach } from "vitest";
import { create } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema } from "../gen/brawt/v1/brawt_pb";
import type { Op } from "../gen/brawt/v1/brawt_pb";
import { useScene } from "./store";
import { emptyScene } from "./types";

// Doppio di SyncClient: conta gli op che finiscono SUL FILO e per il resto si
// comporta come il client vero (apply ottimistico locale, vedi
// rpc/syncClient.ts). Lo store dipende solo dalla superficie { submit }, quindi
// non serve costruire un SyncClient reale (niente rete nei test).
class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().apply(op);
  }
}

function rectNode(id: string, x: number, y: number) {
  return create(NodeSchema, {
    id, parentId: "page1", orderKey: "a0", name: "Rect", visible: true, opacity: 1,
    x, y, width: 100, height: 80,
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

function deleteOp(id: string): Op {
  return create(OpSchema, { opId: "del-" + id, docId: "doc1", kind: { case: "deleteNode", value: { id } } });
}

describe("gesture coalescing", () => {
  let sync: FakeSync;

  beforeEach(() => {
    sync = new FakeSync();
    useScene.setState({
      scene: emptyScene("doc1", "Untitled"),
      selection: [],
      marquee: null,
      gesture: null,
    });
    useScene.getState().setSync(sync);
    // due nodi di partenza, creati fuori dal gesto
    sync.submit(createOp("n1", 0, 0));
    sync.submit(createOp("n2", 300, 0));
    sync.sent = [];
  });

  it("invia UN SOLO op per un drag di 20 pointermove (debito M0: ne mandava ~20)", () => {
    const st = useScene.getState();
    st.beginGesture();
    for (let i = 1; i <= 20; i++) st.applyLocal(moveOp("n1", i * 10, i * 5));

    // durante il gesto: anteprima locale aggiornata, ma niente sul filo
    expect(sync.sent).toHaveLength(0);
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 200, y: 100 });

    st.endGesture([moveOp("n1", 200, 100)]);

    expect(sync.sent).toHaveLength(1);
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 200, y: 100 });
  });

  it("un gesto su più nodi manda un op PER NODO, non uno per pointermove", () => {
    const st = useScene.getState();
    st.beginGesture();
    for (let i = 1; i <= 20; i++) {
      st.applyLocal(moveOp("n1", i, i));
      st.applyLocal(moveOp("n2", 300 + i, i));
    }
    st.endGesture([moveOp("n1", 20, 20), moveOp("n2", 320, 20)]);

    expect(sync.sent).toHaveLength(2);
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 20, y: 20 });
    expect(useScene.getState().scene!.nodes["n2"]).toMatchObject({ x: 320, y: 20 });
  });

  it("lo stato finale è snapshot + op finali: le anteprime non restano attaccate", () => {
    const st = useScene.getState();
    st.beginGesture();
    // anteprima che tocca width/height, campi che l'op finale NON contiene
    st.applyLocal(resizeOp("n1", 999, 999));
    st.endGesture([moveOp("n1", 50, 60)]);

    const n1 = useScene.getState().scene!.nodes["n1"];
    expect(n1).toMatchObject({ x: 50, y: 60, width: 100, height: 80 });
  });

  it("cancelGesture riporta la scena allo stato di inizio gesto senza inviare nulla", () => {
    const before = useScene.getState().scene;
    const st = useScene.getState();
    st.beginGesture();
    for (let i = 1; i <= 20; i++) st.applyLocal(moveOp("n1", i * 10, i * 5));
    st.cancelGesture();

    expect(useScene.getState().scene).toEqual(before);
    expect(sync.sent).toHaveLength(0);
  });

  it("cancelGesture ripristina anche la selezione (gesto di cancellazione annullato)", () => {
    useScene.getState().setSelection(["n1", "n2"]);
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(deleteOp("n1"));
    expect(useScene.getState().selection).toEqual(["n2"]); // invariante selezione

    st.cancelGesture();
    expect(useScene.getState().selection).toEqual(["n1", "n2"]);
    expect(useScene.getState().scene!.nodes["n1"]).toBeDefined();
  });

  it("un gesto senza op finali non cambia nulla e non manda nulla", () => {
    const before = useScene.getState().scene;
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(moveOp("n1", 7, 7));
    st.endGesture([]);

    expect(useScene.getState().scene).toEqual(before);
    expect(sync.sent).toHaveLength(0);
  });

  it("endGesture chiude il gesto: un cancelGesture successivo non ripristina nulla", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(moveOp("n1", 40, 40));
    st.endGesture([moveOp("n1", 40, 40)]);
    st.cancelGesture();

    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 40, y: 40 });
    expect(sync.sent).toHaveLength(1);
  });

  it("gesti consecutivi partono ognuno dal proprio snapshot", () => {
    const st = useScene.getState();
    st.beginGesture();
    st.applyLocal(moveOp("n1", 40, 40));
    st.endGesture([moveOp("n1", 40, 40)]);

    st.beginGesture();
    st.applyLocal(moveOp("n1", 900, 900));
    st.cancelGesture();

    // torna al risultato del PRIMO gesto, non allo stato iniziale
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 40, y: 40 });
  });

  it("applyLocal fuori da un gesto aggiorna solo lo stato locale", () => {
    useScene.getState().applyLocal(moveOp("n1", 12, 34));
    expect(useScene.getState().scene!.nodes["n1"]).toMatchObject({ x: 12, y: 34 });
    expect(sync.sent).toHaveLength(0);
  });
});
