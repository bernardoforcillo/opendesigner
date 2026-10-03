import type { NodeLite } from "../store/types";
import { flattenSubpath } from "../store/vectorGeometry";
import { traceSubpath } from "./shapes";

// IL TRATTO CHE SI DISEGNA ("draw" di un'animazione).
//
// La proprietà `draw` (0..1) ha la semantica di `pathLength` di SVG: la frazione
// del tracciato che è già stata tracciata. Il canvas 2D non ha un pathLength, ma
// ha il tratteggio: con la lunghezza L del tracciato, `setLineDash([L * draw, L])`
// disegna esattamente i primi `draw * L` e poi lascia un vuoto lungo quanto tutto
// il resto -- niente seconda ripetizione. Il compito di questo modulo è dare L.

/** Il tratteggio che lascia visibile la frazione `draw` di un tracciato lungo `length`. */
export function drawDash(length: number, draw: number): number[] {
  const d = Math.min(1, Math.max(0, draw));
  // Il vuoto è L (+1 per non dipendere dall'arrotondamento a draw = 1): un solo
  // tratto visibile per giro.
  return [length * d, length + 1];
}

/**
 * Il perimetro di rect / ellisse / frame, nelle stesse unità del box. Il rettangolo
 * stondato toglie ad ogni angolo (2 - π/2) r di quello che avrebbe da spigolo vivo;
 * l'ellisse è l'approssimazione di Ramanujan (errore sotto 0.01% per ogni
 * eccentricità che un box può avere).
 */
export function perimeterOf(n: Pick<NodeLite, "kind" | "width" | "height" | "cornerRadius">): number {
  const w = Math.max(0, n.width), h = Math.max(0, n.height);
  if (n.kind === "ellipse") {
    const a = w / 2, b = h / 2;
    return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  }
  // `frame` si disegna a spigoli vivi anche con un cornerRadius (vedi nodePath).
  const r = n.kind === "rect" ? Math.min(Math.max(0, n.cornerRadius), w / 2, h / 2) : 0;
  return 2 * (w + h) - 8 * r + 2 * Math.PI * r;
}

// Tolleranza di appiattimento per MISURARE (unità mondo): la lunghezza di una
// spezzata a 0.05 dalla curva sbaglia di meno di un pixel su qualunque contorno
// leggibile, e non dipende dallo zoom (la lunghezza non deve oscillare mentre si
// zooma durante la riproduzione).
const LENGTH_TOL = 0.05;

/** La lunghezza di una spezzata. */
function polylineLength(pts: readonly { x: number; y: number }[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
}

export interface DrawSubpath { path: Path2D; length: number }

/**
 * I contorni di un vettoriale, ognuno col SUO Path2D (coordinate mondo) e la sua
 * lunghezza: ogni contorno si disegna per la stessa frazione, in parallelo --
 * come un'icona SVG i cui tracciati partono insieme. Il tratteggio del canvas
 * ricomincia a ogni sotto-percorso, quindi uno solo con tutti i contorni darebbe
 * la stessa cosa, ma con la lunghezza SBAGLIATA (quella del più lungo, non di
 * ognuno).
 */
export function vectorDrawSubpaths(n: NodeLite): DrawSubpath[] {
  const out: DrawSubpath[] = [];
  for (const sp of n.vector?.subpaths ?? []) {
    if (sp.anchors.length === 0) continue;
    const path = new Path2D();
    traceSubpath(path, n, sp);
    out.push({ path, length: polylineLength(flattenSubpath(sp, LENGTH_TOL)) });
  }
  return out;
}
