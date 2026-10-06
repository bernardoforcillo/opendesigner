import { useMemo } from "react";
import { useScene } from "../../store/store";
import { useAnalysis } from "../../flow/analysis";
import { useFlowUi } from "../../store/flowUi";
import { submit } from "../../flow/commands";
import { screenOf } from "../../flow/screens";
import { assignRoutesOps, computeReadiness, setStartsOps, type Readiness, type ReadinessFix } from "../../dev/readiness";
import type { SceneState } from "../../store/types";

// The bridge between the app state and the pure checklist (dev/readiness.ts). The three
// Develop panels (checklist, stepper, Ship) read the SAME computation:
// a one-slot memo, key = scene identity and report, so the cost is not
// tripled on every edit.

let memo: { scene: SceneState; reports: unknown; value: Readiness } | null = null;

export function readinessFor(scene: SceneState, reports: Parameters<typeof computeReadiness>[1]): Readiness {
  if (memo && memo.scene === scene && memo.reports === reports) return memo.value;
  const value = computeReadiness(scene, reports);
  memo = { scene, reports, value };
  return value;
}

/** The current document's checklist; null until there is a document. */
export function useReadiness(): Readiness | null {
  const scene = useScene((s) => s.scene);
  const reports = useAnalysis((s) => s.reports);
  const analyzed = useAnalysis((s) => s.docId);
  // The server's first response has not arrived yet (or belongs to another document): "pending".
  const usable = scene && analyzed === scene.id ? reports : null;
  return useMemo(() => (scene ? readinessFor(scene, usable) : null), [scene, usable]);
}

/** Brings a screen into view: changes page if needed and selects it (the Develop view shows its file). */
export function selectScreen(scene: SceneState, nodeId: string): void {
  const n = scene.nodes.at(nodeId);
  if (!n) return;
  const st = useScene.getState();
  const screen = screenOf(scene, nodeId);
  if (screen && st.currentPageId !== screen.parentId) st.setCurrentPage(screen.parentId);
  useFlowUi.getState().selectTransition(null);
  st.setSelection([nodeId]);
}

/** Applies a fix in one click. The ops go in ONE gesture: a single Ctrl+Z undoes them all. */
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
