import type { Camera } from "../canvas/camera";
import { worldToScreen } from "../canvas/camera";
import type { Pin } from "../comments/pins";
import { themeColors } from "./themeColors";

// THE COMMENT PINS on the overlay: a numbered bubble whose tip is the commented point.
// Editor-only, never exported. Sizes are screen px and do not scale with the zoom.
export const PIN_RADIUS = 11;

export function drawCommentPins(
  ctx: CanvasRenderingContext2D,
  pins: readonly Pin[],
  cam: Camera,
  activeId: string | null,
  draft: { x: number; y: number } | null,
): void {
  const { accent } = themeColors();
  const bubble = (sx: number, sy: number, fill: string, label: string, active: boolean) => {
    const cy = sy - PIN_RADIUS - 2;
    ctx.beginPath();
    // A circle with its lower-left corner pulled down to the tip.
    ctx.arc(sx, cy, PIN_RADIUS, 0, Math.PI * 2);
    ctx.moveTo(sx - PIN_RADIUS * 0.7, cy + PIN_RADIUS * 0.7);
    ctx.lineTo(sx, sy);
    ctx.lineTo(sx + PIN_RADIUS * 0.7, cy + PIN_RADIUS * 0.7);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = active ? 3 : 2;
    ctx.strokeStyle = active ? "#ffffff" : "rgba(255,255,255,0.9)";
    ctx.stroke();
    if (label !== "") {
      ctx.fillStyle = "#ffffff";
      ctx.font = "600 11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, sx, cy + 0.5);
    }
  };
  for (const p of pins) {
    const s = worldToScreen(cam, p.x, p.y);
    bubble(s.x, s.y, p.resolved ? "#8b8f98" : accent, String(p.number), p.threadId === activeId);
  }
  if (draft) {
    const s = worldToScreen(cam, draft.x, draft.y);
    bubble(s.x, s.y, accent, "+", true);
  }
}
