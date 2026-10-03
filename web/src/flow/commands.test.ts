import { describe, it, expect, beforeEach } from "vitest";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import {
  connectOps, createFlowOp, deleteFlowOp, deleteTransitionOp, editTransitionOp, nextFlowName, renameFlowOp,
  setMetaOp, setStartOp, submit,
} from "./commands";
import { baseScene, flowOf, frame, transition, withFlows } from "./testSupport";

class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

let sync: FakeSync;
beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ selection: [], gesture: null, undoStack: [], redoStack: [], canUndo: false, canRedo: false });
  useScene.getState().setScene(baseScene());
  useScene.getState().setSync(sync);
});

describe("nextFlowName", () => {
  it("«Flusso 1», poi il primo numero libero (non il conteggio)", () => {
    expect(nextFlowName(baseScene())).toBe("Flusso 1");
    const s = withFlows(baseScene(), [flowOf("a", "", "Flusso 1"), flowOf("b", "", "Flusso 3")], []);
    expect(nextFlowName(s)).toBe("Flusso 2");
  });
});

describe("connectOps", () => {
  it("senza flussi: crea «Flusso 1» con la partenza come ingresso, poi la transizione click", () => {
    const r = connectOps(baseScene(), null, "A", "B", "");
    expect(r.createdFlow).toBe(true);
    expect(r.ops.map((o) => o.kind.case)).toEqual(["setFlow", "setTransition"]);
    const flow = r.ops[0].kind.value as { flow: { id: string; name: string; startId: string } };
    expect(flow.flow).toMatchObject({ name: "Flusso 1", startId: "A", id: r.flowId });
    const t = (r.ops[1].kind.value as unknown as { transition: Record<string, string> }).transition;
    expect(t).toMatchObject({ id: r.transitionId, flowId: r.flowId, fromId: "A", toId: "B", trigger: "click", elementId: "" });
  });

  it("l'hotspot finisce in elementId", () => {
    const r = connectOps(baseScene(), null, "A", "B", "btn");
    const t = (r.ops[1].kind.value as unknown as { transition: Record<string, string> }).transition;
    expect(t.elementId).toBe("btn");
    expect(t.fromId).toBe("A");
  });

  it("flusso esistente con ingresso: solo la transizione", () => {
    const s = withFlows(baseScene(), [flowOf("f1", "A")], []);
    const r = connectOps(s, "f1", "B", "C", "");
    expect(r.createdFlow).toBe(false);
    expect(r.ops.map((o) => o.kind.case)).toEqual(["setTransition"]);
    expect(r.flowId).toBe("f1");
  });

  it("flusso senza ingresso: la partenza lo diventa, nello stesso gesto", () => {
    const s = withFlows(baseScene(), [flowOf("f1", "")], []);
    const r = connectOps(s, "f1", "B", "C", "");
    expect(r.ops.map((o) => o.kind.case)).toEqual(["setFlow", "setTransition"]);
    expect((r.ops[0].kind.value as { flow: { startId: string } }).flow.startId).toBe("B");
  });

  it("ingresso sparito (nodo cancellato): lo si rimpiazza", () => {
    const s = withFlows(baseScene(), [flowOf("f1", "ghost")], []);
    expect(connectOps(s, "f1", "B", "C", "").ops).toHaveLength(2);
  });

  it("un currentFlowId obsoleto ripiega sul primo flusso invece di crearne un altro", () => {
    const s = withFlows(baseScene(), [flowOf("f1", "A", "Alfa")], []);
    const r = connectOps(s, "sparito", "A", "B", "");
    expect(r.flowId).toBe("f1");
    expect(r.createdFlow).toBe(false);
  });
});

describe("submit (UN gesto = UNA voce di undo)", () => {
  it("«Collega» senza flussi: un solo undo toglie flusso E transizione", () => {
    const r = connectOps(useScene.getState().scene!, null, "A", "B", "btn");
    submit(r.ops);
    const s = useScene.getState().scene!;
    expect(Object.keys(s.flows)).toEqual([r.flowId]);
    expect(s.flows[r.flowId].startId).toBe("A");
    expect(s.transitions[r.transitionId].elementId).toBe("btn");
    expect(useScene.getState().undoStack).toHaveLength(1);

    useScene.getState().undo();
    expect(useScene.getState().scene!.flows).toEqual({});
    expect(useScene.getState().scene!.transitions).toEqual({});
    useScene.getState().redo();
    expect(Object.keys(useScene.getState().scene!.transitions)).toEqual([r.transitionId]);
  });

  it("senza op non fa nulla", () => {
    submit([]);
    expect(useScene.getState().undoStack).toHaveLength(0);
  });
});

