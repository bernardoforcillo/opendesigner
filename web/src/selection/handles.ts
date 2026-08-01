import type { Camera } from "../canvas/camera";
import { type Bounds, inflateBounds, pointInBounds, worldBoundsToScreen } from "../canvas/geometry";

export type HandleId = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

// Lato (px SCHERMO) del quadratino disegnato dall'overlay.
export const HANDLE_SIZE = 8;

// Area di presa: leggermente più generosa del quadratino disegnato (8px sono
// pochi da centrare col mouse). È px SCHERMO, quindi resta costante a ogni
// livello di zoom -- è tutto il punto di fare l'hit-test in spazio schermo
// invece che in spazio mondo.
export const HANDLE_GRAB_PADDING = 2;

// Angoli PRIMA dei lati: con un bbox piccolo le aree di presa si sovrappongono
// e l'angolo (che muove due assi) è quasi sempre quello che l'utente vuole.
export const HANDLE_IDS: readonly HandleId[] = ["nw", "ne", "se", "sw", "n", "e", "s", "w"];

// Quali bordi del bbox muove ogni maniglia. Tutta la matematica del resize
// (incluso il flip) discende da qui.
const MOVES: Record<HandleId, { left: boolean; right: boolean; top: boolean; bottom: boolean }> = {
  nw: { left: true, right: false, top: true, bottom: false },
  n: { left: false, right: false, top: true, bottom: false },
  ne: { left: false, right: true, top: true, bottom: false },
  e: { left: false, right: true, top: false, bottom: false },
  se: { left: false, right: true, top: false, bottom: true },
  s: { left: false, right: false, top: false, bottom: true },
  sw: { left: true, right: false, top: false, bottom: true },
  w: { left: true, right: false, top: false, bottom: false },
};

const CURSORS: Record<HandleId, string> = {
  nw: "nwse-resize", se: "nwse-resize",
  ne: "nesw-resize", sw: "nesw-resize",
  n: "ns-resize", s: "ns-resize",
  e: "ew-resize", w: "ew-resize",
};

export function cursorForHandle(h: HandleId): string {
  return CURSORS[h];
}

// Centri delle 8 maniglie attorno a un bbox già in spazio SCHERMO.
export function handlePositions(b: Bounds): Record<HandleId, { x: number; y: number }> {
  const midX = b.x + b.width / 2;
  const midY = b.y + b.height / 2;
  const right = b.x + b.width;
  const bottom = b.y + b.height;
  return {
    nw: { x: b.x, y: b.y },
    n: { x: midX, y: b.y },
    ne: { x: right, y: b.y },
    e: { x: right, y: midY },
    se: { x: right, y: bottom },
    s: { x: midX, y: bottom },
    sw: { x: b.x, y: bottom },
    w: { x: b.x, y: midY },
  };
}

// Quadrati delle maniglie in px SCHERMO per un bbox in coordinate MONDO: il
// bbox si scala con lo zoom, i quadrati NO (sono sempre HANDLE_SIZE).
export function handleScreenRects(b: Bounds, cam: Camera): Record<HandleId, Bounds> {
  const box = worldBoundsToScreen(b, cam);
  const half = HANDLE_SIZE / 2;
  const out = {} as Record<HandleId, Bounds>;
  for (const [id, p] of Object.entries(handlePositions(box)) as [HandleId, { x: number; y: number }][]) {
    out[id] = { x: p.x - half, y: p.y - half, width: HANDLE_SIZE, height: HANDLE_SIZE };
  }
  return out;
}

// (sx, sy) sono px SCHERMO nello spazio del canvas, come i rettangoli qui
// sopra: nessuna conversione a mano, la camera entra solo via
// handleScreenRects.
export function hitTestHandle(b: Bounds, cam: Camera, sx: number, sy: number): HandleId | null {
  const rects = handleScreenRects(b, cam);
  for (const id of HANDLE_IDS) {
    if (pointInBounds(inflateBounds(rects[id], HANDLE_GRAB_PADDING), sx, sy)) return id;
  }
  return null;
}

// Trasformazione affine (solo scala + ancora) prodotta da un drag di resize.
// Tenerla separata da resizeBounds serve al resize di una selezione MULTIPLA:
// ogni nodo viene mappato con la stessa trasformazione del bbox di gruppo, e
// il ribaltamento specchia i figli invece di limitarsi a normalizzare.
//
// Il fattore di scala su X è signedW/startW, ma NON lo precalcoliamo: lo
// teniamo come frazione così mapAxis può moltiplicare PRIMA e dividere DOPO.
// Con la divisione anticipata anche un caso esatto sbanda ((100*(110/100)) dà
// 110.00000000000001), e il resize di un rettangolo a coordinate intere deve
// restituire coordinate intere.
export interface ResizeTransform {
  anchorX: number;
  anchorY: number;
  startW: number;
  startH: number;
  // Estensioni FIRMATE dopo il drag, misurate dall'ancora: negative = flip.
  signedW: number;
  signedH: number;
}

