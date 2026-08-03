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

// "Questo nodo lascia dei pixel?" -- indipendentemente da `visible`, che è una
// scelta dell'utente, mentre questa è una proprietà della GEOMETRIA. Una forma
// degenere (larghezza o altezza <= 0) non ha niente da riempire.
//
// Il guard NON vale per il testo: l'altezza di un nodo testo la produce il
// layout (e la width è solo la larghezza di wrap), quindi un testo appena
// creato può avere height 0 pur essendo disegnato.
//
// Vive qui, in una funzione sola, perché la stessa regola serve in tre punti
// che devono restare d'accordo: chi disegna (drawScene), chi colpisce
// (hitTestNode) e chi calcola la regione da esportare (export/region.ts). Una
// terza copia del predicato sarebbe la solita coppia destinata a divergere --
// e una divergenza qui si vede come "l'export ha ritagliato l'immagine attorno
// a un nodo invisibile".
export function isPaintable(n: NodeLite): boolean {
  return n.kind === "text" || (n.width > 0 && n.height > 0);
}

// Hit-test geometrico puro (nessun ctx / DOM), così resta testabile in Node.
// rect: AABB inclusivo dei bordi. ellisse: equazione normalizzata
// ((wx-cx)/rx)^2 + ((wy-cy)/ry)^2 <= 1, che è il test corretto (l'AABB
// dell'ellisse include gli angoli, che sono fuori dall'ellisse stessa).
export function hitTestNode(n: NodeLite, wx: number, wy: number): boolean {
  // Ciò che non si disegna non si colpisce: quello che si vede deve potersi
  // cliccare, e nient'altro.
  if (!isPaintable(n)) return false;
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
