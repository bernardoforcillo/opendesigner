import type { NodeLite, TextStyleLite } from "../store/types";
import type { Bounds } from "../canvas/geometry";
import { resolvedFill } from "../renderer/canvasRenderer";
import { fontFamilyOf, fontSizeOf, fontWeightOf, placeTextLines } from "../renderer/text";

// EXPORT SVG — markup a partire dai NODI.
//
// Funzione pura: nodi dentro, testo fuori. Nessun DOM, nessun canvas, nessuna
// camera. È la ragione per cui la correttezza dell'export SVG è verificabile a
// tavolino, mentre quella del PNG richiede dei pixel.
//
// Il testo esce come <text> VERO e non come tracciato: un testo convertito in
// path non è più né selezionabile né modificabile né cercabile in nessuno
// strumento a valle, e l'unico vantaggio (l'indipendenza dal font installato)
// non vale quella perdita in un editor di design.

// Misura di UNA riga con lo stile dato, in unità mondo.
//
// È un parametro e non un dettaglio interno perché misurare i glifi richiede un
// contesto 2D: in produzione arriva da un canvas (vedi export/exportScene.ts),
// così l'andata a capo dell'SVG è ESATTAMENTE quella del canvas; nei test
// arriva una misura finta e deterministica.
export type MeasureText = (text: string, style: TextStyleLite) => number;

// Cifre decimali tenute nel markup. 3 sono ampiamente sotto il pixel a ogni
// scala ragionevole, e tolgono di mezzo le code della virgola mobile
// (0.1 + 0.2 non deve finire nel file come 0.30000000000000004).
const DECIMALS = 3;

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "0";
  const p = 10 ** DECIMALS;
  // + 0 normalizza lo zero negativo: Math.round(-0.0001 * p) / p è -0, e
  // String(-0) è "-0", che è valido ma è rumore in un file di testo.
  return String(Math.round(v * p) / p + 0);
}

