import type { FillLite, NodeLite } from "../store/types";
import type { Bounds } from "../canvas/geometry";
import { firstBlur, firstShadow, resolvedFill } from "../renderer/canvasRenderer";
import { fontFamilyOf, fontSizeOf, fontWeightOf, placeTextLines } from "../renderer/text";
import type { MeasureText } from "../renderer/text";
import { hasRealStroke, vectorStyleOf } from "../renderer/vectorStyle";
import { subPathsToD } from "../svg/pathData";

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

// La misura del testo è un PARAMETRO e non un dettaglio interno perché misurare
// i glifi richiede un contesto 2D: in produzione arriva da un canvas (vedi
// export/exportScene.ts), così l'andata a capo dell'SVG è ESATTAMENTE quella del
// canvas; nei test arriva una misura finta e deterministica. Il tipo sta in
// renderer/text.ts (lo condivide con export/region.ts) e si ri-esporta da qui
// perché è parte della firma di nodesToSvg.
export type { MeasureText };

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
function paintAttrs(n: NodeLite, defs: string[]): (Attr | null)[] {
  const opacity = n.opacity === 1 ? null : attr("opacity", n.opacity);
  // Un frame senza riempimento è trasparente (come nel canvas), non grigio: il
  // grigio di default di resolvedFill è per le forme.
  if (n.kind === "frame" && n.fills.length === 0) {
    const fx = effectsRef(n, defs);
    return [fx === null ? null : attr("filter", fx), attr("fill", "none"), opacity];
  }
  const f = resolvedFill(n);
  // Il gradiente prima dell'effetto: gli id in <defs> seguono l'ordine di
  // creazione, e un file stabile è più facile da leggere e da confrontare.
  const ref = gradientRef(n, f, defs);
  const fx = effectsRef(n, defs);
  return [
    fx === null ? null : attr("filter", fx),
    attr("fill", ref ?? `rgb(${channel(f.r)},${channel(f.g)},${channel(f.b)})`),
    f.a === 1 || ref !== null ? null : attr("fill-opacity", f.a),
    opacity,
  ];
}

// Gli effetti diventano UN <filter> in <defs>: la prima ombra (feDropShadow) e
// poi la prima sfocatura (feGaussianBlur), nello stesso ordine in cui il canvas
// li applica -- la sfocatura vale anche per l'ombra. Come nel canvas, il
// renderer sceglie la prima ombra e la prima sfocatura del nodo
// (renderer/canvasRenderer.ts::firstShadow).
//
// `blur` dell'ombra è il raggio del canvas 2D, di cui la deviazione standard è
// la metà (feDropShadow vuole la deviazione); `radius` della sfocatura è già una
// deviazione standard. La regione del filtro è in coordinate del documento,
// larga abbastanza da contenere offset e sfocatura: il default (-10%/120%)
// ritaglierebbe un'ombra distante.
function effectsRef(n: NodeLite, defs: string[]): string | null {
  const shadow = firstShadow(n);
  const blur = firstBlur(n);
  if (!shadow && !blur) return null;
  const id = `f${defs.length}`;
  const pad =
    (shadow ? Math.max(Math.abs(shadow.offsetX), Math.abs(shadow.offsetY)) + shadow.blur * 1.5 : 0) +
    (blur ? blur.radius * 3 : 0) + 1;
  const prims =
    (shadow
      ? `<feDropShadow${attrs([
          attr("dx", shadow.offsetX), attr("dy", shadow.offsetY), attr("stdDeviation", shadow.blur / 2),
          attr("flood-color", `rgb(${channel(shadow.color.r)},${channel(shadow.color.g)},${channel(shadow.color.b)})`),
          shadow.color.a === 1 ? null : attr("flood-opacity", shadow.color.a),
        ])}/>`
      : "") +
    (blur ? `<feGaussianBlur${attrs([attr("stdDeviation", blur.radius)])}/>` : "");
  defs.push(
    `<filter${attrs([
      attr("id", id), attr("x", n.x - pad), attr("y", n.y - pad),
      attr("width", n.width + 2 * pad), attr("height", n.height + 2 * pad),
    ])} filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">${prims}</filter>`,
  );
  return `url(#${id})`;
}

