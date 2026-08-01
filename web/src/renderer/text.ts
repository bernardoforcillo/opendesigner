import type { NodeLite, TextAlignLite, TextStyleLite } from "../store/types";

// I default del testo vivono QUI e in nessun altro posto. Il modello conserva
// gli zeri (uno stile assente diventa uno stile tutto a zero, vedi
// store/types.ts) perché deve restare indistinguibile da core.Apply in Go: è il
// renderer che decide cosa significa "non specificato", esattamente come dice
// il commento del proto ("" => default del renderer, line_height 0 => 1.2).
export const DEFAULT_FONT_FAMILY = "Inter, sans-serif";
export const DEFAULT_FONT_SIZE = 16;
export const DEFAULT_FONT_WEIGHT = "400";
export const DEFAULT_LINE_HEIGHT = 1.2;

// Frazione dell'em che sta SOPRA la baseline. È un'approssimazione: le metriche
// vere (actualBoundingBoxAscent) esistono solo con un ctx e cambiano da font a
// font, mentre il layout deve girare anche senza DOM. 0.8em è il valore tipico
// dell'ascent di un font sans-serif e tiene la baseline dentro la riga per ogni
// moltiplicatore >= 1.
const ASCENT_RATIO = 0.8;

export interface TextLayout {
  lines: string[];
  lineHeight: number;
  ascent: number;
  width: number;
  height: number;
}

function fontSizeOf(style: TextStyleLite): number {
  return style.fontSize > 0 ? style.fontSize : DEFAULT_FONT_SIZE;
}

function lineHeightOf(style: TextStyleLite): number {
  const mult = style.lineHeight > 0 ? style.lineHeight : DEFAULT_LINE_HEIGHT;
  return fontSizeOf(style) * mult;
}

// Shorthand CSS accettato da ctx.font: "<weight> <size>px <family>".
export function fontString(style: TextStyleLite): string {
  const weight = style.fontWeight !== "" ? style.fontWeight : DEFAULT_FONT_WEIGHT;
  const family = style.fontFamily !== "" ? style.fontFamily : DEFAULT_FONT_FAMILY;
  return `${weight} ${fontSizeOf(style)}px ${family}`;
}

// Offset x di UNA riga dentro il box, in coordinate relative al box.
// Con un box senza larghezza (un nodo testo appena creato) center e destra non
// hanno un riferimento: si ricade su sinistra invece di disegnare a x negative.
export function alignOffsetX(align: TextAlignLite, lineWidth: number, boxWidth: number): number {
  if (!(boxWidth > 0)) return 0;
  if (align === "center") return (boxWidth - lineWidth) / 2;
  if (align === "right") return boxWidth - lineWidth;
  return 0;
}

// Gli spazi in coda "sporgono" fuori dalla larghezza di wrap, come nei browser:
// senza questa regola, digitare "aaa bbb " farebbe comparire una riga vuota
// sotto al testo a ogni parola completata (lo spazio finale mandava la riga
// oltre maxWidth). Vale sia per il fit del wrap sia per la larghezza misurata.
function visible(s: string): string {
  return s.replace(/\s+$/, "");
}

// Spezza una parola più larga della riga. Il carattere singolo NON viene mai
// rifiutato: è ciò che garantisce il progresso e quindi la terminazione anche
// con maxWidth più stretto di un glifo (traboccare è accettabile, non
// terminare no). Array.from itera per code point, così una coppia surrogata
// (emoji) non viene spezzata a metà.
function breakWord(measure: (s: string) => number, word: string, maxWidth: number): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const ch of Array.from(word)) {
    const candidate = cur + ch;
    if (cur !== "" && measure(candidate) > maxWidth) {
      chunks.push(cur);
      cur = ch;
    } else {
      cur = candidate;
    }
  }
  if (cur !== "") chunks.push(cur);
  return chunks;
}

