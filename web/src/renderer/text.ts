import type { NodeLite, TextAlignLite, TextStyleLite } from "../store/types";
import type { Bounds } from "../canvas/geometry";

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

// Accettano anche uno stile ASSENTE: un nodo testo senza `text` non è uno
// stato che toNodeLite produce (store/types.ts), ma chi risolve una metrica
// non deve esplodere per questo -- ricade sui default del renderer come per
// ogni altro campo non specificato.
//
// Esportata per la stessa ragione di lineHeightOf: il textarea di editing
// (ui/TextEditorOverlay.tsx) deve mostrare il testo con lo STESSO corpo con cui
// il canvas lo disegnerà, e ricalcolare qui il default (o peggio, scriverlo di
// nuovo) è il modo in cui le due misure divergono al primo cambio.
export function fontSizeOf(style: TextStyleLite | undefined): number {
  return style && style.fontSize > 0 ? style.fontSize : DEFAULT_FONT_SIZE;
}

// Esportata perché è anche la misura minima di un nodo testo per chi non può
// misurare i glifi (l'hit-test in shapes.ts): l'altezza di UNA riga è
// calcolabile dal solo stile, senza ctx.
export function lineHeightOf(style: TextStyleLite | undefined): number {
  const mult = style && style.lineHeight > 0 ? style.lineHeight : DEFAULT_LINE_HEIGHT;
  return fontSizeOf(style) * mult;
}

// Come fontSizeOf, e per lo stesso motivo: l'export SVG (export/svg.ts) scrive
// famiglia e peso in ATTRIBUTI separati, non nello shorthand CSS di ctx.font,
// ma il default di "non specificato" deve restare quello del renderer.
export function fontFamilyOf(style: TextStyleLite | undefined): string {
  return style && style.fontFamily !== "" ? style.fontFamily : DEFAULT_FONT_FAMILY;
}

export function fontWeightOf(style: TextStyleLite | undefined): string {
  return style && style.fontWeight !== "" ? style.fontWeight : DEFAULT_FONT_WEIGHT;
}

