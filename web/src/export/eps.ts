import type { FillLite, NodeLite, TextStyleLite } from "@/store/types";
import type { Bounds } from "@/canvas/geometry";
import { outlineCommands, type PathCmd } from "@/renderer/shapeGeometry";
import { resolvedFill } from "@/renderer/canvasRenderer";
import { hasRealStroke, vectorStyleOf } from "@/renderer/vectorStyle";
import { fontSizeOf, paragraphDecorations, piecesOfSegment, placeTextLines, type MeasureText } from "@/renderer/text";

// EPS EXPORT (docs/eps.md). An Encapsulated PostScript Level 2 file of a region, drawn from the same nodes the
// SVG and PDF exports draw (export/region.ts picks and orders them), so Illustrator, Affinity, Ghostscript and
// print workflows can open a page as vector artwork. It is a plain-text, hand-written file: no library.
//
// One world unit is one CSS pixel = 0.75 pt. The PostScript origin is bottom-left, so the prolog flips y and the
// nodes keep their document coordinates (as the PDF writer does).
//
// What carries over: rectangles (rounded, smoothed, per-corner radii), ellipses (arcs, rings), polygons, stars,
// vectors (fill rule, caps, joins, miter, dash), text (placed by the same layout as the canvas, in a base-14 font),
// solid fills and strokes (RGB), masks (clip paths).
// What does not, and the file's `warnings` say so: transparency (EPS has none: alpha is composited on white),
// gradients (flattened to their average colour), images and meshes (a placeholder box), blur and shadow effects,
// embedded fonts (text uses Helvetica, Times or Courier by the family's name), CMYK and spot paints.

export const EPS_PT = 0.75;

export interface EpsResult {
  /** The file's text (ASCII only). */
  eps: string;
  /** Things the file does not reproduce, each once. */
  warnings: string[];
}

const num = (v: number): string => (Number.isFinite(v) ? String(Math.round(v * 1000) / 1000 + 0) : "0");
const pt = (x: number, y: number) => `${num(x)} ${num(y)}`;

// Alpha over a white sheet: EPS has no transparency, so a half-transparent paint becomes the colour it looks like on paper.
function onWhite(c: { r: number; g: number; b: number; a: number }, extra = 1): [number, number, number] {
  const a = Math.min(1, Math.max(0, c.a * extra));
  const mix = (v: number) => Math.min(1, Math.max(0, v)) * a + (1 - a);
  return [mix(c.r), mix(c.g), mix(c.b)];
}

const rgb = (c: [number, number, number]) => `${num(c[0])} ${num(c[1])} ${num(c[2])} setrgbcolor\n`;

function cmdsToPs(cmds: readonly PathCmd[]): string {
  let out = "";
  for (const c of cmds) {
    if (c[0] === "M") out += `${pt(c[1], c[2])} moveto\n`;
    else if (c[0] === "L") out += `${pt(c[1], c[2])} lineto\n`;
    else if (c[0] === "C") out += `${pt(c[1], c[2])} ${pt(c[3], c[4])} ${pt(c[5], c[6])} curveto\n`;
    else out += "closepath\n";
  }
  return out;
}

const KAPPA = 0.5522847498;

function rectCommands(n: NodeLite): PathCmd[] {
  const { x, y, width: w, height: h } = n;
  const r = n.kind === "rect" ? Math.min(n.cornerRadius, w / 2, h / 2) : 0;
  if (!(r > 0)) return [["M", x, y], ["L", x + w, y], ["L", x + w, y + h], ["L", x, y + h], ["Z"]];
  const k = r * (1 - KAPPA);
  return [
    ["M", x + r, y], ["L", x + w - r, y], ["C", x + w - k, y, x + w, y + k, x + w, y + r],
    ["L", x + w, y + h - r], ["C", x + w, y + h - k, x + w - k, y + h, x + w - r, y + h],
    ["L", x + r, y + h], ["C", x + k, y + h, x, y + h - k, x, y + h - r],
    ["L", x, y + r], ["C", x, y + k, x + k, y, x + r, y], ["Z"],
  ];
}