// Un gradiente diventa un <linearGradient>/<radialGradient> in <defs>, con le
// stesse coordinate MONDO che il canvas calcola in renderer/canvasRenderer.ts::
// paintStyle (userSpaceOnUse): niente bbox, quindi nessuna deformazione. Ritorna
// il riferimento `url(#id)` da mettere in `fill`, oppure null per le tinte
// piatte e per i gradienti degeneri (stessi casi del canvas).
function gradientRef(n: NodeLite, f: FillLite, defs: string[]): string | null {
  const g = f.gradient;
  if (!g || g.stops.length < 2) return null;
  const x1 = n.x + g.x1 * n.width, y1 = n.y + g.y1 * n.height;
  const x2 = n.x + g.x2 * n.width, y2 = n.y + g.y2 * n.height;
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (!(len > 0)) return null;
  const id = `g${defs.length}`;
  const stops = g.stops
    .map((st) => `<stop${attrs([
      attr("offset", Math.min(1, Math.max(0, st.position))),
      attr("stop-color", `rgb(${channel(st.color.r)},${channel(st.color.g)},${channel(st.color.b)})`),
      st.color.a === 1 ? null : attr("stop-opacity", st.color.a),
    ])}/>`)
    .join("");
  const geom = g.kind === "linear"
    ? attrs([attr("x1", x1), attr("y1", y1), attr("x2", x2), attr("y2", y2)])
    : attrs([attr("cx", x1), attr("cy", y1), attr("r", len)]);
  const tag = g.kind === "linear" ? "linearGradient" : "radialGradient";
  defs.push(`<${tag}${attrs([attr("id", id)])}${geom} gradientUnits="userSpaceOnUse">${stops}</${tag}>`);
  return `url(#${id})`;
}

// Il TRATTO di un nodo: il primo con peso positivo (come il canvas ne disegna
// uno per strokes[i], ma l'SVG ne ha uno solo per elemento). Solo allineamento
// centrato: è l'unico che SVG sa esprimere senza ritagli.
function strokeAttrs(n: NodeLite, defs: string[]): (Attr | null)[] {
  const s = n.strokes.find((st) => st.weight > 0);
  if (!s) return [];
  const ref = gradientRef(n, s.color, defs);
  const vs = n.kind === "vector" ? vectorStyleOf(n) : null;
  return [
    attr("stroke", ref ?? `rgb(${channel(s.color.r)},${channel(s.color.g)},${channel(s.color.b)})`),
    s.color.a === 1 || ref !== null ? null : attr("stroke-opacity", s.color.a),
    attr("stroke-width", s.weight),
    vs && vs.cap !== "butt" ? attr("stroke-linecap", vs.cap) : null,
    vs && vs.join !== "miter" ? attr("stroke-linejoin", vs.join) : null,
    vs && hasRealStroke(n) && vs.miter !== 4 ? attr("stroke-miterlimit", vs.miter) : null,
    vs && vs.dash.length > 0 ? attr("stroke-dasharray", vs.dash.map(fmt).join(" ")) : null,
    vs && vs.dash.length > 0 && vs.dashOffset !== 0 ? attr("stroke-dashoffset", vs.dashOffset) : null,
  ];
}

// Un vettoriale come <path>. Il canvas riempie SOLO i contorni chiusi, mentre
// SVG riempie anche gli aperti (chiudendoli): per restare identici i contorni
// aperti vanno in un <path> a parte, senza riempimento.
function vectorElement(n: NodeLite, defs: string[]): string {
  const subs = n.vector?.subpaths ?? [];
  const vs = vectorStyleOf(n);
  const closed = subs.filter((sp) => sp.closed && sp.anchors.length >= 2);
  const open = subs.filter((sp) => !(sp.closed && sp.anchors.length >= 2) && sp.anchors.length >= 1);
  const stroke = strokeAttrs(n, defs);
  const out: string[] = [];
  const rule = attr("fill-rule", vs.fillRule ?? "evenodd");
  if (closed.length > 0) {
    out.push(`<path${attrs([attr("d", subPathsToD(closed, n.x, n.y, DECIMALS)), ...paintAttrs(n, defs), rule, ...stroke])}/>`);
  }
  if (open.length > 0 && stroke.length > 0) {
    out.push(`<path${attrs([
      attr("d", subPathsToD(open, n.x, n.y, DECIMALS)), attr("fill", "none"),
      n.opacity === 1 ? null : attr("opacity", n.opacity), ...stroke,
    ])}/>`);
  }
  return out.join("");
}

function rectElement(n: NodeLite, defs: string[]): string {
  // Il raggio si clampa a metà del lato più corto, come fa CanvasRenderingContext2D
  // .roundRect: senza, la stessa forma verrebbe disegnata in modo diverso dal
  // canvas e dal visualizzatore SVG. (Anche la specifica SVG clampa rx, ma
  // scriverlo esplicitamente rende il file indipendente da quel dettaglio.)
  const r = Math.min(n.cornerRadius, n.width / 2, n.height / 2);
  return `<rect${attrs([
    attr("x", n.x), attr("y", n.y), attr("width", n.width), attr("height", n.height),
    r > 0 ? attr("rx", r) : null,
    ...paintAttrs(n, defs),
    ...strokeAttrs(n, defs),
  ])}/>`;
}

function ellipseElement(n: NodeLite, defs: string[]): string {
  return `<ellipse${attrs([
    attr("cx", n.x + n.width / 2), attr("cy", n.y + n.height / 2),
    attr("rx", n.width / 2), attr("ry", n.height / 2),
    ...paintAttrs(n, defs),
    ...strokeAttrs(n, defs),
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
function textElement(n: NodeLite, measure: MeasureText, defs: string[]): string {
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
    ...paintAttrs(n, defs),
  ])} xml:space="preserve">${spans}</text>`;
}

