import { useEffect } from "react";
import { create } from "zustand";
import type { FlowReport } from "../gen/opendesigner/v1/opendesigner_pb";
import { docClient } from "../rpc/client";
import { useScene } from "../store/store";
import { resolveFlow, useFlowUi } from "../store/flowUi";

// L'ANALISI DEI FLUSSI LATO CLIENT: chiede al server `AnalyzeFlows` (la stessa
// analisi di CLI e MCP, calcolata in internal/flow) e tiene l'ultimo risultato
// in uno store. Il server è l'unica fonte: qui non si ricalcola niente, così UI,
// CLI e agenti vedono gli stessi problemi.

export type Fetcher = (docId: string) => Promise<FlowReport[]>;

const defaultFetcher: Fetcher = async (docId) => (await docClient.analyzeFlows({ docId, flowId: "" })).reports;

let fetcher: Fetcher = defaultFetcher;
/** Sostituisce il trasporto (i test iniettano un finto server). Senza argomenti ripristina. */
export function setAnalysisFetcher(f?: Fetcher): void {
  fetcher = f ?? defaultFetcher;
}

export interface AnalysisState {
  /** flowId -> report. Vuoto finché non arriva la prima risposta. */
  reports: Record<string, FlowReport>;
  status: "idle" | "loading" | "error";
  error: string | null;
  /** Il documento (id) a cui si riferisce `reports`. */
  docId: string | null;
}

export const useAnalysis = create<AnalysisState>(() => ({ reports: {}, status: "idle", error: null, docId: null }));

// Il numero d'ordine dell'ultima richiesta partita: una risposta lenta di una
// richiesta VECCHIA non deve sovrascrivere quella arrivata dopo.
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

// Gli id con un problema, per l'overlay del canvas: solo quelli del flusso corrente.
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

/** I problemi di un report, raggruppati per tipo (per i contatori). */
export function countByKind(report: FlowReport | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of report?.issues ?? []) out[i.kind] = (out[i.kind] ?? 0) + 1;
  return out;
}

export const DEBOUNCE_MS = 450;

/**
 * Tiene l'analisi aggiornata finché è montato: richiede subito, poi di nuovo
 * (con debounce) a ogni cambio del documento CONFERMATO -- flussi, transizioni
 * o nodi (i metadati `flow.kind` cambiano l'esito). Si guarda `confirmed` e non
 * la vista ottimistica: il server analizza ciò che ha, e chiedere prima che
 * abbia ricevuto l'op darebbe una risposta già vecchia. Mai durante un gesto
 * aperto (un drag cambia i nodi a ogni pixel).
 */
export function useFlowAnalysis(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (delay: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        // Gesto aperto: si riprova a gesto chiuso.
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
    // Cambiare flusso corrente cambia solo quali problemi si evidenziano.
    const unsubUi = useFlowUi.subscribe((st, prev) => {
      if (st.currentFlowId !== prev.currentFlowId) publishIssueIds(useAnalysis.getState().reports);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
      unsubUi();
      // L'overlay non deve restare evidenziato dopo l'uscita dalla modalità.
      useFlowUi.getState().setIssueIds(new Set(), new Set());
    };
  }, [enabled]);
}
