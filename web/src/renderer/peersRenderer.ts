import type { Camera } from "../canvas/camera";
import { worldToScreen } from "../canvas/camera";
import { type Bounds, worldBoundsToScreen } from "../canvas/geometry";
import type { SceneState } from "../store/types";
import { peerColor, type Peers } from "../store/presence";
import { selectionWorldBounds } from "./overlayRenderer";
import { themeColors, withAlpha } from "./themeColors";

const LABEL_FONT = "600 11px Inter, system-ui, sans-serif";
const LABEL_PAD_X = 6;
const LABEL_H = 16;

// The pointer (the classic arrow) with its tip at (0,0): scaled by the
// caller only by dpr, never by zoom -- a cursor has the same size at
// any magnification, like the handles.
const ARROW: readonly [number, number][] = [[0, 0], [0, 15], [4, 11.5], [7.5, 18], [10, 17], [6.7, 10.5], [11.5, 10.5]];

// A name tag: colored pill with white text, with the top-left
// corner at (x, y).
function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): void {
  const w = ctx.measureText(text).width + LABEL_PAD_X * 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, w, LABEL_H, 4);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + LABEL_PAD_X, y + LABEL_H / 2);
}

/**
 * Draws the other users above the overlay: the box of their selected
 * nodes, their cursor and their nickname. Must be called AFTER
 * drawOverlay, which clears the canvas.
 *
 * Only peers on the same page are seen: their cursor is in the
 * coordinates of a page that the viewer is not showing. A peer without
 * pageId (has not said anything yet) counts as "same page", so as not to
 * vanish in the first instant.
 */
export function drawPeers(
  ctx: CanvasRenderingContext2D,
  scene: SceneState,
  cam: Camera,
  peers: Peers,
  currentPageId: string | null,
): void {
  const dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = LABEL_FONT;
  // Same rule as the view: without a current page the first is shown.
  const here = currentPageId ?? scene.pages[0]?.id ?? null;
  for (const p of Object.values(peers)) {
    if (p.pageId !== "" && here !== null && p.pageId !== here) continue;
    const color = peerColor(p.clientId);

    const sel = selectionWorldBounds(scene, p.selection);
    if (sel) {
      const box = worldBoundsToScreen(sel, cam);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color;
      ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.width, box.height);
      // Whoever has no cursor (the MCP agent, or whoever has the mouse outside the
      // canvas) is recognized by the name above their box: otherwise it
      // would be an anonymous outline.
      if (!p.hasCursor) drawLabel(ctx, p.nickname, box.x, box.y - LABEL_H - 2, color);
    }

    if (!p.hasCursor) continue;
    const at = worldToScreen(cam, p.cursorX, p.cursorY);
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.beginPath();
    ARROW.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();

    drawLabel(ctx, p.nickname, 12, 18, color);
    ctx.restore();
  }
}

/**
 * The preview of a reorder in an auto layout: the insertion line and the
 * dashed outline of the node following the pointer. Must be called AFTER
 * drawOverlay (which clears the canvas); the line's thickness is in screen
 * pixels, like the handles, and does not grow with the zoom.
 */
export function drawLayoutDrop(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  drop: { indicator: Bounds; ghost: Bounds | null },
): void {
  const dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // The theme's accent blue (like the rest of the selection overlay).
  const DROP_COLOR = themeColors().accent;
  if (drop.ghost) {
    const g = worldBoundsToScreen(drop.ghost, cam);
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = DROP_COLOR;
    ctx.fillStyle = withAlpha(DROP_COLOR, 0.08);
    ctx.fillRect(g.x, g.y, g.width, g.height);
    ctx.strokeRect(g.x + 0.5, g.y + 0.5, g.width, g.height);
    ctx.restore();
  }
  const b = worldBoundsToScreen(drop.indicator, cam);
  // The line is thin along ONE axis: it is thickened to 2 screen px, centered.
  const thin = b.width < b.height;
  ctx.fillStyle = DROP_COLOR;
  if (thin) ctx.fillRect(b.x + b.width / 2 - 1, b.y, 2, b.height);
  else ctx.fillRect(b.x, b.y + b.height / 2 - 1, b.width, 2);
}
