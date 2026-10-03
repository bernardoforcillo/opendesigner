import { worldToScreen, type Camera } from "../canvas/camera";
import { worldBoundsToScreen, type Bounds } from "../canvas/geometry";
import { worldBoundsOfNode } from "../canvas/transform";
import type { NodeLite, SceneState } from "../store/types";
import type { ConnectPreview } from "../store/flowUi";
import { arrowFromRectToPoint, arrowhead, type Bezier, type Pt } from "../flow/geometry";
import { arrowsInView, flowLayout, type Arrow } from "../flow/layout";
import { kindOf, metaValue, META_KEYS, statusOf, type FlowKind } from "../flow/meta";
import { topLevelScreens } from "../flow/screens";
import { themeColors, withAlpha, type ThemeColors } from "./themeColors";

// L'OVERLAY DELLA MODALITÀ FLUSSI: frecce fra le schermate, pillole delle
// etichette, marcatore d'ingresso, badge di tipo/stato su ogni schermata e il
// rubber band di "Collega". Si disegna SOPRA l'overlay di selezione (come
// drawPeers: va chiamata dopo drawOverlay, che azzera il canvas) e in spazio
// SCHERMO: lo spessore delle linee, le punte e le pillole restano della stessa
// taglia a ogni zoom, solo le posizioni seguono la camera.
//
// La geometria vive in flow/geometry.ts + flow/layout.ts (pure, memoizzate sulla
// scena): qui si traduce soltanto in tratti di canvas. A editor fermo il
// renderer non gira (App.tsx ridisegna a invalidazione), e il layout non si
// ricalcola finché nodi e transizioni non cambiano.

export interface FlowOverlayState {
  /** Il flusso corrente (effettivo), o null se il documento non ne ha. */
  flowId: string | null;
  /** L'ingresso del flusso corrente. */
  startId: string;
  showAllFlows: boolean;
  selectedTransitionId: string | null;
  hoverTransitionId: string | null;
  connectPreview: ConnectPreview | null;
  issueNodeIds: ReadonlySet<string>;
  issueTransitionIds: ReadonlySet<string>;
}

// I COLORI vengono dai token (renderer/themeColors.ts), non da qui: il viola dei
// flussi (--flow) è distinto dal blu della selezione (--accent), così la freccia
// scelta (blu) si legge a colpo d'occhio fra le altre; i problemi sono in
// --danger, l'ingresso in --ok. Si leggono UNA volta per frame in drawFlows e si
// passano giù (`c`), così un frame è coerente anche se il tema cambia a metà.
const DIM_ALPHA = 0.3;

const LABEL_FONT = "600 11px Inter, system-ui, sans-serif";
const BADGE_FONT = "600 11px Inter, system-ui, sans-serif";
const ROUTE_FONT = "500 10px ui-monospace, SFMono-Regular, Menlo, monospace";
const PILL_H = 18;
const PILL_PAD = 7;
const HEAD_SIZE = 10;
// Sotto questo zoom le etichette sono illeggibili: restano frecce e badge.
const LABEL_MIN_ZOOM = 0.2;
const BADGE_MIN_ZOOM = 0.08;

