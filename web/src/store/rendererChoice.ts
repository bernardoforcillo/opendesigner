import { create } from "zustand";

// Which renderer draws the scene. It is a USER PREFERENCE and a view state:
// it is not document, and does not go through ops, so it lives in a separate store
// (like presence).
//
//  - "cpu": Canvas 2D (renderer/canvasRenderer.ts). The default: it uses system
//    fonts and downloads nothing.
//  - "gpu": CanvasKit on WebGL (renderer/ck). Loaded on demand (~7 MB of
//    WebAssembly) and draws text with Inter.
//
// `status` says what is ACTUALLY drawing, which may differ from the choice: the
// GPU is still loading ("loading") or has failed ("error", and drawing falls back to
// CPU). `frameMs` is the time of the last draw, to compare the two on
// your own machine -- it is the only honest way to know which is faster there.
export type RendererChoice = "cpu" | "gpu";
export type RendererStatus = "cpu" | "loading" | "gpu" | "error";

const KEY = "opendesigner.renderer";

export function loadRendererChoice(): RendererChoice {
  try {
    const q = new URLSearchParams(location.search).get("renderer");
    if (q === "gpu" || q === "cpu") return q;
    const saved = localStorage.getItem(KEY);
    if (saved === "gpu" || saved === "cpu") return saved;
  } catch { /* storage unavailable: default */ }
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
