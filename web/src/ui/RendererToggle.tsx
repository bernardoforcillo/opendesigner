import { useRenderer } from "../store/rendererChoice";
import { Icon } from "./ds";

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

  // Un chip minuscolo: icona (CPU/bolt), testo CPU/GPU e, tenue, i ms dell'ultimo
  // frame. GPU attiva = accento; in errore = avviso; caricamento = tenue.
  const tone =
    status === "error" ? "bg-warn-soft text-warn"
    : status === "loading" ? "bg-surface-3 text-fg-subtle"
    : choice === "gpu" ? "bg-accent-soft text-accent"
    : "bg-surface-3 text-fg-muted hover:text-fg";
  return (
    <button
      type="button"
      title={title}
      aria-label={`Renderer: ${label}. Passa a ${next === "gpu" ? "GPU" : "CPU"}`}
      onClick={() => setChoice(next)}
      className={`inline-flex h-5 items-center gap-1 rounded-full px-1.5 text-[11px] font-semibold outline-none transition-colors focus-visible:shadow-[var(--ring)] ${tone}`}
    >
      <Icon name={choice === "gpu" ? "bolt" : "cpu"} size={11} />
      {label}
      {frameMs !== null && status !== "loading" && (
        <span className="font-medium tabular-nums opacity-70">{frameMs.toFixed(1)} ms</span>
      )}
    </button>
  );
}