function dprOf(): number {
  return typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

function toScreen(cam: Camera, c: Bezier): Bezier {
  return {
    p0: worldToScreen(cam, c.p0.x, c.p0.y),
    c1: worldToScreen(cam, c.c1.x, c.c1.y),
    c2: worldToScreen(cam, c.c2.x, c.c2.y),
    p3: worldToScreen(cam, c.p3.x, c.p3.y),
  };
}

function strokeCurve(ctx: CanvasRenderingContext2D, c: Bezier): void {
  ctx.beginPath();
  ctx.moveTo(c.p0.x, c.p0.y);
  ctx.bezierCurveTo(c.c1.x, c.c1.y, c.c2.x, c.c2.y, c.p3.x, c.p3.y);
  ctx.stroke();
}

function fillHead(ctx: CanvasRenderingContext2D, c: Bezier, size: number): void {
  const [a, b, d] = arrowhead(c, size);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(d.x, d.y);
  ctx.closePath();
  ctx.fill();
}

// Un'ombra morbida e corta: stacca la pillola dalla tela senza un bordo duro. Si
// accende SOLO attorno al riempimento (poi si spegne): lo shadow di canvas costa
// e il testo non deve proiettarne una.
function softShadow(ctx: CanvasRenderingContext2D, dark: boolean): void {
  ctx.shadowColor = dark ? "rgba(0, 0, 0, 0.55)" : "rgba(16, 24, 40, 0.18)";
  ctx.shadowBlur = 6;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 1;
}
function noShadow(ctx: CanvasRenderingContext2D): void {
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

function pill(ctx: CanvasRenderingContext2D, c: ThemeColors, text: string, cx: number, cy: number, fg: string, border: string): void {
  const w = ctx.measureText(text).width + PILL_PAD * 2;
  const x = cx - w / 2;
  const y = cy - PILL_H / 2;
  ctx.beginPath();
  ctx.roundRect(x, y, w, PILL_H, PILL_H / 2);
  ctx.fillStyle = c.surface;
  softShadow(ctx, c.dark);
  ctx.fill();
  noShadow(ctx);
  ctx.lineWidth = 1;
  ctx.strokeStyle = border;
  ctx.stroke();
  ctx.fillStyle = fg;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillText(text, cx, cy + 0.5);
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}

/** Il pittogramma del tipo di nodo, centrato in (cx, cy), raggio r. Solo tratti, nessuna immagine. */
export function drawKindIcon(ctx: CanvasRenderingContext2D, kind: FlowKind, cx: number, cy: number, r: number, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  switch (kind) {
    case "screen": // un telefono: rettangolo verticale
      ctx.roundRect(cx - r * 0.65, cy - r, r * 1.3, r * 2, 2);
      ctx.stroke();
      break;
    case "decision": // un rombo
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      ctx.stroke();
      break;
    case "action": // un fulmine stilizzato
      ctx.moveTo(cx + r * 0.3, cy - r);
      ctx.lineTo(cx - r * 0.6, cy + r * 0.15);
      ctx.lineTo(cx, cy + r * 0.15);
      ctx.lineTo(cx - r * 0.3, cy + r);
      ctx.lineTo(cx + r * 0.6, cy - r * 0.15);
      ctx.lineTo(cx, cy - r * 0.15);
      ctx.closePath();
      ctx.fill();
      break;
    case "start": // un cerchio pieno
      ctx.arc(cx, cy, r * 0.85, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "end": // un cerchio dentro un cerchio
      ctx.arc(cx, cy, r * 0.95, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.45, 0, Math.PI * 2);
      ctx.fill();
      break;
    case "note": // un foglio con l'angolo piegato
      ctx.moveTo(cx - r * 0.8, cy - r);
      ctx.lineTo(cx + r * 0.3, cy - r);
      ctx.lineTo(cx + r * 0.8, cy - r * 0.45);
      ctx.lineTo(cx + r * 0.8, cy + r);
      ctx.lineTo(cx - r * 0.8, cy + r);
      ctx.closePath();
      ctx.stroke();
      break;
  }
  ctx.restore();
}

function drawArrow(ctx: CanvasRenderingContext2D, c0: ThemeColors, a: Arrow, cam: Camera, color: string, width: number, alpha: number, labels: boolean): void {
  const c = toScreen(cam, a.curve);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  // Tratteggiata se ha una guardia: non percorribile sempre.
  ctx.setLineDash(a.guarded ? [6, 4] : []);
  strokeCurve(ctx, c);
  ctx.setLineDash([]);
  fillHead(ctx, c, HEAD_SIZE + (width > 2 ? 2 : 0));
  // L'origine: un pallino (sull'elemento hotspot è il "punto cliccabile").
  ctx.beginPath();
  ctx.arc(c.p0.x, c.p0.y, a.hotspot ? 4 : 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  if (labels && a.label !== "") {
    ctx.save();
    ctx.globalAlpha = alpha < 1 ? 0.7 : 1;
    ctx.font = LABEL_FONT;
    const m = worldToScreen(cam, a.mid.x, a.mid.y);
    pill(ctx, c0, truncate(ctx, a.label, 140), m.x, m.y, color, withAlpha(color, 0.4));
    ctx.restore();
  }
}

function drawHotspot(ctx: CanvasRenderingContext2D, b: Bounds, cam: Camera, color: string): void {
  const r = worldBoundsToScreen(b, cam);
  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.12;
  ctx.fillRect(r.x, r.y, r.width, r.height);
  ctx.globalAlpha = 1;
  ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.width, r.height);
  ctx.restore();
}

/** Il badge sopra una schermata: tipo, stato, nome (e route se c'è spazio). */
function drawScreenBadge(
  ctx: CanvasRenderingContext2D, c: ThemeColors, scene: SceneState, n: NodeLite, cam: Camera, issue: boolean, isStart: boolean,
): void {
  const box = worldBoundsToScreen(worldBoundsOfNode(scene, n), cam);
  const kind = kindOf(n);
  const status = statusOf(n);
  const route = metaValue(n, META_KEYS.route);
  const y = box.y - PILL_H / 2 - 5;
  const maxW = Math.max(60, box.width - 8);
  ctx.font = BADGE_FONT;
  const name = cam.zoom >= 0.18 ? truncate(ctx, n.name.trim() !== "" ? n.name : "Senza nome", Math.max(30, maxW - 44)) : "";
  const nameW = name === "" ? 0 : ctx.measureText(name).width + 5;
  const w = 8 + 12 + 6 + 8 + (name ? 6 + nameW : 0) + 8;
  const x = box.x;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y - PILL_H / 2, w, PILL_H, PILL_H / 2);
  // Una pillola RIALZATA: superficie del tema, filo e ombra morbida.
  ctx.fillStyle = c.surface;
  softShadow(ctx, c.dark);
  ctx.fill();
  noShadow(ctx);
  ctx.lineWidth = issue ? 1.5 : 1;
  ctx.strokeStyle = issue ? c.danger : isStart ? c.ok : c.lineStrong;
  ctx.stroke();
  drawKindIcon(ctx, kind, x + 8 + 6, y, 5, issue ? c.danger : c.fgMuted);
  // Il pallino di stato: tenue pianificata / accento implementata / verde testata.
  ctx.beginPath();
  ctx.arc(x + 8 + 12 + 6 + 4, y, 4, 0, Math.PI * 2);
  ctx.fillStyle = status === "tested" ? c.ok : status === "implemented" ? c.accent : c.fgSubtle;
  ctx.fill();
  if (name) {
    ctx.fillStyle = c.fg;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(name, x + 8 + 12 + 6 + 8 + 6, y + 0.5);
  }
  if (route && cam.zoom >= 0.35 && box.width > 160) {
    ctx.font = ROUTE_FONT;
    ctx.fillStyle = c.fgSubtle;
    ctx.textAlign = "left";
    ctx.fillText(truncate(ctx, route, Math.max(0, maxW - w - 8)), x + w + 6, y + 0.5);
  }
  ctx.restore();
  if (issue) {
    // Un contorno rosso sottile attorno alla schermata con un problema.
    ctx.save();
    ctx.setLineDash([5, 3]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = c.danger;
    ctx.strokeRect(box.x - 3 + 0.5, box.y - 3 + 0.5, box.width + 6, box.height + 6);
    ctx.restore();
  }
}

/** Il marcatore d'ingresso: una bandierina verde sul bordo sinistro della schermata. */
function drawStartMarker(ctx: CanvasRenderingContext2D, c: ThemeColors, box: Bounds): void {
  const cx = box.x - 22;
  const cy = box.y + Math.min(box.height / 2, 60);
  ctx.save();
  ctx.strokeStyle = c.ok;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx + 9, cy);
  ctx.lineTo(box.x, cy);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 10, 0, Math.PI * 2);
  ctx.fillStyle = c.ok;
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(cx - 3, cy - 5);
  ctx.lineTo(cx + 5, cy);
  ctx.lineTo(cx - 3, cy + 5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawPreview(ctx: CanvasRenderingContext2D, c: ThemeColors, scene: SceneState, cam: Camera, p: ConnectPreview): void {
  const from = scene.nodes.at(p.fromScreenId);
  if (from) {
    const fb = worldBoundsToScreen(worldBoundsOfNode(scene, from), cam);
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = c.accent;
    ctx.strokeRect(fb.x + 1, fb.y + 1, fb.width - 2, fb.height - 2);
    ctx.restore();
  }
  if (p.elementId !== "") drawHotspot(ctx, p.fromBounds, cam, c.accent);
  if (p.targetId !== null) {
    const t = scene.nodes.at(p.targetId);
    if (t) {
      const tb = worldBoundsToScreen(worldBoundsOfNode(scene, t), cam);
      ctx.save();
      ctx.fillStyle = c.accent;
      ctx.globalAlpha = 0.1;
      ctx.fillRect(tb.x, tb.y, tb.width, tb.height);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = c.accent;
      ctx.strokeRect(tb.x + 1, tb.y + 1, tb.width - 2, tb.height - 2);
      ctx.restore();
    }
  }
  const curve = toScreen(cam, arrowFromRectToPoint(p.fromBounds, { x: p.x, y: p.y } as Pt));
  ctx.save();
  ctx.strokeStyle = c.accent;
  ctx.fillStyle = c.accent;
  ctx.lineWidth = 2;
  ctx.setLineDash([7, 5]);
  strokeCurve(ctx, curve);
  ctx.setLineDash([]);
  fillHead(ctx, curve, HEAD_SIZE);
  ctx.beginPath();
  ctx.arc(curve.p0.x, curve.p0.y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Disegna la modalità Flussi. Va chiamata DOPO drawOverlay (che azzera il
 * canvas). Salta tutto ciò che sta fuori vista (documenti grandi): per le frecce
 * si confronta il rettangolo dei punti di controllo con la vista, per le
 * schermate il loro box.
 */
export function drawFlows(
  ctx: CanvasRenderingContext2D,
  scene: SceneState,
  cam: Camera,
  ui: FlowOverlayState,
  currentPageId: string | null,
): void {
  const dpr = dprOf();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const c = themeColors();
  const cssW = ctx.canvas.width / dpr;
  const cssH = ctx.canvas.height / dpr;
  const px = 1 / (cam.zoom || 1);
  // La vista in mondo, allargata di quanto sporgono pillole e punte (px schermo).
  const view: Bounds = { x: -cam.x / cam.zoom, y: -cam.y / cam.zoom, width: cssW / cam.zoom, height: cssH / cam.zoom };
  const pad = 80 * px;

  const showBadges = cam.zoom >= BADGE_MIN_ZOOM;
  if (showBadges) {
    ctx.font = BADGE_FONT;
    for (const s of topLevelScreens(scene, currentPageId)) {
      const wb = worldBoundsOfNode(scene, s);
      if (
        wb.x > view.x + view.width + pad || wb.x + wb.width < view.x - pad ||
        wb.y > view.y + view.height + pad || wb.y + wb.height < view.y - pad
      ) continue;
      const isStart = ui.startId === s.id;
      // Un filo attorno alla schermata: un frame bianco su tela bianca sparirebbe,
      // e in Flussi le schermate sono i protagonisti.
      const sb = worldBoundsToScreen(wb, cam);
      ctx.lineWidth = 1;
      ctx.strokeStyle = withAlpha(c.flow, c.dark ? 0.5 : 0.4);
      ctx.strokeRect(sb.x + 0.5, sb.y + 0.5, sb.width, sb.height);
      drawScreenBadge(ctx, c, scene, s, cam, ui.issueNodeIds.has(s.id), isStart);
      if (isStart) drawStartMarker(ctx, c, worldBoundsToScreen(wb, cam));
    }
  }

  const layout = flowLayout(scene);
  if (layout.arrows.length > 0) {
    const visible = arrowsInView(layout, view, pad);
    const labels = cam.zoom >= LABEL_MIN_ZOOM;
    // Prima gli altri flussi (attenuati, se richiesti), poi il corrente, in
    // cima la freccia selezionata/sotto il mouse.
    if (ui.showAllFlows) {
      for (const a of visible) if (a.flowId !== ui.flowId) drawArrow(ctx, c, a, cam, c.flow, 1.5, DIM_ALPHA, false);
    }
    let top: Arrow | null = null;
    let hover: Arrow | null = null;
    for (const a of visible) {
      if (a.flowId !== ui.flowId) continue;
      if (a.id === ui.selectedTransitionId) { top = a; continue; }
      if (a.id === ui.hoverTransitionId) { hover = a; continue; }
      const issue = ui.issueTransitionIds.has(a.id);
      if (a.hotspot) drawHotspot(ctx, a.hotspot, cam, issue ? c.danger : c.flow);
      drawArrow(ctx, c, a, cam, issue ? c.danger : c.flow, 2, 1, labels);
    }
    if (hover) {
      if (hover.hotspot) drawHotspot(ctx, hover.hotspot, cam, c.flow);
      drawArrow(ctx, c, hover, cam, c.flow, 3, 1, labels);
    }
    if (top) {
      if (top.hotspot) drawHotspot(ctx, top.hotspot, cam, c.accent);
      drawArrow(ctx, c, top, cam, c.accent, 3, 1, labels || top.label !== "");
    }
  }

  if (ui.connectPreview) drawPreview(ctx, c, scene, cam, ui.connectPreview);
}