function signOf(v: number): number {
  return v < 0 ? -1 : 1;
}

// v mappato attorno all'ancora con il rapporto signed/start. start === 0 (bbox
// degenere) non ha un fattore di scala definito: lasciamo l'asse invariato
// invece di produrre Infinity/NaN.
function mapAxis(v: number, anchor: number, signed: number, start: number): number {
  return start === 0 ? v : anchor + ((v - anchor) * signed) / start;
}

export function resizeTransform(
  start: Bounds,
  h: HandleId,
  dxWorld: number,
  dyWorld: number,
  opts?: { keepAspect?: boolean },
): ResizeTransform {
  const m = MOVES[h];
  const movesH = m.left || m.right;
  const movesV = m.top || m.bottom;

  // L'ancora è il bordo OPPOSTO alla maniglia: è l'unico punto che il resize
  // non muove mai. Sugli assi che la maniglia non tocca l'ancora è il bordo
  // iniziale (min), così quell'asse resta identico (scala 1).
  const anchorX = m.left ? start.x + start.width : start.x;
  const anchorY = m.top ? start.y + start.height : start.y;

  // Larghezza/altezza FIRMATE dopo il drag, misurate dall'ancora: positive
  // finché il bordo mobile resta dalla parte iniziale dell'ancora, negative
  // quando la supera (= flip).
  let signedW = m.left ? start.width - dxWorld : m.right ? start.width + dxWorld : start.width;
  let signedH = m.top ? start.height - dyWorld : m.bottom ? start.height + dyWorld : start.height;

  if (opts?.keepAspect && start.width !== 0 && start.height !== 0) {
    // Rapporto preservato <=> |scaleX| === |scaleY| (scala uniforme). Il segno
    // resta indipendente, così il flip continua a funzionare con shift premuto.
    const scaleX = signedW / start.width;
    const scaleY = signedH / start.height;
    if (movesH && movesV) {
      // Angolo: comanda l'asse trascinato di più, in proporzione. "Di più" NON
      // è il |fattore| più grande: max(|scaleX|, |scaleY|) premia l'asse mosso
      // MENO ogni volta che il drag rimpicciolisce -- se con dx=-50, dy=0 dava
      // max(0.75, 1) = 1, cioè il neutro dell'asse fermo, e il resize non
      // faceva nulla. È lo stesso errore che i lati qui sotto evitano già.
      //
      // La misura giusta è quanto il bordo mobile ha VIAGGIATO in proporzione
      // al lato: |signedW - startW| / startW === |scaleX - 1|. Vale 0 per un
      // asse fermo, cresce sia allargando sia stringendo, e supera 1 quando il
      // drag ha oltrepassato l'ancora (flip). Vinto l'asse, il fattore comune è
      // il suo |scale|; i SEGNI restano per-asse, così shift + flip continua a
      // specchiare solo l'asse davvero trascinato oltre l'ancora.
      const travelX = Math.abs(scaleX - 1);
      const travelY = Math.abs(scaleY - 1);
      const s = travelX >= travelY ? Math.abs(scaleX) : Math.abs(scaleY);
      signedW = signOf(scaleX) * s * start.width;
      signedH = signOf(scaleY) * s * start.height;
    } else if (movesH) {
      // Lato verticale (e/w): l'asse orizzontale è l'unico trascinato, quindi
      // comanda sempre -- anche quando rimpicciolisce (|scaleX| < 1).
      signedH = Math.abs(scaleX) * start.height;
    } else if (movesV) {
      signedW = Math.abs(scaleY) * start.width;
    }
  }

  return { anchorX, anchorY, startW: start.width, startH: start.height, signedW, signedH };
}

// Applica la trasformazione e NORMALIZZA: width/height restano >= 0 anche dopo
// un flip (il rettangolo si ribalta, x/y passano dall'altra parte dell'ancora).
export function transformBounds(b: Bounds, t: ResizeTransform): Bounds {
  const x0 = mapAxis(b.x, t.anchorX, t.signedW, t.startW);
  const x1 = mapAxis(b.x + b.width, t.anchorX, t.signedW, t.startW);
  const y0 = mapAxis(b.y, t.anchorY, t.signedH, t.startH);
  const y1 = mapAxis(b.y + b.height, t.anchorY, t.signedH, t.startH);
  return {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

// dxWorld/dyWorld sono lo spostamento del puntatore in coordinate MONDO
// dall'inizio del gesto (non l'ultimo delta incrementale): il resize si calcola
// sempre dai bounds INIZIALI, così gli errori non si accumulano move dopo move.
export function resizeBounds(
  start: Bounds,
  h: HandleId,
  dxWorld: number,
  dyWorld: number,
  opts?: { keepAspect?: boolean },
): Bounds {
  return transformBounds(start, resizeTransform(start, h, dxWorld, dyWorld, opts));
}
