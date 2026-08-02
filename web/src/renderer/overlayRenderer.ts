import type { SceneState } from "../store/types";
import { type Camera, worldToScreen } from "../canvas/camera";
import { type Bounds, boundsOfNode, unionBounds, worldAabbOfNode, worldBoundsToScreen } from "../canvas/geometry";
import type { SnapGuide } from "../selection/snap";
import {
  CORNER_IDS,
  HANDLE_SIZE,
  handlePositions,
  ROTATE_CORNER_DIRS,
  ROTATE_MARKER_RADIUS,
  rotateMarkerPositions,
  type SelectionFrame,
} from "../selection/handles";

// La geometria delle maniglie (posizioni, hit-test, resize) è UNA sola e vive
// in selection/handles.ts: qui si disegna soltanto. Ri-esportata perché il
// renderer resta il punto d'ingresso naturale per chi disegna l'overlay.
export {
  HANDLE_SIZE, handlePositions, ROTATE_MARKER_OFFSET, ROTATE_MARKER_RADIUS, rotateMarkerPositions,
  type HandleId, type SelectionFrame,
} from "../selection/handles";
export { worldBoundsToScreen } from "../canvas/geometry";

const DEG_TO_RAD = Math.PI / 180;
const TAU = Math.PI * 2;

// Apertura dell'arco del segno di rotazione: un quarto di giro, rivolto verso
// l'angolo. Un cerchio chiuso si leggerebbe come un'altra maniglia; un arco
// aperto è il segno con cui gli editor dicono "gira".
const ROTATE_ARC_GAP = Math.PI / 2;
const ROTATE_MARKER_WIDTH = 1.5;

// Le guide di snap sono ROSSE e non blu come il resto dell'overlay, di
// proposito: il blu dice "questo è selezionato", il rosso dice "questa è la
// retta su cui stai scattando". Sono due informazioni diverse e compaiono
// insieme -- con lo stesso colore la guida si leggerebbe come un altro bordo
// del riquadro. È anche la convenzione degli editor di design.
const SNAP_GUIDE_COLOR = "#f24822";
const SNAP_GUIDE_WIDTH = 1;

