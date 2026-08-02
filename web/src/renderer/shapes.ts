import type { NodeLite } from "../store/types";
import { boundsOfNode, inflateBounds, strokeOutsetOfNode } from "../canvas/geometry";
import { centerOf, worldToLocal, type Point } from "../canvas/transform";
import { lineHeightOf } from "./text";

// Il centro attorno a cui il nodo RUOTA: il centro del suo box NON ruotato.
// Una funzione sola, usata dal renderer (che ci applica ctx.rotate) e
// dall'hit-test (che ci applica la rotazione inversa): la convenzione di
// canvas/transform.ts vale solo se i due la leggono dallo stesso posto.
export function nodeCenter(n: NodeLite): Point {
  return centerOf(boundsOfNode(n));
}

// Costruisce il Path2D del nodo in coordinate mondo (nessuna trasformazione
// camera qui: la camera è applicata dal chiamante via ctx.setTransform).
//
// Il path è quello NON ruotato: la rotazione è una trasformazione del contesto
// (drawScene la applica attorno a nodeCenter), non una geometria diversa --
// così il path resta lo stesso oggetto per qualunque angolo e l'hit-test può
// specchiarla portando il punto nello spazio locale.
export function nodePath(n: NodeLite): Path2D {
  const path = new Path2D();
  if (n.kind === "ellipse") {
    const cx = n.x + n.width / 2;
    const cy = n.y + n.height / 2;
    const rx = n.width / 2;
    const ry = n.height / 2;
    path.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI);
  } else if (n.cornerRadius > 0) {
    path.roundRect(n.x, n.y, n.width, n.height, n.cornerRadius);
  } else {
    path.rect(n.x, n.y, n.width, n.height);
  }
  return path;
}

// Hit-test geometrico puro (nessun ctx / DOM), così resta testabile in Node.
// rect: AABB inclusivo dei bordi. ellisse: equazione normalizzata
// ((wx-cx)/rx)^2 + ((wy-cy)/ry)^2 <= 1, che è il test corretto (l'AABB
// dell'ellisse include gli angoli, che sono fuori dall'ellisse stessa).
// Il punto arriva in coordinate MONDO e viene portato nello spazio LOCALE del
// nodo (rotazione inversa attorno a nodeCenter) PRIMA di testare la forma: è
// l'unico modo perché un'ellisse ruotata resti colpita da ellisse invece che
// dal suo rettangolo contenitore -- lo stesso errore che il test normalizzato
// qui sotto esiste per evitare, ma introdotto dalla rotazione.
export function hitTestNode(n: NodeLite, wx: number, wy: number): boolean {
  const local = worldToLocal({ x: wx, y: wy }, nodeCenter(n), n.rotation);
  return hitTestLocal(n, local.x, local.y);
}

function hitTestLocal(n: NodeLite, wx: number, wy: number): boolean {
  // Il guard sulla dimensione NON vale per il testo, esattamente come in
  // drawScene (canvasRenderer.ts): un testo con height 0 -- un nodo appena
  // creato, la cui altezza la produce il layout -- viene disegnato, e ciò che
  // si vede deve potersi cliccare. Una forma degenere invece non ha né
  // riempimento né area da colpire -- e NEMMENO un tratto: senza perimetro non
  // c'è niente da tracciare, quindi il guard sta PRIMA della sporgenza.
  if (n.kind !== "text" && (n.width <= 0 || n.height <= 0)) return false;
  // La sporgenza del tratto ALLARGA il bersaglio: quello che si vede si deve
  // poter cliccare, e un tratto esterno da 20 è una fascia larga 20 tutt'attorno
  // alla forma -- esattamente la parte che si mira per afferrare una forma dal
  // bordo. La misura è quella di canvas/geometry.ts, la stessa che usano
  // marquee ed export: due nozioni diverse di "quanto sporge" darebbero un
  // bersaglio che non coincide con ciò che è dipinto.
  const outset = strokeOutsetOfNode(n);
  // Il testo si colpisce sul suo BOUNDING BOX, mai sui glifi: è il
  // comportamento atteso in un editor (cliccare fra due lettere, o nello spazio
  // vuoto a destra di una riga corta, seleziona comunque il nodo) ed è anche
  // l'unico test possibile senza misurare il font. Ramo esplicito e non
  // implicito nel fallback: se un giorno il ramo "rect" imparasse i corner
  // radius, il testo non deve seguirlo.
  if (n.kind === "text") return insideBox(inflateBounds(textHitBox(n), outset), wx, wy);
  if (n.kind === "ellipse") {
    // La sporgenza si somma ai RAGGI, non all'AABB: il tratto di un'ellisse è
    // un anello, non una cornice quadrata, quindi l'angolo del rettangolo
    // contenitore allargato deve restare un miss come lo era quello del box.
    const cx = n.x + n.width / 2;
    const cy = n.y + n.height / 2;
    const rx = n.width / 2 + outset;
    const ry = n.height / 2 + outset;
    const nx = (wx - cx) / rx;
    const ny = (wy - cy) / ry;
    return nx * nx + ny * ny <= 1;
  }
  return insideBox(inflateBounds(boundsOfNode(n), outset), wx, wy);
}

interface Box { x: number; y: number; width: number; height: number }

// Il box su cui si colpisce un nodo testo, che NON coincide sempre con il box
// del modello: l'altezza la produce il layout e la width è solo la larghezza di
// wrap, quindi un nodo appena creato può averle a 0 pur essendo disegnato. Un
// box degenere non è colpibile da nessun click (servirebbe wy esattamente
// uguale a n.y), quindi il testo riceve il minimo che si può calcolare senza un
// ctx: una riga alta lineHeight e altrettanto larga -- il target del caret di un
// testo ancora vuoto.
//
// È di proposito una SOTTOstima quando il testo trabocca il suo box: senza
// misurare il font l'hit-test può sbagliare per difetto (il nodo resta
// raggiungibile dal pannello livelli) ma non per eccesso, o ruberebbe i click
// alle forme che gli stanno sotto.
function textHitBox(n: NodeLite): Box {
  const min = lineHeightOf(n.text?.style);
  return { x: n.x, y: n.y, width: Math.max(n.width, min), height: Math.max(n.height, min) };
}

function insideBox(b: Box, wx: number, wy: number): boolean {
  return wx >= b.x && wx <= b.x + b.width && wy >= b.y && wy <= b.y + b.height;
}
