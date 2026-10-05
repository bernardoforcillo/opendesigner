import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { create } from "@bufbuild/protobuf";
import { FlowReportSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { FlowReport } from "../gen/opendesigner/v1/opendesigner_pb";
import { useScene } from "../store/store";
import { useFlowUi } from "../store/flowUi";
import { countByKind, DEBOUNCE_MS, refreshAnalysis, setAnalysisFetcher, useAnalysis, useFlowAnalysis } from "./analysis";
import { baseScene, flowOf, transition, withFlows } from "./testSupport";

// AnalyzeFlows belongs to the server: here the transport is fake, and what is tested is what belongs to the
// client -- when it requests, which response wins, what it highlights on the canvas.

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
  it("stores the reports per flow and publishes the ids of the current flow's problems", async () => {
    setAnalysisFetcher(async () => [report("f1", [{ nodeId: "B" }, { transitionId: "t1" }]), report("f2", [{ nodeId: "C" }])]);
    await refreshAnalysis();
    expect(Object.keys(useAnalysis.getState().reports).sort()).toEqual(["f1", "f2"]);
    expect(useAnalysis.getState().status).toBe("idle");
    // currentFlowId null -> the first flow (f1): C, which belongs to f2, is not highlighted
    expect([...useFlowUi.getState().issueNodeIds]).toEqual(["B"]);
    expect([...useFlowUi.getState().issueTransitionIds]).toEqual(["t1"]);
  });

  it("a server error becomes state, not an exception", async () => {
    setAnalysisFetcher(async () => {
      throw new Error("boom");
    });
    await refreshAnalysis();
    expect(useAnalysis.getState()).toMatchObject({ status: "error", error: "boom" });
  });

  it("an OLD and slow response does not overwrite the one that arrived later", async () => {
    let release!: (r: FlowReport[]) => void;
    const slow = new Promise<FlowReport[]>((res) => (release = res));
    setAnalysisFetcher(() => slow);
    const first = refreshAnalysis();
    setAnalysisFetcher(async () => [report("f1", [{ nodeId: "FRESH" }])]);
    await refreshAnalysis();
    release([report("f1", [{ nodeId: "STALE" }])]);
    await first;
    expect(useAnalysis.getState().reports.f1.issues[0].nodeId).toBe("FRESH");
    expect([...useFlowUi.getState().issueNodeIds]).toEqual(["FRESH"]);
  });

  it("without a scene it requests nothing", async () => {
    const fetcher = vi.fn(async () => []);
    setAnalysisFetcher(fetcher);
    useScene.setState({ scene: null });
    await refreshAnalysis();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("countByKind", () => {
  it("groups by type", () => {
    const r = report("f1", [{ kind: "dead_end" }, { kind: "dead_end" }, { kind: "unreachable" }]);
    expect(countByKind(r)).toEqual({ dead_end: 2, unreachable: 1 });
    expect(countByKind(undefined)).toEqual({});
  });
});

describe("useFlowAnalysis (debounced requests)", () => {
  it("requests immediately, and again ONCE only after a burst of confirmed changes", async () => {
    const fetcher = vi.fn(async () => [report("f1")]);
    setAnalysisFetcher(fetcher);
    render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // three close confirmed changes: a single request, once the debounce expires
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

  it("does not request while a gesture is open (a drag changes the nodes at every pixel)", async () => {
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

  it("disabled: no requests; unmounting turns the highlighting off", async () => {
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

  it("changing the current flow re-highlights without a new request", async () => {
    const fetcher = vi.fn(async () => [report("f1", [{ nodeId: "B" }]), report("f2", [{ nodeId: "C" }])]);
    setAnalysisFetcher(fetcher);
    render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect([...useFlowUi.getState().issueNodeIds]).toEqual(["B"]);
    // f2 must exist for it to be "current"
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
