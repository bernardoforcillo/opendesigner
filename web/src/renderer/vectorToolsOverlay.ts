import { type Camera, worldToScreen } from "../canvas/camera";
import type { SceneState } from "../store/types";
import type { BuilderPreview } from "../store/store";
import { widthHandles } from "../vector/widthEdit";
import { themeColors, withAlpha } from "./themeColors";

// The overlays of the two vector tools of docs/vector.md: the Variable width tool's handles and the Shape
// builder's tinted regions. Drawn above everything else while the tool is active; geometry is read from
// the node or the preview, never stored here.

const devicePixelRatioOf = () => (typeof devicePixelRatio === "number" ? devicePixelRatio : 1);

/**
 * The Variable width tool's view of the selected vector: both handles of every width point (the selected
 * point's filled), the two joined by a line across the path.
 */
export function drawWidthEdit(
  ctx: CanvasRenderingContext2D, state: SceneState, cam: Camera, selection: readonly string[], sel: number | null,
): void {
  if (selection.length !== 1) return;
  const n = state.nodes.get(selection[0]);
  if (!n || n.kind !== "vector" || !n.vector || n.rotation % 360 !== 0) return;
  const handles = widthHandles(n);
  if (handles.length === 0) return;
  const dpr = devicePixelRatioOf();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const { accent } = themeColors();
  const at = (x: number, y: number) => worldToScreen(cam, n.x + x, n.y + y);
  ctx.lineWidth = 1;
  ctx.strokeStyle = accent;
  for (const h of handles) {
    const p = at(h.x, h.y);
    const other = h.side === "left" ? handles.find((q) => q.sub === h.sub && q.index === h.index && q.side === "right") : undefined;
    if (other) {
      const o = at(other.x, other.y);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(o.x, o.y);
      ctx.stroke();
    }
    ctx.fillStyle = sel !== null && h.index === sel ? accent : "#ffffff";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

/** The Shape builder's preview: the faces under the pointer or the drag, tinted (red when Alt will remove them). */
export function drawBuilderPreview(ctx: CanvasRenderingContext2D, cam: Camera, preview: BuilderPreview): void {
  const dpr = devicePixelRatioOf();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const color = preview.mode === "remove" ? "#e5484d" : themeColors().accent;
  ctx.fillStyle = withAlpha(color, 0.35);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  for (const polygon of preview.faces) {
    ctx.beginPath();
    for (const ring of polygon) {
      ring.forEach(([x, y], i) => {
        const p = worldToScreen(cam, x, y);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
    }
    ctx.fill("evenodd");
    ctx.stroke();
  }
}
