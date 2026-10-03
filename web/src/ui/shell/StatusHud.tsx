import { useScene } from "../../store/store";
import { RendererToggle } from "../RendererToggle";
import { Icon } from "../ds";

// L'HUD in basso a destra della tela: zoom e stato della connessione. Piccolo,
// tenue, sempre nello stesso posto -- si guarda quando serve, non chiede
// attenzione. (Il renderer CPU/GPU vive qui perché è uno stato della TELA.)
export function StatusHud({ statusLabel, connection }: { statusLabel: string; connection: string }) {
  const zoom = useScene((s) => s.camera.zoom);
  const dot =
    connection === "connected" ? "bg-ok" : connection === "reconnecting" || connection === "connecting" ? "bg-warn" : "bg-danger";
  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-20 flex items-center gap-2">
      <div className="pointer-events-auto flex items-center gap-2 rounded-lg bg-raised px-2 py-1 text-[12px] text-fg-muted shadow-bar">
        <span className="flex items-center gap-1.5" aria-live="polite">
          <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
          {statusLabel}
        </span>
        <span className="h-3 w-px bg-line" />
        <span title="Zoom" className="flex items-center gap-1 tabular-nums">
          <Icon name="search" size={12} />
          {Math.round(zoom * 100)}%
        </span>
        <span className="h-3 w-px bg-line" />
        <RendererToggle />
      </div>
    </div>
  );
}
