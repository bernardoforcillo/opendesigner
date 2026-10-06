import { describe, it, expect, beforeEach, vi } from "vitest";
import { connectTool, createConnectTool } from "./connectTool";
import type { ToolContext } from "./types";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { useFlowUi } from "../store/flowUi";
import { baseScene, flowOf, transition, withFlows } from "../flow/testSupport";
import type { SceneState } from "../store/types";

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

function install(scene: SceneState) {
  useScene.getState().setScene(scene);
}

// Fixture geometry: A x 0..200, B x 400..600, C x 800..1000 (all y 0..300);
// btn inside A at (60,200)..(140,230); `loose` is a page rectangle at (0,600).
beforeEach(() => {
  sync = new FakeSync();
  useScene.setState({ camera: { x: 0, y: 0, zoom: 1 }, selection: [], gesture: null, undoStack: [], redoStack: [], canUndo: false, canRedo: false });
  useFlowUi.setState({ mode: "flows", currentFlowId: null, selectedTransitionId: null, connectPreview: null });
  install(baseScene());
  useScene.getState().setSync(sync);
});

function drag(tool = connectTool, from: [number, number], to: [number, number], c = ctx()) {
  tool.onPointerDown!(at(...from), c);
  tool.onPointerMove!(at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2), c);
  tool.onPointerMove!(at(...to), c);
  tool.onPointerUp!(at(...to), c);
}

