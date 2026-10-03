import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { NodeSchema, OpSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Node, Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyTransform, compose, rotateAround, type Transform } from "../canvas/transform";
import { orderKeyBetween } from "../store/orderKey";
import {
  toPbFills, toPbStrokes, toPbSubPaths, toPbTextStyle,
  type FillLite, type GradientLite, type StrokeLite, type SubPathLite, type TextStyleLite,
} from "../store/types";
import { vectorBounds } from "../store/vectorGeometry";
import {
  META_CAP, META_DASH, META_DASH_OFFSET, META_FILL_RULE, META_JOIN, META_MITER, META_NO_HAIRLINE,
} from "../renderer/vectorStyle";
import { parseColor, type Rgba } from "./color";
import { cmdsToSubPaths, parsePathData, transformCmds, type PathCmd } from "./pathData";
import { computeStyle, declaredProps, parseCss, type CssRule, type Decl, type Props } from "./styles";
import {
  isTranslationM, lengthScaleOf, parseTransform, similarityOf, translateM,
} from "./transform";

// IMPORT SVG -> NODI MODIFICABILI.
//
// `importSvg(source, opts)` è PURA: testo dentro, op `createNode` fuori (in
// ordine padre-prima-dei-figli, pronti per un solo gesto). Non tocca lo store,
// non fa rete, non decodifica immagini; l'unico I/O è DOMParser, che esiste
// ovunque giri il resto (browser, jsdom). Gli id arrivano da un generatore
// iniettabile così i test sono deterministici.
//
// COSA DIVENTA COSA
//   <svg>                       -> un GRUPPO radice (la cosa che si seleziona,
//                                  sposta e anima come un oggetto solo)
//   <g>, <a>, <switch>, <use>   -> GRUPPO annidato (la struttura si conserva)
//   <rect>/<circle>/<ellipse>   -> nodo rect/ellipse quando la matrice è una
//                                  similitudine (traslazione+scala uniforme+
//                                  rotazione), altrimenti un PATH
//   <path>/<line>/<polyline>/
//   <polygon>                   -> nodo vettoriale
//   <text>                      -> nodo di testo
//   <image data:...>            -> nodo immagine (l'asset lo carica chi applica)
//
// LE TRASFORMAZIONI SI COTTURANO nella geometria: il modello non ha
// trasformazioni arbitrarie per nodo, quindi ogni `transform` (e il viewBox) si
// compone in una matrice che si applica ad ancoraggi e maniglie. L'unica
// eccezione è la pura traslazione di un <g>, che diventa il x/y del gruppo
// (così il gruppo si può ancora spostare/animare come ci si aspetta).
//
// Tutto ciò che il modello non sa esprimere (filtri, maschere, pattern, ...)
// produce UN avviso con conteggio e un ripiego, mai un'eccezione. Gli unici
// errori veri sono quelli che rendono impossibile importare: non è un SVG,
// troppo grande, troppi nodi.

export class SvgImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SvgImportError";
  }
}

export const MAX_SVG_BYTES = 5 * 1024 * 1024;
export const MAX_SVG_NODES = 5000;
/** Lato lungo massimo (unità mondo) dell'import: come MAX_DROP_SIZE delle immagini. */
export const DEFAULT_MAX_SIZE = 512;
// Elementi visitati in tutto (conta anche i <use> che si moltiplicano): il tetto
// ai NODI da solo non ferma un documento che ne scarta milioni.
const MAX_VISITS = 100_000;
const MAX_DEPTH = 128;

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const INKSCAPE_NS = "http://www.inkscape.org/namespaces/inkscape";

/** Un asset incorporato (data URI) che chi applica gli op deve ancora caricare. */
export interface PendingAsset {
  /** Il nodo immagine creato con assetHash "" da riempire. */
  nodeId: string;
  mime: string;
  bytes: Uint8Array;
  name: string;
}

export interface ImportOptions {
  /** docId stampato negli op (vuoto nei test puri). */
  docId?: string;
  /** Il parent del gruppo radice (id di pagina o di container). */
  parentId?: string;
  /** Order key del gruppo radice (default: la prima chiave). */
  orderKey?: string | null;
  /** Generatore di id (nodi e op). Default: crypto.randomUUID. */
  newId?: () => string;
  /** Nome di ripiego del gruppo radice (es. il nome del file senza estensione). */
  name?: string;
  /** Lato lungo massimo: l'SVG più grande si rimpicciolisce in proporzione. */
  maxSize?: number;
  /** Scala esplicita (vince su maxSize). */
  scale?: number;
  /** Angolo in alto a sinistra del gruppo radice nello spazio del parent. */
  at?: { x: number; y: number };
  /** Larghezza di una riga di testo (serve ad allineare text-anchor). */
  measureText?: (text: string, style: TextStyleLite) => number;
  maxNodes?: number;
  maxBytes?: number;
  /** Interno: misura il contenuto di un SVG privo di viewBox (vedi measureContent). */
  probe?: boolean;
}

export interface ImportResult {
  ops: Op[];
  rootId: string;
  warnings: string[];
  /** Le dimensioni (mondo) del gruppo radice: il viewport dell'SVG scalato. */
  size: { width: number; height: number };
  /** Quanti nodi (gruppi inclusi) sono stati creati. */
  nodeCount: number;
  assets: PendingAsset[];
}

// --- numeri e lunghezze -------------------------------------------------------

// Oltre questa distanza dall'origine una coordinata non è un disegno: è un
// file ostile (o rotto) che farebbe traboccare i box.
const MAX_COORD = 1e9;

const r4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0;

const UNIT: Record<string, number> = {
  "": 1, px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96,
};

/** Una lunghezza SVG in px utente; `ref` è la base delle percentuali. */
function lengthOf(v: string | null | undefined, ref = 0, fontSize = 16): number | undefined {
  if (v == null) return undefined;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|pt|pc|mm|cm|in|em|rem|ex|%)?\s*$/i.exec(v);
  if (!m) return undefined;
  const n = Number(m[1]);
  // Valori non finiti o assurdi ("1e400") non sono lunghezze: tenerli
  // metterebbe Infinity/NaN in un op, che il server rifiuterebbe.
  if (!Number.isFinite(n) || Math.abs(n) > MAX_COORD) return undefined;
  const u = (m[2] ?? "").toLowerCase();
  if (u === "%") return (n / 100) * ref;
  if (u === "em") return n * fontSize;
  if (u === "rem") return n * 16;
  if (u === "ex") return n * fontSize * 0.5;
  return n * UNIT[u];
}

function numberList(s: string | null | undefined): number[] {
  if (!s) return [];
  const out: number[] = [];
  const re = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(Number(m[0]));
  return out;
}