describe("operazioni su flussi e transizioni", () => {
  const f = flowOf("f1", "A", "Uno");
  const t = transition("t1", "f1", "A", "B", { label: "Vai" });

  it("renameFlowOp: niente op per nome vuoto o invariato, trim del resto", () => {
    expect(renameFlowOp(f, "  ")).toBeNull();
    expect(renameFlowOp(f, "Uno")).toBeNull();
    const op = renameFlowOp(f, "  Due ")!;
    expect((op.kind.value as { flow: { name: string; startId: string } }).flow).toMatchObject({ name: "Due", startId: "A" });
  });

  it("setStartOp: niente op se è già l'ingresso; altrimenti conserva il resto del flusso", () => {
    expect(setStartOp(f, "A")).toBeNull();
    const op = setStartOp({ ...f, description: "d" }, "B")!;
    expect((op.kind.value as { flow: { startId: string; description: string; name: string } }).flow).toMatchObject({ startId: "B", description: "d", name: "Uno" });
  });

  it("editTransitionOp: un campo alla volta, niente op se invariato", () => {
    expect(editTransitionOp(t, "label", "Vai")).toBeNull();
    const op = editTransitionOp(t, "guard", "x=1")!;
    expect((op.kind.value as unknown as { transition: Record<string, string> }).transition).toMatchObject({ id: "t1", label: "Vai", guard: "x=1", toId: "B" });
  });

  it("createFlowOp / deleteFlowOp / deleteTransitionOp", () => {
    const c = createFlowOp(baseScene());
    expect(c.op.kind.case).toBe("setFlow");
    expect(c.flow).toMatchObject({ name: "Flusso 1", startId: "" });
    expect(deleteFlowOp("f1").kind.case).toBe("deleteFlow");
    expect(deleteTransitionOp("t1").kind.case).toBe("deleteTransition");
  });
});

describe("setMetaOp (read-modify-write della mappa meta)", () => {
  it("riscrive TUTTE le chiavi: scrivere una non cancella le altre", () => {
    const node = frame("A", 0, 0, { meta: { "code.route": "/a", "altro": "1" } });
    const op = setMetaOp(node, "status", "tested")!;
    expect(op.kind.case).toBe("setProps");
    const v = op.kind.value as { patch: { meta: Record<string, string> }; mask: { paths: string[] } };
    expect(v.mask.paths).toEqual(["meta"]);
    expect(v.patch.meta).toEqual({ "code.route": "/a", altro: "1", status: "tested" });
  });

  it("niente op se la mappa non cambia (anche svuotando una chiave assente)", () => {
    const node = frame("A", 0, 0, { meta: { status: "tested" } });
    expect(setMetaOp(node, "status", "tested")).toBeNull();
    expect(setMetaOp(node, "code.route", "")).toBeNull();
    expect(setMetaOp(frame("B", 0), "code.route", "")).toBeNull();
  });

  it("applicato al documento: le chiavi non toccate sopravvivono, svuotare toglie", () => {
    const s0 = useScene.getState().scene!;
    submit([setMetaOp(s0.nodes.at("A"), "code.route", "/home")!]);
    submit([setMetaOp(useScene.getState().scene!.nodes.at("A"), "status", "implemented")!]);
    expect(useScene.getState().scene!.nodes.at("A").meta).toEqual({ "code.route": "/home", status: "implemented" });
    submit([setMetaOp(useScene.getState().scene!.nodes.at("A"), "code.route", "")!]);
    expect(useScene.getState().scene!.nodes.at("A").meta).toEqual({ status: "implemented" });
    // l'undo di una singola scrittura ripristina esattamente la mappa precedente
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at("A").meta).toEqual({ "code.route": "/home", status: "implemented" });
  });
});
