import { useEffect, useState } from "react";
import { useScene } from "@/store/store";
import { canvasMeasure } from "@/export/exportScene";
import { preflightScene, type PreflightIssue } from "@/export/preflight";
import type { MeasureText } from "@/renderer/text";
import type { NodeLite, SceneState } from "@/store/types";

// THE LIVE PREFLIGHT: the document checked as it is edited, for the status bar's verdict and the
// Preflight panel. It is `preflightScene` (export/preflight.ts) with a real text measure, so text that
// does not fit its frame is found, plus the stories that overflow their LAST frame -- threaded frames are
// laid out as one story (store/threads.ts), which preflightScene does not judge frame by frame.

let measure: MeasureText | null | undefined;
function measurer(): MeasureText | undefined {
  if (measure === undefined) {
    // No 2D canvas (a test environment): the text-fit check is skipped, the rest still runs.
    try { measure = canvasMeasure(() => document.createElement("canvas")); } catch { measure = null; }
  }
  return measure ?? undefined;
}

function pageOf(scene: SceneState, n: NodeLite): string | undefined {
  const pages = new Set(scene.pages.map((p) => p.id));
  for (let c: NodeLite | undefined = n, g = 0; c && g < 64; c = scene.nodes.get(c.parentId), g++) if (pages.has(c.parentId)) return c.parentId;
  return undefined;
}

export function liveIssues(scene: SceneState): PreflightIssue[] {
  const out = preflightScene(scene, {}, measurer());
  for (const n of scene.nodes.values()) {
    if (!n.overset || !n.visible || n.fromMaster) continue;
    out.push({ severity: "warning", code: "overset-story", nodeId: n.id, pageId: pageOf(scene, n), message: `The story ending in "${n.name}" has more text than its frames hold.` });
  }
  return out;
}

/** The live issues of the open document, recomputed shortly after edits settle (measuring every text is not free). */
export function usePreflight(): PreflightIssue[] {
  const scene = useScene((s) => s.scene);
  const [issues, setIssues] = useState<PreflightIssue[]>(() => (scene ? liveIssues(scene) : []));
  useEffect(() => {
    if (!scene) { setIssues([]); return; }
    const t = setTimeout(() => setIssues(liveIssues(scene)), 300);
    return () => clearTimeout(t);
  }, [scene]);
  return issues;
}
