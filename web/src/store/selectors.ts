import { frameOriginOf } from "./groups";
import type { FillLite, NodeLite, SceneState, StrokeLite } from "./types";

// Il pannello livelli mostra il PRIMO PIANO in cima alla lista: è l'ordine
// INVERSO del disegno (che va dal fondo alla cima, orderKey crescente). Un
// nuovo Object.values() a ogni chiamata: la mappa dei nodi non è ordinata e
// l'ordine di iterazione non è quello di orderKey, quindi c'è comunque un
// sort da fare -- niente da guadagnare a farlo "in place".
export function layersInDrawOrder(scene: SceneState): NodeLite[] {
  return Object.values(scene.nodes).sort((a, b) => (a.orderKey < b.orderKey ? 1 : a.orderKey > b.orderKey ? -1 : 0));
}

// Marcatore di "valore misto" per un campo che differisce fra i nodi
// selezionati. Un Symbol e non una stringa sentinella ("mixed"): un nodo di
// testo potrebbe legittimamente chiamarsi "mixed", e una stringa letterale
// sarebbe indistinguibile da quel valore vero. Il Symbol non collide con
// nessun valore che un NodeLite possa mai contenere.
export const MIXED = Symbol("mixed");
export type Mixed = typeof MIXED;
export type OrMixed<T> = T | Mixed;

export interface SelectionSummary {
  count: number;
  name: OrMixed<string>;
  kind: OrMixed<NodeLite["kind"]>;
  visible: OrMixed<boolean>;
  opacity: OrMixed<number>;
  x: OrMixed<number>;
  y: OrMixed<number>;
  width: OrMixed<number>;
  height: OrMixed<number>;
  rotation: OrMixed<number>;
  cornerRadius: OrMixed<number>;
  fills: OrMixed<FillLite[]>;
  strokes: OrMixed<StrokeLite[]>;
}

function sameColor(a: FillLite, b: FillLite): boolean {
  if (!(a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a)) return false;
  // Due gradienti sono lo stesso valore se hanno stessa forma e stessi stop.
  return JSON.stringify(a.gradient ?? null) === JSON.stringify(b.gradient ?? null);
}

function sameFills(a: FillLite[], b: FillLite[]): boolean {
  return a.length === b.length && a.every((f, i) => sameColor(f, b[i]));
}

// Come sameFills: due array distinti con lo stesso contenuto sono lo STESSO
// valore per l'utente. Peso e allineamento oltre al colore -- due tratti dello
// stesso colore ma di spessore diverso non sono "lo stesso tratto", e il
// pannello deve dire "Misto".
function sameStrokes(a: StrokeLite[], b: StrokeLite[]): boolean {
  return a.length === b.length
    && a.every((s, i) => s.weight === b[i].weight && s.align === b[i].align && sameColor(s.color, b[i].color));
}

// Confronta un campo su tutti i nodi selezionati rispetto al PRIMO: appena
// uno diverge il campo è MIXED, e il resto dei nodi non conta più (short
// circuit, non serve continuare a leggerli). `eq` di default è `Object.is`
// (numeri, stringhe, booleani); fills passa `sameFills` perché due array
// distinti con lo stesso contenuto sono lo STESSO valore per l'utente.
// Generica sull'ELEMENTO e non solo sul campo: x/y non si riassumono dal nodo
// grezzo ma dall'origine della sua cornice (vedi sotto), che è un altro tipo.
function summarize<I, T>(items: readonly I[], get: (n: I) => T, eq: (a: T, b: T) => boolean = Object.is): OrMixed<T> {
  const value = get(items[0]);
  for (let i = 1; i < items.length; i++) {
    if (!eq(get(items[i]), value)) return MIXED;
  }
  return value;
}

// Riassume la selezione per il pannello proprietà: per ogni campo, il valore
// comune a tutti i nodi selezionati o MIXED se differisce. null per una
// selezione vuota (o ridotta a niente perché gli id non esistono più nella
// scena): il pannello proprietà, in quel caso, resta vuoto/disabilitato.
export function selectionSummary(scene: SceneState, ids: readonly string[]): SelectionSummary | null {
  const nodes = ids.map((id) => scene.nodes[id]).filter((n): n is NodeLite => n !== undefined);
  if (nodes.length === 0) return null;
  // x/y sono l'origine della CORNICE, non il campo grezzo del nodo: per tutto
  // ciò che non è un gruppo sono la stessa cosa, per un gruppo no (le sue x/y
  // sono la traslazione che contribuisce ai figli, vedi groups.ts::
  // frameOriginOf). Calcolate una volta sola qui perché servono a due campi.
  const origins = nodes.map((n) => frameOriginOf(scene, n));
  return {
    count: nodes.length,
    name: summarize(nodes, (n) => n.name),
    kind: summarize(nodes, (n) => n.kind),
    visible: summarize(nodes, (n) => n.visible),
    opacity: summarize(nodes, (n) => n.opacity),
    x: summarize(origins, (o) => o.x),
    y: summarize(origins, (o) => o.y),
    width: summarize(nodes, (n) => n.width),
    height: summarize(nodes, (n) => n.height),
    rotation: summarize(nodes, (n) => n.rotation),
    cornerRadius: summarize(nodes, (n) => n.cornerRadius),
    fills: summarize(nodes, (n) => n.fills, sameFills),
    strokes: summarize(nodes, (n) => n.strokes, sameStrokes),
  };
}
