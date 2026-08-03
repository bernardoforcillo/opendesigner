import type { SceneState } from "../store/types";
import type { Camera } from "../canvas/camera";
import { worldToScreen } from "../canvas/camera";
import { type Bounds, boundsOfNode, unionBounds, worldBoundsToScreen } from "../canvas/geometry";
import { HANDLE_SIZE, handlePositions } from "../selection/handles";
import {
  anchorPoint,
  hasInHandle,
  hasOutHandle,
  inHandlePoint,
  outHandlePoint,
} from "../store/vectorGeometry";
import type { PenPreview, PointLite } from "../store/vectorGeometry";

// La geometria delle maniglie (posizioni, hit-test, resize) è UNA sola e vive
// in selection/handles.ts: qui si disegna soltanto. Ri-esportata perché il
// renderer resta il punto d'ingresso naturale per chi disegna l'overlay.
export { HANDLE_SIZE, handlePositions, type HandleId } from "../selection/handles";
export { worldBoundsToScreen } from "../canvas/geometry";

function devicePixelRatio(): number {
  return typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

// Il blu dell'interfaccia: bbox di selezione, maniglie, marquee e path in corso
// parlano tutti la stessa lingua. Uno solo, così non può diventarne due.
const ACCENT = "#2f6fed";

// Lato (px SCHERMO) del quadratino di un ancoraggio del PEN TOOL. Più piccolo
// delle maniglie di resize (HANDLE_SIZE = 8) di proposito: sono due bersagli
// diversi e non devono sembrare lo stesso -- l'uno ridimensiona il box, l'altro
// è un punto della geometria.
export const PEN_ANCHOR_SIZE = 6;

// Raggio di PRESA (px SCHERMO) del primo ancoraggio: quanto vicino deve cadere
// il click che CHIUDE il contorno. Più generoso del quadratino disegnato,
// esattamente come HANDLE_GRAB_PADDING lo è per le maniglie di resize (6px sono
// pochi da centrare col mouse), e in px SCHERMO perché la presa deve restare la
// stessa a ogni livello di zoom. Lo legge tools/penTool.ts: disegno e presa
// devono venire dallo stesso posto, o il bersaglio non è più quello che si
// vede.
export const PEN_ANCHOR_GRAB_PX = 6;

// Raggio (px SCHERMO) del pallino in punta a una maniglia bézier.
const PEN_HANDLE_DOT = 3;

// Il tratteggio del segmento PENDENTE (quello che segue il cursore). Tratteggio
// e non tinta piena perché quel pezzo non è ancora geometria: nessun click lo
// ha ancora posato, e disegnarlo identico al resto prometterebbe una curva che
// il documento non contiene.
const PEN_PENDING_DASH = [4, 3];

// Gli ancoraggi dell'anteprima sono già in coordinate MONDO (il nodo non esiste
// ancora, quindi non c'è nessuna origine da cui misurarli): la lettura della
// regola dei due spazi resta quella di vectorGeometry, con origine nello zero.
const PEN_ORIGIN = { x: 0, y: 0 };

// Il path che il pen tool sta disegnando, in spazio SCHERMO come tutto il resto
// dell'overlay.
//
// I quattro punti di controllo di ogni segmento si convertono UNO A UNO con
// worldToScreen e la bézier si disegna in schermo: è esatto, non
// un'approssimazione, perché la trasformazione della camera è affine (scala
// uniforme + traslazione) e le curve di Bézier sono covarianti per affinità --
// trasformare i controlli trasforma la curva. Il vantaggio è che il tratto
// resta di 1px a ogni zoom, come le maniglie di selezione.
function drawPenPreview(ctx: CanvasRenderingContext2D, cam: Camera, pen: PenPreview): void {
  const anchors = pen.anchors;
  const n = anchors.length;
  if (n === 0) return;
  const to = (p: PointLite) => worldToScreen(cam, p.x, p.y);

  ctx.lineWidth = 1;
  ctx.strokeStyle = ACCENT;

  // 1. Il contorno già posato. Un ancoraggio solo non ha segmenti: si vede il
  //    suo quadratino e basta.
  //
  //    Se l'anteprima è CHIUSA c'è un segmento in più, quello di ritorno
  //    (ultimo -> primo): stesso ciclo, indice del bersaglio modulo n --
  //    identico a renderer/shapes.ts::traceSubpath, perché è la stessa
  //    geometria e deve venire dalla stessa regola. È il segmento che il
  //    trascinamento di chiusura sta modellando (tira la maniglia ENTRANTE del
  //    primo ancoraggio, cioè il secondo punto di controllo di QUESTA curva):
  //    senza disegnarlo, di quel trascinamento si vedrebbero solo il bastoncino
  //    e il pallino, e la curva comparirebbe solo a nodo creato.
  if (n > 1) {
    const segments = pen.closed ? n : n - 1;
    ctx.beginPath();
    const start = to(anchorPoint(PEN_ORIGIN, anchors[0]));
    ctx.moveTo(start.x, start.y);
    for (let i = 1; i <= segments; i++) {
      const a = anchors[i - 1];
      const b = anchors[i % n];
      const c1 = to(outHandlePoint(PEN_ORIGIN, a));
      const c2 = to(inHandlePoint(PEN_ORIGIN, b));
      const p = to(anchorPoint(PEN_ORIGIN, b));
      ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p.x, p.y);
    }
    ctx.stroke();
  }

  // 2. Il segmento che seguirebbe il cursore. Il punto d'arrivo non ha
  //    maniglia, quindi il secondo controllo cade su di lui: è esattamente la
  //    curva che si otterrebbe posando lì un ancoraggio d'angolo, non
  //    un'approssimazione dritta.
  if (pen.next) {
    const last = anchors[n - 1];
    const a = to(anchorPoint(PEN_ORIGIN, last));
    const c1 = to(outHandlePoint(PEN_ORIGIN, last));
    const end = to(pen.next);
    ctx.setLineDash(PEN_PENDING_DASH);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo(c1.x, c1.y, end.x, end.y, end.x, end.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 3. Le maniglie dell'ancoraggio che si sta trascinando: il bastoncino fino
  //    al punto di controllo e il suo pallino. Solo quelle ESISTENTI (offset
  //    non nullo): una maniglia a zero coincide con l'ancoraggio, e disegnarla
  //    sarebbe un pallino sopra il quadratino che non vuol dire niente.
  const active = pen.active === null ? null : anchors[pen.active];
  if (active) {
    const c = to(anchorPoint(PEN_ORIGIN, active));
    const ends: PointLite[] = [];
    if (hasInHandle(active)) ends.push(inHandlePoint(PEN_ORIGIN, active));
    if (hasOutHandle(active)) ends.push(outHandlePoint(PEN_ORIGIN, active));
    for (const end of ends) {
      const p = to(end);
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, PEN_HANDLE_DOT, 0, Math.PI * 2);
      ctx.fillStyle = ACCENT;
      ctx.fill();
    }
  }

  // 4. I quadratini degli ancoraggi, sopra a tutto il resto. Il PRIMO è pieno:
  //    è il bersaglio che CHIUDE il contorno, e deve distinguersi dagli altri
  //    prima ancora che il puntatore ci arrivi sopra.
  const half = PEN_ANCHOR_SIZE / 2;
  for (let i = 0; i < n; i++) {
    const p = to(anchorPoint(PEN_ORIGIN, anchors[i]));
    ctx.fillStyle = i === 0 ? ACCENT : "#ffffff";
    ctx.fillRect(p.x - half, p.y - half, PEN_ANCHOR_SIZE, PEN_ANCHOR_SIZE);
    // +0.5 come per le maniglie di selezione: lo stroke da 1px cade su un
    // confine di pixel netto invece di sbavare su due righe.
    ctx.strokeRect(p.x - half + 0.5, p.y - half + 0.5, PEN_ANCHOR_SIZE - 1, PEN_ANCHOR_SIZE - 1);
  }
}

// Unione (in coordinate MONDO) dei bounds dei nodi selezionati. null se la
// selezione è vuota o non punta più a nodi esistenti -- lo store toglie già
// gli id spariti dalla selezione (vedi store.ts), ma questa funzione resta
// difensiva così l'overlay non esplode su uno stato transitorio incoerente.
// Estratta apposta così è testabile senza ctx/DOM.
export function selectionWorldBounds(state: SceneState, selection: string[]): Bounds | null {
  const boxes: Bounds[] = [];
  for (const id of selection) {
    const n = state.nodes[id];
    if (n) boxes.push(boundsOfNode(n));
  }
  return unionBounds(boxes);
}

// Disegna il bbox della selezione, le sue 8 maniglie, il rettangolo del marquee
// e il path che il pen tool sta disegnando -- TUTTO in spazio SCHERMO (px CSS).
// A differenza di drawScene,
// qui NON si applica cam.zoom alla trasformazione del canvas: i bounds
// mondo vengono convertiti a mano via worldToScreen prima di disegnare, così
// bordi (1px) e maniglie (8px) restano di dimensione costante a ogni livello
// di zoom. L'unica trasformazione applicata è lo scale per devicePixelRatio,
// necessario perché il backing store del canvas è in pixel fisici.
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  state: SceneState,
  cam: Camera,
  selection: string[],
  marquee: Bounds | null,
  // Il path in corso del pen tool (store::penPreview). Opzionale perché è
  // ANTEPRIMA e non documento: chi non disegna non ne ha uno, e i chiamanti che
  // non conoscono il pen tool restano validi.
  pen: PenPreview | null = null,
): void {
  const { canvas } = ctx;
  const dpr = devicePixelRatio();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const worldBox = selectionWorldBounds(state, selection);
  if (worldBox) {
    const box = worldBoundsToScreen(worldBox, cam);
    ctx.lineWidth = 1;
    ctx.strokeStyle = ACCENT;
    // +0.5 così lo stroke da 1px cade su un confine di pixel netto invece di
    // sbavare su due righe (il classico trucco del canvas 2D).
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.width, box.height);

    const half = HANDLE_SIZE / 2;
    for (const p of Object.values(handlePositions(box))) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(p.x - half, p.y - half, HANDLE_SIZE, HANDLE_SIZE);
      ctx.strokeStyle = ACCENT;
      ctx.strokeRect(p.x - half + 0.5, p.y - half + 0.5, HANDLE_SIZE - 1, HANDLE_SIZE - 1);
    }
  }

  if (marquee) {
    const m = worldBoundsToScreen(marquee, cam);
    ctx.fillStyle = "rgba(47, 111, 237, 0.08)";
    ctx.fillRect(m.x, m.y, m.width, m.height);
    ctx.lineWidth = 1;
    ctx.strokeStyle = ACCENT;
    ctx.strokeRect(m.x + 0.5, m.y + 0.5, m.width, m.height);
  }

  // Per ultimo: il path in corso sta SOPRA la selezione (di solito non
  // coesistono -- il pen tool non seleziona finché non ha finito -- ma quando
  // succede è il disegno in corso a dover restare leggibile).
  if (pen) drawPenPreview(ctx, cam, pen);
}
