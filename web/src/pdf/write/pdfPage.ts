import type { BlendModeLite, FillLite, GradientLite, NodeLite } from "../../store/types";
import type { Bounds } from "../../canvas/geometry";
import { decorationBars, fontSizeOf, placeTextLines, type MeasureText } from "../../renderer/text";
import { resolvedFill } from "../../renderer/canvasRenderer";
import { hasRealStroke, vectorStyleOf } from "../../renderer/vectorStyle";
import { meshBitmap } from "../../renderer/mesh";
import { writeImage, type PreparedImage } from "./pdfImages";
import { num, pdfName, type PdfFile } from "./pdfFile";
import type { PdfColors } from "./pdfColor";
import type { PdfFonts } from "./pdfFonts";

// A PAGE'S CONTENT STREAM, from the same nodes the SVG export draws (export/region.ts picks and orders
// them). One world unit is one CSS pixel = 0.75 pt; the page's initial matrix flips y so nodes keep
// their document coordinates and the bounds' top-left is the page's top-left.
//
// What carries over: rectangles (rounded), ellipses, vectors (fill rule, caps, joins, miter, dash),
// text (placed by the same layout as the canvas, real fonts, real colour, decorations), images
// (original JPEG/PNG bytes), linear and radial gradients (true shadings), mesh gradients (a small
// bitmap), opacity and blend modes (ExtGState), masks (clip paths), CMYK and spot paints.
// What does not: blur effects and inner shadows (a hard offset copy stands in for a drop shadow),
// gradient stop transparency, per-glyph OpenType features. The preflight lists these.

export const PT = 0.75;

const KAPPA = 0.5522847498;

const BLEND: Record<BlendModeLite, string> = {
  multiply: "Multiply", screen: "Screen", overlay: "Overlay", darken: "Darken", lighten: "Lighten", "color-dodge": "ColorDodge",
  "color-burn": "ColorBurn", "hard-light": "HardLight", "soft-light": "SoftLight", difference: "Difference", exclusion: "Exclusion",
  hue: "Hue", saturation: "Saturation", color: "Color", luminosity: "Luminosity",
};

export interface PageDeps {
  file: PdfFile;
  fonts: PdfFonts;
  colors: PdfColors;
  measure: MeasureText;
  /** Prepared images by asset hash. */
  images: Map<string, PreparedImage>;
  /** Image XObjects already written (shared across pages). */
  imageObjs: Map<string, number>;
}

export interface Placed { assetHash: string; width: number; height: number }

export interface PageRender {
  content: string;
  resources: string;
  /** Every image placed on the page, with the box it was drawn into (for the preflight's resolution check). */
  placed: Placed[];
  transparency: boolean;
  /** Effects the PDF cannot reproduce, by node id. */
  flattened: string[];
}

class Page {
  out: string[] = [];
  xobjects = new Map<string, number>();
  gstates: string[] = [];
  gsKey = new Map<string, string>();
  shadings: string[] = [];
  placed: Placed[] = [];
  transparency = false;
  flattened: string[] = [];
  constructor(readonly d: PageDeps) {}

  gs(ca: number, CA: number, blend?: BlendModeLite): string {
    if (ca >= 1 && CA >= 1 && !blend) return "";
    const key = `${num(ca)}/${num(CA)}/${blend ?? ""}`;
    let name = this.gsKey.get(key);
    if (!name) {
      name = `GS${this.gstates.length + 1}`;
      this.gsKey.set(key, name);
      this.gstates.push(`${pdfName(name)}<</Type/ExtGState/ca ${num(ca)}/CA ${num(CA)}${blend ? `/BM/${BLEND[blend]}` : ""}>>`);
    }
    if (ca >= 1 && CA >= 1 && !blend) return "";
    this.transparency = true;
    return `${pdfName(name)} gs\n`;
  }

  image(hash: string): string | null {
    const img = this.d.images.get(hash);
    if (!img) return null;
    let obj = this.d.imageObjs.get(hash);
    if (obj === undefined) { obj = writeImage(this.d.file, img); this.d.imageObjs.set(hash, obj); }
    const name = `Im${obj}`;
    this.xobjects.set(name, obj);
    return name;
  }
}