/**
 * Da un hash di asset all'URI da scrivere nell'href, oppure null quando i byte
 * non sono raggiungibili.
 *
 * In produzione è un `data:` (vedi export/exportScene.ts): un SVG che
 * riferisse `/assets-api/...` sarebbe rotto appena il file esce da questa
 * macchina, cioè sempre, visto che esportare vuol dire proprio mandarlo
 * altrove.
 */
export type ResolveImageHref = (assetHash: string) => string | null;

// I colori del segnaposto. Sono di proposito gli stessi valori del segnaposto
// del canvas (renderer/canvasRenderer.ts): un'immagine mancante deve avere lo
// stesso aspetto sullo schermo e nel file.
const PLACEHOLDER_FILL = "rgb(0,0,0)";
const PLACEHOLDER_FILL_OPACITY = 0.06;
const PLACEHOLDER_LINE = "rgb(0,0,0)";
const PLACEHOLDER_LINE_OPACITY = 0.35;

// Un'immagine che c'è: <image> sul box del nodo.
//
// `preserveAspectRatio="none"` non è un dettaglio: il canvas disegna con
// `drawImage` a quattro coordinate, cioè TIRA l'immagine sul box del nodo,
// mentre il default SVG ("xMidYMid meet") la adatterebbe dentro lasciando dei
// margini. Senza questo attributo lo stesso documento avrebbe due aspetti
// diversi a seconda di dove lo si guarda.
function imageElement(n: NodeLite, href: string, defs: string[]): string {
  const fx = effectsRef(n, defs);
  return `<image${attrs([
    fx === null ? null : attr("filter", fx),
    attr("x", n.x), attr("y", n.y), attr("width", n.width), attr("height", n.height),
    attr("href", href),
    { name: "preserveAspectRatio", value: "none" },
    n.opacity === 1 ? null : attr("opacity", n.opacity),
  ])}/>`;
}

// Un'immagine che NON c'è: lo stesso segnaposto del canvas -- rettangolo
// tenue, bordo, croce -- invece del <rect> grigio in cui cadeva prima.
//
// Un rettangolo pieno sarebbe la forma sbagliata due volte: non dice che lì
// c'era un'immagine, e si confonde con un rettangolo VERO che l'utente ha
// disegnato. Lo spessore del tratto è in unità del documento (un SVG non ha uno
// zoom da cui dedurre un pixel) e resta sottile su qualunque figura.
function imagePlaceholderElement(n: NodeLite): string {
  const w = n.width;
  const h = n.height;
  const cross = `M${fmt(n.x)} ${fmt(n.y)}L${fmt(n.x + w)} ${fmt(n.y + h)}` +
    `M${fmt(n.x + w)} ${fmt(n.y)}L${fmt(n.x)} ${fmt(n.y + h)}`;
  const body =
    `<rect${attrs([
      attr("x", n.x), attr("y", n.y), attr("width", w), attr("height", h),
      attr("fill", PLACEHOLDER_FILL), attr("fill-opacity", PLACEHOLDER_FILL_OPACITY),
      attr("stroke", PLACEHOLDER_LINE), attr("stroke-opacity", PLACEHOLDER_LINE_OPACITY),
    ])}/>` +
    `<path${attrs([
      attr("d", cross), { name: "fill", value: "none" },
      attr("stroke", PLACEHOLDER_LINE), attr("stroke-opacity", PLACEHOLDER_LINE_OPACITY),
    ])}/>`;
  return `<g${attrs([n.opacity === 1 ? null : attr("opacity", n.opacity)])}>${body}</g>`;
}

function element(n: NodeLite, measure: MeasureText, href: ResolveImageHref, defs: string[]): string {
  if (n.kind === "text") return textElement(n, measure, defs);
  if (n.kind === "ellipse") return ellipseElement(n, defs);
  if (n.kind === "vector") return vectorElement(n, defs);
  if (n.kind === "image") {
    const uri = href(n.image?.assetHash ?? "");
    return uri === null ? imagePlaceholderElement(n) : imageElement(n, uri, defs);
  }
  return rectElement(n, defs);
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
  // Il default è "nessun asset risolvibile", cioè il segnaposto: un chiamante
  // che si dimentica di passare il risolutore ottiene un file ONESTO invece di
  // uno che riferisce URL locali destinati a rompersi altrove.
  href: ResolveImageHref = () => null,
): string {
  const defs: string[] = [];
  const body = nodes
    .map((n) => element(n, measure, href, defs))
    .filter((s) => s !== "")
    .map((s) => `  ${s}`)
    .join("\n");
  const head =
    `<svg xmlns="http://www.w3.org/2000/svg"` +
    attrs([attr("width", bounds.width), attr("height", bounds.height)]) +
    ` viewBox="${fmt(bounds.x)} ${fmt(bounds.y)} ${fmt(bounds.width)} ${fmt(bounds.height)}">`;
  const defsBlock = defs.length === 0 ? "" : `\n  <defs>${defs.join("")}</defs>`;
  return `${head}${defsBlock}\n${body}${body === "" ? "" : "\n"}</svg>\n`;
}
