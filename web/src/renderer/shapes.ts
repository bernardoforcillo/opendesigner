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

// Hit-test geometrico puro (nessun ctx / DOM), così resta testabile in Node.
// rect: AABB inclusivo dei bordi. ellisse: equazione normalizzata
// ((wx-cx)/rx)^2 + ((wy-cy)/ry)^2 <= 1, che è il test corretto (l'AABB
// dell'ellisse include gli angoli, che sono fuori dall'ellisse stessa).
export function hitTestNode(n: NodeLite, wx: number, wy: number): boolean {
  // Il guard sulla dimensione NON vale per il testo, esattamente come in
  // drawScene (canvasRenderer.ts): un testo con height 0 -- un nodo appena
  // creato, la cui altezza la produce il layout -- viene disegnato, e ciò che
  // si vede deve potersi cliccare. Una forma degenere invece non ha né
  // riempimento né area da colpire.
  if (n.kind !== "text" && (n.width <= 0 || n.height <= 0)) return false;
  // Il testo si colpisce sul suo BOUNDING BOX, mai sui glifi: è il
  // comportamento atteso in un editor (cliccare fra due lettere, o nello spazio
  // vuoto a destra di una riga corta, seleziona comunque il nodo) ed è anche
  // l'unico test possibile senza misurare il font. Ramo esplicito e non
  // implicito nel fallback: se un giorno il ramo "rect" imparasse i corner
  // radius, il testo non deve seguirlo.
  if (n.kind === "text") return insideBox(textHitBox(n), wx, wy);
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
