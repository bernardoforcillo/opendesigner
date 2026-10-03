import type { NodeLite, SceneState } from "../store/types";
import { ancestorsOf } from "../store/tree";
import { type Bounds, boundsOfNode } from "./geometry";

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

// I 4 angoli in coordinate MONDO, in ordine nw, ne, se, sw (lo stesso giro
// orario delle maniglie d'angolo, vedi selection/handles.ts).
export function rotatedCorners(b: Bounds, deg: number): [Point, Point, Point, Point] {
  const c = centerOf(b);
  const r = b.x + b.width;
  const bottom = b.y + b.height;
  return [
    rotateAround({ x: b.x, y: b.y }, c, deg),
    rotateAround({ x: r, y: b.y }, c, deg),
    rotateAround({ x: r, y: bottom }, c, deg),
    rotateAround({ x: b.x, y: bottom }, c, deg),
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

// TRASFORMAZIONI COMPOSTE — le coordinate di un nodo sono RELATIVE AL PARENT.
//
// Fino a qui la scena era piatta e x/y erano coordinate MONDO: il renderer
// poteva disegnare ogni nodo dov'era scritto e l'hit-test confrontare il punto
// del puntatore con il box così com'era. Con l'albero non è più vero: le
// coordinate di un nodo vivono nello spazio LOCALE del suo parent, e il mondo
// si ottiene accumulando le trasformazioni scendendo dalla pagina.
//
// Le due direzioni servono ENTRAMBE, ed è la sola ragione per cui
// `invertTransform` esiste:
//   locale -> mondo   disegnare (renderer), i bounds della selezione, l'origine
//                     del campo di testo: tutto ciò che deve finire su schermo.
//   mondo  -> locale  il puntatore: l'hit-test confronta il punto con il box
//                     del nodo, che è scritto in coordinate locali, e il resize
//                     riscrive x/y/width/height che sono locali anche loro.
//
// MIGRAZIONE: in un documento esistente ogni nodo sta direttamente sotto una
// pagina, e una pagina contribuisce l'IDENTITÀ (vedi worldTransformOf). Mondo e
// locale coincidono ancora, quindi nessuna opera si sposta.

// Matrice affine 2x3 nella convenzione del canvas 2D (gli stessi sei numeri, e
// nello stesso ordine, di ctx.setTransform/DOMMatrix):
//   x' = a*x + c*y + e
//   y' = b*x + d*y + f
export interface Transform { a: number; b: number; c: number; d: number; e: number; f: number }

export const IDENTITY: Transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function translation(tx: number, ty: number): Transform {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

// `outer` DOPO `inner`: il punto passa prima per inner, poi per outer -- cioè
// il prodotto di matrici outer*inner. È la direzione con cui si scende
// l'albero: la trasformazione di un figlio è quella del parent composta sopra
// la propria.
export function compose(outer: Transform, inner: Transform): Transform {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  };
}

export function applyTransform(t: Transform, x: number, y: number): { x: number; y: number } {
  return { x: t.a * x + t.c * y + t.e, y: t.b * x + t.d * y + t.f };
}

// Inversa. Con determinante 0 la trasformazione ha collassato il piano su una
// retta e un'inversa non esiste: si torna l'IDENTITÀ invece di dividere per
// zero, perché il valore di ritorno finisce nel loop di rendering e
// nell'hit-test, dove degli Infinity/NaN si propagherebbero in silenzio in ogni
// coordinata.
export function invertTransform(t: Transform): Transform {
  const det = t.a * t.d - t.b * t.c;
  if (det === 0) return IDENTITY;
  return {
    a: t.d / det,
    b: -t.b / det,
    c: -t.c / det,
    d: t.a / det,
    e: (t.c * t.f - t.d * t.e) / det,
    f: (t.b * t.e - t.a * t.f) / det,
  };
}

// La rotazione (in gradi, stessa convenzione oraria di rotateVector) attorno a
// un centro `c`, come Transform: T(c) · R(θ) · T(-c). È il pezzo che
// `localTransformOf` compone sopra la traslazione perché i figli di un container
// ruotato ruotino con lui.
function rotationAround(c: Point, deg: number): Transform {
  if (isUnrotated(deg)) return IDENTITY;
  const r = deg * DEG_TO_RAD;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const rot: Transform = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
  return compose(translation(c.x, c.y), compose(rot, translation(-c.x, -c.y)));
}

// Ciò che un nodo contribuisce ai PROPRI figli: l'origine del loro spazio è
// l'angolo alto-sinistro del nodo, ruotato con lui. Un solo posto, così il
// renderer, l'hit-test e i bounds non possono divergere.
//
// Compone DUE cose (traccia annidamento + traccia rotazione): la traslazione
// parent-relativa (da x/y) e la rotazione del nodo attorno al centro del suo box
// NON ruotato. Prima si trasla nel box del parent, poi si ruota attorno al
// centro: compose(rotationAround(centro), translation(x, y)). Un nodo fermo
// (rotation ≡ 0) ricade sulla sola traslazione, IDENTICA a prima.
//
// Esportata perché il renderer la applica al ctx scendendo (ctx.transform con
// gli stessi sei numeri) e l'hit-test applica la sua INVERSA al punto: sono le
// due direzioni della stessa cosa, e devono restare la stessa cosa.
export function localTransformOf(n: NodeLite): Transform {
  const t = translation(n.x, n.y);
  // `animScale` esiste solo nelle scene derivate dalla riproduzione
  // (animation/pose.ts): una scena vera non lo ha mai, e il ramo sotto non costa
  // nulla a un nodo fermo (stessa traslazione di prima, numeri compresi).
  const scaled = n.animScale !== undefined && n.animScale !== 1;
  if (!scaled && isUnrotated(n.rotation)) return t;
  const c: Point = n.animPivot ?? { x: n.x + n.width / 2, y: n.y + n.height / 2 };
  const rotated = isUnrotated(n.rotation) ? t : compose(rotationAround(c, n.rotation), t);
  if (!scaled) return rotated;
  // Scala UNIFORME attorno allo stesso centro della rotazione: i due commutano.
  const s = n.animScale as number;
  const scale: Transform = { a: s, b: 0, c: 0, d: s, e: c.x - s * c.x, f: c.y - s * c.y };
  return compose(scale, rotated);
}

// Dallo spazio LOCALE di `id` -- quello in cui sono scritte le coordinate dei
// suoi FIGLI -- al MONDO.
//
// `id` è un CONTENITORE: l'id di un nodo oppure quello di una pagina. Una
// pagina (come un id sconosciuto o la stringa vuota) contribuisce l'IDENTITÀ:
// è ciò che tiene fermi i documenti già esistenti, in cui ogni nodo sta
// direttamente sotto una pagina.
//
// ATTENZIONE alla direzione, è il punto delicato della traccia: le coordinate
// PROPRIE di un nodo n non stanno nel suo spazio locale ma in quello del suo
// parent, quindi chi lavora sul box di n (hit-test, bounds, resize) usa
// `worldTransformOf(scene, n.parentId)`, non `worldTransformOf(scene, n.id)`.
export function worldTransformOf(scene: SceneState, id: string): Transform {
  const node = scene.nodes.at(id);
  if (!node) return IDENTITY;
  let t = localTransformOf(node);
  // ancestorsOf: dal più vicino al più lontano, si ferma alla pagina ed è già a
  // prova di ciclo (store/tree.ts). Ogni antenato si compone SOPRA quanto
  // accumulato, che è esattamente l'ordine in cui si scende l'albero.
  for (const a of ancestorsOf(scene, id)) t = compose(localTransformOf(a), t);
  return t;
}

// Un rettangolo trasformato. Si trasformano i quattro ANGOLI e si prende il
// rettangolo che li contiene, invece di trasformare origine e dimensioni: con
// una traslazione le due cose coincidono, ma questa resta corretta per
// qualunque trasformazione affine (con una rotazione il risultato è l'AABB del
// rettangolo ruotato, che è il significato giusto di "bounds" lì).
export function mapBounds(t: Transform, b: Bounds): Bounds {
  const corners = [
    applyTransform(t, b.x, b.y),
    applyTransform(t, b.x + b.width, b.y),
    applyTransform(t, b.x + b.width, b.y + b.height),
    applyTransform(t, b.x, b.y + b.height),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

// Un DELTA (uno spostamento), non un punto: passa solo per la parte LINEARE
// della trasformazione, la traslazione non lo tocca. È la differenza fra
// "dove sta questo punto" e "di quanto si è mosso il puntatore": trasformare
// uno spostamento come un punto lo sposterebbe una seconda volta.
export function mapVector(t: Transform, dx: number, dy: number): { x: number; y: number } {
  return { x: t.a * dx + t.c * dy, y: t.b * dx + t.d * dy };
}

// Il box di un nodo in coordinate MONDO. Il box del modello (x, y, width,
// height) è scritto nello spazio del PARENT, quindi la trasformazione da
// applicare è quella del parent -- vedi l'avvertenza su worldTransformOf.
export function worldBoundsOfNode(scene: SceneState, n: NodeLite): Bounds {
  return mapBounds(worldTransformOf(scene, n.parentId), boundsOfNode(n));
}

// Punto dallo spazio locale del contenitore `spaceId` al mondo, e ritorno --
// OPPURE la versione ROTAZIONE (rotateAround attorno a un centro), a seconda del
// secondo argomento. Le due vivono sotto lo stesso nome perché sono la stessa
// domanda ("porta questo punto da locale a mondo") posta a due strati diversi:
//   - (scene, spaceId, x, y)  scende/risale l'albero dei container (annidamento);
//   - (point, center, deg)    ruota un punto attorno al centro di un box (T2).
// Il discriminante è il secondo argomento: una stringa è uno spaceId, un Point è
// un centro di rotazione.
export function localToWorld(p: Point, c: Point, deg: number): Point;
export function localToWorld(scene: SceneState, spaceId: string, x: number, y: number): { x: number; y: number };
export function localToWorld(
  a: Point | SceneState,
  b: Point | string,
  c: number,
  d?: number,
): { x: number; y: number } {
  if (typeof b === "string") return applyTransform(worldTransformOf(a as SceneState, b), c, d as number);
  return rotateAround(a as Point, b, c);
}

export function worldToLocal(p: Point, c: Point, deg: number): Point;
export function worldToLocal(scene: SceneState, spaceId: string, wx: number, wy: number): { x: number; y: number };
export function worldToLocal(
  a: Point | SceneState,
  b: Point | string,
  c: number,
  d?: number,
): { x: number; y: number } {
  if (typeof b === "string") {
    return applyTransform(invertTransform(worldTransformOf(a as SceneState, b)), c, d as number);
  }
  return rotateAround(a as Point, b, -c);
}