// Shorthand CSS accettato da ctx.font: "<weight> <size>px <family>".
export function fontString(style: TextStyleLite): string {
  return `${fontWeightOf(style)} ${fontSizeOf(style)}px ${fontFamilyOf(style)}`;
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
  // null = NIENTE piazzato ancora su questa riga; "" = riga che finora
  // contiene una parola vuota, cioè uno spazio in arrivo. La distinzione è il
  // motivo del sentinella: con `line === ""` per entrambi, gli spazi che
  // aprono una riga ("  ciao", o una riga indentata dopo un \n) sparivano --
  // ogni parola vuota veniva ri-piazzata "da sola" invece di essere unita alla
  // successiva con il suo spazio.
  let line: string | null = null;
  // Piazza una parola su una riga vuota, spezzandola se da sola non ci sta.
  // Ritorna il residuo che resta in riga.
  const placeAlone = (word: string): string => {
    if (fits(word)) return word;
    const chunks = breakWord(measure, word, maxWidth);
    out.push(...chunks.slice(0, -1));
    return chunks[chunks.length - 1] ?? "";
  };

  for (const word of para.split(" ")) {
    if (line === null) { line = placeAlone(word); continue; }
    // Annotazione necessaria: senza, l'inferenza gira in tondo (il tipo
    // ristretto di `line` dipende da `candidate`, che dipende da `line`) e tsc
    // ferma il build con TS7022.
    const candidate: string = `${line} ${word}`;
    if (fits(candidate)) { line = candidate; continue; }
    out.push(line);
    line = placeAlone(word);
  }
  // split(" ") ritorna sempre almeno un elemento e il paragrafo vuoto è già
  // uscito sopra, quindi qui `line` è sempre una stringa; il ?? è solo per il
  // tipo.
  out.push(line ?? "");
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

// Misura di UNA riga con lo stile dato, in unità mondo.
//
// È una funzione e non un ctx per la stessa ragione di layoutText: misurare i
// glifi richiede un contesto 2D, ma chi deve solo SAPERE dove finisce il testo
// (l'export, vedi export/region.ts) non deve per questo diventare impuro. In
// produzione arriva da un canvas vero (export/exportScene.ts::canvasMeasure),
// nei test da una misura finta e deterministica.
//
// Vive qui e non in export/svg.ts (dov'è nata) perché ormai la usano DUE
// moduli di export -- il generatore SVG e il calcolo della regione -- e il tipo
// che li mette d'accordo è una proprietà del testo, non di un formato.
export type MeasureText = (text: string, style: TextStyleLite) => number;

// Una riga di testo GIÀ POSIZIONATA, in coordinate MONDO. La y è quella della
// BASELINE alfabetica (vedi drawText), non del bordo superiore della riga.
// `width` è la larghezza DIPINTA della riga (senza gli spazi in coda, che non
// si vedono): chi disegna la ignora, chi deve sapere quanto spazio occupa il
// testo la usa invece di misurare una seconda volta.
export interface PlacedLine { text: string; x: number; y: number; width: number }

// Le righe che un nodo testo produce, con la loro posizione: esattamente
// quelle che il canvas dipinge, e nello stesso posto.
//
// Estratta da drawText perché serve a DUE consumatori che devono restare
// d'accordo: il canvas (drawText, qui sotto) e l'export SVG
// (export/svg.ts, che ne fa dei <tspan>). Se la posizione delle righe fosse
// calcolata due volte, il testo esportato scivolerebbe rispetto a quello
// disegnato al primo cambiamento del layout -- ed è proprio la cosa che
// nell'immagine esportata si nota.
//
// `measure` è una funzione per lo stesso motivo di layoutText: così questo
// pezzo resta verificabile senza un ctx. Chi disegna passa
// (s) => ctx.measureText(s).width con ctx.font GIÀ impostato.
export function placeTextLines(measure: (s: string) => number, n: NodeLite): PlacedLine[] {
  const t = n.text;
  if (n.kind !== "text" || !t || t.content === "") return [];
  return placeLines(measure, n, t.style, layoutText(measure, t.content, t.style, n.width));
}

// Il piazzamento vero, a partire da un layout GIÀ calcolato: è privata perché
// esiste solo per non far girare layoutText due volte a chi (textPaintBounds)
// ha bisogno sia delle righe piazzate sia dell'altezza del layout.
function placeLines(
  measure: (s: string) => number,
  n: NodeLite,
  style: TextStyleLite,
  layout: TextLayout,
): PlacedLine[] {
  const out: PlacedLine[] = [];
  for (let i = 0; i < layout.lines.length; i++) {
    // Gli spazi in coda non si disegnano (sono invisibili) ma allargherebbero
    // la misura, e con align center/right sposterebbero la riga.
    const line = visible(layout.lines[i]);
    // Una riga vuota non si disegna ma occupa comunque il suo slot verticale.
    if (line === "") continue;
    const width = measure(line);
    out.push({
      text: line,
      x: n.x + alignOffsetX(style.align, width, n.width),
      y: n.y + layout.ascent + i * layout.lineHeight,
      width,
    });
  }
  return out;
}

/**
 * Il rettangolo che un nodo testo DIPINGE davvero, che non è il suo box.
 *
 * Il box del modello non è un limite per il disegno e non lo è mai stato:
 * `drawText` piazza la riga `i` a `y = n.y + ascent + i * lineHeight` senza
 * guardare `n.height`, `drawScene` non ritaglia niente, e nessuno riscrive
 * l'altezza misurata dentro al nodo (il textarea di editing cresce, il nodo
 * no). Un nodo creato con un click è alto UNA riga: basta andare a capo una
 * volta perché il testo esca dal box e continui a vedersi sullo schermo.
 *
 * Chi disegna può permettersi di ignorarlo -- il canvas dello schermo è grande
 * quanto la finestra. Chi RITAGLIA no: l'export dimensiona il file sui bounds,
 * quindi con il box del modello butterebbe via tutto quello che sta sotto la
 * prima riga, in silenzio e con un file che sembra riuscito. Per questo la
 * misura del testo entra fin dentro al calcolo della regione da esportare.
 *
 * È l'UNIONE del box e delle righe, mai una sostituzione: un box più alto del
 * testo (trascinato dall'utente, o rimasto tale dopo aver cancellato delle
 * righe) resta parte di ciò che si esporta, esattamente come lo è a schermo.
 * Il traboccamento orizzontale conta come quello verticale, ed esiste in
 * entrambe le direzioni: una parola più larga del box viene spezzata ma un
 * singolo glifo no (breakWord non rifiuta mai un carattere solo), e con
 * l'allineamento a destra quel residuo sporge a SINISTRA del box.
 */
export function textPaintBounds(measure: MeasureText, n: NodeLite): Bounds {
  const box = { x: n.x, y: n.y, width: n.width, height: n.height };
  const t = n.text;
  if (n.kind !== "text" || !t || t.content === "") return box;

  const m = (s: string) => measure(s, t.style);
  const layout = layoutText(m, t.content, t.style, n.width);
  let minX = n.x;
  let maxX = n.x + n.width;
  for (const line of placeLines(m, n, t.style, layout)) {
    minX = Math.min(minX, line.x);
    maxX = Math.max(maxX, line.x + line.width);
  }
  // In verticale si usa l'altezza del LAYOUT e non l'ultima riga piazzata: le
  // righe vuote non dipingono niente ma occupano il loro slot, e l'altezza del
  // testo è quella che il layout dichiara (invariante di layoutText:
  // height === lines.length * lineHeight).
  const height = Math.max(n.height, layout.height);
  return { x: minX, y: n.y, width: maxX - minX, height };
}

// Disegna il testo del nodo in coordinate MONDO (la camera è già nella
// trasformazione del ctx, come per le altre forme). Il colore lo imposta il
// chiamante (drawScene mette fillStyle e globalAlpha dal nodo): qui si tocca
// solo ciò che riguarda il testo.
export function drawText(ctx: CanvasRenderingContext2D, n: NodeLite): void {
  paintText(ctx, n, (line, x, y) => ctx.fillText(line, x, y));
}

// Il TRATTO del testo. Gemella di drawText -- stesso layout, stesse coordinate,
// stessa riga per riga -- e non una seconda misura: due percorsi di layout
// indipendenti sfaserebbero i glifi tracciati da quelli riempiti al primo
// cambio del wrap.
//
// APPROSSIMAZIONE DICHIARATA: il tratto di un testo è SEMPRE centrato sul
// contorno del glifo, qualunque sia `align`. INSIDE e OUTSIDE si ottengono
// ritagliando col path della forma (vedi canvasRenderer.ts::strokeShape), e un
// glifo un Path2D non ce l'ha -- il canvas 2D non espone il contorno del testo.
// La sporgenza contata nei bounds segue la STESSA regola (metà peso per un nodo
// testo, sempre: canvas/geometry.ts::strokeOutsetOfNode), così quello che si
// misura e quello che si dipinge restano la stessa cosa.
export function strokeText(ctx: CanvasRenderingContext2D, n: NodeLite): void {
  paintText(ctx, n, (line, x, y) => ctx.strokeText(line, x, y));
}

function paintText(
  ctx: CanvasRenderingContext2D,
  n: NodeLite,
  paintLine: (line: string, x: number, y: number) => void,
): void {
  const t = n.text;
  if (n.kind !== "text" || !t || t.content === "") return;

  // ctx.font va impostato PRIMA di misurare: measureText usa il font corrente.
  ctx.font = fontString(t.style);
  // Mai il default: il valore iniziale di textBaseline è "alphabetic" per
  // specifica, ma lasciarlo implicito significa dipendere dallo stato lasciato
  // da chi ha disegnato prima. La y delle righe è calcolata rispetto alla
  // baseline alfabetica, che è l'unica ancora stabile fra browser e font
  // ("top" dipende dalle metriche di ascent del font).
  ctx.textBaseline = "alphabetic";
  // Stessa ragione: l'allineamento lo calcola alignOffsetX riga per riga
  // rispetto al box del nodo, non il ctx.
  ctx.textAlign = "left";

  // placeTextLines (traccia 3) è l'UNICA sorgente della posizione delle righe --
  // la stessa che l'export SVG consuma -- e paintLine (traccia 2) sceglie
  // riempimento o tratto: le due tracce si compongono qui senza una seconda
  // misura del layout.
  for (const line of placeTextLines((s) => ctx.measureText(s).width, n)) {
    paintLine(line.text, line.x, line.y);
  }
}
