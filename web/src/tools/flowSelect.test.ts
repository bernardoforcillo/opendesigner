import { describe, it, expect, beforeEach, vi } from "vitest";
import { pickArrow, withFlowArrows } from "./flowSelect";
import type { Tool, ToolContext } from "./types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { useFlowUi } from "../store/flowUi";
import { baseScene, flowOf, transition, withFlows } from "../flow/testSupport";

class FakeSync {
  sent: Op[] = [];
  submit(op: Op) {
    this.sent.push(op);
    useScene.getState().applyPending(op);
    useScene.getState().apply(op);
  }
}

let sync: FakeSync;
function ctx(): ToolContext {
  return {
    sync,
    getScene: () => useScene.getState().scene,
    getCamera: () => useScene.getState().camera,
    setCamera: vi.fn(),
    canvas: {} as HTMLCanvasElement,
    toWorld: (e: PointerEvent) => ({ x: e.clientX, y: e.clientY }),
  } as unknown as ToolContext;
}
const at = (x: number, y: number) => ({ clientX: x, clientY: y }) as PointerEvent;
const key = (k: string) => ({ key: k }) as KeyboardEvent;

function fakeBase() {
  const base: Tool = {
    id: "select", cursor: "default",
    onPointerDown: vi.fn(), onPointerMove: vi.fn(), onPointerUp: vi.fn(), onKeyDown: vi.fn(), onDeactivate: vi.fn(),
  };
  return base;
}

// A->B goes through (300,150): the arrow t1 lies on that row between x 200 and 400.
beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: ["A"], gesture: null, undoStack: [], redoStack: [], canUndo: false, canRedo: false });
  useFlowUi.setState({ mode: "flows", currentFlowId: null, showAllFlows: false, selectedTransitionId: null, hoverTransitionId: null });
  useScene.getState().setScene(withFlows(baseScene(), [flowOf("f1", "A", "Alfa"), flowOf("f2", "A", "Zeta")], [
    transition("t1", "f1", "A", "B"),
    transition("t2", "f2", "B", "C"),
  ]));
  useScene.getState().setSync(sync);
});