// --- paths ------------------------------------------------------------------------------------------

const p = (x: number, y: number) => `${num(x)} ${num(y)}`;

function rectPath(x: number, y: number, w: number, h: number, r: number): string {
  if (r <= 0) return `${p(x, y)} ${p(w, h)} re\n`;
  const k = r * (1 - KAPPA);
  return (
    `${p(x + r, y)} m ${p(x + w - r, y)} l ${p(x + w - k, y)} ${p(x + w, y + k)} ${p(x + w, y + r)} c ` +
    `${p(x + w, y + h - r)} l ${p(x + w, y + h - k)} ${p(x + w - k, y + h)} ${p(x + w - r, y + h)} c ` +
    `${p(x + r, y + h)} l ${p(x + k, y + h)} ${p(x, y + h - k)} ${p(x, y + h - r)} c ` +
    `${p(x, y + r)} l ${p(x, y + k)} ${p(x + k, y)} ${p(x + r, y)} c h\n`
  );
}

function ellipsePath(x: number, y: number, w: number, h: number): string {
  const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry, kx = rx * KAPPA, ky = ry * KAPPA;
  return (
    `${p(cx + rx, cy)} m ${p(cx + rx, cy + ky)} ${p(cx + kx, cy + ry)} ${p(cx, cy + ry)} c ` +
    `${p(cx - kx, cy + ry)} ${p(cx - rx, cy + ky)} ${p(cx - rx, cy)} c ` +
    `${p(cx - rx, cy - ky)} ${p(cx - kx, cy - ry)} ${p(cx, cy - ry)} c ` +
    `${p(cx + kx, cy - ry)} ${p(cx + rx, cy - ky)} ${p(cx + rx, cy)} c h\n`
  );
}

function subPaths(n: NodeLite, closedOnly: boolean | null): string {
  let out = "";
  for (const sp of n.vector?.subpaths ?? []) {
    const k = sp.anchors.length;
    const closed = sp.closed && k >= 2;
    if (k === 0 || (closedOnly === true && !closed) || (closedOnly === false && closed)) continue;
    const a0 = sp.anchors[0]!;
    out += `${p(n.x + a0.x, n.y + a0.y)} m `;
    const segs = sp.closed ? k : k - 1;
    for (let i = 0; i < segs; i++) {
      const a = sp.anchors[i]!, b = sp.anchors[(i + 1) % k]!;
      out += `${p(n.x + a.x + a.outX, n.y + a.y + a.outY)} ${p(n.x + b.x + b.inX, n.y + b.y + b.inY)} ${p(n.x + b.x, n.y + b.y)} c `;
    }
    out += sp.closed ? "h\n" : "\n";
  }
  return out;
}

/** The outline of a node as path operators, or "" for kinds with none. `forFill` keeps only closed vector outlines. */
function outline(n: NodeLite, forFill: boolean): string {
  if (n.kind === "ellipse") return ellipsePath(n.x, n.y, n.width, n.height);
  if (n.kind === "vector") return subPaths(n, forFill ? true : null);
  const r = n.kind === "rect" ? Math.min(n.cornerRadius, n.width / 2, n.height / 2) : 0;
  return rectPath(n.x, n.y, n.width, n.height, r);
}

// --- paints -----------------------------------------------------------------------------------------

