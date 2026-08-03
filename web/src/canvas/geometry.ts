import type { NodeLite, StrokeLite } from "../store/types";
import { type Camera, worldToScreen } from "./camera";
import { rotatedAabb } from "./transform";

export interface Bounds { x: number; y: number; width: number; height: number }

// I bounds LOCALI del nodo: il rettangolo asse-allineato che il modello tiene
// in x/y/width/height, PRIMA della rotazione. È lo spazio in cui lavorano il
// resize e le maniglie (vedi selection/handles.ts).
export function boundsOfNode(n: NodeLite): Bounds {
  return { x: n.x, y: n.y, width: n.width, height: n.height };
}

// Il rettangolo asse-allineato che il BOX DEL MODELLO occupa nel mondo,
// rotazione inclusa. È la GEOMETRIA -- il tratto non c'entra, di proposito:
// questo è lo spazio in cui il resize scrive (frame di selezione e resize di
// gruppo, vedi renderer/overlayRenderer.ts::selectionFrame). Includerci la
// sporgenza del tratto significherebbe scrivere in x/y/width/height un box
// gonfiato, e il nodo crescerebbe di mezza sporgenza a ogni trascinamento di
// maniglia. Per quello che il nodo DIPINGE c'è worldVisualAabbOfNode.
// Per un nodo fermo è identico (numeri compresi) a boundsOfNode.
export function worldAabbOfNode(n: NodeLite): Bounds {
  return rotatedAabb(boundsOfNode(n), n.rotation);
}

// --- IL TRATTO NEI BOUNDS ----------------------------------------------------
//
// Un tratto è disegnato SUL perimetro, quindi a seconda dell'allineamento
// sporge fuori dal box del modello: metà peso per CENTER, tutto il peso per
// OUTSIDE, niente per INSIDE. Quella sporgenza è pixel dipinti come gli altri:
// chi ragiona su "che spazio occupa questo nodo" -- il marquee, l'hit-test,
// l'export -- deve contarla, o taglia il bordo esattamente dove si vede di più.
//
// Sta QUI e non nel renderer perché è geometria, non disegno: il renderer la
// usa per decidere lineWidth e clip, ma la MISURA è una sola e la leggono
// entrambi (renderer/canvasRenderer.ts, renderer/shapes.ts).

// Quanto sporge UN tratto oltre il perimetro. Un peso non positivo non è un
// tratto sottilissimo: non è un tratto, e non sporge (il canvas non disegna
// nulla con lineWidth 0, e un peso negativo sarebbe un errore da cui non deve
// uscire un box più PICCOLO del nodo).
export function strokeOutset(s: StrokeLite): number {
  if (!(s.weight > 0)) return 0;
  if (s.align === "inside") return 0;
  return s.align === "outside" ? s.weight : s.weight / 2;
}

// La sporgenza del nodo: il MASSIMO fra i suoi tratti, non la somma. I tratti
// si disegnano uno SOPRA l'altro sullo stesso perimetro (come i fills), quindi
// quello che sporge di più contiene tutti gli altri.
//
// Il TESTO è l'eccezione, e non per comodità: il suo tratto è disegnato con
// ctx.strokeText, che è SEMPRE centrato sul contorno del glifo -- un glifo un
// Path2D non ce l'ha, quindi non c'è niente da ritagliare (vedi
// renderer/text.ts::strokeText). L'allineamento non è rappresentabile, e la
// misura deve dire quello che il disegno fa DAVVERO: contare `weight` intero
// per un OUTSIDE su un testo darebbe bounds più grandi del dipinto, e contare 0
// per un INSIDE ne darebbe di più piccoli -- cioè taglierebbe.
export function strokeOutsetOfNode(n: NodeLite): number {
  let max = 0;
  for (const s of n.strokes) {
    max = Math.max(max, strokeOutset(n.kind === "text" ? { ...s, align: "center" } : s));
  }
  return max;
}

// I bounds LOCALI di ciò che il nodo dipinge: il box del modello allargato
// della sporgenza del tratto. Un nodo senza tratti (il caso normale) ritorna
// numeri IDENTICI a boundsOfNode -- inflateBounds con pad 0 è l'identità
// aritmetica, non un arrotondamento.
export function visualBoundsOfNode(n: NodeLite): Bounds {
  return inflateBounds(boundsOfNode(n), strokeOutsetOfNode(n));
}

// Il rettangolo asse-allineato che il nodo DIPINGE nel mondo: tratto compreso e
// rotazione inclusa. Si allarga PRIMA e si ruota DOPO, perché il tratto vive
// nello spazio LOCALE del nodo (è il perimetro del box non ruotato a portarlo);
// ruotare e poi allargare metterebbe la sporgenza sugli assi dello schermo
// invece che su quelli del nodo.
export function worldVisualAabbOfNode(n: NodeLite): Bounds {
  return rotatedAabb(visualBoundsOfNode(n), n.rotation);
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
