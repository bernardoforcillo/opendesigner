import type { NodeLite, SceneState } from "../store/types";
import { ancestorsOf } from "../store/tree";
import { type Bounds, boundsOfNode } from "./geometry";

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
//
// Perché una matrice affine intera e non una semplice coppia (dx, dy): oggi
// l'unica trasformazione che un container contribuisce è una traslazione, ma il
// campo `rotation` esiste già nel modello e la rotazione è in lavorazione su
// un'altra traccia. Con la matrice, aggiungerla è un cambio dentro
// `localTransformOf` e nient'altro: composizione, inversa, hit-test e renderer
// continuano a valere parola per parola. Con una coppia di numeri andrebbe
// riscritto tutto ciò che le usa.

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
// coordinata. Oggi è irraggiungibile (le trasformazioni sono traslazioni, det
// vale sempre 1); resta perché una scala 0 la renderebbe raggiungibile domani.
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

// Ciò che un nodo contribuisce ai PROPRI figli: l'origine del loro spazio è
// l'angolo alto-sinistro del nodo. Un solo posto, così il renderer, l'hit-test
// e i bounds non possono divergere -- ed è QUI che entrerà la rotazione (un
// compose con la rotazione attorno al centro), non nei chiamanti.
//
// Esportata perché il renderer la applica al ctx scendendo (ctx.transform con
// gli stessi sei numeri) e l'hit-test applica la sua INVERSA al punto: sono le
// due direzioni della stessa cosa, e devono restare la stessa cosa.
export function localTransformOf(n: NodeLite): Transform {
  return translation(n.x, n.y);
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
  const node = scene.nodes[id];
  if (!node) return IDENTITY;
  let t = localTransformOf(node);
  // ancestorsOf: dal più vicino al più lontano, si ferma alla pagina ed è già a
  // prova di ciclo (store/tree.ts). Ogni antenato si compone SOPRA quanto
  // accumulato, che è esattamente l'ordine in cui si scende l'albero.
  for (const a of ancestorsOf(scene, id)) t = compose(localTransformOf(a), t);
  return t;
}

// Punto dallo spazio locale del contenitore `spaceId` al mondo, e ritorno.
// `spaceId` è lo stesso di worldTransformOf: un id di nodo (lo spazio dei suoi
// figli) o di pagina (identità).
export function localToWorld(scene: SceneState, spaceId: string, x: number, y: number): { x: number; y: number } {
  return applyTransform(worldTransformOf(scene, spaceId), x, y);
}

export function worldToLocal(scene: SceneState, spaceId: string, wx: number, wy: number): { x: number; y: number } {
  return applyTransform(invertTransform(worldTransformOf(scene, spaceId)), wx, wy);
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
