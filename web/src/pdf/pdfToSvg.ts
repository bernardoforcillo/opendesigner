// A PDF PAGE -> SVG TEXT, which the existing SVG importer turns into editable nodes.
//
// Why through SVG and not straight to ops: svg/importSvg.ts already knows how to make
// rect / vector / text / image nodes (with the right fills, strokes, dashes, fill rules
// and warnings), so a PDF page only has to be *described* in SVG. The converter is PURE:
// it takes what pdf.js reports (the operator list, the text items, the images already
// turned into data URIs) and returns a string, so it is testable without pdf.js.
//
// WHAT COMES ACROSS
//   paths filled / stroked   -> <rect> (axis-aligned rectangle) or <path>, with fill rule,
//                               colour, opacity, line width / cap / join / miter / dash
//   text                     -> <text> per run: position, size, bold / italic, colour
//   images                   -> <image> (placed by the current matrix)
// WHAT DOES NOT (counted in `warnings`, never an error): clipping, shadings and tiling
// patterns (the previous solid colour is kept), soft masks, text rendering modes and
// horizontal scaling. Vectors keep their geometry; fonts are matched by name, not embedded.

export type Matrix = readonly [number, number, number, number, number, number];

/** The operator names of pdf.js (`pdfjs.OPS`), passed in so this file does not import it. */
export type OpsTable = Readonly<Record<string, number>>;

export interface PdfTextRun {
  str: string;
  /** Text space -> default user space (pdf.js `TextItem.transform`). */
  transform: readonly number[];
  width: number;
  fontName: string;
}

export interface PdfPageInput {
  width: number;
  height: number;
  /** Default user space -> top-left origin pixels (pdf.js `viewport.transform`). */
  viewTransform: Matrix;
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown>;
  OPS: OpsTable;
  text: readonly PdfTextRun[];
  /** pdf.js font id -> real font name (may be missing). */
  fontNames?: Readonly<Record<string, string>>;
  /** Image object id (or `inline:<n>`) -> data URI. */
  images?: Readonly<Record<string, string>>;
}

