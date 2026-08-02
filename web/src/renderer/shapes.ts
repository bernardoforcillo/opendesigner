import type { NodeLite } from "../store/types";
import { lineHeightOf } from "./text";

// Costruisce il Path2D del nodo in coordinate mondo (nessuna trasformazione
// camera qui: la camera è applicata dal chiamante via ctx.setTransform).
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

// Vero quando l'INCHIOSTRO del nodo è il suo box, cioè quando un box degenere
// significa davvero "niente da disegnare e niente da colpire". Vale per rect ed
// ellipse (e per una forma sconosciuta, che questo lato può solo trattare da
// rettangolo), NON per testo e vettoriale:
//   - il testo ha l'altezza prodotta dal layout, quindi un nodo appena creato ha
//     height 0 ed è comunque disegnato;
//   - il vettoriale ha l'inchiostro negli ancoraggi, e per l'invariante del
//     proto il box è la bbox ESATTA della geometria -- quindi un path di un solo
//     punto (il pen tool dopo il primo click) o un segmento orizzontale hanno
//     legittimamente un lato a zero. Scartarli qui li renderebbe invisibili E
//     non cliccabili: raggiungibili solo dal pannello livelli, cancellabili solo
//     da lì.
// Esportata perché drawScene (canvasRenderer.ts) deve fare la STESSA scelta: due
// elenchi di eccezioni divergerebbero al primo tipo aggiunto.
export function inkIsBox(n: NodeLite): boolean {
  return n.kind !== "text" && n.kind !== "vector";
}

// Lato minimo (unità MONDO) del box su cui si afferra un nodo vettoriale. È una
// TOLLERANZA DI SELEZIONE, non un fatto sulla geometria: il modello continua a
// dire il vero (vectorBounds è esatta, e un segmento orizzontale ha davvero
// height 0), ma un box di area zero è colpibile solo da un click con la
// coordinata ESATTA -- cioè mai. Stesso compromesso di textHitBox qui sotto, e
// per lo stesso motivo: l'hit-test non conosce la camera, quindi la tolleranza è
// in unità mondo e non in px schermo. Quando arriverà il renderer del path
// questa diventa la distanza di presa dalla curva, e allora avrà i suoi px.
export const VECTOR_MIN_GRAB = 4;

// Il box su cui un nodo si SELEZIONA (click e marquee), che non è sempre il box
// del modello. Una sola definizione perché hit-test e marquee devono essere
// d'accordo: un nodo che si clicca ma che il marquee non prende (o viceversa)
// è la peggiore delle due possibilità.
export function selectionBoundsOfNode(n: NodeLite): Box {
  if (n.kind !== "vector") return { x: n.x, y: n.y, width: n.width, height: n.height };
  // Solo l'asse DEGENERE si allarga, e centrato sull'inchiostro: un path normale
  // resta com'è (e non ruba click alle forme sotto), un segmento orizzontale
  // diventa afferrabile da sopra come da sotto.
  const dw = Math.max(0, VECTOR_MIN_GRAB - n.width);
  const dh = Math.max(0, VECTOR_MIN_GRAB - n.height);
  return { x: n.x - dw / 2, y: n.y - dh / 2, width: n.width + dw, height: n.height + dh };
}

// Hit-test geometrico puro (nessun ctx / DOM), così resta testabile in Node.
// rect: AABB inclusivo dei bordi. ellisse: equazione normalizzata
// ((wx-cx)/rx)^2 + ((wy-cy)/ry)^2 <= 1, che è il test corretto (l'AABB
// dell'ellisse include gli angoli, che sono fuori dall'ellisse stessa).
export function hitTestNode(n: NodeLite, wx: number, wy: number): boolean {
  // Il guard sulla dimensione vale solo per le forme il cui inchiostro È il box
  // (vedi inkIsBox), esattamente come in drawScene (canvasRenderer.ts).
  if (inkIsBox(n) && (n.width <= 0 || n.height <= 0)) return false;
  // Il testo si colpisce sul suo BOUNDING BOX, mai sui glifi: è il
  // comportamento atteso in un editor (cliccare fra due lettere, o nello spazio
  // vuoto a destra di una riga corta, seleziona comunque il nodo) ed è anche
  // l'unico test possibile senza misurare il font. Ramo esplicito e non
  // implicito nel fallback: se un giorno il ramo "rect" imparasse i corner
  // radius, il testo non deve seguirlo.
  if (n.kind === "text") return insideBox(textHitBox(n), wx, wy);
  // Il vettoriale si colpisce (per ora) sul suo box di selezione, non sul path:
  // la prossimità alla curva arriva col renderer del path. Passa comunque da
  // selectionBoundsOfNode e non dal box grezzo, così un path degenere -- che per
  // l'invariante del proto ha un lato a zero -- resta afferrabile.
  if (n.kind === "vector") return insideBox(selectionBoundsOfNode(n), wx, wy);
  if (n.kind === "ellipse") {
    const cx = n.x + n.width / 2;
    const cy = n.y + n.height / 2;
    const rx = n.width / 2;
    const ry = n.height / 2;
    const nx = (wx - cx) / rx;
    const ny = (wy - cy) / ry;
    return nx * nx + ny * ny <= 1;
  }
  return insideBox(n, wx, wy);
}

export interface Box { x: number; y: number; width: number; height: number }

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
