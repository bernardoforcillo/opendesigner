import { useScene } from "../store/store";

// "HAI GIA' PROVATO IL PROTOTIPO?" -- un'abitudine dell'utente, non documento:
// vive nel localStorage (per documento) e alimenta il passo "Prova" della
// pipeline (dev/pipeline.ts). Senza storage (modalità privata, test) risponde
// semplicemente "no": la pipeline funziona lo stesso, senza il tick.

const key = (docId: string) => `od.presented.${docId}`;

export function hasPresented(docId: string | null | undefined): boolean {
  if (!docId) return false;
  try {
    return localStorage.getItem(key(docId)) === "1";
  } catch {
    return false;
  }
}

/** Segna il documento corrente come "prototipo provato almeno una volta". */
export function markPresented(docId: string | null | undefined = useScene.getState().scene?.id): void {
  if (!docId) return;
  try {
    localStorage.setItem(key(docId), "1");
  } catch {
    /* niente storage */
  }
}
