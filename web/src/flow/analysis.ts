import { useEffect } from "react";
import { create } from "zustand";
import type { FlowReport } from "../gen/opendesigner/v1/opendesigner_pb";
import { docClient } from "../rpc/client";
import { useScene } from "../store/store";
import { resolveFlow, useFlowUi } from "../store/flowUi";

// CLIENT-SIDE FLOW ANALYSIS: asks the server for `AnalyzeFlows` (the same
// analysis as the CLI and MCP, computed in internal/flow) and keeps the last result
// in a store. The server is the only source: nothing is recomputed here, so UI,
// CLI and agents see the same problems.

export type Fetcher = (docId: string) => Promise<FlowReport[]>;

const defaultFetcher: Fetcher = async (docId) => (await docClient.analyzeFlows({ docId, flowId: "" })).reports;

let fetcher: Fetcher = defaultFetcher;
/** Replaces the transport (tests inject a fake server). With no arguments it restores. */
export function setAnalysisFetcher(f?: Fetcher): void {
  fetcher = f ?? defaultFetcher;
}

export interface AnalysisState {
  /** flowId -> report. Empty until the first response arrives. */
  reports: Record<string, FlowReport>;
  status: "idle" | "loading" | "error";
  error: string | null;
  /** The document (id) that `reports` refers to. */
  docId: string | null;
}

export const useAnalysis = create<AnalysisState>(() => ({ reports: {}, status: "idle", error: null, docId: null }));

// The sequence number of the last request sent: a slow response to an OLD
// request must not overwrite the one that arrived later.
let ticket = 0;

export async function refreshAnalysis(): Promise<void> {
  const scene = useScene.getState().scene;
  if (!scene) return;
  const mine = ++ticket;
  useAnalysis.setState((s) => (s.status === "loading" ? s : { ...s, status: "loading", error: null }));
  try {
    const reports = await fetcher(scene.id);
    if (mine !== ticket) return;
    const byFlow: Record<string, FlowReport> = {};
    for (const r of reports) byFlow[r.flowId] = r;
    useAnalysis.setState({ reports: byFlow, status: "idle", error: null, docId: scene.id });
    publishIssueIds(byFlow);
  } catch (err) {
    if (mine !== ticket) return;
    useAnalysis.setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
  }
}

// The ids with a problem, for the canvas overlay: only those of the current flow.
function publishIssueIds(reports: Record<string, FlowReport>): void {
  const scene = useScene.getState().scene;
  const flow = resolveFlow(scene, useFlowUi.getState().currentFlowId);
  const nodes = new Set<string>();
  const trs = new Set<string>();
  for (const i of (flow ? reports[flow.id]?.issues : undefined) ?? []) {
    if (i.nodeId) nodes.add(i.nodeId);
    if (i.transitionId) trs.add(i.transitionId);
  }
  useFlowUi.getState().setIssueIds(nodes, trs);
}

/** The problems of a report, grouped by type (for the counters). */
export function countByKind(report: FlowReport | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of report?.issues ?? []) out[i.kind] = (out[i.kind] ?? 0) + 1;
  return out;
}

export const DEBOUNCE_MS = 450;

/**
 * Keeps the analysis up to date while mounted: requests immediately, then again
 * (debounced) on every change of the CONFIRMED document -- flows, transitions
 * or nodes (the `flow.kind` metadata changes the outcome). It looks at `confirmed` and not
 * the optimistic view: the server analyzes what it has, and asking before it
 * has received the op would give an already stale answer. Never during an open
 * gesture (a drag changes the nodes at every pixel).
 */
export function useFlowAnalysis(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (delay: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        // Gesture open: retry once the gesture is closed.
        if (useScene.getState().gesture) return schedule(DEBOUNCE_MS);
        void refreshAnalysis();
      }, delay);
    };
    schedule(0);
    const unsub = useScene.subscribe((st, prev) => {
      const a = st.confirmed;
      const b = prev.confirmed;
      if (!a) return;
      if (!b || a.flows !== b.flows || a.transitions !== b.transitions || a.nodes !== b.nodes) schedule(DEBOUNCE_MS);
    });
    // Changing the current flow only changes which problems are highlighted.
    const unsubUi = useFlowUi.subscribe((st, prev) => {
      if (st.currentFlowId !== prev.currentFlowId) publishIssueIds(useAnalysis.getState().reports);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
      unsubUi();
      // The overlay must not stay highlighted after leaving the mode.
      useFlowUi.getState().setIssueIds(new Set(), new Set());
    };
  }, [enabled]);
}
