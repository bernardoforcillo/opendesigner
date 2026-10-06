import { useScene } from "../store/store";

// "HAVE YOU ALREADY TRIED THE PROTOTYPE?" -- a user habit, not document:
// it lives in localStorage (per document) and feeds the "Try" step of the
// pipeline (dev/pipeline.ts). Without storage (private mode, tests) it simply
// answers "no": the pipeline works all the same, without the tick.

const key = (docId: string) => `od.presented.${docId}`;

export function hasPresented(docId: string | null | undefined): boolean {
  if (!docId) return false;
  try {
    return localStorage.getItem(key(docId)) === "1";
  } catch {
    return false;
  }
}

/** Marks the current document as "prototype tried at least once". */
export function markPresented(docId: string | null | undefined = useScene.getState().scene?.id): void {
  if (!docId) return;
  try {
    localStorage.setItem(key(docId), "1");
  } catch {
    /* no storage */
  }
}
