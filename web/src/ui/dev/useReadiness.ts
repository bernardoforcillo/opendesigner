import { useMemo } from "react";
import { useScene } from "../../store/store";
import { useAnalysis } from "../../flow/analysis";
import { useFlowUi } from "../../store/flowUi";
import { submit } from "../../flow/commands";
import { screenOf } from "../../flow/screens";
import { assignRoutesOps, computeReadiness, setStartsOps, type Readiness, type ReadinessFix } from "../../dev/readiness";
import type { SceneState } from "../../store/types";

// Il ponte fra lo stato dell'app e la checklist pura (dev/readiness.ts). I tre
// pannelli di Sviluppo (checklist, stepper, Spedisci) leggono lo STESSO calcolo:
// una memoria a un posto, chiave = identità di scena e report, così il costo non
// si triplica a ogni modifica.

let memo: { scene: SceneState; reports: unknown; value: Readiness } | null = null;

export function readinessFor(scene: SceneState, reports: Parameters<typeof computeReadiness>[1]): Readiness {
  if (memo && memo.scene === scene && memo.reports === reports) return memo.value;
  const value = computeReadiness(scene, reports);
  memo = { scene, reports, value };
  return value;
}

/** La checklist del documento corrente; null finché non c'è un documento. */
export function useReadiness(): Readiness | null {
  const scene = useScene((s) => s.scene);
  const reports = useAnalysis((s) => s.reports);
  const analyzed = useAnalysis((s) => s.docId);
  // Prima risposta del server non ancora arrivata (o di un altro documento): "pending".
  const usable = scene && analyzed === scene.id ? reports : null;
  return useMemo(() => (scene ? readinessFor(scene, usable) : null), [scene, usable]);
}

/** Porta in vista una schermata: cambia pagina se serve e la seleziona (la vista Sviluppo ne mostra il file). */
export function selectScreen(scene: SceneState, nodeId: string): void {
  const n = scene.nodes.at(nodeId);
  if (!n) return;
  const st = useScene.getState();
  const screen = screenOf(scene, nodeId);
  if (screen && st.currentPageId !== screen.parentId) st.setCurrentPage(screen.parentId);
  useFlowUi.getState().selectTransition(null);
  st.setSelection([nodeId]);
}

/** Applica una correzione a un click. Gli op vanno in UN gesto: un Ctrl+Z li annulla tutti. */
export function applyFix(scene: SceneState, fix: ReadinessFix): void {
  switch (fix.kind) {
    case "assign-routes":
      submit(assignRoutesOps(scene));
      break;
    case "set-starts":
      submit(setStartsOps(scene));
      break;
    case "goto-flows":
      useFlowUi.getState().setMode("flows");
      break;
    case "select":
      selectScreen(scene, fix.nodeId);
      break;
  }
}
