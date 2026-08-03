import type { Bounds } from "./geometry";

// ROTAZIONE — LA CONVENZIONE, IN UN POSTO SOLO.
//
// `Node.rotation` (proto: `double rotation = 14`) è in GRADI e vale attorno al
// CENTRO del box del nodo -- mai attorno alla sua origine. Gli assi mondo hanno
// y verso il BASSO (è il canvas 2D), quindi un angolo POSITIVO porta l'asse +x
// sull'asse +y: sullo schermo si legge come una rotazione ORARIA, la stessa di
// `ctx.rotate` e la stessa che gli editor di design mostrano nel pannello.
//
// I gradi (e non i radianti) perché è la forma che l'utente legge e scrive; la
// conversione a radianti resta confinata qui dentro, dove sta l'unica matrice
// di rotazione del progetto. Renderer, hit-test, maniglie e tool passano tutti
// da queste funzioni: una seconda matrice scritta a mano altrove sarebbe la
// solita coppia destinata a divergere (vedi canvas/camera.ts per screen<->world).
//
//   world = c + R(θ) · (local − c)      R(θ) = [[cos, −sin], [sin, cos]]
//   local = c + R(−θ) · (world − c)
//
// dove c è il centro del box NON ruotato del nodo: il modello continua a tenere
// x/y/width/height in coordinate mondo, ASSE-ALLINEATI, e la rotazione è un
// campo a parte applicato sopra. È il motivo per cui il resize può continuare a
// lavorare sui bounds (spazio locale) e solo l'ancora va ricollocata.

export interface Point { x: number; y: number }

const DEG_TO_RAD = Math.PI / 180;

// Un angolo che non ruota nulla (0, 360, -720...) deve lasciare le coordinate
// IDENTICHE, non "vicinissime": tutto il resto della pipeline (resizeBounds, le
// maniglie, i test su coordinate intere) confronta numeri esatti, e un giro per
// cos/sin trasformerebbe 110 in 110.00000000000001.
function isUnrotated(deg: number): boolean {
  return deg % 360 === 0;
}

export function centerOf(b: Bounds): Point {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

// Ruota un VETTORE (una direzione, uno spostamento): nessun centro, nessuna
// traslazione. È ciò che serve per portare il delta di un drag dallo spazio
// mondo a quello locale del nodo.
export function rotateVector(v: Point, deg: number): Point {
  if (isUnrotated(deg)) return { x: v.x, y: v.y };
  const r = deg * DEG_TO_RAD;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos };
}

export function rotateAround(p: Point, c: Point, deg: number): Point {
  if (isUnrotated(deg)) return { x: p.x, y: p.y };
  const v = rotateVector({ x: p.x - c.x, y: p.y - c.y }, deg);
  return { x: c.x + v.x, y: c.y + v.y };
}

// I due versi della stessa trasformazione, con i nomi del DOMINIO invece del
// segno: chi disegna va da locale a mondo, chi fa hit-test va da mondo a locale.
export function localToWorld(p: Point, c: Point, deg: number): Point {
  return rotateAround(p, c, deg);
}

export function worldToLocal(p: Point, c: Point, deg: number): Point {
  return rotateAround(p, c, -deg);
}

// I 4 angoli in coordinate MONDO, in ordine nw, ne, se, sw (lo stesso giro
// orario delle maniglie d'angolo, vedi selection/handles.ts).
export function rotatedCorners(b: Bounds, deg: number): [Point, Point, Point, Point] {
  const c = centerOf(b);
  const r = b.x + b.width;
  const bottom = b.y + b.height;
  return [
    localToWorld({ x: b.x, y: b.y }, c, deg),
    localToWorld({ x: r, y: b.y }, c, deg),
    localToWorld({ x: r, y: bottom }, c, deg),
    localToWorld({ x: b.x, y: bottom }, c, deg),
  ];
}

// Il rettangolo ASSE-ALLINEATO che contiene la forma ruotata: è ciò che serve a
// chiunque ragioni per rettangoli (unione di una selezione multipla,
// intersezione col marquee) su un nodo che ruotato non lo è più.
export function rotatedAabb(b: Bounds, deg: number): Bounds {
  if (isUnrotated(deg)) return { x: b.x, y: b.y, width: b.width, height: b.height };
  const corners = rotatedCorners(b, deg);
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

// Riporta un angolo in [0, 360). Serve a ciò che si SCRIVE nel modello: dopo
// tre giri di maniglia una rotazione di 1080° e una di 0° sono la stessa cosa,
// e il pannello proprietà (e chiunque confronti due nodi) non deve vedere la
// differenza.
export function normalizeDegrees(deg: number): number {
  const m = deg % 360;
  return m < 0 ? m + 360 : m;
}

export function snapDegrees(deg: number, step: number): number {
  return Math.round(deg / step) * step;
}

// L'angolo (in gradi, stessa convenzione oraria) del raggio che va da `c` a
// `p`. È la misura con cui un trascinamento della maniglia di rotazione si
// traduce in un delta angolare.
export function angleOf(c: Point, p: Point): number {
  return Math.atan2(p.y - c.y, p.x - c.x) / DEG_TO_RAD;
}
