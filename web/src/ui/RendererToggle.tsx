import { useRenderer } from "../store/rendererChoice";
import { Icon } from "./ds";

/**
 * Chooses the scene's renderer: CPU (Canvas 2D) or GPU (CanvasKit on WebGL).
 * It also shows how long the last frame took, because the answer to "which is
 * faster" depends on the machine and the only honest way to give it is to measure it there.
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
    status === "error" ? `The GPU is not available (${error}). Drawing on the CPU. Click to retry.`
    : status === "loading" ? "Loading CanvasKit…"
    : choice === "gpu"
      ? "GPU renderer (CanvasKit, WebGL). Click to switch to the CPU."
      : "CPU renderer (Canvas 2D). Click to try the GPU (CanvasKit, WebGL): downloads ~7 MB the first time.";

  // A tiny chip: icon (CPU/bolt), CPU/GPU text and, faint, the ms of the last
  // frame. GPU active = accent; on error = warning; loading = faint.
  const tone =
    status === "error" ? "bg-warn-soft text-warn"
    : status === "loading" ? "bg-surface-3 text-fg-subtle"
    : choice === "gpu" ? "bg-accent-soft text-accent"
    : "bg-surface-3 text-fg-muted hover:text-fg";
  return (
    <button
      type="button"
      title={title}
      aria-label={`Renderer: ${label}. Switch to ${next === "gpu" ? "GPU" : "CPU"}`}
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