function ellipseCommands(n: NodeLite): PathCmd[] {
  const rx = n.width / 2, ry = n.height / 2, cx = n.x + rx, cy = n.y + ry, kx = rx * KAPPA, ky = ry * KAPPA;
  return [
    ["M", cx + rx, cy], ["C", cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
    ["C", cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy], ["C", cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
    ["C", cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy], ["Z"],
  ];
}

function vectorCommands(n: NodeLite, closedOnly: boolean | null): PathCmd[] {
  const out: PathCmd[] = [];
  for (const sp of n.vector?.subpaths ?? []) {
    const k = sp.anchors.length;
    const closed = sp.closed && k >= 2;
    if (k === 0 || (closedOnly === true && !closed) || (closedOnly === false && closed)) continue;
    const a0 = sp.anchors[0]!;
    out.push(["M", n.x + a0.x, n.y + a0.y]);
    const segs = sp.closed ? k : k - 1;
    for (let i = 0; i < segs; i++) {
      const a = sp.anchors[i]!, b = sp.anchors[(i + 1) % k]!;
      out.push(["C", n.x + a.x + a.outX, n.y + a.y + a.outY, n.x + b.x + b.inX, n.y + b.y + b.inY, n.x + b.x, n.y + b.y]);
    }
    if (sp.closed) out.push(["Z"]);
  }
  return out;
}

/** The outline of a shape node; `forFill` keeps only the closed vector subpaths. Null for kinds with none. */
function outlineOf(n: NodeLite, forFill: boolean): PathCmd[] | null {
  if (n.kind === "vector") return vectorCommands(n, forFill ? true : null);
  const computed = outlineCommands(n);
  if (computed) return computed;
  if (n.kind === "ellipse") return ellipseCommands(n);
  return rectCommands(n);
}

// --- fonts -----------------------------------------------------------------------------------------

function psFontName(style: TextStyleLite): string {
  const fam = style.fontFamily.toLowerCase();
  const bold = /bold|black|heavy/.test(style.fontWeight.toLowerCase()) || Number(style.fontWeight) >= 600;
  const italic = style.italic === true;
  if (/mono|courier|consolas|menlo/.test(fam)) {
    if (bold) return italic ? "Courier-BoldOblique" : "Courier-Bold";
    return italic ? "Courier-Oblique" : "Courier";
  }
  if (/times|georgia|garamond|serif/.test(fam) && !/sans/.test(fam)) {
    if (bold) return italic ? "Times-BoldItalic" : "Times-Bold";
    return italic ? "Times-Italic" : "Times-Roman";
  }
  if (bold) return italic ? "Helvetica-BoldOblique" : "Helvetica-Bold";
  return italic ? "Helvetica-Oblique" : "Helvetica";
}

/** A PostScript string literal: Latin-1 as octal escapes, anything wider replaced with "?". */
export function psString(s: string): string {
  let out = "(";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === "(" || ch === ")" || ch === "\\") out += "\\" + ch;
    else if (c >= 32 && c < 127) out += ch;
    else if (c === 160) out += "\\240";
    else if (c >= 128 && c <= 255) out += "\\" + c.toString(8).padStart(3, "0");
    else if (c === 0x2018 || c === 0x2019) out += "'";
    else if (c === 0x201c || c === 0x201d) out += '"';
    else if (c === 0x2013 || c === 0x2014) out += "-";
    else if (c === 0x2022) out += "*";
    else if (c === 10 || c === 13 || c === 9) out += " ";
    else out += "?";
  }
  return out + ")";
}

// --- the file --------------------------------------------------------------------------------------

/**
 * The EPS of `nodes` (already in draw order) inside the region `bounds`.
 * `measure` lays text out exactly as the canvas does.
 */