function opacityOf(v: string | undefined): number {
  if (v === undefined) return 1;
  const t = v.trim();
  const n = t.endsWith("%") ? parseFloat(t) / 100 : parseFloat(t);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

// --- il documento -------------------------------------------------------------

const KNOWN_PREFIXES: Record<string, string> = {
  xlink: XLINK_NS,
  inkscape: INKSCAPE_NS,
  sodipodi: "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd",
  sketch: "http://www.bohemiancoding.com/sketch/ns",
  serif: "http://www.serif.com/",
  svg: SVG_NS,
};

// Un SVG scritto a mano (o ricavato da innerHTML) spesso omette gli xmlns: il
// browser lo digerisce, un parser XML rigoroso no. Si aggiungono sul tag
// radice SOLO quelli mancanti e noti, invece di rifiutare un file che chiunque
// vedrebbe rendersi.
function withNamespaces(source: string): string {
  const m = /<svg\b[^>]*>/i.exec(source);
  if (!m) return source;
  let tag = m[0];
  let extra = "";
  if (!/\sxmlns\s*=/.test(tag)) extra += ` xmlns="${SVG_NS}"`;
  for (const [p, uri] of Object.entries(KNOWN_PREFIXES)) {
    if (p === "svg") continue;
    const used = new RegExp(`[\\s<]${p}:[\\w-]+`).test(source);
    if (used && !new RegExp(`xmlns:${p}\\s*=`).test(source)) extra += ` xmlns:${p}="${uri}"`;
  }
  if (extra === "") return source;
  tag = tag.replace(/<svg\b/i, (s) => s + extra);
  return source.slice(0, m.index) + tag + source.slice(m.index + m[0].length);
}

function byteLength(s: string): number {
  return typeof TextEncoder !== "undefined" ? new TextEncoder().encode(s).length : s.length;
}

function parseDocument(source: string, maxBytes: number): Document {
  if (typeof source !== "string" || source.trim() === "") throw new SvgImportError("il file SVG è vuoto");
  if (byteLength(source) > maxBytes) {
    throw new SvgImportError(`il file SVG supera ${Math.round(maxBytes / 1024 / 1024)} MB: troppo grande per essere importato`);
  }
  // Le entità XML definite dal documento sono l'attacco classico dei parser
  // (billion laughs, XXE): un SVG da design non ne ha bisogno, si rifiutano.
  if (/<!ENTITY/i.test(source)) throw new SvgImportError("il file SVG contiene entità XML: non importato per sicurezza");
  const doc = new DOMParser().parseFromString(withNamespaces(source), "image/svg+xml");
  const err = doc.getElementsByTagName("parsererror");
  const root = doc.documentElement;
  if (err.length > 0 || !root || root.localName.toLowerCase() !== "svg") {
    throw new SvgImportError("il file non è un SVG valido");
  }
  return doc;
}

// --- il contesto dell'import ---------------------------------------------------

interface Env {
  opts: ImportOptions;
  doc: Document;
  root: Element;
  ids: Map<string, Element>;
  ruleDecls: Map<Element, Decl[]>;
  declaredCache: Map<Element, Props>;
  ops: Op[];
  assets: PendingAsset[];
  warnings: Map<string, number>;
  counters: Map<string, number>;
  keys: Map<string, string | null>;
  nodeCount: number;
  visits: number;
  maxNodes: number;
  vbW: number;
  vbH: number;
  newId: () => string;
  docId: string;
  useStack: Set<Element>;
  scale: number;
}

interface State {
  /** Dalle coordinate utente dell'elemento allo spazio del NODO parent. */
  M: Transform;
  /** Stile calcolato del genitore (per l'ereditarietà). */
  style: Props;
  /** Prodotto delle `opacity` degli antenati (i gruppi non la disegnano). */
  opacity: number;
  depth: number;
  /** Il parent è nascosto da display:none: i figli restano, nascosti. */
  hidden: boolean;
}

function warn(env: Env, message: string): void {
  env.warnings.set(message, (env.warnings.get(message) ?? 0) + 1);
}

function declared(env: Env, el: Element): Props {
  let p = env.declaredCache.get(el);
  if (!p) {
    p = declaredProps(el, env.ruleDecls.get(el));
    env.declaredCache.set(el, p);
  }
  return p;
}

function nextKey(env: Env, parentId: string): string {
  const k = orderKeyBetween(env.keys.get(parentId) ?? null, null);
  env.keys.set(parentId, k);
  return k;
}

function pushNode(env: Env, node: Node): number {
  if (env.nodeCount >= env.maxNodes) {
    throw new SvgImportError(`l'SVG ha troppi elementi (oltre ${env.maxNodes}): non importato`);
  }
  env.nodeCount++;
  env.ops.push(create(OpSchema, {
    opId: env.newId(), docId: env.docId, kind: { case: "createNode", value: { node } },
  }));
  return env.ops.length - 1;
}

// --- nomi ---------------------------------------------------------------------

function cleanName(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}

// L'etichetta che l'autore ha dato all'elemento, se c'è: è ciò che l'animazione
// userà per indirizzarlo, quindi ha la precedenza su ogni nome generato.
function labelOf(el: Element, withId = true): string {
  const candidates = [
    el.getAttributeNS(INKSCAPE_NS, "label") ?? el.getAttribute("inkscape:label"),
    el.getAttribute("data-name"),
    withId ? el.getAttribute("id") : null,
    el.getAttribute("aria-label"),
  ];
  for (const c of candidates) {
    const n = c ? cleanName(c) : "";
    if (n !== "") return n;
  }
  return "";
}

function nameOf(env: Env, el: Element, base: string): string {
  const label = labelOf(el);
  if (label !== "") return label;
  const n = (env.counters.get(base) ?? 0) + 1;
  env.counters.set(base, n);
  return `${base} ${n}`;
}

// --- paint e gradienti --------------------------------------------------------

const NO_FILL: FillLite = { r: 0, g: 0, b: 0, a: 0 };

type PaintSpec =
  | { t: "none" }
  | { t: "color"; c: Rgba }
  | { t: "grad"; el: Element };

function parsePaint(env: Env, raw: string | undefined, style: Props, fallbackNone: boolean): PaintSpec {
  const dflt: PaintSpec = fallbackNone ? { t: "none" } : { t: "color", c: { r: 0, g: 0, b: 0, a: 1 } };
  if (raw === undefined) return dflt;
  const v = raw.trim();
  if (v === "" ) return dflt;
  const low = v.toLowerCase();
  if (low === "none") return { t: "none" };
  const currentColor = (): Rgba => parseColor(style.get("color") ?? "") ?? { r: 0, g: 0, b: 0, a: 1 };
  if (low === "currentcolor") return { t: "color", c: currentColor() };
  const u = /^url\(\s*(['"]?)([^'")]*)\1\s*\)\s*(.*)$/i.exec(v);
  if (u) {
    const fb = u[3].trim();
    const fbSpec: PaintSpec | null = fb === ""
      ? null
      : fb.toLowerCase() === "none" ? { t: "none" }
      : fb.toLowerCase() === "currentcolor" ? { t: "color", c: currentColor() }
      : (() => { const c = parseColor(fb); return c ? { t: "color" as const, c } : null; })();
    if (!u[2].startsWith("#")) {
      warn(env, "riferimento esterno a un paint ignorato");
      return fbSpec ?? { t: "none" };
    }
    const target = env.ids.get(u[2].slice(1));
    const tag = target?.localName;
    if (tag === "linearGradient" || tag === "radialGradient") return { t: "grad", el: target as Element };
    if (tag === "pattern") {
      warn(env, "pattern non supportato: sostituito da un grigio");
      return fbSpec ?? { t: "color", c: { r: 0.5, g: 0.5, b: 0.5, a: 1 } };
    }
    warn(env, `paint "${u[2]}" non trovato`);
    return fbSpec ?? { t: "none" };
  }
  if (low === "context-fill" || low === "context-stroke") return dflt;
  const c = parseColor(v);
  if (c) return { t: "color", c };
  warn(env, `colore "${v.slice(0, 30)}" non riconosciuto`);
  return dflt;
}

interface GradStop { offset: number; color: Rgba }

interface GradDef {
  radial: boolean;
  attr: (name: string) => string | null;
  stops: GradStop[];
}

function hrefOf(el: Element): string | null {
  return el.getAttribute("href") ?? el.getAttributeNS(XLINK_NS, "href") ?? el.getAttribute("xlink:href");
}

function resolveGradient(env: Env, el: Element): GradDef {
  const chain: Element[] = [];
  let cur: Element | undefined = el;
  while (cur && chain.length < 12 && !chain.includes(cur)) {
    chain.push(cur);
    const h = hrefOf(cur);
    cur = h && h.startsWith("#") ? env.ids.get(h.slice(1)) : undefined;
    if (cur && cur.localName !== "linearGradient" && cur.localName !== "radialGradient") cur = undefined;
  }
  const attr = (name: string): string | null => {
    for (const g of chain) {
      const v = g.getAttribute(name);
      if (v !== null && v.trim() !== "") return v.trim();
    }
    return null;
  };
  const stopHolder = chain.find((g) => childElements(g).some((c) => c.localName === "stop"));
  const stops: GradStop[] = [];
  let prev = 0;
  for (const s of (stopHolder ? childElements(stopHolder) : [])) {
    if (s.localName !== "stop") continue;
    const p = declared(env, s);
    const rawOff = s.getAttribute("offset") ?? "0";
    let off = rawOff.trim().endsWith("%") ? parseFloat(rawOff) / 100 : parseFloat(rawOff);
    if (!Number.isFinite(off)) off = 0;
    off = Math.min(1, Math.max(prev, Math.max(0, off)));
    prev = off;
    const raw = p.get("stop-color");
    const col = raw === undefined ? { r: 0, g: 0, b: 0, a: 1 }
      : raw.trim().toLowerCase() === "currentcolor" ? (parseColor(p.get("color") ?? "") ?? { r: 0, g: 0, b: 0, a: 1 })
      : (parseColor(raw) ?? { r: 0, g: 0, b: 0, a: 1 });
    const so = opacityOf(p.get("stop-opacity"));
    stops.push({ offset: off, color: { ...col, a: col.a * so } });
  }
  return { radial: el.localName === "radialGradient", attr, stops };
}

/** La geometria in cui un paint viene valutato: serve a normalizzare i gradienti. */
interface PaintGeom {
  /** Box del nodo nello spazio del parent (non ruotato). */
  box: { x: number; y: number; width: number; height: number };
  rotation: number;
  /** Dalle coordinate utente dell'elemento allo spazio del nodo parent. */
  M: Transform;
  /** Bounding box utente dell'elemento (per objectBoundingBox). Pigro. */
  userBBox: () => { x: number; y: number; width: number; height: number } | null;
}

function solidOf(c: Rgba, alphaMul: number): FillLite {
  return { r: c.r, g: c.g, b: c.b, a: c.a * alphaMul };
}

function gradientPaint(env: Env, el: Element, g: PaintGeom, alphaMul: number): FillLite | null {
  const def = resolveGradient(env, el);
  if (def.stops.length === 0) return null;
  const first = def.stops[0].color;
  const last = def.stops[def.stops.length - 1].color;
  if (def.stops.length === 1) return solidOf(first, alphaMul);

  const spread = def.attr("spreadMethod");
  if (spread && spread !== "pad") warn(env, `gradiente con spreadMethod="${spread}": reso come "pad"`);

  const obb = (def.attr("gradientUnits") ?? "objectBoundingBox") !== "userSpaceOnUse";
  const gt = parseTransform(def.attr("gradientTransform")).matrix;
  let total: Transform;
  if (obb) {
    const bb = g.userBBox();
    if (!bb || !(bb.width > 0) || !(bb.height > 0)) return solidOf(first, alphaMul);
    total = compose(compose(g.M, { a: bb.width, b: 0, c: 0, d: bb.height, e: bb.x, f: bb.y }), gt);
  } else {
    total = compose(g.M, gt);
  }
  // Coordinate: in bbox sono frazioni (numero o %), in user space sono
  // lunghezze con le percentuali riferite al viewport.
  const coord = (name: string, dflt: string, axis: "x" | "y" | "d"): number => {
    const raw = def.attr(name) ?? dflt;
    if (obb) {
      const t = raw.trim();
      const n = t.endsWith("%") ? parseFloat(t) / 100 : parseFloat(t);
      return Number.isFinite(n) ? n : 0;
    }
    const ref = axis === "x" ? env.vbW : axis === "y" ? env.vbH : Math.hypot(env.vbW, env.vbH) / Math.SQRT2;
    return lengthOf(raw, ref) ?? 0;
  };
  const { box, rotation } = g;
  if (!(box.width > 0) || !(box.height > 0)) return solidOf(first, alphaMul);
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // Dallo spazio del parent al box NORMALIZZATO del nodo (annullando la
  // rotazione, che il renderer applica al contesto).
  const norm = (p: { x: number; y: number }) => {
    const q = rotation === 0 ? p : rotateAround(p, center, -rotation);
    return { x: (q.x - box.x) / box.width, y: (q.y - box.y) / box.height };
  };
  const stops = def.stops.map((s) => ({
    color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a * alphaMul },
    position: s.offset,
  }));
  let gradient: GradientLite;
  if (!def.radial) {
    const qx1 = coord("x1", obb ? "0" : "0%", "x"), qy1 = coord("y1", obb ? "0" : "0%", "y");
    const qx2 = coord("x2", obb ? "1" : "100%", "x"), qy2 = coord("y2", "0" + (obb ? "" : "%"), "y");
    const dx = qx2 - qx1, dy = qy2 - qy1;
    const len2 = dx * dx + dy * dy;
    const det = total.a * total.d - total.b * total.c;
    // x1==x2 e y1==y2: per specifica l'area si dipinge col colore dell'ultimo stop.
    if (!(len2 > 0)) return solidOf(last, alphaMul);
    if (!(Math.abs(det) > 1e-12)) return solidOf(first, alphaMul);
    const p1 = applyTransform(total, qx1, qy1);
    // Un gradiente lineare è un COVETTORE: t(P) = (P - p1)·g. Con una matrice
    // non similare (bbox non quadrato in objectBoundingBox, scala non uniforme,
    // skew) il covettore NON è il vettore p2-p1 trasformato: è la sua
    // inversa-trasposta. Il modello (come il canvas) ha isolivelli ortogonali
    // all'asse, quindi si ricostruisce un asse p1->p2 con quel covettore e il
    // risultato è ESATTO anche sotto skew, non un'approssimazione.
    const cx = dx / len2, cy = dy / len2;
    const gx = (total.d * cx - total.b * cy) / det;
    const gy = (-total.c * cx + total.a * cy) / det;
    const g2 = gx * gx + gy * gy;
    if (!(g2 > 0)) return solidOf(first, alphaMul);
    const p2 = { x: p1.x + gx / g2, y: p1.y + gy / g2 };
    const n1 = norm(p1);
    const n2 = norm(p2);
    gradient = { kind: "linear", stops, x1: n1.x, y1: n1.y, x2: n2.x, y2: n2.y };
  } else {
    const cx = coord("cx", obb ? "0.5" : "50%", "x");
    const cy = coord("cy", obb ? "0.5" : "50%", "y");
    const r = coord("r", obb ? "0.5" : "50%", "d");
    if (!(r > 0)) return solidOf(last, alphaMul);
    const fx = def.attr("fx");
    const fy = def.attr("fy");
    if ((fx !== null && coord("fx", "0", "x") !== cx) || (fy !== null && coord("fy", "0", "y") !== cy)) {
      warn(env, "gradiente radiale con fuoco decentrato: reso centrato");
    }
    const c = applyTransform(total, cx, cy);
    const ex = applyTransform(total, cx + r, cy);
    const ey = applyTransform(total, cx, cy + r);
    const rx = Math.hypot(ex.x - c.x, ex.y - c.y);
    const ry = Math.hypot(ey.x - c.x, ey.y - c.y);
    // Il modello ha un raggio solo (cerchio): per una ellisse si prende la
    // media geometrica. Esatto quando il bbox è quadrato.
    const rad = Math.sqrt(rx * ry);
    if (Math.abs(rx - ry) > 0.02 * Math.max(rx, ry)) warn(env, "gradiente radiale ellittico approssimato da un cerchio");
    const n1 = norm(c);
    gradient = { kind: "radial", stops, x1: n1.x, y1: n1.y, x2: n1.x + rad / box.width, y2: n1.y };
  }
  return { ...stops[0].color, gradient };
}

function resolveFill(env: Env, spec: PaintSpec, opacity: number, g: PaintGeom): FillLite | null {
  if (spec.t === "none") return null;
  if (spec.t === "color") return solidOf(spec.c, opacity);
  return gradientPaint(env, spec.el, g, opacity);
}

// --- foglie --------------------------------------------------------------------

type Box = { x: number; y: number; width: number; height: number };

interface LeafSpec {
  kind: "rect" | "ellipse" | "vector" | "text" | "image";
  base: string;
  box: Box;
  rotation: number;
  cornerRadius?: number;
  /** Il raggio in unità UTENTE (cornerRadius è già scalato): serve a rifare il path. */
  userRadius?: number;
  subpaths?: SubPathLite[];
  text?: { content: string; style: TextStyleLite };
  image?: { bytes: Uint8Array; mime: string };
  M: Transform;
  userBBox: () => Box | null;
  /** Il tag, per le eccezioni (line non si riempie). */
  tag: string;
  /** Per il nome del nodo di testo. */
  nameHint?: string;
}

function strokeSpecOf(env: Env, style: Props, M: Transform, g: PaintGeom): {
  stroke: StrokeLite | null; cap: string; join: string; miter: number; dash: number[]; dashOffset: number;
} {
  const none = { stroke: null, cap: "butt", join: "miter", miter: 4, dash: [] as number[], dashOffset: 0 };
  const spec = parsePaint(env, style.get("stroke"), style, true);
  if (spec.t === "none") return none;
  const sf = lengthScaleOf(M);
  const fs = lengthOf(style.get("font-size"), 16) ?? 16;
  const w = (lengthOf(style.get("stroke-width"), Math.hypot(env.vbW, env.vbH) / Math.SQRT2, fs) ?? 1) * sf;
  if (!(w > 0)) return none;
  const so = opacityOf(style.get("stroke-opacity"));
  const paint = resolveFill(env, spec, so, g);
  if (!paint) return none;
  const capRaw = style.get("stroke-linecap")?.trim();
  const joinRaw = style.get("stroke-linejoin")?.trim();
  const miter = Number(style.get("stroke-miterlimit"));
  const dashRaw = style.get("stroke-dasharray");
  let dash: number[] = [];
  if (dashRaw && dashRaw.trim().toLowerCase() !== "none") {
    dash = dashRaw.split(/[\s,]+/).filter((s) => s !== "")
      .map((s) => (lengthOf(s, Math.hypot(env.vbW, env.vbH) / Math.SQRT2, fs) ?? NaN) * sf);
    if (dash.some((d) => !Number.isFinite(d) || d < 0) || !dash.some((d) => d > 0)) dash = [];
  }
  return {
    stroke: { color: paint, weight: r4(w), align: "center" },
    cap: capRaw === "round" || capRaw === "square" ? capRaw : "butt",
    join: joinRaw === "round" || joinRaw === "bevel" ? joinRaw : "miter",
    miter: Number.isFinite(miter) && miter >= 1 ? miter : 4,
    dash,
    dashOffset: (lengthOf(style.get("stroke-dashoffset"), 0, fs) ?? 0) * sf,
  };
}

function emitLeaf(
  env: Env,
  parentId: string,
  el: Element,
  spec: LeafSpec,
  style: Props,
  st: State,
  opacity: number,
  visible: boolean,
): void {
  const isText = spec.kind === "text";
  const isImage = spec.kind === "image";
  const geom: PaintGeom = { box: spec.box, rotation: spec.rotation, M: spec.M, userBBox: spec.userBBox };

  // RIEMPIMENTO. `fill="none"` è un riempimento TRASPARENTE e non una lista
  // vuota: per il modello `fills: []` significa "il grigio di default delle
  // forme" (renderer/canvasRenderer.ts::resolvedFill), l'opposto.
  let fills: FillLite[] = [NO_FILL];
  let fillVisible = false;
  if (!isImage) {
    const fSpec = parsePaint(env, style.get("fill"), style, false);
    const fo = opacityOf(style.get("fill-opacity"));
    const f = resolveFill(env, fSpec, fo, geom);
    if (f) { fills = [f]; fillVisible = f.a > 0 || f.gradient !== undefined; }
  }

  let strokes: StrokeLite[] = [];
  const strokeInfo = strokeSpecOf(env, style, spec.M, geom);
  if (!isImage && strokeInfo.stroke) strokes = [strokeInfo.stroke];

  let kind = spec.kind;
  let subpaths = spec.subpaths;
  let box = spec.box;
  let rotation = spec.rotation;
  let cornerRadius = spec.cornerRadius ?? 0;
  const hasStroke = strokes.length > 0;

  // Forme che il renderer non sa tratteggiare/arrotondare sugli spigoli:
  // diventano path (che porta cap/join/dash nei meta) invece di perdere
  // l'aspetto. Un rect con raggio non ha spigoli, quindi il giunto non conta.
  if (hasStroke && (kind === "rect" || kind === "ellipse")) {
    const needPath = strokeInfo.dash.length > 0
      || (kind === "rect" && cornerRadius === 0 && strokeInfo.join !== "miter");
    if (needPath) {
      const n = shapeAsPath(spec, st.M);
      if (n) { kind = "vector"; subpaths = n.subpaths; box = n.box; rotation = 0; }
    }
  }

  // Un tracciato APERTO riempito: SVG lo chiude implicitamente per il
  // riempimento, il modello riempie solo i chiusi. Senza tratto la chiusura
  // è invisibile e si fa; col tratto cambierebbe il disegno, si segnala.
  if (kind === "vector" && subpaths && fillVisible && spec.tag !== "line") {
    const hasOpen = subpaths.some((sp) => !sp.closed && sp.anchors.length > 2);
    if (hasOpen) {
      if (!hasStroke) subpaths = subpaths.map((sp) => (sp.anchors.length > 2 ? { ...sp, closed: true } : sp));
      else warn(env, "tracciato aperto con riempimento e tratto: il riempimento non è disegnato");
    }
  }

  const meta: Record<string, string> = {};
  if (kind === "vector") {
    meta[META_NO_HAIRLINE] = "0";
    const rule = style.get("fill-rule")?.trim();
    meta[META_FILL_RULE] = rule === "evenodd" ? "evenodd" : "nonzero";
    if (hasStroke) {
      if (strokeInfo.cap !== "butt") meta[META_CAP] = strokeInfo.cap;
      if (strokeInfo.join !== "miter") meta[META_JOIN] = strokeInfo.join;
      meta[META_MITER] = String(r4(strokeInfo.miter));
      if (strokeInfo.dash.length > 0) {
        meta[META_DASH] = strokeInfo.dash.map((d) => String(r4(d))).join(",");
        if (strokeInfo.dashOffset !== 0) meta[META_DASH_OFFSET] = String(r4(strokeInfo.dashOffset));
      }
    }
  }

  const id = env.newId();
  // Un'etichetta dell'autore (id, inkscape:label, ...) vince sempre; per il
  // testo, in mancanza, il nome è il contenuto (come in ogni editor).
  const name = isText && spec.nameHint && labelOf(el) === ""
    ? (cleanName(spec.nameHint) || nameOf(env, el, spec.base))
    : nameOf(env, el, spec.base);

  const node = create(NodeSchema, {
    id,
    parentId,
    orderKey: nextKey(env, parentId),
    name,
    visible,
    opacity: r4(opacity),
    x: r4(box.x), y: r4(box.y), width: r4(box.width), height: r4(box.height),
    rotation: r4(rotation),
    fills: isImage ? [] : toPbFills(fills),
    strokes: toPbStrokes(strokes),
    meta,
    shape: shapeInit(kind, spec, subpaths, cornerRadius),
  });
  pushNode(env, node);
  if (isImage && spec.image) {
    env.assets.push({ nodeId: id, mime: spec.image.mime, bytes: spec.image.bytes, name });
  }
}

function shapeInit(kind: LeafSpec["kind"], spec: LeafSpec, subpaths: SubPathLite[] | undefined, cornerRadius: number): MessageInitShape<typeof NodeSchema>["shape"] {
  switch (kind) {
    case "ellipse": return { case: "ellipse" as const, value: {} };
    case "vector": return { case: "vector" as const, value: { subpaths: toPbSubPaths(subpaths ?? []) } };
    case "text": return {
      case: "text" as const,
      value: { content: spec.text?.content ?? "", style: toPbTextStyle(spec.text?.style as TextStyleLite) },
    };
    case "image": return { case: "image" as const, value: { assetHash: "" } };
    default: return { case: "rect" as const, value: { cornerRadius: r4(cornerRadius) } };
  }
}

// Le subpath NORMALIZZATE al box e il box, da comandi già nello spazio del
// parent. Rispetta l'invariante del proto: dopo la scrittura la bbox locale
// della geometria è (0,0)-(width,height), ed è la bbox VERA delle curve.
function normalizeVector(cmds: readonly PathCmd[]): { subpaths: SubPathLite[]; box: Box } | null {
  const raw = cmdsToSubPaths(cmds);
  if (raw.length === 0) return null;
  const b = vectorBounds(raw);
  if (![b.x, b.y, b.width, b.height].every((v) => Number.isFinite(v) && Math.abs(v) <= MAX_COORD)) return null;
  const subpaths = raw.map((sp) => ({
    closed: sp.closed,
    anchors: sp.anchors.map((a) => ({
      x: r4(a.x - b.x), y: r4(a.y - b.y), inX: r4(a.inX), inY: r4(a.inY), outX: r4(a.outX), outY: r4(a.outY),
    })),
  }));
  return { subpaths, box: { x: b.x, y: b.y, width: b.width, height: b.height } };
}

/** Un rect/ellisse come path nello spazio del parent (per le conversioni). */
function shapeAsPath(spec: LeafSpec, _M: Transform): { subpaths: SubPathLite[]; box: Box } | null {
  void _M;
  const bb = spec.userBBox();
  if (!bb) return null;
  const cmds = spec.kind === "ellipse"
    ? ellipseCmds(bb.x + bb.width / 2, bb.y + bb.height / 2, bb.width / 2, bb.height / 2)
    : roundedRectCmds(bb.x, bb.y, bb.width, bb.height, spec.userRadius ?? 0, spec.userRadius ?? 0);
  return normalizeVector(transformCmds(cmds, spec.M));
}

function ellipseCmds(cx: number, cy: number, rx: number, ry: number): PathCmd[] {
  const d = `M${cx + rx} ${cy}A${rx} ${ry} 0 1 1 ${cx - rx} ${cy}A${rx} ${ry} 0 1 1 ${cx + rx} ${cy}Z`;
  return parsePathData(d).cmds;
}

function roundedRectCmds(x: number, y: number, w: number, h: number, rx: number, ry: number): PathCmd[] {
  if (!(rx > 0) && !(ry > 0)) return parsePathData(`M${x} ${y}H${x + w}V${y + h}H${x}Z`).cmds;
  const d =
    `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}` +
    `A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}` +
    `V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
  return parsePathData(d).cmds;
}

// --- visita --------------------------------------------------------------------

const SKIPPED = new Set([
  "defs", "style", "title", "desc", "metadata", "linearGradient", "radialGradient", "pattern",
  "clipPath", "mask", "marker", "filter", "symbol", "script", "foreignObject",
  "animate", "animateTransform", "animateMotion", "set", "mpath",
  "namedview", "font", "font-face", "view", "cursor", "color-profile",
]);
const ANIMATIONS = new Set(["animate", "animateTransform", "animateMotion", "set"]);
const SHAPES = new Set(["rect", "circle", "ellipse", "line", "polyline", "polygon", "path"]);
const CONTAINERS = new Set(["g", "a", "switch", "svg"]);

function isSvgElement(el: Element): boolean {
  return el.namespaceURI === SVG_NS || el.namespaceURI === null || el.namespaceURI === "";
}

// I figli ELEMENTO in un array, percorrendo la catena dei fratelli: l'accesso
// per indice a una HTMLCollection costa O(n) in jsdom (quadratico su migliaia
// di figli: 5000 forme = 4 secondi), mentre firstElementChild/nextElementSibling
// sono O(1) ovunque.
function childElements(el: Element): Element[] {
  const out: Element[] = [];
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) out.push(c);
  return out;
}

function walkChildren(env: Env, container: Element, parentId: string, st: State): void {
  for (const child of childElements(container)) walkElement(env, child, parentId, st);
}

function viewBoxMatrix(
  vb: { x: number; y: number; w: number; h: number },
  W: number,
  H: number,
  par: string | null,
): Transform {
  const parts = (par ?? "xMidYMid meet").trim().split(/\s+/).filter((p) => p !== "defer");
  const align = parts[0] ?? "xMidYMid";
  const slice = parts[1] === "slice";
  const sx = W / vb.w;
  const sy = H / vb.h;
  if (align === "none") return { a: sx, b: 0, c: 0, d: sy, e: -vb.x * sx, f: -vb.y * sy };
  const u = slice ? Math.max(sx, sy) : Math.min(sx, sy);
  const ax = align.includes("xMin") ? 0 : align.includes("xMax") ? 1 : 0.5;
  const ay = align.includes("YMin") ? 0 : align.includes("YMax") ? 1 : 0.5;
  return {
    a: u, b: 0, c: 0, d: u,
    e: ax * (W - vb.w * u) - vb.x * u,
    f: ay * (H - vb.h * u) - vb.y * u,
  };
}

function parseViewBox(s: string | null): { x: number; y: number; w: number; h: number } | null {
  const v = numberList(s);
  if (v.length !== 4 || !(v[2] > 0) || !(v[3] > 0)) return null;
  return { x: v[0], y: v[1], w: v[2], h: v[3] };
}

function walkElement(env: Env, el: Element, parentId: string, st: State): void {
  if (++env.visits > MAX_VISITS) throw new SvgImportError("l'SVG è troppo complesso: non importato");
  const tag = el.localName;
  if (!isSvgElement(el)) return;
  if (SKIPPED.has(tag)) {
    if (ANIMATIONS.has(tag)) warn(env, "animazione SMIL ignorata");
    else if (tag === "foreignObject") warn(env, "<foreignObject> rimosso");
    else if (tag === "script") warn(env, "<script> rimosso");
    return;
  }
  if (st.depth > MAX_DEPTH) { warn(env, "annidamento troppo profondo: ramo ignorato"); return; }

  const own = declared(env, el);
  const style = computeStyle(own, st.style);
  const display = own.get("display")?.trim();
  const hiddenSelf = display === "none";
  const vis = style.get("visibility")?.trim();
  const visible = !st.hidden && !hiddenSelf && vis !== "hidden" && vis !== "collapse";

  for (const [prop, label] of [["filter", "filtro"], ["clip-path", "clip-path"], ["mask", "maschera"], ["mix-blend-mode", "blend mode"]] as const) {
    const v = own.get(prop)?.trim();
    if (v && v !== "none" && v !== "normal") warn(env, `${label} non supportato: ignorato`);
  }
  for (const m of ["marker-start", "marker-mid", "marker-end"]) {
    const v = own.get(m)?.trim();
    if (v && v !== "none") { warn(env, "marker non supportato: ignorato"); break; }
  }

  const tr = parseTransform(own.get("transform") ?? el.getAttribute("transform"));
  if (!tr.ok) warn(env, "transform non valido: ignorato in parte");
  const opacity = st.opacity * opacityOf(own.get("opacity"));

  if (tag === "use") return walkUse(env, el, parentId, st, style, tr.matrix, opacity, visible, hiddenSelf);
  if (CONTAINERS.has(tag)) {
    return walkContainer(env, el, parentId, st, style, tr.matrix, opacity, visible, hiddenSelf);
  }
  if (!SHAPES.has(tag) && tag !== "text" && tag !== "image") return; // elemento ignoto: si ignora

  const M = compose(st.M, tr.matrix);
  const fs = lengthOf(style.get("font-size"), 16) ?? 16;
  const lenX = (a: string) => lengthOf(el.getAttribute(a), env.vbW, fs);
  const lenY = (a: string) => lengthOf(el.getAttribute(a), env.vbH, fs);
  const lenD = (a: string) => lengthOf(el.getAttribute(a), Math.hypot(env.vbW, env.vbH) / Math.SQRT2, fs);
  const leaf = (spec: LeafSpec) => emitLeaf(env, parentId, el, spec, style, st, opacity, visible);

  switch (tag) {
    case "rect": {
      const x = lenX("x") ?? 0, y = lenY("y") ?? 0;
      const w = lenX("width") ?? 0, h = lenY("height") ?? 0;
      if (!(w > 0) || !(h > 0)) return;
      let rx = lenX("rx"), ry = lenY("ry");
      if (rx === undefined && ry === undefined) { rx = 0; ry = 0; }
      else if (rx === undefined) rx = ry;
      else if (ry === undefined) ry = rx;
      rx = Math.min(Math.max(0, rx ?? 0), w / 2);
      ry = Math.min(Math.max(0, ry ?? 0), h / 2);
      const bbox = { x, y, width: w, height: h };
      const sim = similarityOf(M);
      if (sim && rx === ry) {
        const c = applyTransform(M, x + w / 2, y + h / 2);
        leaf({
          kind: "rect", base: "Rettangolo", tag,
          box: { x: c.x - (w * sim.s) / 2, y: c.y - (h * sim.s) / 2, width: w * sim.s, height: h * sim.s },
          rotation: sim.rotation, cornerRadius: rx * sim.s, userRadius: rx, M, userBBox: () => bbox,
        });
        return;
      }
      const n = normalizeVector(transformCmds(roundedRectCmds(x, y, w, h, rx, ry), M));
      if (n) leaf({ kind: "vector", base: "Rettangolo", tag, box: n.box, rotation: 0, subpaths: n.subpaths, M, userBBox: () => bbox });
      return;
    }
    case "circle":
    case "ellipse": {
      const cx = lenX("cx") ?? 0, cy = lenY("cy") ?? 0;
      let rx: number | undefined, ry: number | undefined;
      if (tag === "circle") { rx = ry = lenD("r"); }
      else {
        rx = lenX("rx"); ry = lenY("ry");
        if (rx === undefined) rx = ry; else if (ry === undefined) ry = rx;
      }
      if (!(rx !== undefined && ry !== undefined && rx > 0 && ry > 0)) return;
      const bbox = { x: cx - rx, y: cy - ry, width: 2 * rx, height: 2 * ry };
      const sim = similarityOf(M);
      const base = tag === "circle" ? "Cerchio" : "Ellisse";
      if (sim) {
        const c = applyTransform(M, cx, cy);
        leaf({
          kind: "ellipse", base, tag,
          box: { x: c.x - rx * sim.s, y: c.y - ry * sim.s, width: 2 * rx * sim.s, height: 2 * ry * sim.s },
          rotation: sim.rotation, M, userBBox: () => bbox,
        });
        return;
      }
      const n = normalizeVector(transformCmds(ellipseCmds(cx, cy, rx, ry), M));
      if (n) leaf({ kind: "vector", base, tag, box: n.box, rotation: 0, subpaths: n.subpaths, M, userBBox: () => bbox });
      return;
    }
    case "line": {
      const x1 = lenX("x1") ?? 0, y1 = lenY("y1") ?? 0, x2 = lenX("x2") ?? 0, y2 = lenY("y2") ?? 0;
      const cmds: PathCmd[] = [{ t: "M", x: x1, y: y1 }, { t: "L", x: x2, y: y2 }];
      emitPathLike(env, leaf, "Linea", tag, cmds, M);
      return;
    }
    case "polyline":
    case "polygon": {
      const pts = numberList(el.getAttribute("points"));
      if (pts.length % 2 === 1) { pts.pop(); warn(env, "points con un numero dispari di coordinate: l'ultima è ignorata"); }
      if (pts.length < 4) return;
      const cmds: PathCmd[] = [];
      for (let i = 0; i < pts.length; i += 2) cmds.push({ t: i === 0 ? "M" : "L", x: pts[i], y: pts[i + 1] });
      if (tag === "polygon") cmds.push({ t: "Z" });
      emitPathLike(env, leaf, tag === "polygon" ? "Poligono" : "Polilinea", tag, cmds, M);
      return;
    }
    case "path": {
      const parsed = parsePathData(el.getAttribute("d") ?? "");
      if (parsed.error) warn(env, "path con dati non validi: disegnato fino all'errore");
      if (parsed.cmds.length === 0) return;
      emitPathLike(env, leaf, "Path", tag, parsed.cmds, M);
      return;
    }
    case "text":
      return emitText(env, el, parentId, st, style, M, opacity, visible);
    case "image":
      return emitImage(env, el, leaf, M, lenX, lenY);
  }
}

function emitPathLike(
  env: Env,
  leaf: (s: LeafSpec) => void,
  base: string,
  tag: string,
  cmds: PathCmd[],
  M: Transform,
): void {
  void env;
  const n = normalizeVector(transformCmds(cmds, M));
  if (!n) return;
  leaf({
    kind: "vector", base, tag, box: n.box, rotation: 0, subpaths: n.subpaths, M,
    // La bbox UTENTE (prima di M) serve solo ai gradienti objectBoundingBox.
    userBBox: () => {
      const raw = cmdsToSubPaths(cmds);
      if (raw.length === 0) return null;
      const b = vectorBounds(raw);
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    },
  });
}

function walkContainer(
  env: Env, el: Element, parentId: string, st: State, style: Props,
  T: Transform, opacity: number, visible: boolean, hiddenSelf: boolean,
  extra?: { name?: string },
): void {
  let M2: Transform;
  let gx = 0, gy = 0;
  let inner = T;
  // <svg> annidato: x/y + viewBox -> larghezza/altezza.
  if (el.localName === "svg" || el.localName === "symbol") {
    const x = lengthOf(el.getAttribute("x"), env.vbW) ?? 0;
    const y = lengthOf(el.getAttribute("y"), env.vbH) ?? 0;
    const vb = parseViewBox(el.getAttribute("viewBox"));
    const w = lengthOf(el.getAttribute("width"), env.vbW);
    const h = lengthOf(el.getAttribute("height"), env.vbH);
    let local = translateM(x, y);
    if (vb && w !== undefined && h !== undefined && w > 0 && h > 0) {
      local = compose(local, viewBoxMatrix(vb, w, h, el.getAttribute("preserveAspectRatio")));
    } else if (vb) {
      local = compose(local, translateM(-vb.x, -vb.y));
    }
    inner = compose(T, local);
  }
  if (isTranslationM(inner) && (inner.e !== 0 || inner.f !== 0)) {
    // Una pura traslazione resta il x/y del GRUPPO: si può ancora spostare e
    // animare come gruppo. Il delta è nello spazio del parent (parte lineare
    // di M, senza la sua traslazione: quella la applica già il parent).
    gx = st.M.a * inner.e + st.M.c * inner.f;
    gy = st.M.b * inner.e + st.M.d * inner.f;
    M2 = st.M;
  } else {
    M2 = compose(st.M, inner);
  }
  const id = env.newId();
  const node = create(NodeSchema, {
    id, parentId, orderKey: nextKey(env, parentId),
    name: extra?.name ?? nameOf(env, el, "Gruppo"),
    visible: !hiddenSelf && !st.hidden,
    opacity: 1,
    x: r4(gx), y: r4(gy), width: 0, height: 0, rotation: 0,
    shape: { case: "group", value: {} },
  });
  const before = env.nodeCount;
  const idx = pushNode(env, node);
  void visible;
  walkChildren(env, el, id, {
    M: M2, style, opacity, depth: st.depth + 1, hidden: st.hidden || hiddenSelf,
  });
  // Un gruppo che non ha prodotto nessun figlio (solo <defs>, forme a area
  // nulla) non è un livello: non deve sporcare il pannello.
  if (env.nodeCount === before + 1) {
    env.ops.splice(idx, 1);
    env.nodeCount--;
    env.keys.delete(id);
  }
}

function walkUse(
  env: Env, el: Element, parentId: string, st: State, style: Props,
  T: Transform, opacity: number, visible: boolean, hiddenSelf: boolean,
): void {
  const href = hrefOf(el);
  if (!href || !href.startsWith("#")) { warn(env, "<use> con riferimento esterno ignorato"); return; }
  const ref = env.ids.get(href.slice(1));
  if (!ref) { warn(env, `<use> verso "${href.slice(1)}" che non esiste`); return; }
  if (env.useStack.has(ref) || env.useStack.size > 32) { warn(env, "<use> ricorsivo ignorato"); return; }
  const ux = lengthOf(el.getAttribute("x"), env.vbW) ?? 0;
  const uy = lengthOf(el.getAttribute("y"), env.vbH) ?? 0;
  const T2 = compose(T, translateM(ux, uy));
  const id = env.newId();
  const hasTranslateOnly = isTranslationM(T2) && (T2.e !== 0 || T2.f !== 0);
  const gx = hasTranslateOnly ? st.M.a * T2.e + st.M.c * T2.f : 0;
  const gy = hasTranslateOnly ? st.M.b * T2.e + st.M.d * T2.f : 0;
  const M2 = hasTranslateOnly ? st.M : compose(st.M, T2);
  const node = create(NodeSchema, {
    id, parentId, orderKey: nextKey(env, parentId),
    name: nameOf(env, el, "Istanza"),
    visible: !hiddenSelf && !st.hidden, opacity: 1,
    x: r4(gx), y: r4(gy), width: 0, height: 0, rotation: 0,
    shape: { case: "group", value: {} },
  });
  const before = env.nodeCount;
  const idx = pushNode(env, node);
  void visible;
  env.useStack.add(ref);
  try {
    const sub: State = { M: M2, style, opacity, depth: st.depth + 1, hidden: st.hidden || hiddenSelf };
    if (ref.localName === "symbol" || ref.localName === "svg") {
      // Il contenuto di un symbol/svg referenziato, con la sua viewBox.
      walkContainerAsChildren(env, ref, id, sub, el);
    } else {
      walkElement(env, ref, id, sub);
    }
  } finally {
    env.useStack.delete(ref);
  }
  if (env.nodeCount === before + 1) {
    env.ops.splice(idx, 1);
    env.nodeCount--;
    env.keys.delete(id);
  }
}

// I figli di un <symbol>/<svg> richiamato da <use>: la viewBox si mappa su
// width/height del <use> (o del symbol).
function walkContainerAsChildren(env: Env, ref: Element, parentId: string, st: State, use: Element): void {
  const vb = parseViewBox(ref.getAttribute("viewBox"));
  const w = lengthOf(use.getAttribute("width"), env.vbW) ?? lengthOf(ref.getAttribute("width"), env.vbW);
  const h = lengthOf(use.getAttribute("height"), env.vbH) ?? lengthOf(ref.getAttribute("height"), env.vbH);
  let M = st.M;
  if (vb && w !== undefined && h !== undefined && w > 0 && h > 0) {
    M = compose(M, viewBoxMatrix(vb, w, h, ref.getAttribute("preserveAspectRatio")));
  } else if (vb) {
    M = compose(M, translateM(-vb.x, -vb.y));
  }
  const own = declared(env, ref);
  walkChildren(env, ref, parentId, { ...st, M, style: computeStyle(own, st.style) });
}

// --- testo ---------------------------------------------------------------------

function collapseSpace(s: string): string {
  return s.replace(/[\t\r\n ]+/g, " ");
}

function emitText(
  env: Env, el: Element, parentId: string, st: State, style: Props, M: Transform,
  opacity: number, visible: boolean,
): void {
  const fs = lengthOf(style.get("font-size"), 16) ?? 16;
  const family = (style.get("font-family") ?? "").trim();
  const wRaw = style.get("font-weight")?.trim() ?? "";
  const weight = wRaw === "bold" ? "700" : wRaw === "normal" ? "400" : /^\d+$/.test(wRaw) ? wRaw : wRaw === "bolder" ? "700" : "";
  const anchor = style.get("text-anchor")?.trim() ?? "start";
  if (el.querySelector("textPath")) warn(env, "testo su tracciato (textPath): reso come testo semplice");

  // Le righe: un <tspan> con y (o dy) proprio comincia una riga nuova.
  const lines: string[] = [""];
  const preserve = (el.getAttribute("xml:space") ?? "") === "preserve";
  const first = (a: string | null) => (a ? numberList(a)[0] : undefined);
  // `curY` è la y della riga in corso: un tspan con una y diversa, o con un dy
  // non nullo, apre una riga nuova (e la differenza è l'interlinea).
  let curY = first(el.getAttribute("y"));
  let firstTy: number | undefined;
  let firstTx: number | undefined;
  let lineStep: number | undefined;
  const walk = (node: Element) => {
    for (const ch of Array.from(node.childNodes)) {
      if (ch.nodeType === 3 || ch.nodeType === 4) {
        lines[lines.length - 1] += preserve ? (ch.nodeValue ?? "") : collapseSpace(ch.nodeValue ?? "");
        continue;
      }
      if (ch.nodeType !== 1) continue;
      const c = ch as Element;
      if (c.localName !== "tspan" && c.localName !== "textPath" && c.localName !== "a") continue;
      const ty = first(c.getAttribute("y"));
      const dyRaw = c.getAttribute("dy");
      const dy = dyRaw ? lengthOf(dyRaw.trim().split(/[\s,]+/)[0], 0, fs) : undefined;
      if (firstTy === undefined) firstTy = ty;
      if (firstTx === undefined) firstTx = first(c.getAttribute("x"));
      const newLine = (ty !== undefined && curY !== undefined && ty !== curY) || (dy !== undefined && dy !== 0);
      if (newLine && lines[lines.length - 1].trim() !== "") {
        lines.push("");
        if (lines.length === 2) {
          lineStep = dy !== undefined && dy !== 0 ? dy : ty !== undefined && curY !== undefined ? ty - curY : undefined;
        }
      }
      if (ty !== undefined) curY = ty;
      else if (dy !== undefined && curY !== undefined) curY += dy;
      walk(c);
    }
  };
  walk(el);
  const content = lines
    .map((l) => (preserve ? l : l.trim()))
    .filter((l, i, arr) => !(l === "" && (i === 0 || i === arr.length - 1)))
    .join("\n");
  if (content.trim() === "") return;

  const x = first(el.getAttribute("x")) ?? firstTx ?? 0;
  const y = first(el.getAttribute("y")) ?? firstTy ?? 0;
  // Interlinea come moltiplicatore del corpo, se le righe ne dichiarano una.
  const lhMult = lineStep !== undefined && lineStep > 0 && lines.length > 1 ? lineStep / fs : 0;
  const tstyle: TextStyleLite = {
    fontFamily: family.replace(/\s+/g, " "),
    fontSize: r4(fs),
    fontWeight: weight,
    lineHeight: r4(lhMult),
    align: anchor === "middle" ? "center" : anchor === "end" ? "right" : "left",
  };
  const mult = lhMult > 0 ? lhMult : 1.2;
  const lh = fs * mult;
  const ascent = (lh - fs) / 2 + fs * 0.8;
  const rows = content.split("\n");
  const measure = env.opts.measureText;
  const widest = Math.max(...rows.map((r) => (measure ? measure(r, tstyle) : r.length * fs * 0.56)));
  // Il box ha un po' di respiro: se la misura di import e quella di
  // rendering differiscono di un pelo (font non ancora caricato) una riga
  // non deve andare a capo da sola.
  const bw = widest * 1.04 + fs * 0.2;
  const bh = rows.length * lh;
  const left = anchor === "middle" ? x - bw / 2 : anchor === "end" ? x - bw : x;
  const top = y - ascent;
  const sim = similarityOf(M);
  if (!sim) warn(env, "testo con trasformazione non uniforme: approssimato");
  const s = sim?.s ?? lengthScaleOf(M);
  const c = applyTransform(M, left + bw / 2, top + bh / 2);
  const spec: LeafSpec = {
    kind: "text", base: "Testo", tag: "text", nameHint: rows[0].slice(0, 40),
    box: { x: c.x - (bw * s) / 2, y: c.y - (bh * s) / 2, width: bw * s, height: bh * s },
    rotation: sim?.rotation ?? 0,
    text: { content, style: { ...tstyle, fontSize: r4(fs * s) } },
    M,
    userBBox: () => ({ x: left, y: top, width: bw, height: bh }),
  };
  emitLeaf(env, parentId, el, spec, style, st, opacity, visible);
}

// --- immagini ------------------------------------------------------------------

export function decodeDataUri(href: string, maxBytes = MAX_SVG_BYTES): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/is.exec(href.trim());
  if (!m) return null;
  const mime = (m[1] || "text/plain").toLowerCase();
  const base64 = /;base64/i.test(m[2]);
  try {
    let bytes: Uint8Array;
    if (base64) {
      const bin = atob(m[3].replace(/\s+/g, ""));
      if (bin.length > maxBytes) return null;
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(m[3]));
      if (bytes.length > maxBytes) return null;
    }
    return { mime, bytes };
  } catch {
    return null;
  }
}

/** Dimensioni naturali (px) di PNG, GIF e JPEG dall'intestazione, o null. */
export function imageSizeOf(b: Uint8Array): { width: number; height: number } | null {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) { p++; continue; }
      const marker = b[p + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (b[p + 5] << 8) | b[p + 6], width: (b[p + 7] << 8) | b[p + 8] };
      }
      p += 2 + ((b[p + 2] << 8) | b[p + 3]);
    }
  }
  return null;
}

function emitImage(
  env: Env, el: Element, leaf: (s: LeafSpec) => void, M: Transform,
  lenX: (a: string) => number | undefined, lenY: (a: string) => number | undefined,
): void {
  const href = hrefOf(el) ?? "";
  if (!/^data:image\//i.test(href.trim())) {
    warn(env, "immagine esterna (non data URI) ignorata");
    return;
  }
  const data = decodeDataUri(href);
  if (!data) { warn(env, "immagine incorporata non leggibile ignorata"); return; }
  const nat = imageSizeOf(data.bytes);
  let w = lenX("width");
  let h = lenY("height");
  if (w === undefined && h === undefined && nat) { w = nat.width; h = nat.height; }
  else if (w === undefined && h !== undefined && nat) w = (h * nat.width) / nat.height;
  else if (h === undefined && w !== undefined && nat) h = (w * nat.height) / nat.width;
  if (w === undefined || h === undefined || !(w > 0) || !(h > 0)) {
    warn(env, "immagine incorporata senza dimensioni ignorata");
    return;
  }
  let x = lenX("x") ?? 0;
  let y = lenY("y") ?? 0;
  // preserveAspectRatio di default è "meet": l'immagine sta DENTRO il rettangolo
  // senza deformarsi. Il nodo immagine invece si stira sul proprio box, quindi
  // il box va ridotto al rettangolo che l'immagine occuperebbe davvero.
  const par = (el.getAttribute("preserveAspectRatio") ?? "xMidYMid meet").trim();
  if (nat && !par.startsWith("none")) {
    const u = Math.min(w / nat.width, h / nat.height);
    const iw = nat.width * u, ih = nat.height * u;
    const ax = par.includes("xMin") ? 0 : par.includes("xMax") ? 1 : 0.5;
    const ay = par.includes("YMin") ? 0 : par.includes("YMax") ? 1 : 0.5;
    x += ax * (w - iw); y += ay * (h - ih);
    w = iw; h = ih;
  }
  const bbox = { x, y, width: w, height: h };
  const sim = similarityOf(M);
  let box: Box;
  let rotation = 0;
  if (sim) {
    const c = applyTransform(M, x + w / 2, y + h / 2);
    box = { x: c.x - (w * sim.s) / 2, y: c.y - (h * sim.s) / 2, width: w * sim.s, height: h * sim.s };
    rotation = sim.rotation;
  } else {
    warn(env, "immagine con trasformazione non uniforme: approssimata");
    const pts = [applyTransform(M, x, y), applyTransform(M, x + w, y), applyTransform(M, x + w, y + h), applyTransform(M, x, y + h)];
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  leaf({
    kind: "image", base: "Immagine", tag: "image", box, rotation,
    image: { bytes: data.bytes, mime: data.mime }, M, userBBox: () => bbox,
  });
}

// --- la radice -----------------------------------------------------------------

function applyRules(doc: Document, env: Env): void {
  const rules: CssRule[] = [];
  let order = 0;
  const atRules = new Set<string>();
  for (const s of Array.from(doc.getElementsByTagName("style"))) {
    const parsed = parseCss(s.textContent ?? "", order);
    order += parsed.rules.length;
    rules.push(...parsed.rules);
    parsed.atRules.forEach((a) => atRules.add(a));
  }
  for (const a of atRules) {
    warn(env, a === "@keyframes" || a === "@-webkit-keyframes"
      ? "animazioni CSS (@keyframes) ignorate"
      : `regola CSS ${a} ignorata`);
  }
  const perEl = new Map<Element, CssRule[]>();
  for (const rule of rules) {
    let hits: ArrayLike<Element>;
    try {
      hits = doc.querySelectorAll(rule.selector);
    } catch {
      warn(env, "selettore CSS non supportato ignorato");
      continue;
    }
    for (const el of Array.from(hits)) {
      const list = perEl.get(el);
      if (list) list.push(rule); else perEl.set(el, [rule]);
    }
  }
  for (const [el, list] of perEl) {
    list.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
    env.ruleDecls.set(el, list.flatMap((r) => r.decls));
  }
}

function defaultNewId(): string {
  return crypto.randomUUID();
}

/**
 * Importa il testo di un SVG come op `createNode` (genitori prima dei figli).
 * Lancia SvgImportError solo per ciò che rende l'import impossibile; tutto il
 * resto è un avviso in `warnings`.
 */
export function importSvg(source: string, opts: ImportOptions = {}): ImportResult {
  const maxBytes = opts.maxBytes ?? MAX_SVG_BYTES;
  const doc = parseDocument(source, maxBytes);
  const root = doc.documentElement;
  const newId = opts.newId ?? defaultNewId;

  // viewBox e dimensioni dichiarate.
  // In modalità PROBE (la misura del contenuto di un SVG senza viewBox) il
  // viewport è un quadrato enorme: le forme non vengono mai ridimensionate.
  const vb = opts.probe
    ? { x: 0, y: 0, w: 100_000, h: 100_000 }
    : parseViewBox(root.getAttribute("viewBox"));
  const wAttr = opts.probe ? undefined : lengthOf(root.getAttribute("width"), vb?.w ?? 100);
  const hAttr = opts.probe ? undefined : lengthOf(root.getAttribute("height"), vb?.h ?? 100);
  const pctW = /%\s*$/.test(root.getAttribute("width") ?? "");
  const pctH = /%\s*$/.test(root.getAttribute("height") ?? "");
  let natW: number | undefined = pctW ? undefined : wAttr;
  let natH: number | undefined = pctH ? undefined : hAttr;
  if (vb) {
    if (natW === undefined && natH === undefined) { natW = vb.w; natH = vb.h; }
    else if (natW === undefined && natH !== undefined) natW = (natH * vb.w) / vb.h;
    else if (natH === undefined && natW !== undefined) natH = (natW * vb.h) / vb.w;
  }

  const env: Env = {
    opts, doc, root,
    ids: new Map(), ruleDecls: new Map(), declaredCache: new Map(),
    ops: [], assets: [], warnings: new Map(), counters: new Map(), keys: new Map(),
    nodeCount: 0, visits: 0, maxNodes: opts.maxNodes ?? MAX_SVG_NODES,
    vbW: vb?.w ?? natW ?? 300, vbH: vb?.h ?? natH ?? 150,
    newId, docId: opts.docId ?? "", useStack: new Set(), scale: 1,
  };
  for (const el of Array.from(doc.querySelectorAll("[id]"))) {
    const id = el.getAttribute("id");
    if (id && !env.ids.has(id)) env.ids.set(id, el);
  }
  applyRules(doc, env);

  // Senza viewBox né dimensioni non c'è un viewport: si usa la bbox del
  // contenuto (un SVG "nudo" è comunque un disegno finito).
  let contentBox: { x: number; y: number; w: number; h: number } | null = null;
  if (!vb && (natW === undefined || natH === undefined)) {
    contentBox = measureContent(source, opts);
    if (contentBox) { natW = natW ?? contentBox.w; natH = natH ?? contentBox.h; }
    else { natW = natW ?? 300; natH = natH ?? 150; }
    warn(env, "SVG senza viewBox né dimensioni: usata la dimensione del contenuto");
  }
  const W0 = natW as number;
  const H0 = natH as number;
  const scale = opts.scale ?? Math.min(1, (opts.maxSize ?? DEFAULT_MAX_SIZE) / Math.max(W0, H0, 1e-9));
  const W = W0 * scale;
  const H = H0 * scale;
  env.scale = scale;
  const viewBox = vb ?? contentBox ?? { x: 0, y: 0, w: W0, h: H0 };
  const M0 = viewBoxMatrix(viewBox, W, H, root.getAttribute("preserveAspectRatio"));
  env.vbW = viewBox.w;
  env.vbH = viewBox.h;

  const rootProps = computeStyle(declared(env, root), null);
  const rootId = newId();
  const at = opts.at ?? { x: 0, y: 0 };
  const rootName = labelOf(root, false)
    || cleanName(childElements(root).find((c) => c.localName === "title")?.textContent ?? "")
    || cleanName(opts.name ?? "")
    || labelOf(root)
    || "SVG";
  pushNode(env, create(NodeSchema, {
    id: rootId,
    parentId: opts.parentId ?? "",
    orderKey: opts.orderKey ?? orderKeyBetween(null, null),
    name: rootName,
    visible: true, opacity: 1,
    x: r4(at.x), y: r4(at.y), width: 0, height: 0, rotation: 0,
    shape: { case: "group", value: {} },
  }));
  walkChildren(env, root, rootId, {
    M: M0, style: rootProps, opacity: opacityOf(declared(env, root).get("opacity")), depth: 0,
    hidden: declared(env, root).get("display")?.trim() === "none",
  });

  // Solo la radice? Niente di importabile.
  if (env.nodeCount <= 1) throw new SvgImportError("l'SVG non contiene forme importabili");

  const warnings = [...env.warnings].map(([m, n]) => (n > 1 ? `${m} (${n}×)` : m));
  return {
    ops: env.ops, rootId, warnings,
    size: { width: r4(W), height: r4(H) },
    nodeCount: env.nodeCount, assets: env.assets,
  };
}

// Bbox del contenuto (in unità utente) per un SVG privo di viewBox/dimensioni:
// una prima importazione a scala 1 e viewport provvisorio, di cui si leggono i
// box dei nodi di primo livello.
function measureContent(source: string, opts: ImportOptions): { x: number; y: number; w: number; h: number } | null {
  try {
    let n = 0;
    const r = importSvg(source, { ...opts, probe: true, scale: 1, newId: () => `m${n++}`, at: { x: 0, y: 0 } });
    const boxes: Box[] = [];
    // Gli op sono padre-prima: l'offset cumulativo dei gruppi (x/y di una pura
    // traslazione) si accumula scendendo.
    const offset = new Map<string, { x: number; y: number }>([[r.rootId, { x: 0, y: 0 }]]);
    for (const op of r.ops) {
      if (op.kind.case !== "createNode") continue;
      const nd = op.kind.value.node;
      if (!nd) continue;
      const po = offset.get(nd.parentId) ?? { x: 0, y: 0 };
      if (nd.shape.case === "group") { offset.set(nd.id, { x: po.x + nd.x, y: po.y + nd.y }); continue; }
      boxes.push({ x: po.x + nd.x, y: po.y + nd.y, width: nd.width, height: nd.height });
    }
    if (boxes.length === 0) return null;
    const minX = Math.min(...boxes.map((b) => b.x)), minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.width)), maxY = Math.max(...boxes.map((b) => b.y + b.height));
    if (!(maxX > minX) && !(maxY > minY)) return null;
    return { x: minX, y: minY, w: Math.max(maxX - minX, 1), h: Math.max(maxY - minY, 1) };
  } catch {
    return null;
  }
}