// I cinque caratteri che in XML non possono comparire come sé stessi. Si
// escapano anche negli attributi e non solo nel contenuto: `font-family` arriva
// dal modello, quindi da una stringa che l'utente può scrivere.
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function channel(v: number): number {
  // Il clamp non serve ai valori del modello (RGBA float 0..1) ma protegge il
  // FILE: un rgb() fuori scala è markup invalido, e un documento che non si
  // apre è peggio di un colore approssimato.
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

interface Attr { name: string; value: string }

function attrs(list: readonly (Attr | null)[]): string {
  return list
    .filter((a): a is Attr => a !== null)
    .map((a) => ` ${a.name}="${a.value}"`)
    .join("");
}

function attr(name: string, value: string | number): Attr {
  return { name, value: typeof value === "number" ? fmt(value) : esc(value) };
}

// Gli attributi di riempimento di un nodo: colore, alfa della tinta e opacità
// del nodo.
//
// Sono TRE cose distinte e restano distinte, come nel modello e come nel
// canvas: `fill-opacity` è l'alfa della tinta e `opacity` è quella del nodo, e
// il visualizzatore le moltiplica esattamente come ctx moltiplica globalAlpha
// per l'alfa di fillStyle. Le due opacità si omettono quando valgono 1, che è
// il loro valore di default in SVG: attributi neutri in ogni elemento sono solo
// rumore in un file che qualcuno leggerà.
function paintAttrs(n: NodeLite): (Attr | null)[] {
  const f = resolvedFill(n);
  return [
    attr("fill", `rgb(${channel(f.r)},${channel(f.g)},${channel(f.b)})`),
    f.a === 1 ? null : attr("fill-opacity", f.a),
    n.opacity === 1 ? null : attr("opacity", n.opacity),
  ];
}

function rectElement(n: NodeLite): string {
  // Il raggio si clampa a metà del lato più corto, come fa CanvasRenderingContext2D
  // .roundRect: senza, la stessa forma verrebbe disegnata in modo diverso dal
  // canvas e dal visualizzatore SVG. (Anche la specifica SVG clampa rx, ma
  // scriverlo esplicitamente rende il file indipendente da quel dettaglio.)
  const r = Math.min(n.cornerRadius, n.width / 2, n.height / 2);
  return `<rect${attrs([
    attr("x", n.x), attr("y", n.y), attr("width", n.width), attr("height", n.height),
    r > 0 ? attr("rx", r) : null,
    ...paintAttrs(n),
  ])}/>`;
}

function ellipseElement(n: NodeLite): string {
  return `<ellipse${attrs([
    attr("cx", n.x + n.width / 2), attr("cy", n.y + n.height / 2),
    attr("rx", n.width / 2), attr("ry", n.height / 2),
    ...paintAttrs(n),
  ])}/>`;
}

// Il testo: un <text> con un <tspan> per riga, ognuno con la SUA x e y assolute.
//
// Le righe (contenuto, andata a capo, allineamento, baseline) le calcola
// placeTextLines, cioè la stessa funzione che usa il canvas: il testo
// esportato sta dove sta quello disegnato, per costruzione.
//
// Ritorna "" per un testo vuoto -- il canvas in quel caso non disegna niente
// (drawText esce subito), e un <text> vuoto nel file sarebbe un elemento in
// più che non rappresenta nulla.
function textElement(n: NodeLite, measure: MeasureText): string {
  const style = n.text?.style;
  if (!style) return "";
  const lines = placeTextLines((s) => measure(s, style), n);
  if (lines.length === 0) return "";
  const spans = lines
    .map((l) => `<tspan${attrs([attr("x", l.x), attr("y", l.y)])}>${esc(l.text)}</tspan>`)
    .join("");
  // xml:space="preserve" serve agli spazi INIZIALI di una riga, che il canvas
  // disegna e che l'SVG altrimenti collasserebbe. Il prezzo è che ogni spazio
  // bianco DENTRO <text> diventa disegnato: per questo i tspan sono attaccati
  // l'uno all'altro, senza a capo né rientri.
  return `<text${attrs([
    attr("font-family", fontFamilyOf(style)),
    attr("font-size", fontSizeOf(style)),
    attr("font-weight", fontWeightOf(style)),
    ...paintAttrs(n),
  ])} xml:space="preserve">${spans}</text>`;
}

function element(n: NodeLite, measure: MeasureText): string {
  if (n.kind === "text") return textElement(n, measure);
  if (n.kind === "ellipse") return ellipseElement(n);
  return rectElement(n);
}

/**
 * Il markup SVG di `nodes` dentro la regione `bounds`.
 *
 * `nodes` arriva già filtrato e ORDINATO (dal fondo alla cima) da
 * export/region.ts: l'ordine degli elementi in un SVG è l'ordine di
 * sovrapposizione, quindi è lo stesso di quello del canvas.
 *
 * `bounds` finisce nel viewBox e NON nelle coordinate: i nodi restano scritti
 * con le coordinate del modello, e a spostare l'origine ci pensa il viewBox. È
 * il motivo per cui un export non porta dentro nessuna traccia di dove fosse la
 * camera -- e per cui il file resta leggibile accanto al documento.
 */
export function nodesToSvg(
  nodes: readonly NodeLite[],
  bounds: Bounds,
  measure: MeasureText,
): string {
  const body = nodes
    .map((n) => element(n, measure))
    .filter((s) => s !== "")
    .map((s) => `  ${s}`)
    .join("\n");
  const head =
    `<svg xmlns="http://www.w3.org/2000/svg"` +
    attrs([attr("width", bounds.width), attr("height", bounds.height)]) +
    ` viewBox="${fmt(bounds.x)} ${fmt(bounds.y)} ${fmt(bounds.width)} ${fmt(bounds.height)}">`;
  return `${head}\n${body}${body === "" ? "" : "\n"}</svg>\n`;
}