function devicePixelRatio(): number {
  return typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

// Unione (in coordinate MONDO) dei box dei nodi selezionati, rotazione inclusa
// (worldAabbOfNode).
//
// GEOMETRIA, non il dipinto: il tratto NON entra qui, di proposito. Questo
// rettangolo è il frame su cui vivono le maniglie, e il resize scrive proprio
// in x/y/width/height -- se il riquadro includesse la sporgenza del tratto, le
// maniglie starebbero staccate dal bordo della forma e ogni trascinamento
// scriverebbe un box gonfiato di quella sporgenza. Un tratto esterno sborda
// quindi dal riquadro di selezione: è la convenzione degli editor di design
// (la selezione mostra la GEOMETRIA che si sta modificando), e chi ha bisogno
// di quello che il nodo DIPINGE -- marquee, hit-test, export -- passa da
// canvas/geometry.ts::worldVisualAabbOfNode.
//
// null se la selezione è vuota o non punta
// più a nodi esistenti -- lo store toglie già gli id spariti dalla selezione
// (vedi store.ts), ma questa funzione resta difensiva così l'overlay non
// esplode su uno stato transitorio incoerente. Estratta apposta così è
// testabile senza ctx/DOM.
export function selectionWorldBounds(state: SceneState, selection: string[]): Bounds | null {
  const boxes: Bounds[] = [];
  for (const id of selection) {
    const n = state.nodes[id];
    if (n) boxes.push(worldAabbOfNode(n));
  }
  return unionBounds(boxes);
}

// Il FRAME della selezione: il rettangolo su cui vivono le maniglie PIÙ il suo
// angolo. La convenzione, che vale ovunque (overlay, hit-test, resize):
//
//  - UN nodo solo: il frame è il suo box NON ruotato con la SUA rotazione, così
//    le maniglie stanno sui suoi lati veri e il resize lavora nel suo spazio
//    locale (trascinare la maniglia e lo allarga lungo il proprio asse).
//  - PIÙ nodi: il frame è ASSE-ALLINEATO attorno a quello che i nodi occupano
//    davvero. Non esiste un angolo comune a nodi ruotati in modo diverso, e
//    inventarne uno (quello del primo? quello della media?) renderebbe il
//    resize di gruppo imprevedibile. I singoli nodi restano ruotati; è il
//    riquadro di gruppo a non esserlo.
export function selectionFrame(state: SceneState, selection: string[]): SelectionFrame | null {
  const nodes = selection.map((id) => state.nodes[id]).filter((n) => n !== undefined);
  if (nodes.length === 0) return null;
  if (nodes.length === 1) return { bounds: boundsOfNode(nodes[0]), rotation: nodes[0].rotation };
  const bounds = selectionWorldBounds(state, selection);
  return bounds ? { bounds, rotation: 0 } : null;
}

// Disegna il bbox della selezione, le sue 8 maniglie e il rettangolo del
// marquee -- TUTTO in spazio SCHERMO (px CSS). A differenza di drawScene,
// qui NON si applica cam.zoom alla trasformazione del canvas: i bounds
// mondo vengono convertiti a mano via worldToScreen prima di disegnare, così
// bordi (1px) e maniglie (8px) restano di dimensione costante a ogni livello
// di zoom. L'unica trasformazione applicata è lo scale per devicePixelRatio,
// necessario perché il backing store del canvas è in pixel fisici.
//
// La ROTAZIONE del frame è l'eccezione, ed è applicata come in drawScene: al
// CONTESTO, attorno al centro del riquadro in px schermo. Il riquadro e i
// quadratini restano disegnati con la stessa identica geometria di prima --
// solo, girati con il nodo. La camera è una similitudine, quindi l'angolo
// mondo e l'angolo schermo coincidono e le maniglie NON si deformano con lo
// zoom. Il marquee resta fuori dalla trasformazione: è sempre asse-allineato.
// Le GUIDE di snap (in coordinate mondo, vedi selection/snap.ts) si disegnano
// per ultime e FUORI da qualunque rotazione del frame: una guida è per
// definizione una retta dello schermo -- è la retta su cui i bordi combaciano
// -- e girarla con il nodo la renderebbe una retta qualunque.
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  state: SceneState,
  cam: Camera,
  selection: string[],
  marquee: Bounds | null,
  guides: readonly SnapGuide[] = [],
): void {
  const { canvas } = ctx;
  const dpr = devicePixelRatio();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const frame = selectionFrame(state, selection);
  if (frame) {
    const box = worldBoundsToScreen(frame.bounds, cam);
    const rotated = frame.rotation % 360 !== 0;
    if (rotated) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(frame.rotation * DEG_TO_RAD);
      ctx.translate(-cx, -cy);
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#2f6fed";
    // +0.5 così lo stroke da 1px cade su un confine di pixel netto invece di
    // sbavare su due righe (il classico trucco del canvas 2D).
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.width, box.height);

    const half = HANDLE_SIZE / 2;
    for (const p of Object.values(handlePositions(box))) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(p.x - half, p.y - half, HANDLE_SIZE, HANDLE_SIZE);
      ctx.strokeStyle = "#2f6fed";
      ctx.strokeRect(p.x - half + 0.5, p.y - half + 0.5, HANDLE_SIZE - 1, HANDLE_SIZE - 1);
    }
    // La MANIGLIA DI ROTAZIONE: un arco aperto appena FUORI da ogni angolo,
    // dentro la zona di presa che selection/handles.ts::hitTestFrame già
    // riconosce (stessa geometria, un'unica fonte -- vedi
    // rotateMarkerPositions). Non un quadratino: quello vuol dire "trascina per
    // ridimensionare", e qui non si ridimensiona niente. L'apertura guarda
    // verso il riquadro, così il segno "abbraccia" l'angolo che gira.
    const markers = rotateMarkerPositions(box);
    ctx.lineWidth = ROTATE_MARKER_WIDTH;
    ctx.strokeStyle = "#2f6fed";
    for (const id of CORNER_IDS) {
      const p = markers[id];
      const d = ROTATE_CORNER_DIRS[id];
      // Verso l'INTERNO: la direzione opposta alla diagonale uscente.
      const inward = Math.atan2(-d.y, -d.x);
      ctx.beginPath();
      ctx.arc(p.x, p.y, ROTATE_MARKER_RADIUS, inward + ROTATE_ARC_GAP / 2, inward - ROTATE_ARC_GAP / 2 + TAU);
      ctx.stroke();
    }
    if (rotated) ctx.restore();
  }

  if (marquee) {
    const m = worldBoundsToScreen(marquee, cam);
    ctx.fillStyle = "rgba(47, 111, 237, 0.08)";
    ctx.fillRect(m.x, m.y, m.width, m.height);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "#2f6fed";
    ctx.strokeRect(m.x + 0.5, m.y + 0.5, m.width, m.height);
  }

  if (guides.length > 0) {
    ctx.lineWidth = SNAP_GUIDE_WIDTH;
    ctx.strokeStyle = SNAP_GUIDE_COLOR;
    for (const g of guides) {
      // Gli estremi passano dalla camera come ogni altra coordinata: la retta
      // vive nel MONDO, il segmento sullo schermo. Il +0.5 sulla sola coordinata
      // costante è lo stesso trucco del riquadro (un tratto da 1px su un confine
      // di pixel netto invece che sbavato su due righe).
      const a = worldToScreen(cam, g.axis === "x" ? g.pos : g.from, g.axis === "x" ? g.from : g.pos);
      const b = worldToScreen(cam, g.axis === "x" ? g.pos : g.to, g.axis === "x" ? g.to : g.pos);
      ctx.beginPath();
      if (g.axis === "x") {
        ctx.moveTo(a.x + 0.5, a.y);
        ctx.lineTo(b.x + 0.5, b.y);
      } else {
        ctx.moveTo(a.x, a.y + 0.5);
        ctx.lineTo(b.x, b.y + 0.5);
      }
      ctx.stroke();
    }
  }
}
