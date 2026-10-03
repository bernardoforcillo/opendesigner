import type { Bounds } from "../canvas/geometry";

// GEOMETRIA DELLE FRECCE DEI FLUSSI. Pura: bounds in ingresso, numeri in uscita,
// nessun DOM e nessun canvas -- così si testa senza browser e il renderer
// (renderer/flowRenderer.ts) e il hit-test (tools/flowSelect.ts) leggono la
// STESSA curva. Tutto è in coordinate MONDO: la camera la applica chi disegna.
//
// La freccia è una bézier cubica che esce dal punto medio del lato più vicino
// della schermata di partenza ed entra nel punto medio del lato più vicino di
// quella di arrivo, con le tangenti PERPENDICOLARI ai lati (la curva "esce"
// dritta dal bordo, come i connettori di Figma/FigJam).

export interface Pt { x: number; y: number }

/** Una bézier cubica: p0 -> p3 con punti di controllo c1, c2. */
export interface Bezier { p0: Pt; c1: Pt; c2: Pt; p3: Pt }

/** Il lato di un rettangolo da cui la freccia esce/entra. */
export type Side = "left" | "right" | "top" | "bottom";

export const NORMAL: Record<Side, Pt> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

// Quanto escono le tangenti: una frazione della distanza fra gli estremi, con un
// minimo (due schermate a contatto devono comunque dare una curva leggibile) e un
// massimo (a distanze enormi la curva non deve gonfiarsi a dismisura).
const HANDLE_RATIO = 0.4;
const HANDLE_MIN = 40;
const HANDLE_MAX = 400;
// Distanza fra due frecce PARALLELE (stessa coppia di schermate), lungo il lato.
export const LANE_GAP = 26;
// Quanto sporge un auto-anello dalla schermata.
const LOOP_OUT = 70;