export interface PdfSvgResult {
  svg: string;
  warnings: string[];
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

// Points go through `b` first, then `a`: M_new = M_old . T for a `cm` operator.
export function mul(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const r = (v: number) => String(Math.round(v * 1e3) / 1e3 + 0);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hex = (c: readonly [number, number, number]) =>
  "#" + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
// The mean scale of a matrix: what a line width or a dash length becomes under it.
const scaleOf = (m: Matrix) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

interface GState {
  ctm: Matrix;
  fill: string;
  stroke: string;
  fillOpacity: number;
  strokeOpacity: number;
  lineWidth: number;
  cap: number;
  join: number;
  miter: number;
  dash: number[];
  dashPhase: number;
}

const initial = (): GState => ({
  ctm: IDENTITY, fill: "#000000", stroke: "#000000", fillOpacity: 1, strokeOpacity: 1,
  lineWidth: 1, cap: 0, join: 0, miter: 10, dash: [], dashPhase: 0,
});

const CAPS = ["butt", "round", "square"];
const JOINS = ["miter", "round", "bevel"];

/** "ABCDEF+Arial-BoldMT" -> family "Arial", bold, italic. */
export function describeFont(name: string | undefined, fallbackFamily: string): { family: string; bold: boolean; italic: boolean } {
  const clean = (name ?? "").replace(/^[A-Z]{6}\+/, "");
  const bold = /bold|black|heavy|semibold|demi/i.test(clean);
  const italic = /italic|oblique/i.test(clean);
  const base = clean.split(/[-,]/)[0].replace(/(MT|PS)$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  const generic = /mono|courier/i.test(clean) ? "monospace" : /times|serif(?!.*sans)|georgia|garamond|minion/i.test(clean) ? "serif" : fallbackFamily || "sans-serif";
  return { family: base ? `${base}, ${generic}` : generic, bold, italic };
}

export function pdfPageToSvg(page: PdfPageInput): PdfSvgResult {
  const { OPS, viewTransform: V } = page;
  const warnings = new Set<string>();
  const out: string[] = [];
  const stack: GState[] = [];
  let gs = initial();
  let path: { kind: string; pts: number[] }[] = [];
  let rectOnly: number[] | null = null;
  let fillColors: string[] = []; // colour at each showText, in order
  let inlineImages = 0;

  const M = () => mul(V, gs.ctm);
  const attrsPaint = (fill: boolean, stroke: boolean, evenOdd: boolean) => {
    const m = M();
    const a: string[] = [];
    a.push(fill ? `fill="${gs.fill}"` : `fill="none"`);
    if (fill && evenOdd) a.push(`fill-rule="evenodd"`);
    if (fill && gs.fillOpacity < 1) a.push(`fill-opacity="${r(gs.fillOpacity)}"`);
    if (stroke) {
      const k = scaleOf(m);
      a.push(`stroke="${gs.stroke}"`, `stroke-width="${r(Math.max(gs.lineWidth, 0) * k)}"`);
      if (gs.strokeOpacity < 1) a.push(`stroke-opacity="${r(gs.strokeOpacity)}"`);
      if (gs.cap) a.push(`stroke-linecap="${CAPS[gs.cap] ?? "butt"}"`);
      if (gs.join) a.push(`stroke-linejoin="${JOINS[gs.join] ?? "miter"}"`);
      if (gs.join === 0 && gs.miter !== 10) a.push(`stroke-miterlimit="${r(gs.miter)}"`);
      if (gs.dash.length > 0 && gs.dash.some((d) => d > 0)) {
        a.push(`stroke-dasharray="${gs.dash.map((d) => r(d * k)).join(" ")}"`);
        if (gs.dashPhase) a.push(`stroke-dashoffset="${r(gs.dashPhase * k)}"`);
      }
    }
    return a.join(" ");
  };

  const paint = (fill: boolean, stroke: boolean, evenOdd: boolean, close: boolean) => {
    if (path.length === 0) return;
    const m = M();
    const attrs = attrsPaint(fill, stroke, evenOdd);
    const axisAligned = Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9;
    if (rectOnly && axisAligned) {
      const [x, y, w, h] = rectOnly;
      const [x1, y1] = apply(m, x, y);
      const [x2, y2] = apply(m, x + w, y + h);
      out.push(`<rect x="${r(Math.min(x1, x2))}" y="${r(Math.min(y1, y2))}" width="${r(Math.abs(x2 - x1))}" height="${r(Math.abs(y2 - y1))}" ${attrs}/>`);
    } else {
      let d = "";
      for (const seg of path) {
        const p = seg.pts;
        const dev = (i: number) => apply(m, p[i], p[i + 1]).map(r).join(" ");
        if (seg.kind === "M") d += `M${dev(0)}`;
        else if (seg.kind === "L") d += `L${dev(0)}`;
        else if (seg.kind === "C") d += `C${dev(0)} ${dev(2)} ${dev(4)}`;
        else if (seg.kind === "Z") d += "Z";
      }
      if (close && !d.endsWith("Z")) d += "Z";
      out.push(`<path d="${d}" ${attrs}/>`);
    }
  };

  const endPath = () => {
    path = [];
    rectOnly = null;
  };

  // The current point, for curveTo2 / curveTo3 which omit one control point.
  const current = (): [number, number] => {
    for (let i = path.length - 1; i >= 0; i--) {
      const p = path[i].pts;
      if (p.length >= 2) return [p[p.length - 2], p[p.length - 1]];
    }
    return [0, 0];
  };

  const byCode = new Map<number, string>(Object.entries(OPS).map(([k, v]) => [v, k]));

  const addPathOps = (ops: ArrayLike<number>, coords: ArrayLike<number>) => {
    let c = 0;
    const first = path.length === 0;
    for (let i = 0; i < ops.length; i++) {
      switch (byCode.get(ops[i])) {
        case "moveTo": path.push({ kind: "M", pts: [coords[c], coords[c + 1]] }); c += 2; break;
        case "lineTo": path.push({ kind: "L", pts: [coords[c], coords[c + 1]] }); c += 2; break;
        case "curveTo": path.push({ kind: "C", pts: Array.from({ length: 6 }, (_, k) => coords[c + k]) }); c += 6; break;
        case "curveTo2": { // first control point = current point
          const [cx, cy] = current();
          path.push({ kind: "C", pts: [cx, cy, coords[c], coords[c + 1], coords[c + 2], coords[c + 3]] }); c += 4; break;
        }
        case "curveTo3": // last control point = end point
          path.push({ kind: "C", pts: [coords[c], coords[c + 1], coords[c + 2], coords[c + 3], coords[c + 2], coords[c + 3]] }); c += 4; break;
        case "closePath": path.push({ kind: "Z", pts: [] }); break;
        case "rectangle": {
          const [x, y, w, h] = [coords[c], coords[c + 1], coords[c + 2], coords[c + 3]];
          c += 4;
          path.push(
            { kind: "M", pts: [x, y] }, { kind: "L", pts: [x + w, y] },
            { kind: "L", pts: [x + w, y + h] }, { kind: "L", pts: [x, y + h] }, { kind: "Z", pts: [] },
          );
          if (first && ops.length === 1) rectOnly = [x, y, w, h];
          break;
        }
      }
    }
    if (!(first && ops.length === 1 && byCode.get(ops[0]) === "rectangle")) rectOnly = null;
  };

  const image = (key: string) => {
    const uri = page.images?.[key];
    if (!uri) { warnings.add("some images could not be read"); return; }
    const m = M();
    // The image occupies the unit square, y up: flip it into SVG's y-down box.
    const n = mul(m, [1, 0, 0, -1, 0, 1]);
    if (Math.abs(n[1]) < 1e-9 && Math.abs(n[2]) < 1e-9 && n[0] > 0 && n[3] > 0) {
      out.push(`<image x="${r(n[4])}" y="${r(n[5])}" width="${r(n[0])}" height="${r(n[3])}" preserveAspectRatio="none" href="${uri}"/>`);
    } else {
      out.push(`<image width="1" height="1" preserveAspectRatio="none" transform="matrix(${n.map(r).join(" ")})" href="${uri}"/>`);
    }
  };

  const rgb = (a: unknown): string | null =>
    Array.isArray(a) || ArrayBuffer.isView(a) ? hex(Array.from(a as ArrayLike<number>) as [number, number, number]) : null;

  for (let i = 0; i < page.fnArray.length; i++) {
    const op = byCode.get(page.fnArray[i]);
    const args = (page.argsArray[i] ?? []) as unknown[];
    switch (op) {
      case "save": stack.push({ ...gs, dash: [...gs.dash] }); break;
      case "restore": if (stack.length) gs = stack.pop()!; break;
      case "transform": gs.ctm = mul(gs.ctm, args as unknown as Matrix); break;
      case "constructPath": addPathOps(args[0] as number[], args[1] as number[]); break;
      case "setFillRGBColor": gs.fill = rgb(args) ?? gs.fill; break;
      case "setStrokeRGBColor": gs.stroke = rgb(args) ?? gs.stroke; break;
      case "setFillColorN": case "setStrokeColorN": case "shadingFill": case "paintShading":
        warnings.add("gradients and patterns were replaced by a solid colour");
        break;
      case "setLineWidth": gs.lineWidth = Number(args[0]); break;
      case "setLineCap": gs.cap = Number(args[0]); break;
      case "setLineJoin": gs.join = Number(args[0]); break;
      case "setMiterLimit": gs.miter = Number(args[0]); break;
      case "setDash": gs.dash = (args[0] as number[]).slice(); gs.dashPhase = Number(args[1]) || 0; break;
      case "setGState":
        for (const [k, v] of args[0] as [string, unknown][]) {
          if (k === "CA") gs.strokeOpacity = Number(v);
          else if (k === "ca") gs.fillOpacity = Number(v);
          else if (k === "SMask" && v) warnings.add("soft masks were ignored");
        }
        break;
      case "fill": paint(true, false, false, true); endPath(); break;
      case "eoFill": paint(true, false, true, true); endPath(); break;
      case "stroke": paint(false, true, false, false); endPath(); break;
      case "closeStroke": paint(false, true, false, true); endPath(); break;
      case "fillStroke": paint(true, true, false, true); endPath(); break;
      case "eoFillStroke": paint(true, true, true, true); endPath(); break;
      case "closeFillStroke": paint(true, true, false, true); endPath(); break;
      case "closeEOFillStroke": paint(true, true, true, true); endPath(); break;
      case "endPath": endPath(); break;
      case "clip": case "eoClip": warnings.add("clipping was not carried over"); break;
      case "showText": case "showSpacedText":
        // A marker keeps the stacking order; it is replaced by the run below.
        out.push(`@@T${fillColors.length}@@`);
        fillColors.push(gs.fill);
        break;
      case "paintImageXObject": case "paintImageMaskXObject": image(String(args[0])); break;
      case "paintInlineImageXObject": case "paintInlineImageMaskXObject": image(`inline:${inlineImages++}`); break;
      default: break;
    }
  }

  // TEXT. Runs come from pdf.js's text content; colours come from the operator list, matched
  // by order -- only when the counts agree, otherwise every run is black rather than wrong.
  const runs = page.text.filter((t) => t.str.trim() !== "");
  const colorsOk = fillColors.length === runs.length;
  const rendered = runs.map((t, idx) => {
    const m = mul(V, t.transform as unknown as Matrix);
    const size = Math.hypot(m[0], m[1]);
    if (size < 0.01) return "";
    const font = describeFont(page.fontNames?.[t.fontName], "sans-serif");
    const color = colorsOk ? fillColors[idx] : "#000000";
    const rot = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
    const place = Math.abs(rot) < 0.01 ? `x="${r(m[4])}" y="${r(m[5])}"` : `x="0" y="0" transform="translate(${r(m[4])} ${r(m[5])}) rotate(${r(rot)})"`;
    return (
      `<text ${place} font-family="${esc(font.family)}" font-size="${r(size)}"` +
        `${font.bold ? ' font-weight="700"' : ""}${font.italic ? ' font-style="italic"' : ""} fill="${color}" xml:space="preserve">${esc(t.str)}</text>`
    );
  });
  // Counts agree: each run sits where its showText was. Otherwise they go on top.
  const body = colorsOk
    ? out.map((e) => e.replace(/^@@T(\d+)@@$/, (_m, n) => rendered[Number(n)] ?? "")).join("")
    : out.filter((e) => !e.startsWith("@@T")).join("") + rendered.join("");
  if (page.text.some((t) => t.str.trim() !== "")) warnings.add("fonts are matched by name, not embedded");

  const w = r(page.width), h = r(page.height);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect id="page-background" width="${w}" height="${h}" fill="#ffffff"/>${body}</svg>`;
  return { svg, warnings: [...warnings] };
}
