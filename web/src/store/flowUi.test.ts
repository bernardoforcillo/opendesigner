import { describe, it, expect, beforeEach, vi } from "vitest";
import { resolveFlow, sortedFlows, useFlowUi } from "./flowUi";
import { baseScene, flowOf, withFlows } from "../flow/testSupport";
import { useScene } from "./store";

beforeEach(() => {
  useFlowUi.setState({
    mode: "design", currentFlowId: null, showAllFlows: false, selectedTransitionId: null,
    hoverTransitionId: null, connectPreview: null, presenting: false,
  });
});

describe("modes", () => {
  it("parte in Design; toggleMode alterna", () => {
    expect(useFlowUi.getState().mode).toBe("design");
    useFlowUi.getState().toggleMode();
    expect(useFlowUi.getState().mode).toBe("flows");
    useFlowUi.getState().toggleMode();
    expect(useFlowUi.getState().mode).toBe("design");
  });

  it("Development is the third mode: toggleMode from there goes back to Design, and setMode resets the Flows state", () => {
    const st = useFlowUi.getState();
    st.setMode("flows");
    st.selectTransition("t1");
    st.setMode("dev");
    expect(useFlowUi.getState()).toMatchObject({ mode: "dev", selectedTransitionId: null, presenting: false });
    useFlowUi.getState().toggleMode();
    expect(useFlowUi.getState().mode).toBe("design");
  });

  it("opening the prototype remembers (per document) that it was tried; closing it does not", () => {
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: () => {} });
    useScene.getState().setScene(baseScene());
    useFlowUi.getState().setPresenting(false);
    expect(store).toEqual({});
    useFlowUi.getState().setPresenting(true);
    expect(store).toEqual({ "od.presented.doc": "1" });
    vi.unstubAllGlobals();
  });

  it("leaving Flows resets the chosen arrow, hover, rubber band and prototype", () => {
    const st = useFlowUi.getState();
    st.setMode("flows");
    st.selectTransition("t1");
    st.setHoverTransition("t1");
    st.setPresenting(true);
    st.setConnectPreview({ fromScreenId: "A", elementId: "", fromBounds: { x: 0, y: 0, width: 1, height: 1 }, x: 0, y: 0, targetId: null });
    useFlowUi.getState().setMode("design");
    const s = useFlowUi.getState();
    expect(s).toMatchObject({ mode: "design", selectedTransitionId: null, hoverTransitionId: null, connectPreview: null, presenting: false });
  });

  it("setMode with the same mode does not change the state (no notification)", () => {
    const fn = vi.fn();
    const unsub = useFlowUi.subscribe(fn);
    useFlowUi.getState().setMode("design");
    expect(fn).not.toHaveBeenCalled();
    unsub();
  });

  it("an equal hover does not notify: pointermove does not invalidate the canvas for nothing", () => {
    useFlowUi.getState().setHoverTransition("t1");
    const fn = vi.fn();
    const unsub = useFlowUi.subscribe(fn);
    useFlowUi.getState().setHoverTransition("t1");
    expect(fn).not.toHaveBeenCalled();
    useFlowUi.getState().setHoverTransition(null);
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("changing flow deselects the arrow (it belongs to the other)", () => {
    useFlowUi.getState().selectTransition("t1");
    useFlowUi.getState().setCurrentFlow("f2");
    expect(useFlowUi.getState().selectedTransitionId).toBeNull();
  });
});

describe("resolveFlow / sortedFlows", () => {
  const s = withFlows(baseScene(), [flowOf("b", "", "Beta"), flowOf("a", "", "Alfa")], []);

  it("the chosen flow if it still exists, otherwise the first by name", () => {
    expect(resolveFlow(s, "b")?.id).toBe("b");
    expect(resolveFlow(s, null)?.id).toBe("a");
    expect(resolveFlow(s, "deleted")?.id).toBe("a");
  });

  it("no flow or no scene: null", () => {
    expect(resolveFlow(baseScene(), null)).toBeNull();
    expect(resolveFlow(null, "a")).toBeNull();
  });

  it("sortedFlows: by name, then by id", () => {
    const eq = withFlows(baseScene(), [flowOf("z", "", "Same"), flowOf("y", "", "Same"), flowOf("x", "", "First")], []);
    expect(sortedFlows(eq).map((f) => f.id)).toEqual(["x", "y", "z"]);
  });
});