function shadingFor(pg: Page, n: NodeLite, g: GradientLite): string | null {
  const x1 = n.x + g.x1 * n.width, y1 = n.y + g.y1 * n.height, x2 = n.x + g.x2 * n.width, y2 = n.y + g.y2 * n.height;
  const len = Math.hypot(x2 - x1, y2 - y1);
  if (!(len > 0) || g.stops.length < 2) return null;
  const stops = [...g.stops].sort((a, b) => a.position - b.position);
  // RGB (or device CMYK in a CMYK document) interpolation between stops, stitched into one function.
  const comp = (s: (typeof stops)[number]) => cmykDoc(pg) ? cmykOf(s.color) : [s.color.r, s.color.g, s.color.b];
  const fns: string[] = [], bounds: number[] = [], encode: string[] = [];
  for (let i = 0; i < stops.length - 1; i++) {
    fns.push(`${pg.d.file.add(`<</FunctionType 2/Domain[0 1]/C0[${comp(stops[i]!).map(num).join(" ")}]/C1[${comp(stops[i + 1]!).map(num).join(" ")}]/N 1>>`)} 0 R`);
    if (i > 0) bounds.push(Math.min(1, Math.max(0, stops[i]!.position)));
    encode.push("0 1");
  }
  const fn = stops.length === 2 ? fns[0]! : `${pg.d.file.add(`<</FunctionType 3/Domain[0 1]/Functions[${fns.join(" ")}]/Bounds[${bounds.map(num).join(" ")}]/Encode[${encode.join(" ")}]>>`)} 0 R`;
  const space = cmykDoc(pg) ? "/DeviceCMYK" : "/DeviceRGB";
  const dict = g.kind === "linear"
    ? `<</ShadingType 2/ColorSpace${space}/Coords[${num(x1)} ${num(y1)} ${num(x2)} ${num(y2)}]/Function ${fn}/Extend[true true]>>`
    : `<</ShadingType 3/ColorSpace${space}/Coords[${num(x1)} ${num(y1)} 0 ${num(x1)} ${num(y1)} ${num(len)}]/Function ${fn}/Extend[true true]>>`;
  const name = `Sh${pg.shadings.length + 1}`;
  pg.shadings.push(`${pdfName(name)} ${pg.d.file.add(dict)} 0 R`);
  return name;
}

const cmykDoc = (pg: Page) => pg.d.colors.cmykDocument;
function cmykOf(c: { r: number; g: number; b: number }): number[] {
  const k = 1 - Math.max(c.r, c.g, c.b);
  if (k >= 1) return [0, 0, 0, 1];
  return [(1 - c.r - k) / (1 - k), (1 - c.g - k) / (1 - k), (1 - c.b - k) / (1 - k), k];
}

/** Paints the current path with `f`: flat colour, gradient shading, image or mesh. `path` is already on the stream. */
function paintFill(pg: Page, n: NodeLite, f: FillLite, slot: string, evenOdd: boolean, path: string): void {
  const op = evenOdd ? "f*" : "f";
  const clip = evenOdd ? "W*" : "W";
  if (f.mesh && n.width > 0 && n.height > 0) {
    const SIZE = 32;
    const px = meshBitmap(f.mesh, SIZE, 0);
    const prepared: PreparedImage = { kind: "rgba", width: SIZE, height: SIZE, rgba: px };
    const key = `mesh:${n.id}`;
    pg.d.images.set(key, prepared);
    const name = pg.image(key);
    if (name) {
      pg.transparency ||= f.mesh.colors.some((c) => c.a < 1);
      pg.out.push(`q\n${path}${clip} n\n${num(n.width)} 0 0 ${num(-n.height)} ${num(n.x)} ${num(n.y + n.height)} cm\n${pdfName(name)} Do\nQ\n`);
      return;
    }
  }
  if (f.image) {
    const name = pg.image(f.image.assetHash);
    const img = pg.d.images.get(f.image.assetHash);
    if (name && img && n.width > 0 && n.height > 0) {
      const sx = n.width / img.width, sy = n.height / img.height;
      const s = f.image.mode === "fit" ? Math.min(sx, sy) : Math.max(sx, sy);
      const w = img.width * s, h = img.height * s;
      pg.placed.push({ assetHash: f.image.assetHash, width: w, height: h });
      pg.out.push(`q\n${path}${clip} n\n${num(w)} 0 0 ${num(-h)} ${num(n.x + (n.width - w) / 2)} ${num(n.y + (n.height + h) / 2)} cm\n${pdfName(name)} Do\nQ\n`);
      return;
    }
  }
  if (f.gradient) {
    const sh = shadingFor(pg, n, f.gradient);
    if (sh) {
      pg.out.push(`q\n${path}${clip} n\n${pdfName(sh)} sh\nQ\n`);
      return;
    }
  }
  pg.out.push(pg.d.colors.ops(pg.d.colors.paintOf(n, slot, f), false), path, `${op}\n`);
}

function strokeOf(n: NodeLite) {
  return n.strokes.find((s) => s.weight > 0);
}

