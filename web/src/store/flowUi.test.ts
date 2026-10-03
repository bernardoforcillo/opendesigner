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

describe("modalità", () => {
  it("parte in Design; toggleMode alterna", () => {
    expect(useFlowUi.getState().mode).toBe("design");
    useFlowUi.getState().toggleMode();
    expect(useFlowUi.getState().mode).toBe("flows");
    useFlowUi.getState().toggleMode();
    expect(useFlowUi.getState().mode).toBe("design");
  });

  it("Sviluppo è la terza modalità: toggleMode da lì riporta a Design, e setMode azzera lo stato di Flussi", () => {
    const st = useFlowUi.getState();
    st.setMode("flows");
    st.selectTransition("t1");
    st.setMode("dev");
    expect(useFlowUi.getState()).toMatchObject({ mode: "dev", selectedTransitionId: null, presenting: false });
    useFlowUi.getState().toggleMode();
    expect(useFlowUi.getState().mode).toBe("design");
  });

  it("aprire il prototipo ricorda (per documento) che è stato provato; chiuderlo no", () => {
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: () => {} });
    useScene.getState().setScene(baseScene());
    useFlowUi.getState().setPresenting(false);
    expect(store).toEqual({});
    useFlowUi.getState().setPresenting(true);
    expect(store).toEqual({ "od.presented.doc": "1" });
    vi.unstubAllGlobals();
  });

  it("uscire da Flussi azzera freccia scelta, hover, rubber band e prototipo", () => {
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

  it("setMode con la stessa modalità non cambia lo stato (nessuna notifica)", () => {
    const fn = vi.fn();
    const unsub = useFlowUi.subscribe(fn);
    useFlowUi.getState().setMode("design");
    expect(fn).not.toHaveBeenCalled();
    unsub();
  });

  it("l'hover uguale non notifica: il pointermove non invalida il canvas a vuoto", () => {
    useFlowUi.getState().setHoverTransition("t1");
    const fn = vi.fn();
    const unsub = useFlowUi.subscribe(fn);
    useFlowUi.getState().setHoverTransition("t1");
    expect(fn).not.toHaveBeenCalled();
    useFlowUi.getState().setHoverTransition(null);
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("cambiare flusso deseleziona la freccia (appartiene all'altro)", () => {
    useFlowUi.getState().selectTransition("t1");
    useFlowUi.getState().setCurrentFlow("f2");
    expect(useFlowUi.getState().selectedTransitionId).toBeNull();
  });
});

describe("resolveFlow / sortedFlows", () => {
  const s = withFlows(baseScene(), [flowOf("b", "", "Beta"), flowOf("a", "", "Alfa")], []);

  it("il flusso scelto se esiste, altrimenti il primo per nome", () => {
    expect(resolveFlow(s, "b")?.id).toBe("b");
    expect(resolveFlow(s, null)?.id).toBe("a");
    expect(resolveFlow(s, "cancellato")?.id).toBe("a");
  });

  it("nessun flusso o nessuna scena: null", () => {
    expect(resolveFlow(baseScene(), null)).toBeNull();
    expect(resolveFlow(null, "a")).toBeNull();
  });

  it("sortedFlows: per nome, poi per id", () => {
    const eq = withFlows(baseScene(), [flowOf("z", "", "Uguale"), flowOf("y", "", "Uguale"), flowOf("x", "", "Prima")], []);
    expect(sortedFlows(eq).map((f) => f.id)).toEqual(["x", "y", "z"]);
  });
});