export function centerOf(b: Bounds): Pt {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/**
 * Il lato di `a` rivolto verso `b`. Si confrontano gli scostamenti dei centri
 * NORMALIZZATI sulle semi-dimensioni: due schermate affiancate (stessa altezza,
 * una a destra dell'altra) devono dare right/left anche quando la distanza
 * verticale in assoluto è grande ma piccola rispetto all'altezza dei frame.
 */
export function facingSide(a: Bounds, b: Bounds): Side {
  const ca = centerOf(a);
  const cb = centerOf(b);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  const nx = Math.abs(dx) / Math.max(1, a.width / 2 + b.width / 2);
  const ny = Math.abs(dy) / Math.max(1, a.height / 2 + b.height / 2);
  if (nx >= ny) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

export function opposite(s: Side): Side {
  return s === "left" ? "right" : s === "right" ? "left" : s === "top" ? "bottom" : "top";
}

/** Il punto medio di un lato, spostato lungo il lato di `shift` (corsie parallele). */
export function sidePoint(b: Bounds, side: Side, shift = 0): Pt {
  switch (side) {
    case "left": return { x: b.x, y: b.y + b.height / 2 + shift };
    case "right": return { x: b.x + b.width, y: b.y + b.height / 2 + shift };
    case "top": return { x: b.x + b.width / 2 + shift, y: b.y };
    case "bottom": return { x: b.x + b.width / 2 + shift, y: b.y + b.height };
  }
}

function handleLength(p: Pt, q: Pt): number {
  const d = Math.hypot(q.x - p.x, q.y - p.y);
  return Math.min(HANDLE_MAX, Math.max(HANDLE_MIN, d * HANDLE_RATIO));
}

/** La bézier fra due punti con le normali d'uscita e d'ingresso (verso l'ESTERNO dei lati). */
export function bezierBetween(p0: Pt, n0: Pt, p3: Pt, n3: Pt): Bezier {
  const h = handleLength(p0, p3);
  return {
    p0,
    c1: { x: p0.x + n0.x * h, y: p0.y + n0.y * h },
    c2: { x: p3.x + n3.x * h, y: p3.y + n3.y * h },
    p3,
  };
}

/**
 * La freccia fra due rettangoli. `shift` sposta entrambi gli estremi lungo i
 * lati (per tenere separate le frecce che collegano la stessa coppia).
 * Con `loop` (from === to) il percorso esce dal lato destro e rientra sempre
 * dal destro, sporgendo: è l'unico caso in cui la tangente d'ingresso guarda
 * nella stessa direzione di quella d'uscita.
 */
export function arrowBetween(from: Bounds, to: Bounds, shift = 0, loop = false): Bezier {
  if (loop) {
    const a = sidePoint(from, "right", -Math.min(from.height / 4, 30) + shift);
    const b = sidePoint(from, "right", Math.min(from.height / 4, 30) + shift);
    return {
      p0: a,
      c1: { x: a.x + LOOP_OUT, y: a.y - LOOP_OUT * 0.6 },
      c2: { x: b.x + LOOP_OUT, y: b.y + LOOP_OUT * 0.6 },
      p3: b,
    };
  }
  const side = facingSide(from, to);
  const other = opposite(side);
  return bezierBetween(sidePoint(from, side, shift), NORMAL[side], sidePoint(to, other, shift), NORMAL[other]);
}

/** La freccia da un PUNTO (il puntatore, durante il drag di "Collega") a un rettangolo. */
export function arrowFromRectToPoint(from: Bounds, p: Pt): Bezier {
  const side = facingSide(from, { x: p.x, y: p.y, width: 0, height: 0 });
  const p0 = sidePoint(from, side);
  // Il punto d'arrivo non ha lato: la tangente d'ingresso guarda verso chi arriva.
  const n3 = NORMAL[opposite(side)];
  return bezierBetween(p0, NORMAL[side], p, n3);
}

export function bezierPoint(b: Bezier, t: number): Pt {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * b.p0.x + w1 * b.c1.x + w2 * b.c2.x + w3 * b.p3.x,
    y: w0 * b.p0.y + w1 * b.c1.y + w2 * b.c2.y + w3 * b.p3.y,
  };
}

/** Il rettangolo che contiene i 4 punti di controllo: contiene sempre la curva. */
export function bezierBounds(b: Bezier): Bounds {
  const x = Math.min(b.p0.x, b.c1.x, b.c2.x, b.p3.x);
  const y = Math.min(b.p0.y, b.c1.y, b.c2.y, b.p3.y);
  return {
    x,
    y,
    width: Math.max(b.p0.x, b.c1.x, b.c2.x, b.p3.x) - x,
    height: Math.max(b.p0.y, b.c1.y, b.c2.y, b.p3.y) - y,
  };
}

/**
 * I tre vertici della punta, con la punta vera in `b.p3`. `size` è nella stessa
 * unità delle coordinate di `b`.
 */
export function arrowhead(b: Bezier, size: number): [Pt, Pt, Pt] {
  // Tangente in t=1 (da c2 a p3); se i due coincidono si ripiega sulla corda.
  let tx = b.p3.x - b.c2.x;
  let ty = b.p3.y - b.c2.y;
  if (Math.hypot(tx, ty) < 1e-6) {
    tx = b.p3.x - b.p0.x;
    ty = b.p3.y - b.p0.y;
  }
  const len = Math.hypot(tx, ty) || 1;
  const ux = tx / len;
  const uy = ty / len;
  const half = size * 0.55;
  const bx = b.p3.x - ux * size;
  const by = b.p3.y - uy * size;
  return [b.p3, { x: bx - uy * half, y: by + ux * half }, { x: bx + uy * half, y: by - ux * half }];
}

const SAMPLES = 24;

/** La distanza minima di (x, y) dalla curva, per campionamento. */
export function distanceToBezier(b: Bezier, x: number, y: number): number {
  let best = Infinity;
  let prev = b.p0;
  for (let i = 1; i <= SAMPLES; i++) {
    const p = bezierPoint(b, i / SAMPLES);
    const d = distanceToSegment(prev, p, x, y);
    if (d < best) best = d;
    prev = p;
  }
  return best;
}

export function distanceToSegment(a: Pt, b: Pt, x: number, y: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}

/** Il rettangolo allargato di `pad` per lato. */
export function inflate(b: Bounds, pad: number): Bounds {
  return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
}

export function overlaps(a: Bounds, b: Bounds): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

/**
 * La corsia di una freccia fra le N che collegano la STESSA coppia di
 * schermate (in qualunque verso): lo scostamento lungo il lato, simmetrico
 * attorno allo zero. Una sola freccia: 0. Due: ±gap/2. Così A->B e B->A non si
 * sovrappongono e due click diversi A->B restano distinguibili.
 */
export function laneShift(index: number, count: number): number {
  if (count <= 1) return 0;
  return (index - (count - 1) / 2) * LANE_GAP;
}