function strokeOps(pg: Page, n: NodeLite): string {
  const s = strokeOf(n);
  if (!s) return "";
  const vs = n.kind === "vector" || n.meta ? vectorStyleOf(n) : null;
  const cap = vs ? { butt: 0, round: 1, square: 2 }[vs.cap] : 0;
  const join = vs ? { miter: 0, round: 1, bevel: 2 }[vs.join] : 0;
  const idx = n.strokes.indexOf(s);
  return (
    `${num(s.weight)} w ${cap} J ${join} j\n` +
    (vs && hasRealStroke(n) && vs.miter !== 10 ? `${num(vs.miter)} M\n` : "") +
    (vs && vs.dash.length > 0 ? `[${vs.dash.map(num).join(" ")}] ${num(vs.dashOffset)} d\n` : "[] 0 d\n") +
    pg.d.colors.ops(pg.d.colors.paintOf(n, `strokes.${idx}`, s.color), true)
  );
}

// --- one node ---------------------------------------------------------------------------------------

function drawShape(pg: Page, n: NodeLite): void {
  const fillable = !(n.kind === "frame" && n.fills.length === 0);
  const evenOdd = n.kind === "vector" ? (vectorStyleOf(n).fillRule ?? "evenodd") === "evenodd" : false;
  const f = resolvedFill(n);
  const path = outline(n, true);
  const s = strokeOf(n);
  const shadow = n.effects?.find((e) => e.kind === "dropShadow");
  if (shadow && shadow.kind === "dropShadow" && path !== "") {
    // PDF has no blur: a hard-edged offset copy at the shadow's colour and alpha stands in for it.
    pg.out.push(`q\n${pg.gs(shadow.color.a, shadow.color.a)}1 0 0 1 ${num(shadow.offsetX)} ${num(shadow.offsetY)} cm\n`);
    pg.out.push(pg.d.colors.rgbOps(shadow.color, false), path, evenOdd ? "f*\n" : "f\n", "Q\n");
    pg.flattened.push(n.id);
  }
  if (n.effects?.some((e) => e.kind === "layerBlur" || e.kind === "innerShadow" || e.kind === "backgroundBlur")) pg.flattened.push(n.id);
  const alpha = fillable && !f.gradient && !f.image && !f.mesh ? f.a : 1;
  if (fillable && path !== "") {
    pg.out.push(`q\n${pg.gs(alpha, 1)}`);
    paintFill(pg, n, f, "fills.0", evenOdd, path);
    pg.out.push("Q\n");
  }
  if (s) {
    pg.out.push(`q\n${pg.gs(1, s.color.a)}${strokeOps(pg, n)}${outline(n, false)}S\nQ\n`);
  }
}

function drawImage(pg: Page, n: NodeLite): void {
  const hash = n.image?.assetHash ?? "";
  const name = pg.image(hash);
  if (!name) {
    // The same placeholder the canvas and the SVG show: faint box, border, cross.
    pg.out.push(`q\n${pg.gs(0.06, 1)}0 g\n${p(n.x, n.y)} ${p(n.width, n.height)} re f\nQ\n`);
    pg.out.push(`q\n${pg.gs(1, 0.35)}0 G 1 w\n${p(n.x, n.y)} ${p(n.width, n.height)} re S\n${p(n.x, n.y)} m ${p(n.x + n.width, n.y + n.height)} l ${p(n.x + n.width, n.y)} m ${p(n.x, n.y + n.height)} l S\nQ\n`);
    return;
  }
  pg.placed.push({ assetHash: hash, width: n.width, height: n.height });
  pg.out.push(`q\n${num(n.width)} 0 0 ${num(-n.height)} ${num(n.x)} ${num(n.y + n.height)} cm\n${pdfName(name)} Do\nQ\n`);
}

