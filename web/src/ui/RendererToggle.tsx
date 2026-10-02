import { useRenderer } from "../store/rendererChoice";

/**
 * Sceglie il renderer della scena: CPU (Canvas 2D) o GPU (CanvasKit su WebGL).
 * Mostra anche quanto è durato l'ultimo frame, perché la risposta a "quale è più
 * veloce" dipende dalla macchina e l'unico modo onesto di darla è misurarla lì.
 */
export function RendererToggle() {
  const choice = useRenderer((s) => s.choice);
  const status = useRenderer((s) => s.status);
  const error = useRenderer((s) => s.error);
  const frameMs = useRenderer((s) => s.frameMs);
  const setChoice = useRenderer((s) => s.setChoice);

  const next = choice === "gpu" ? "cpu" : "gpu";
  const label =
    status === "loading" ? "GPU…"
    : status === "error" ? "GPU ✕"
    : choice === "gpu" ? "GPU" : "CPU";
  const title =
    status === "error" ? `La GPU non è disponibile (${error}). Si disegna in CPU. Clic per riprovare.`
    : status === "loading" ? "Caricamento di CanvasKit…"
    : choice === "gpu"
      ? "Renderer GPU (CanvasKit, WebGL). Clic per passare alla CPU."
      : "Renderer CPU (Canvas 2D). Clic per provare la GPU (CanvasKit, WebGL): si scarica ~7 MB la prima volta.";

  return (
    <button
      type="button"
      title={title}
      aria-label={`Renderer: ${label}. Passa a ${next === "gpu" ? "GPU" : "CPU"}`}
      onClick={() => setChoice(next)}
      className="rounded border border-neutral-200 px-2 py-0.5 text-xs text-neutral-600 hover:bg-neutral-50"
    >
      {label}
      {frameMs !== null && status !== "loading" && (
        <span className="ml-1 tabular-nums text-neutral-400">{frameMs.toFixed(1)} ms</span>
      )}
    </button>
  );
}
