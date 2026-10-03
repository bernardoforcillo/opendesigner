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

// Il puntatore (la classica freccia) con la punta in (0,0): scalato dal
// chiamante solo dal dpr, mai dallo zoom -- un cursore ha la stessa taglia a
// qualunque ingrandimento, come le maniglie.
const ARROW: readonly [number, number][] = [[0, 0], [0, 15], [4, 11.5], [7.5, 18], [10, 17], [6.7, 10.5], [11.5, 10.5]];

// Una targhetta col nome: pillola colorata con testo bianco, con l'angolo in
// alto a sinistra in (x, y).
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
      // Chi non ha un cursore (l'agente MCP, o chi ha il mouse fuori dal
      // canvas) si riconosce dal nome sopra il suo riquadro: altrimenti
      // sarebbe un contorno anonimo.
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
 * L'anteprima di un riordino in un auto layout: la linea d'inserimento e il
 * contorno tratteggiato del nodo che segue il puntatore. Va chiamata DOPO
 * drawOverlay (che azzera il canvas); lo spessore della linea è in pixel
 * schermo, come le maniglie, e non cresce con lo zoom.
 */
export function drawLayoutDrop(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  drop: { indicator: Bounds; ghost: Bounds | null },
): void {
  const dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Il blu d'accento del tema (come il resto dell'overlay di selezione).
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
  // La linea è sottile lungo UN asse: la si ingrossa a 2px schermo, centrata.
  const thin = b.width < b.height;
  ctx.fillStyle = DROP_COLOR;
  if (thin) ctx.fillRect(b.x + b.width / 2 - 1, b.y, 2, b.height);
  else ctx.fillRect(b.x, b.y + b.height / 2 - 1, b.width, 2);
}