export function nodesToEps(nodes: readonly NodeLite[], bounds: Bounds, measure: MeasureText, title = "opendesigner"): EpsResult {
  const warnings = new Set<string>();
  const warn = (s: string) => warnings.add(s);
  const body: string[] = [];
  const fonts = new Map<string, string>();
  const clipOf = new Map<string, string>();
  const fontRes = (name: string) => {
    let id = fonts.get(name);
    if (!id) { id = `F${fonts.size + 1}`; fonts.set(name, id); }
    return id;
  };

  const flatFill = (f: FillLite, opacity: number): [number, number, number] => {
    if (f.mesh) { warn("mesh gradients are drawn as the base colour"); }
    if (f.gradient) {
      warn("gradients are flattened to their average colour");
      const st = f.gradient.stops;
      if (st.length > 0) {
        const avg = { r: 0, g: 0, b: 0, a: 0 };
        for (const s of st) { avg.r += s.color.r; avg.g += s.color.g; avg.b += s.color.b; avg.a += s.color.a; }
        const k = 1 / st.length;
        return onWhite({ r: avg.r * k, g: avg.g * k, b: avg.b * k, a: avg.a * k }, opacity);
      }
    }
    if (f.a * opacity < 1) warn("transparency is flattened against white (EPS has none)");
    return onWhite(f, opacity);
  };

  for (const n of nodes) {
    if (n.isMask) {
      const cmds = n.kind === "ellipse" || n.kind === "rect" || n.kind === "frame" || n.kind === "polygon" || n.kind === "star"
        ? outlineOf(n, true) : n.kind === "vector" ? vectorCommands(n, true) : null;
      if (cmds && cmds.length > 0) { clipOf.set(n.parentId, cmdsToPs(cmds)); continue; }
    }
    const clip = clipOf.get(n.parentId);
    body.push("gsave\n");
    if (clip) body.push("newpath\n", clip, "eoclip newpath\n");
    if (n.effects?.length) warn("blur and shadow effects are not reproduced");
    if (n.blendMode) warn("blend modes are not reproduced");

    if (n.kind === "text") drawText(n);
    else if (n.kind === "image") {
      warn("images are not embedded: a placeholder box stands in");
      placeholder(n);
    } else drawShape(n);
    body.push("grestore\n");
  }

  function placeholder(n: NodeLite) {
    const box = `${pt(n.x, n.y)} moveto ${pt(n.x + n.width, n.y)} lineto ${pt(n.x + n.width, n.y + n.height)} lineto ${pt(n.x, n.y + n.height)} lineto closepath`;
    body.push("newpath\n", `${box}\n`, "0.94 setgray fill\n", "newpath\n", `${box}\n`, "0.6 setgray 1 setlinewidth stroke\n");
    body.push(`newpath ${pt(n.x, n.y)} moveto ${pt(n.x + n.width, n.y + n.height)} lineto ${pt(n.x + n.width, n.y)} moveto ${pt(n.x, n.y + n.height)} lineto stroke\n`);
  }

  function drawShape(n: NodeLite) {
    const fillable = !(n.kind === "frame" && n.fills.length === 0);
    const evenOdd = n.kind === "vector" ? (vectorStyleOf(n).fillRule ?? "evenodd") === "evenodd" : true;
    const fillPath = outlineOf(n, true);
    if (fillable && fillPath && fillPath.length > 0) {
      body.push("newpath\n", cmdsToPs(fillPath), rgb(flatFill(resolvedFill(n), n.opacity)), evenOdd ? "eofill\n" : "fill\n");
    }
    const s = n.strokes.find((st) => st.weight > 0);
    if (!s) return;
    if (s.align !== "center" && n.kind !== "vector") warn("inside and outside strokes are drawn centred");
    if (s.brush || s.widthProfile) warn("brush and variable-width strokes are drawn as plain strokes");
    const strokePath = outlineOf(n, false);
    if (!strokePath || strokePath.length === 0) return;
    const vs = n.kind === "vector" || n.meta ? vectorStyleOf(n) : null;
    const cap = vs ? { butt: 0, round: 1, square: 2 }[vs.cap] : 0;
    const join = vs ? { miter: 0, round: 1, bevel: 2 }[vs.join] : 0;
    body.push(
      "newpath\n", cmdsToPs(strokePath), rgb(flatFill(s.color, n.opacity)),
      `${num(s.weight)} setlinewidth ${cap} setlinecap ${join} setlinejoin\n`,
      vs && hasRealStroke(n) && vs.miter !== 10 ? `${num(vs.miter)} setmiterlimit\n` : "",
      `[${vs ? vs.dash.map(num).join(" ") : ""}] ${vs ? num(vs.dashOffset) : "0"} setdash\n`,
      "stroke\n",
    );
  }

  function drawText(n: NodeLite) {
    const style = n.text?.style;
    if (!style) return;
    const lines = placeTextLines((s) => measure(s, style), n, (st) => (s) => measure(s, st));
    if (lines.length === 0) return;
    const base = resolvedFill(n);
    for (const d of paragraphDecorations((st) => (s) => measure(s, st), n)) {
      if (d.kind === "border") continue;
      body.push("newpath\n", `${pt(d.x, d.y)} moveto ${pt(d.x + d.width, d.y)} lineto ${pt(d.x + d.width, d.y + d.height)} lineto ${pt(d.x, d.y + d.height)} lineto closepath\n`, rgb(flatFill(d.color, n.opacity)), "fill\n");
    }
    const show = (text: string, x: number, y: number, st: TextStyleLite, scale: number, color: FillLite) => {
      if (text === "") return;
      const id = fontRes(psFontName(st));
      body.push(
        rgb(flatFill(color, n.opacity)),
        `gsave ${pt(x, y)} translate 1 -1 scale ${id} ${num(fontSizeOf(st) * scale)} scalefont setfont `,
        `${num(st.horizontalScale ?? 1)} 1 scale 0 0 moveto ${psString(text)} show grestore\n`,
      );
    };
    for (const l of lines) {
      if (l.segments) {
        for (const seg of l.segments) {
          if (seg.inline) continue;
          if (seg.angle) warn("text along a path is drawn without its rotation");
          for (const pc of piecesOfSegment(seg, l.y)) show(pc.text, pc.x, pc.y - (seg.style.baselineShift ?? 0), seg.style, pc.scale, seg.style.color ?? base);
        }
      } else {
        const pieces = l.pieces ?? [{ text: l.text, x: l.x, y: l.y, scale: 1 }];
        for (const pc of pieces) show(pc.text, pc.x, pc.y, style, pc.scale, style.color ?? base);
      }
    }
    warn("fonts are not embedded: text uses Helvetica, Times or Courier, so widths may differ");
  }

  const w = Math.max(1, bounds.width), h = Math.max(1, bounds.height);
  const prolog = [
    "%!PS-Adobe-3.0 EPSF-3.0",
    "%%Creator: opendesigner",
    `%%Title: ${title.replace(/[^\x20-\x7e]/g, "?")}`,
    `%%BoundingBox: 0 0 ${Math.ceil(w * EPS_PT)} ${Math.ceil(h * EPS_PT)}`,
    `%%HiResBoundingBox: 0 0 ${num(w * EPS_PT)} ${num(h * EPS_PT)}`,
    "%%LanguageLevel: 2",
    "%%EndComments",
    "%%BeginProlog",
    "/opendesigner-state save def",
    "/reencode { findfont dup length dict begin { 1 index /FID ne { def } { pop pop } ifelse } forall /Encoding ISOLatin1Encoding def currentdict end definefont pop } bind def",
    "%%EndProlog",
    "%%BeginSetup",
    // Each used font is re-encoded to Latin-1 once, and F<n> pushes it.
    ...[...fonts].map(([name, id]) => `/${name}-L1 /${name} reencode /${id} { /${name}-L1 findfont } bind def`),
    "%%EndSetup",
    `${num(-bounds.x * EPS_PT)} ${num((bounds.y + bounds.height) * EPS_PT)} translate ${num(EPS_PT)} ${num(-EPS_PT)} scale`,
    // The drawing area clip, in document coordinates.
    `newpath ${pt(bounds.x, bounds.y)} moveto ${pt(bounds.x + w, bounds.y)} lineto ${pt(bounds.x + w, bounds.y + h)} lineto ${pt(bounds.x, bounds.y + h)} lineto closepath clip newpath`,
  ];
  const eps = `${prolog.join("\n")}\n${body.join("")}opendesigner-state restore\nshowpage\n%%EOF\n`;
  return { eps, warnings: [...warnings] };
}
