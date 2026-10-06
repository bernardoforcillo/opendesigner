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
  it("'Flow 1', then the first free number (not the count)", () => {
    expect(nextFlowName(baseScene())).toBe("Flow 1");
    const s = withFlows(baseScene(), [flowOf("a", "", "Flow 1"), flowOf("b", "", "Flow 3")], []);
    expect(nextFlowName(s)).toBe("Flow 2");
  });
});

describe("connectOps", () => {
  it("without flows: creates 'Flow 1' with the start as the entry, then the click transition", () => {
    const r = connectOps(baseScene(), null, "A", "B", "");
    expect(r.createdFlow).toBe(true);
    expect(r.ops.map((o) => o.kind.case)).toEqual(["setFlow", "setTransition"]);
    const flow = r.ops[0].kind.value as { flow: { id: string; name: string; startId: string } };
    expect(flow.flow).toMatchObject({ name: "Flow 1", startId: "A", id: r.flowId });
    const t = (r.ops[1].kind.value as unknown as { transition: Record<string, string> }).transition;
    expect(t).toMatchObject({ id: r.transitionId, flowId: r.flowId, fromId: "A", toId: "B", trigger: "click", elementId: "" });
  });

  it("the hotspot ends up in elementId", () => {
    const r = connectOps(baseScene(), null, "A", "B", "btn");
    const t = (r.ops[1].kind.value as unknown as { transition: Record<string, string> }).transition;
    expect(t.elementId).toBe("btn");
    expect(t.fromId).toBe("A");
  });

  it("existing flow with an entry: only the transition", () => {
    const s = withFlows(baseScene(), [flowOf("f1", "A")], []);
    const r = connectOps(s, "f1", "B", "C", "");
    expect(r.createdFlow).toBe(false);
    expect(r.ops.map((o) => o.kind.case)).toEqual(["setTransition"]);
    expect(r.flowId).toBe("f1");
  });

  it("flow without an entry: the start becomes it, in the same gesture", () => {
    const s = withFlows(baseScene(), [flowOf("f1", "")], []);
    const r = connectOps(s, "f1", "B", "C", "");
    expect(r.ops.map((o) => o.kind.case)).toEqual(["setFlow", "setTransition"]);
    expect((r.ops[0].kind.value as { flow: { startId: string } }).flow.startId).toBe("B");
  });

  it("entry vanished (node deleted): it is replaced", () => {
    const s = withFlows(baseScene(), [flowOf("f1", "ghost")], []);
    expect(connectOps(s, "f1", "B", "C", "").ops).toHaveLength(2);
  });

  it("a stale currentFlowId falls back to the first flow instead of creating another", () => {
    const s = withFlows(baseScene(), [flowOf("f1", "A", "Alfa")], []);
    const r = connectOps(s, "sparito", "A", "B", "");
    expect(r.flowId).toBe("f1");
    expect(r.createdFlow).toBe(false);
  });
});

describe("submit (ONE gesture = ONE undo entry)", () => {
  it("'Connect' without flows: a single undo removes flow AND transition", () => {
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

  it("without ops it does nothing", () => {
    submit([]);
    expect(useScene.getState().undoStack).toHaveLength(0);
  });
});

describe("operations on flows and transitions", () => {
  const f = flowOf("f1", "A", "Uno");
  const t = transition("t1", "f1", "A", "B", { label: "Vai" });

  it("renameFlowOp: no op for an empty or unchanged name, trim the rest", () => {
    expect(renameFlowOp(f, "  ")).toBeNull();
    expect(renameFlowOp(f, "Uno")).toBeNull();
    const op = renameFlowOp(f, "  Due ")!;
    expect((op.kind.value as { flow: { name: string; startId: string } }).flow).toMatchObject({ name: "Due", startId: "A" });
  });

  it("setStartOp: no op if it is already the entry; otherwise keeps the rest of the flow", () => {
    expect(setStartOp(f, "A")).toBeNull();
    const op = setStartOp({ ...f, description: "d" }, "B")!;
    expect((op.kind.value as { flow: { startId: string; description: string; name: string } }).flow).toMatchObject({ startId: "B", description: "d", name: "Uno" });
  });

  it("editTransitionOp: one field at a time, no op if unchanged", () => {
    expect(editTransitionOp(t, "label", "Vai")).toBeNull();
    const op = editTransitionOp(t, "guard", "x=1")!;
    expect((op.kind.value as unknown as { transition: Record<string, string> }).transition).toMatchObject({ id: "t1", label: "Vai", guard: "x=1", toId: "B" });
  });

  it("createFlowOp / deleteFlowOp / deleteTransitionOp", () => {
    const c = createFlowOp(baseScene());
    expect(c.op.kind.case).toBe("setFlow");
    expect(c.flow).toMatchObject({ name: "Flow 1", startId: "" });
    expect(deleteFlowOp("f1").kind.case).toBe("deleteFlow");
    expect(deleteTransitionOp("t1").kind.case).toBe("deleteTransition");
  });
});

describe("setMetaOp (read-modify-write of the meta map)", () => {
  it("rewrites ALL the keys: writing one does not erase the others", () => {
    const node = frame("A", 0, 0, { meta: { "code.route": "/a", "other": "1" } });
    const op = setMetaOp(node, "status", "tested")!;
    expect(op.kind.case).toBe("setProps");
    const v = op.kind.value as { patch: { meta: Record<string, string> }; mask: { paths: string[] } };
    expect(v.mask.paths).toEqual(["meta"]);
    expect(v.patch.meta).toEqual({ "code.route": "/a", other: "1", status: "tested" });
  });

  it("no op if the map does not change (even when clearing an absent key)", () => {
    const node = frame("A", 0, 0, { meta: { status: "tested" } });
    expect(setMetaOp(node, "status", "tested")).toBeNull();
    expect(setMetaOp(node, "code.route", "")).toBeNull();
    expect(setMetaOp(frame("B", 0), "code.route", "")).toBeNull();
  });

  it("applied to the document: untouched keys survive, clearing removes", () => {
    const s0 = useScene.getState().scene!;
    submit([setMetaOp(s0.nodes.at("A"), "code.route", "/home")!]);
    submit([setMetaOp(useScene.getState().scene!.nodes.at("A"), "status", "implemented")!]);
    expect(useScene.getState().scene!.nodes.at("A").meta).toEqual({ "code.route": "/home", status: "implemented" });
    submit([setMetaOp(useScene.getState().scene!.nodes.at("A"), "code.route", "")!]);
    expect(useScene.getState().scene!.nodes.at("A").meta).toEqual({ status: "implemented" });
    // the undo of a single write restores exactly the previous map
    useScene.getState().undo();
    expect(useScene.getState().scene!.nodes.at("A").meta).toEqual({ "code.route": "/home", status: "implemented" });
  });
});
