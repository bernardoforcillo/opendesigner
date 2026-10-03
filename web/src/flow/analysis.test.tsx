import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { create } from "@bufbuild/protobuf";
import { FlowReportSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { FlowReport } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { useFlowUi } from "../store/flowUi";
import { countByKind, DEBOUNCE_MS, refreshAnalysis, setAnalysisFetcher, useAnalysis, useFlowAnalysis } from "./analysis";
import { baseScene, flowOf, transition, withFlows } from "./testSupport";

// AnalyzeFlows è del server: qui il trasporto è finto, e si prova ciò che è del
// client -- quando richiede, quale risposta vince, cosa evidenzia sul canvas.

function report(flowId: string, issues: Partial<FlowReport["issues"][number]>[] = []): FlowReport {
  return create(FlowReportSchema, {
    flowId, screens: 2, transitions: 1,
    issues: issues.map((i) => ({ kind: "dead_end", flowId, nodeId: "", transitionId: "", message: "m", ...i })),
  });
}

function Probe({ enabled = true }: { enabled?: boolean }) {
  useFlowAnalysis(enabled);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  useAnalysis.setState({ reports: {}, status: "idle", error: null, docId: null });
  useFlowUi.setState({ currentFlowId: null, issueNodeIds: new Set(), issueTransitionIds: new Set() });
  useScene.setState({ gesture: null });
  useScene.getState().setScene(withFlows(baseScene(), [flowOf("f1", "A")], [transition("t1", "f1", "A", "B")]));
});
afterEach(() => {
  cleanup();
  setAnalysisFetcher();
  vi.useRealTimers();
});

describe("refreshAnalysis", () => {
  it("salva i report per flusso e pubblica gli id dei problemi del flusso corrente", async () => {
    setAnalysisFetcher(async () => [report("f1", [{ nodeId: "B" }, { transitionId: "t1" }]), report("f2", [{ nodeId: "C" }])]);
    await refreshAnalysis();
    expect(Object.keys(useAnalysis.getState().reports).sort()).toEqual(["f1", "f2"]);
    expect(useAnalysis.getState().status).toBe("idle");
    // currentFlowId null -> il primo flusso (f1): C, che è di f2, non si evidenzia
    expect([...useFlowUi.getState().issueNodeIds]).toEqual(["B"]);
    expect([...useFlowUi.getState().issueTransitionIds]).toEqual(["t1"]);
  });

  it("un errore del server diventa stato, non eccezione", async () => {
    setAnalysisFetcher(async () => {
      throw new Error("boom");
    });
    await refreshAnalysis();
    expect(useAnalysis.getState()).toMatchObject({ status: "error", error: "boom" });
  });

  it("una risposta VECCHIA e lenta non sovrascrive quella arrivata dopo", async () => {
    let release!: (r: FlowReport[]) => void;
    const slow = new Promise<FlowReport[]>((res) => (release = res));
    setAnalysisFetcher(() => slow);
    const first = refreshAnalysis();
    setAnalysisFetcher(async () => [report("f1", [{ nodeId: "FRESCO" }])]);
    await refreshAnalysis();
    release([report("f1", [{ nodeId: "VECCHIO" }])]);
    await first;
    expect(useAnalysis.getState().reports.f1.issues[0].nodeId).toBe("FRESCO");
    expect([...useFlowUi.getState().issueNodeIds]).toEqual(["FRESCO"]);
  });

  it("senza scena non chiede nulla", async () => {
    const fetcher = vi.fn(async () => []);
    setAnalysisFetcher(fetcher);
    useScene.setState({ scene: null });
    await refreshAnalysis();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("countByKind", () => {
  it("raggruppa per tipo", () => {
    const r = report("f1", [{ kind: "dead_end" }, { kind: "dead_end" }, { kind: "unreachable" }]);
    expect(countByKind(r)).toEqual({ dead_end: 2, unreachable: 1 });
    expect(countByKind(undefined)).toEqual({});
  });
});

describe("useFlowAnalysis (richieste con debounce)", () => {
  it("chiede subito, e di nuovo UNA volta sola dopo una raffica di cambi del confermato", async () => {
    const fetcher = vi.fn(async () => [report("f1")]);
    setAnalysisFetcher(fetcher);
    render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // tre modifiche confermate ravvicinate: una sola richiesta, a debounce scaduto
    const base = useScene.getState().scene!;
    for (let i = 0; i < 3; i++) {
      act(() => {
        useScene.getState().setScene({ ...base, transitions: { ...base.transitions, [`n${i}`]: transition(`n${i}`, "f1", "A", "C") } });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS / 3);
      });
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("non chiede mentre un gesto è aperto (un drag cambia i nodi a ogni pixel)", async () => {
    const fetcher = vi.fn(async () => [report("f1")]);
    setAnalysisFetcher(fetcher);
    useScene.setState({ gesture: { selection: [], preview: new Map() } });
    render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 3);
    });
    expect(fetcher).not.toHaveBeenCalled();
    useScene.setState({ gesture: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("disabilitato: niente richieste; smontando si spegne l'evidenziazione", async () => {
    const fetcher = vi.fn(async () => [report("f1", [{ nodeId: "B" }])]);
    setAnalysisFetcher(fetcher);
    const { unmount } = render(<Probe enabled={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    });
    expect(fetcher).not.toHaveBeenCalled();
    unmount();

    const on = render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(useFlowUi.getState().issueNodeIds.has("B")).toBe(true);
    on.unmount();
    expect(useFlowUi.getState().issueNodeIds.size).toBe(0);
  });

  it("cambiare flusso corrente rievidenzia senza una nuova richiesta", async () => {
    const fetcher = vi.fn(async () => [report("f1", [{ nodeId: "B" }]), report("f2", [{ nodeId: "C" }])]);
    setAnalysisFetcher(fetcher);
    render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect([...useFlowUi.getState().issueNodeIds]).toEqual(["B"]);
    // f2 deve esistere perché sia "corrente"
    const s = useScene.getState().scene!;
    act(() => {
      useScene.getState().setScene({ ...s, flows: { ...s.flows, f2: flowOf("f2") } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 10);
    });
    const calls = fetcher.mock.calls.length;
    act(() => useFlowUi.getState().setCurrentFlow("f2"));
    expect([...useFlowUi.getState().issueNodeIds]).toEqual(["C"]);
    expect(fetcher.mock.calls.length).toBe(calls);
  });
});