function drawText(pg: Page, n: NodeLite): void {
  const style = n.text?.style;
  if (!style) return;
  const lines = placeTextLines((s) => pg.d.measure(s, style), n, (st) => (s) => pg.d.measure(s, st));
  if (lines.length === 0) return;
  const base = resolvedFill(n);
  pg.out.push("BT\n");
  for (const l of lines) {
    for (const seg of l.segments ?? [{ text: l.text, x: l.x, width: l.width, style }]) {
      if (seg.text === "" || seg.inline) continue;
      const st = seg.style;
      const font = pg.d.fonts.fontFor(st);
      const y = (seg.y ?? l.y) - (st.baselineShift ?? 0);
      const color = st.color ?? base;
      const paint = st.color ? pg.d.colors.paintOf({ ...n, bindings: undefined }, "", st.color) : pg.d.colors.paintOf(n, "fills.0", base);
      const a = seg.angle ?? 0;
      const c = Math.cos(a), s = Math.sin(a);
      pg.out.push(
        `${pg.gs(color.a, color.a)}${pg.d.colors.ops(paint, false)}${pdfName(font.res)} ${num(fontSizeOf(st))} Tf\n` +
        `${num(st.letterSpacing ?? 0)} Tc ${num((st.horizontalScale ?? 1) * 100)} Tz\n` +
        `${num(c)} ${num(s)} ${num(s)} ${num(-c)} ${num(seg.x)} ${num(y)} Tm\n${font.encode(seg.text)} Tj\n`,
      );
    }
  }
  pg.out.push("ET\n");
  for (const l of lines) {
    for (const seg of l.segments ?? [{ text: l.text, x: l.x, width: l.width, style }]) {
      if (seg.text === "" || seg.angle) continue;
      const y = (seg.y ?? l.y) - (seg.style.baselineShift ?? 0);
      const bars = decorationBars(seg.style, y);
      if (bars.length === 0) continue;
      const color = seg.style.color ?? base;
      pg.out.push(`q\n${pg.gs(color.a, color.a)}${pg.d.colors.ops(pg.d.colors.paintOf({ ...n, bindings: undefined }, "", color), false)}`);
      for (const b of bars) pg.out.push(`${p(seg.x, b.y)} ${p(seg.width, b.height)} re f\n`);
      pg.out.push("Q\n");
    }
  }
}

function maskOutline(n: NodeLite): string | null {
  if (n.kind === "ellipse" || n.kind === "rect" || n.kind === "frame") return outline(n, true);
  if (n.kind === "vector") {
    const s = subPaths(n, true);
    return s === "" ? null : s;
  }
  return null;
}

/**
 * Renders `nodes` (already in draw order) into a content stream for a page whose top-left is `bounds`' top-left.
 * `noPrint` ids are skipped: nodes on a no-print layer do not reach the output.
 */
export function renderPage(deps: PageDeps, nodes: readonly NodeLite[], bounds: Bounds, skip: (n: NodeLite) => boolean = () => false): PageRender {
  const pg = new Page(deps);
  const clipOf = new Map<string, string>();
  const clipOpen = new Set<string>();
  // y flipped, origin at the bounds' top-left, scaled to points.
  pg.out.push(`${num(PT)} 0 0 ${num(-PT)} ${num(-bounds.x * PT)} ${num((bounds.y + bounds.height) * PT)} cm\n`);
  for (const n of nodes) {
    if (skip(n)) continue;
    if (n.isMask) {
      const path = maskOutline(n);
      if (path !== null) { clipOf.set(n.parentId, path); continue; }
    }
    const clip = clipOf.get(n.parentId);
    pg.out.push("q\n");
    if (clip && !clipOpen.has(n.id)) pg.out.push(`${clip}W* n\n`);
    // Node opacity and blend mode wrap the whole node; the paint's own alpha is applied inside.
    if (n.opacity !== 1 || n.blendMode) pg.out.push(pg.gs(n.opacity, n.opacity, n.blendMode));
    if (n.kind === "text") drawText(pg, n);
    else if (n.kind === "image") drawImage(pg, n);
    else drawShape(pg, n);
    pg.out.push("Q\n");
  }
  const res: string[] = [];
  if (pg.xobjects.size) res.push(`/XObject<<${[...pg.xobjects].map(([k, v]) => `${pdfName(k)} ${v} 0 R`).join(" ")}>>`);
  if (pg.gstates.length) res.push(`/ExtGState<<${pg.gstates.join(" ")}>>`);
  if (pg.shadings.length) res.push(`/Shading<<${pg.shadings.join(" ")}>>`);
  return { content: pg.out.join(""), resources: res.join(""), placed: pg.placed, transparency: pg.transparency, flattened: [...new Set(pg.flattened)] };
}