describe("withFlowArrows", () => {
  it("keeps the base tool's id and cursor", () => {
    const t = withFlowArrows(fakeBase());
    expect(t.id).toBe("select");
    expect(t.cursor).toBe("default");
  });

  it("in Design it always delegates, without looking at the arrows", () => {
    useFlowUi.setState({ mode: "design" });
    const base = fakeBase();
    const t = withFlowArrows(base);
    t.onPointerDown!(at(300, 150), ctx());
    expect(base.onPointerDown).toHaveBeenCalledTimes(1);
    expect(useFlowUi.getState().selectedTransitionId).toBeNull();
  });

  it("in Flows a click on the arrow selects it and does NOT reach the select tool", () => {
    const base = fakeBase();
    const t = withFlowArrows(base);
    const c = ctx();
    t.onPointerDown!(at(300, 151), c);
    expect(useFlowUi.getState().selectedTransitionId).toBe("t1");
    // nodes are deselected: there is only one selection
    expect(useScene.getState().selection).toEqual([]);
    t.onPointerMove!(at(310, 150), c);
    t.onPointerUp!(at(310, 150), c);
    expect(base.onPointerDown).not.toHaveBeenCalled();
    expect(base.onPointerMove).not.toHaveBeenCalled();
    expect(base.onPointerUp).not.toHaveBeenCalled();
    // once the gesture is over, the next click is back to normal
    t.onPointerDown!(at(100, 100), c);
    expect(base.onPointerDown).toHaveBeenCalledTimes(1);
  });

  it("a click elsewhere deselects the arrow and goes to the select tool", () => {
    useFlowUi.setState({ selectedTransitionId: "t1" });
    const base = fakeBase();
    withFlowArrows(base).onPointerDown!(at(100, 100), ctx());
    expect(useFlowUi.getState().selectedTransitionId).toBeNull();
    expect(base.onPointerDown).toHaveBeenCalledTimes(1);
  });

  it("the label pill is hit even far from the stroke", () => {
    const base = fakeBase();
    // the midpoint is (300,150): 8px above is outside the stroke (6) but inside the pill
    withFlowArrows(base).onPointerDown!(at(300, 142), ctx());
    expect(useFlowUi.getState().selectedTransitionId).toBe("t1");
  });

  it("only the arrows of the current flow, unless 'show all'", () => {
    const t = withFlowArrows(fakeBase());
    // t2 (B->C, flow f2) is on the row (700,150); the current flow is the first by name: f1
    t.onPointerDown!(at(700, 150), ctx());
    expect(useFlowUi.getState().selectedTransitionId).toBeNull();
    useFlowUi.setState({ showAllFlows: true });
    t.onPointerDown!(at(700, 150), ctx());
    expect(useFlowUi.getState().selectedTransitionId).toBe("t2");
  });

  it("the hover updates on pointermove and turns off elsewhere", () => {
    const t = withFlowArrows(fakeBase());
    const c = ctx();
    t.onPointerMove!(at(300, 150), c);
    expect(useFlowUi.getState().hoverTransitionId).toBe("t1");
    t.onPointerMove!(at(100, 100), c);
    expect(useFlowUi.getState().hoverTransitionId).toBeNull();
  });

  it("hover is not computed during an open gesture (a node drag)", () => {
    useScene.setState({ gesture: { selection: [], preview: new Map() } });
    const t = withFlowArrows(fakeBase());
    t.onPointerMove!(at(300, 150), ctx());
    expect(useFlowUi.getState().hoverTransitionId).toBeNull();
  });

  it("Delete on the selected arrow deletes it (one op, undoable) and does not touch the nodes", () => {
    useFlowUi.setState({ selectedTransitionId: "t1" });
    const base = fakeBase();
    withFlowArrows(base).onKeyDown!(key("Delete"), ctx());
    expect(sync.sent.map((o) => o.kind.case)).toEqual(["deleteTransition"]);
    expect(useScene.getState().scene!.transitions.t1).toBeUndefined();
    expect(useFlowUi.getState().selectedTransitionId).toBeNull();
    expect(base.onKeyDown).not.toHaveBeenCalled();
    useScene.getState().undo();
    expect(useScene.getState().scene!.transitions.t1).toBeDefined();
  });

  it("Delete with the arrow already gone (deleted by a peer) sends nothing", () => {
    useFlowUi.setState({ selectedTransitionId: "ghost" });
    withFlowArrows(fakeBase()).onKeyDown!(key("Backspace"), ctx());
    expect(sync.sent).toHaveLength(0);
  });

  it("Escape deselects the arrow; without an arrow the key goes to the base tool", () => {
    useFlowUi.setState({ selectedTransitionId: "t1" });
    const base = fakeBase();
    const t = withFlowArrows(base);
    t.onKeyDown!(key("Escape"), ctx());
    expect(useFlowUi.getState().selectedTransitionId).toBeNull();
    expect(base.onKeyDown).not.toHaveBeenCalled();
    t.onKeyDown!(key("Escape"), ctx());
    expect(base.onKeyDown).toHaveBeenCalledTimes(1);
  });

  it("onDeactivate clears the armed gesture and delegates", () => {
    const base = fakeBase();
    const t = withFlowArrows(base);
    const c = ctx();
    t.onPointerDown!(at(300, 150), c); // arms
    t.onDeactivate!(c);
    expect(base.onDeactivate).toHaveBeenCalledTimes(1);
    t.onPointerUp!(at(0, 0), c);
    expect(base.onPointerUp).toHaveBeenCalledTimes(1);
  });
});

describe("pickArrow", () => {
  it("scene without transitions: null without building anything", () => {
    useScene.getState().setScene(baseScene());
    expect(pickArrow(ctx(), 300, 150)).toBeNull();
  });

  it("the tolerance is in screen px: at low zoom the grab in world units grows", () => {
    useScene.setState({ camera: { x: 0, y: 0, zoom: 0.25 } });
    // 20 world units = 5px screen: within the 6px grab
    expect(pickArrow(ctx(), 250, 170)?.id).toBe("t1");
    useScene.setState({ camera: { x: 0, y: 0, zoom: 4 } });
    // at zoom 4 the grab is 1.5 units: 5 above is outside
    expect(pickArrow(ctx(), 250, 155)).toBeNull();
  });
});
