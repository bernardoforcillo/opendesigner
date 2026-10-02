import { create } from "zustand";

// Qual è il renderer della scena. È una PREFERENZA dell'utente e uno stato di
// vista: non è documento e non passa dagli op, quindi sta in uno store a parte
// (come la presenza).
//
//  - "cpu": Canvas 2D (renderer/canvasRenderer.ts). Il predefinito: usa i font del
//    sistema e non scarica niente.
//  - "gpu": CanvasKit su WebGL (renderer/ck). Si carica a richiesta (~7 MB di
//    WebAssembly) e disegna il testo con Inter.
//
// `status` dice cosa sta DAVVERO disegnando, che può differire dalla scelta: la
// GPU si sta ancora caricando ("loading") o ha fallito ("error", e si disegna in
// CPU). `frameMs` è il tempo dell'ultimo disegno, per confrontare i due sulla
// propria macchina -- è l'unico modo onesto di sapere quale è più veloce lì.
export type RendererChoice = "cpu" | "gpu";
export type RendererStatus = "cpu" | "loading" | "gpu" | "error";

const KEY = "opendesigner.renderer";

export function loadRendererChoice(): RendererChoice {
  try {
    const q = new URLSearchParams(location.search).get("renderer");
    if (q === "gpu" || q === "cpu") return q;
    const saved = localStorage.getItem(KEY);
    if (saved === "gpu" || saved === "cpu") return saved;
  } catch { /* storage non disponibile: predefinito */ }
  return "cpu";
}

function save(c: RendererChoice): void {
  try { localStorage.setItem(KEY, c); } catch { /* idem */ }
}

interface RendererStore {
  choice: RendererChoice;
  status: RendererStatus;
  error: string | null;
  frameMs: number | null;
  setChoice: (c: RendererChoice) => void;
  setStatus: (s: RendererStatus, error?: string | null) => void;
  setFrameMs: (ms: number) => void;
}

export const useRenderer = create<RendererStore>((set) => ({
  choice: loadRendererChoice(),
  status: "cpu",
  error: null,
  frameMs: null,
  setChoice: (c) => {
    save(c);
    set({ choice: c, error: null, status: c === "gpu" ? "loading" : "cpu", frameMs: null });
  },
  setStatus: (status, error = null) => set({ status, error }),
  setFrameMs: (frameMs) => set({ frameMs }),
}));