function wrapParagraph(
  measure: (s: string) => number,
  para: string,
  maxWidth: number,
  out: string[],
): void {
  // Un paragrafo vuoto è una riga vuota: i newline espliciti creano righe
  // anche quando non c'è niente da disegnarci.
  if (para === "") { out.push(""); return; }
  if (!(maxWidth > 0) || !Number.isFinite(maxWidth)) { out.push(para); return; }

  const fits = (s: string) => measure(visible(s)) <= maxWidth;
  let line = "";
  // Piazza una parola su una riga vuota, spezzandola se da sola non ci sta.
  // Ritorna il residuo che resta in riga.
  const placeAlone = (word: string): string => {
    if (fits(word)) return word;
    const chunks = breakWord(measure, word, maxWidth);
    out.push(...chunks.slice(0, -1));
    return chunks[chunks.length - 1] ?? "";
  };

  for (const word of para.split(" ")) {
    if (line === "") { line = placeAlone(word); continue; }
    const candidate = `${line} ${word}`;
    if (fits(candidate)) { line = candidate; continue; }
    out.push(line);
    line = placeAlone(word);
  }
  out.push(line);
}

// Layout greedy del testo dentro una larghezza di wrap.
//
// `measure` è una funzione e non il ctx di proposito: così il layout è
// verificabile in Node con una misura finta e deterministica, e in produzione
// riceve (s) => ctx.measureText(s).width (con ctx.font GIÀ impostato).
//
// Invariante: height === lines.length * lineHeight. Contenuto vuoto => nessuna
// riga e altezza 0; `lineHeight` resta comunque risolto, perché è la misura che
// serve al caret di un testo ancora vuoto.
export function layoutText(
  measure: (s: string) => number,
  content: string,
  style: TextStyleLite,
  maxWidth: number,
): TextLayout {
  const lineHeight = lineHeightOf(style);
  // half-leading come in CSS: l'interlinea in eccesso si divide sopra e sotto,
  // così la prima riga non si incolla al bordo superiore del box.
  const ascent = (lineHeight - fontSizeOf(style)) / 2 + fontSizeOf(style) * ASCENT_RATIO;
  if (content === "") return { lines: [], lineHeight, ascent, width: 0, height: 0 };

  const lines: string[] = [];
  for (const para of content.replace(/\r\n?/g, "\n").split("\n")) {
    wrapParagraph(measure, para, maxWidth, lines);
  }
  let width = 0;
  for (const line of lines) {
    const paint = visible(line);
    width = Math.max(width, paint === "" ? 0 : measure(paint));
  }
  return { lines, lineHeight, ascent, width, height: lines.length * lineHeight };
}

// Disegna il testo del nodo in coordinate MONDO (la camera è già nella
// trasformazione del ctx, come per le altre forme). Il colore lo imposta il
// chiamante (drawScene mette fillStyle e globalAlpha dal nodo): qui si tocca
// solo ciò che riguarda il testo.
export function drawText(ctx: CanvasRenderingContext2D, n: NodeLite): void {
  const t = n.text;
  if (n.kind !== "text" || !t || t.content === "") return;
  const style = t.style;

  // ctx.font va impostato PRIMA di misurare: measureText usa il font corrente.
  ctx.font = fontString(style);
  // Mai il default: il valore iniziale di textBaseline è "alphabetic" per
  // specifica, ma lasciarlo implicito significa dipendere dallo stato lasciato
  // da chi ha disegnato prima. La y delle righe è calcolata rispetto alla
  // baseline alfabetica, che è l'unica ancora stabile fra browser e font
  // ("top" dipende dalle metriche di ascent del font).
  ctx.textBaseline = "alphabetic";
  // Stessa ragione: l'allineamento lo calcola alignOffsetX riga per riga
  // rispetto al box del nodo, non il ctx.
  ctx.textAlign = "left";

  const layout = layoutText((s) => ctx.measureText(s).width, t.content, style, n.width);
  for (let i = 0; i < layout.lines.length; i++) {
    // Gli spazi in coda non si disegnano (sono invisibili) ma allargherebbero
    // la misura, e con align center/right sposterebbero la riga.
    const line = visible(layout.lines[i]);
    // Una riga vuota non si disegna ma occupa comunque il suo slot verticale.
    if (line === "") continue;
    const x = n.x + alignOffsetX(style.align, ctx.measureText(line).width, n.width);
    ctx.fillText(line, x, n.y + layout.ascent + i * layout.lineHeight);
  }
}