describe("connectTool", () => {
  it("is the 'connect' tool with the crosshair cursor", () => {
    expect(connectTool.id).toBe("connect");
    expect(connectTool.cursor).toBe("crosshair");
  });

  it("from one screen to another creates 'Flow 1' and the click transition, in ONE gesture", () => {
    drag(connectTool, [100, 100], [500, 100]);
    const s = useScene.getState().scene!;
    const flows = Object.values(s.flows);
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ name: "Flow 1", startId: "A" });
    const ts = Object.values(s.transitions);
    expect(ts).toHaveLength(1);
    expect(ts[0]).toMatchObject({ fromId: "A", toId: "B", trigger: "click", elementId: "", flowId: flows[0].id });
    // the ops on the wire: setFlow + setTransition, and ONE single undo entry
    expect(sync.sent.map((o) => o.kind.case)).toEqual(["setFlow", "setTransition"]);
    expect(useScene.getState().undoStack).toHaveLength(1);
    // the flow becomes the current one and the new arrow is selected
    expect(useFlowUi.getState().currentFlowId).toBe(flows[0].id);
    expect(useFlowUi.getState().selectedTransitionId).toBe(ts[0].id);
    // rubber band off
    expect(useFlowUi.getState().connectPreview).toBeNull();

    useScene.getState().undo();
    expect(useScene.getState().scene!.flows).toEqual({});
    expect(useScene.getState().scene!.transitions).toEqual({});
  });

  it("starting from an element makes it a hotspot (elementId), fromId is its screen", () => {
    drag(connectTool, [100, 215], [500, 100]); // inside btn
    const t = Object.values(useScene.getState().scene!.transitions)[0];
    expect(t).toMatchObject({ fromId: "A", toId: "B", elementId: "btn" });
  });

  it("landing on an element inside the destination screen connects the SCREEN", () => {
    drag(connectTool, [500, 100], [100, 215]); // B -> inside btn (which sits in A)
    const t = Object.values(useScene.getState().scene!.transitions)[0];
    expect(t).toMatchObject({ fromId: "B", toId: "A", elementId: "" });
  });

  it("existing flow with an entry: adds only the transition", () => {
    install(withFlows(baseScene(), [flowOf("f1", "A")], []));
    useFlowUi.setState({ currentFlowId: "f1" });
    drag(connectTool, [500, 100], [900, 100]);
    expect(sync.sent.map((o) => o.kind.case)).toEqual(["setTransition"]);
    expect(Object.values(useScene.getState().scene!.transitions)[0]).toMatchObject({ flowId: "f1", fromId: "B", toId: "C" });
  });

  it("flow without an entry: the starting screen becomes it", () => {
    install(withFlows(baseScene(), [flowOf("f1", "")], []));
    useFlowUi.setState({ currentFlowId: "f1" });
    drag(connectTool, [500, 100], [900, 100]);
    expect(useScene.getState().scene!.flows.f1.startId).toBe("B");
  });

  it("a click without dragging creates nothing", () => {
    const c = ctx();
    connectTool.onPointerDown!(at(100, 100), c);
    connectTool.onPointerUp!(at(101, 100), c);
    expect(sync.sent).toHaveLength(0);
    expect(useFlowUi.getState().connectPreview).toBeNull();
  });

  it("releasing in empty space or on a loose rectangle creates nothing", () => {
    drag(connectTool, [100, 100], [300, 500]); // the empty space between the screens and `loose`
    drag(connectTool, [100, 100], [20, 620]); // `loose` is not a screen
    expect(sync.sent).toHaveLength(0);
  });

  it("starting from empty space or from a loose rectangle starts no gesture", () => {
    const c = ctx();
    connectTool.onPointerDown!(at(300, 500), c);
    expect(useFlowUi.getState().connectPreview).toBeNull();
    connectTool.onPointerDown!(at(20, 620), c);
    expect(useFlowUi.getState().connectPreview).toBeNull();
    connectTool.onPointerUp!(at(500, 100), c);
    expect(sync.sent).toHaveLength(0);
  });

  it("a screen towards itself only from an element", () => {
    drag(connectTool, [100, 100], [150, 150]); // A -> A without a hotspot: nothing
    expect(sync.sent).toHaveLength(0);
    drag(connectTool, [100, 215], [150, 50]); // btn -> A: a "reload"
    expect(Object.values(useScene.getState().scene!.transitions)[0]).toMatchObject({ fromId: "A", toId: "A", elementId: "btn" });
  });

  it("during the drag the rubber band follows the pointer and reports the destination screen", () => {
    const c = ctx();
    connectTool.onPointerDown!(at(100, 100), c);
    expect(useFlowUi.getState().connectPreview).toMatchObject({
      fromScreenId: "A", elementId: "", fromBounds: { x: 0, y: 0, width: 200, height: 300 }, targetId: null,
    });
    connectTool.onPointerMove!(at(500, 120), c);
    expect(useFlowUi.getState().connectPreview).toMatchObject({ x: 500, y: 120, targetId: "B" });
    connectTool.onPointerMove!(at(300, 120), c);
    expect(useFlowUi.getState().connectPreview?.targetId).toBeNull();
    // and the starting hotspot is the element's box
    connectTool.onPointerUp!(at(300, 120), c);
    connectTool.onPointerDown!(at(100, 215), c);
    expect(useFlowUi.getState().connectPreview).toMatchObject({ elementId: "btn", fromBounds: { x: 60, y: 200, width: 80, height: 30 } });
  });

  it("Escape cancels the gesture: no op, rubber band off", () => {
    const c = ctx();
    connectTool.onPointerDown!(at(100, 100), c);
    connectTool.onPointerMove!(at(500, 100), c);
    connectTool.onKeyDown!({ key: "Escape" } as KeyboardEvent, c);
    expect(useFlowUi.getState().connectPreview).toBeNull();
    connectTool.onPointerUp!(at(500, 100), c);
    expect(sync.sent).toHaveLength(0);
  });

  it("changing tool (onDeactivate) abandons the half-done gesture", () => {
    const c = ctx();
    const tool = createConnectTool();
    tool.onPointerDown!(at(100, 100), c);
    tool.onDeactivate!(c);
    expect(useFlowUi.getState().connectPreview).toBeNull();
    tool.onPointerUp!(at(500, 100), c);
    expect(sync.sent).toHaveLength(0);
  });

  it("several links between the same two screens are distinct transitions", () => {
    install(withFlows(baseScene(), [flowOf("f1", "A")], [transition("t0", "f1", "A", "B")]));
    useFlowUi.setState({ currentFlowId: "f1" });
    drag(connectTool, [100, 100], [500, 100]);
    expect(Object.keys(useScene.getState().scene!.transitions)).toHaveLength(2);
  });

  it("zoom and pan: the hit-test goes through the camera (ctx.toWorld is already world)", () => {
    useScene.setState({ camera: { x: 50, y: 0, zoom: 0.5 } });
    // the toWorld mock ignores the camera: here it is enough that zoom does not break the slop
    drag(connectTool, [100, 100], [500, 100]);
    expect(Object.keys(useScene.getState().scene!.transitions)).toHaveLength(1);
  });
});
