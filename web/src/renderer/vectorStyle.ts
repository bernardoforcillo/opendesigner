import type { NodeLite } from "../store/types";

// LO STILE EXTRA DEI NODI VETTORIALI (import SVG).
//
// Il modello (Stroke) conosce colore, peso e allineamento, ma non le terminazioni
// (`stroke-linecap`), i giunti (`stroke-linejoin`), il limite di spigolo, il
// tratteggio e la regola di riempimento: cose che un SVG importato porta con sé
// e senza le quali un'icona a tratto (capi tondi) o un'illustrazione con buchi
// (nonzero vs even-odd) si vede DIVERSA dall'originale.
//
// Il proto non si tocca (è del modello, non di chi importa): quei valori
// viaggiano in `Node.meta`, la mappa libera chiave -> valore che esiste per
// questo -- metadati che il modello conserva (op, undo, snapshot, clipboard) e
// che soltanto chi li sa leggere interpreta. Questo file è l'UNICO posto che
// conosce le chiavi: l'importer le scrive, i renderer (canvas 2D, CanvasKit) e
// l'export SVG le leggono da qui.
//
// Tutte le chiavi sono facoltative e hanno un default: un nodo creato dal pen
// tool non ne ha nessuna e si disegna come ha sempre fatto.

export const META_FILL_RULE = "vector.fillRule"; // "nonzero" | "evenodd"
export const META_NO_HAIRLINE = "vector.hairline"; // "0" = non disegnare il filo di 1.5px
export const META_CAP = "stroke.cap"; // "butt" | "round" | "square"
export const META_JOIN = "stroke.join"; // "miter" | "round" | "bevel"
export const META_MITER = "stroke.miter"; // numero
export const META_DASH = "stroke.dash"; // "4,2" in unità mondo
export const META_DASH_OFFSET = "stroke.dashOffset"; // numero

export interface VectorStyle {
  /** null = il default storico del renderer (even-odd). */
  fillRule: CanvasFillRule | null;
  /** Il filo di 1.5px che rende visibile un contorno senza tratto. */
  hairline: boolean;
  cap: CanvasLineCap;
  join: CanvasLineJoin;
  miter: number;
  dash: number[];
  dashOffset: number;
}

function numberOf(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Legge lo stile extra di un nodo. Un valore sconosciuto vale il default. */
export function vectorStyleOf(n: Pick<NodeLite, "meta">): VectorStyle {
  const m = n.meta;
  if (!m) return { fillRule: null, hairline: true, cap: "butt", join: "miter", miter: 10, dash: [], dashOffset: 0 };
  const rule = m[META_FILL_RULE];
  const cap = m[META_CAP];
  const join = m[META_JOIN];
  const dash = (m[META_DASH] ?? "")
    .split(",")
    .map((s) => Number(s))
    .filter((v) => Number.isFinite(v) && v >= 0);
  return {
    fillRule: rule === "nonzero" || rule === "evenodd" ? rule : null,
    hairline: m[META_NO_HAIRLINE] !== "0",
    cap: cap === "round" || cap === "square" ? cap : "butt",
    join: join === "round" || join === "bevel" ? join : "miter",
    miter: numberOf(m[META_MITER], 10),
    // Un tratteggio con somma nulla (o dispari è lecito: si ripete) non esiste.
    dash: dash.some((v) => v > 0) ? dash : [],
    dashOffset: numberOf(m[META_DASH_OFFSET], 0),
  };
}

/**
 * Un nodo vettoriale ha un tratto "vero" quando almeno uno dei suoi `strokes`
 * ha peso positivo. Fino all'import SVG il pannello poteva scrivere strokes su
 * un path senza che il renderer li disegnasse: ora li disegna, e il filo di
 * 1.5px (che esisteva solo per rendere visibile un path senza altro
 * inchiostro) cede il posto al tratto vero.
 */
export function hasRealStroke(n: Pick<NodeLite, "strokes">): boolean {
  return n.strokes.some((s) => s.weight > 0);
}
