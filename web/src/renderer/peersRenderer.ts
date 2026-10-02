import type { Camera } from "../canvas/camera";
import { worldToScreen } from "../canvas/camera";
import { worldBoundsToScreen } from "../canvas/geometry";
import type { SceneState } from "../store/types";
import { peerColor, type Peers } from "../store/presence";
import { selectionWorldBounds } from "./overlayRenderer";

const LABEL_FONT = "600 11px system-ui, sans-serif";
const LABEL_PAD_X = 6;
const LABEL_H = 16;

// Il puntatore (la classica freccia) con la punta in (0,0): scalato dal
// chiamante solo dal dpr, mai dallo zoom -- un cursore ha la stessa taglia a
// qualunque ingrandimento, come le maniglie.
const ARROW: readonly [number, number][] = [[0, 0], [0, 15], [4, 11.5], [7.5, 18], [10, 17], [6.7, 10.5], [11.5, 10.5]];

/**
 * Disegna gli altri utenti sopra l'overlay: il riquadro dei loro nodi
 * selezionati, il loro cursore e il loro nickname. Va chiamata DOPO
 * drawOverlay, che azzera il canvas.
 *
 * Si vedono solo i peer sulla stessa pagina: il loro cursore sta in
 * coordinate di una pagina che chi guarda non sta mostrando. Un peer senza
 * pageId (non ha ancora detto niente) conta come "stessa pagina", per non
 * sparire nel primo istante.
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
  // Stessa regola della vista: senza pagina corrente si mostra la prima.
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

    const w = ctx.measureText(p.nickname).width + LABEL_PAD_X * 2;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(12, 18, w, LABEL_H, 4);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(p.nickname, 12 + LABEL_PAD_X, 18 + LABEL_H / 2);
    ctx.restore();
  }
}
