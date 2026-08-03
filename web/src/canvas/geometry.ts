import type { NodeLite } from "../store/types";
import { type Camera, worldToScreen } from "./camera";

export interface Bounds { x: number; y: number; width: number; height: number }

export function boundsOfNode(n: NodeLite): Bounds {
  return { x: n.x, y: n.y, width: n.width, height: n.height };
}

export function unionBounds(list: Bounds[]): Bounds | null {
  if (list.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of list) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// gestisce drag all'indietro (in qualunque direzione): (x0,y0) e (x1,y1) sono i due
// angoli del rettangolo di drag, in un ordine qualsiasi.
export function normalizeRect(x0: number, y0: number, x1: number, y1: number): Bounds {
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  return { x, y, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

// La parte in COMUNE fra due rettangoli, o null se non ne hanno.
//
// Serve a chi deve sapere quanto di un nodo si VEDE dentro un ritaglio: un
// frame con clips_content nasconde ciò che esce dal proprio box, e la banda
// elastica non deve poter selezionare quello che il ritaglio ha portato via
// (renderer/canvasRenderer.ts::collectIn).
//
// Un'intersezione DEGENERE (larghezza o altezza nulla: due rettangoli che si
// toccano su un bordo) è null e non un rettangolo piatto, per coerenza con
// boundsIntersect qui sopra, che confronta i bordi opposti con < / >: una
// striscia di area zero non è area visibile.
export function intersectBounds(a: Bounds, b: Bounds): Bounds | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export function pointInBounds(b: Bounds, x: number, y: number): boolean {
  return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
}

// Converte bounds MONDO in bounds SCHERMO (px CSS) passando SEMPRE da
// canvas/camera.ts, mai ricalcolando la trasformazione a mano. Vive qui (e non
// nel renderer) perché serve sia all'overlay che a selection/handles.ts, e
// tenerla nel renderer costringerebbe le maniglie a importare da lui -- ciclo.
export function worldBoundsToScreen(b: Bounds, cam: Camera): Bounds {
  const p0 = worldToScreen(cam, b.x, b.y);
  const p1 = worldToScreen(cam, b.x + b.width, b.y + b.height);
  return { x: p0.x, y: p0.y, width: p1.x - p0.x, height: p1.y - p0.y };
}

// Allarga (o restringe, con pad negativo) un rettangolo di pad px su ogni lato.
export function inflateBounds(b: Bounds, pad: number): Bounds {
  return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
}
