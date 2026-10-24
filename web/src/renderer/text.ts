import type { NodeLite, TextAlignLite, TextStyleLite } from "../store/types";
import type { Bounds } from "../canvas/geometry";

// The text defaults live HERE and nowhere else. The model keeps
// the zeros (an absent style becomes an all-zero style, see
// store/types.ts) because it must remain indistinguishable from core.Apply in Go: it is
// the renderer that decides what "unspecified" means, exactly as the
// proto's comment says ("" => renderer default, line_height 0 => 1.2).
export const DEFAULT_FONT_FAMILY = "Inter, sans-serif";
export const DEFAULT_FONT_SIZE = 16;
export const DEFAULT_FONT_WEIGHT = "400";
export const DEFAULT_LINE_HEIGHT = 1.2;

// Fraction of the em that sits ABOVE the baseline. It is an approximation: the true
// metrics (actualBoundingBoxAscent) exist only with a ctx and change from font to
// font, while layout must run without a DOM too. 0.8em is the typical
// ascent value of a sans-serif font and keeps the baseline inside the line for every
// multiplier >= 1.
const ASCENT_RATIO = 0.8;

export interface TextLayout {
  lines: string[];
  lineHeight: number;
  ascent: number;
  width: number;
  height: number;
  // Parallel to `lines`: the left lead of each line (paragraph indent plus the hanging
  // list marker column) and the marker of the paragraph's FIRST line ("" elsewhere).
  leads: number[];
  markers: string[];
}

// Small caps are SYNTHESISED (lowercase letters drawn as capitals at this fraction of
// the size) instead of asking the font for `smcp`: it works on every renderer, in the
// 2D canvas and in the GPU font book alike, and the layout can measure it.
export const SMALL_CAPS_SCALE = 0.8;
// Super/subscript: glyphs at this fraction of the size, raised or lowered by a fraction
// of the (unscaled) size.
export const SCRIPT_SCALE = 0.65;
const SUPER_RISE = 0.33;
const SUB_DROP = 0.12;
// Gap between a list marker and its text, and the marker column's minimum width, in em.
const LIST_GAP_EM = 0.4;
const LIST_MIN_MARKER_EM = 0.9;
export const BULLET = "•";

type StyleX = TextStyleLite | undefined;

/** True for small caps asked by `textCase` or by the font-feature string (`"smcp"` / `"c2sc"`). */
export function isSmallCaps(style: StyleX): boolean {
  if (!style) return false;
  return style.textCase === "smallCaps" || /"(smcp|c2sc)"(?!\s*0)/.test(style.fontFeatures ?? "");
}

/** Whether `"liga"` (or `"clig"`) is switched off in the feature string. */
export function ligaturesOff(style: StyleX): boolean {
  return /"(liga|clig)"\s*0/.test(style?.fontFeatures ?? "");
}

/** The sanitised font-feature string (what CSS/SVG may write), "" if unset or malformed. */
export function fontFeaturesOf(style: StyleX): string {
  const f = style?.fontFeatures ?? "";
  return /^[A-Za-z0-9 ,"]{0,128}$/.test(f) ? f : "";
}

/** Scale of super/subscript glyphs: 1 for none. */
export function scriptScaleOf(style: StyleX): number {
  return style?.textScript ? SCRIPT_SCALE : 1;
}

/** The baseline shift of a super/subscript (negative = up), in world units. */
export function scriptShiftOf(style: StyleX): number {
  if (style?.textScript === "super") return -fontSizeOf(style) * SUPER_RISE;
  if (style?.textScript === "sub") return fontSizeOf(style) * SUB_DROP;
  return 0;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());
}

/** The text as DRAWN: upper, lower and title case transform it; small caps are a drawing matter. */
export function caseText(text: string, style: StyleX): string {
  switch (style?.textCase) {
    case "upper": return text.toUpperCase();
    case "lower": return text.toLowerCase();
    case "title": return titleCase(text);
    default: return text;
  }
}

export interface TextRun { text: string; scale: number }

/** A line split into runs of one size: the small-cap lowercase letters (as capitals) apart from the rest. */
export function runsOf(text: string, style: StyleX): TextRun[] {
  const base = scriptScaleOf(style);
  if (!isSmallCaps(style)) return text === "" ? [] : [{ text, scale: base }];
  const out: TextRun[] = [];
  for (const ch of Array.from(text)) {
    const up = ch.toUpperCase();
    const small = up !== ch && ch === ch.toLowerCase();
    const scale = small ? base * SMALL_CAPS_SCALE : base;
    const piece = small ? up : ch;
    const last = out[out.length - 1];
    if (last && last.scale === scale) last.text += piece;
    else out.push({ text: piece, scale });
  }
  return out;
}

// Whether a style changes how a line is MEASURED or drawn in runs (case synthesis, scripts).
function needsRuns(style: StyleX): boolean {
  return isSmallCaps(style) || !!style?.textScript;
}

/** `measure` made aware of runs: linear in the size, so a run at 0.8 is 0.8 of its width. */
export function styledMeasure(measure: (s: string) => number, style: StyleX): (s: string) => number {
  if (!needsRuns(style)) return measure;
  return (s) => runsOf(s, style).reduce((w, r) => w + measure(r.text) * r.scale, 0);
}

/** Padding between the box and the text on every side. */
export function insetOf(style: StyleX): number {
  return style?.inset && style.inset > 0 ? style.inset : 0;
}

function innerWidth(n: NodeLite, style: StyleX): number {
  return n.width > 0 ? Math.max(0, n.width - 2 * insetOf(style)) : n.width;
}

// The lead of a paragraph (indent plus the marker column of a list). The marker column
// is as wide as the widest marker of the node, so every item's text lines up.
function paragraphLead(markerWidth: number, style: StyleX): number {
  const indent = style?.indent && style.indent > 0 ? style.indent : 0;
  return indent + (style?.listKind ? markerWidth : 0);
}

function markerFor(style: StyleX, ordinal: number): string {
  return style?.listKind === "numbered" ? `${ordinal}.` : style?.listKind === "bullet" ? BULLET : "";
}
// They also accept an ABSENT style: a text node without `text` is not a
// state that toNodeLite produces (store/types.ts), but whoever resolves a metric
// must not blow up because of it -- it falls back to the renderer defaults like for
// every other unspecified field.
//
// Exported for the same reason as lineHeightOf: the editing textarea
// (ui/TextEditorOverlay.tsx) must show the text with the SAME size with which
// the canvas will draw it, and recomputing the default here (or worse, writing it
// again) is how the two measures diverge at the first change.
export function fontSizeOf(style: TextStyleLite | undefined): number {
  return style && style.fontSize > 0 ? style.fontSize : DEFAULT_FONT_SIZE;
}

// Exported because it is also the minimum measure of a text node for whoever cannot
// measure the glyphs (hit-test in shapes.ts): the height of ONE line is
// computable from the style alone, without a ctx.
export function lineHeightOf(style: TextStyleLite | undefined): number {
  const mult = style && style.lineHeight > 0 ? style.lineHeight : DEFAULT_LINE_HEIGHT;
  return fontSizeOf(style) * mult;
}

// Like fontSizeOf, and for the same reason: the SVG export (export/svg.ts) writes
// family and weight in separate ATTRIBUTES, not in ctx.font's CSS shorthand,
// but the "unspecified" default must remain the renderer's.
export function fontFamilyOf(style: TextStyleLite | undefined): string {
  return style && style.fontFamily !== "" ? style.fontFamily : DEFAULT_FONT_FAMILY;
}

export function fontWeightOf(style: TextStyleLite | undefined): string {
  return style && style.fontWeight !== "" ? style.fontWeight : DEFAULT_FONT_WEIGHT;
}

// Shorthand CSS accettato da ctx.font: "<weight> <size>px <family>".
export function fontString(style: TextStyleLite, scale = 1): string {
  return `${style.italic ? "italic " : ""}${fontWeightOf(style)} ${fontSizeOf(style) * scale}px ${fontFamilyOf(style)}`;
}

// x offset of ONE line inside the box, in coordinates relative to the box.
// With a box without width (a just-created text node) center and right have
// no reference: it falls back to left instead of drawing at negative x.
export function alignOffsetX(align: TextAlignLite, lineWidth: number, boxWidth: number): number {
  if (!(boxWidth > 0)) return 0;
  if (align === "center") return (boxWidth - lineWidth) / 2;
  if (align === "right") return boxWidth - lineWidth;
  return 0;
}

// Trailing spaces "hang" outside the wrap width, as in browsers:
// without this rule, typing "aaa bbb " would make an empty line appear
// below the text on every completed word (the trailing space sent the line
// past maxWidth). It applies both to the wrap's fit and to the measured width.
function visible(s: string): string {
  return s.replace(/\s+$/, "");
}

// Breaks a word wider than the line. A single character is NEVER
// rejected: it is what guarantees progress and therefore termination even
// with a maxWidth narrower than a glyph (overflowing is acceptable, not
// terminating is not). Array.from iterates by code point, so a surrogate pair
// (emoji) is not split in half.
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
  // An empty paragraph is an empty line: explicit newlines create lines
  // even when there is nothing to draw in them.
  if (para === "") { out.push(""); return; }
  if (!(maxWidth > 0) || !Number.isFinite(maxWidth)) { out.push(para); return; }

  const fits = (s: string) => measure(visible(s)) <= maxWidth;
  // null = NOTHING placed yet on this line; "" = a line that so far
  // contains an empty word, that is a space coming. The distinction is the
  // reason for the sentinel: with `line === ""` for both, the spaces that
  // open a line ("  hello", or an indented line after a \n) vanished --
  // every empty word was re-placed "alone" instead of being joined to the
  // next one with its space.
  let line: string | null = null;
  // Places a word on an empty line, breaking it if it does not fit alone.
  // Returns the remainder left on the line.
  const placeAlone = (word: string): string => {
    if (fits(word)) return word;
    const chunks = breakWord(measure, word, maxWidth);
    out.push(...chunks.slice(0, -1));
    return chunks[chunks.length - 1] ?? "";
  };

  for (const word of para.split(" ")) {
    if (line === null) { line = placeAlone(word); continue; }
    // Necessary annotation: without it, inference goes in circles (the narrowed
    // type of `line` depends on `candidate`, which depends on `line`) and tsc
    // stops the build with TS7022.
    const candidate: string = `${line} ${word}`;
    if (fits(candidate)) { line = candidate; continue; }
    out.push(line);
    line = placeAlone(word);
  }
  // split(" ") always returns at least one element and the empty paragraph has already
  // exited above, so here `line` is always a string; the ?? is only for the
  // type.
  out.push(line ?? "");
}

// Greedy text layout inside a wrap width.
//
// `measure` is a function and not the ctx on purpose: this way layout is
// verifiable in Node with a fake, deterministic measure, and in production
// it receives (s) => ctx.measureText(s).width (with ctx.font ALREADY set).
//
// Invariant: height === lines.length * lineHeight. Empty content => no
// lines and height 0; `lineHeight` stays resolved anyway, because it is the measure
// needed by the caret of a still-empty text.
export function layoutText(
  measure: (s: string) => number,
  content: string,
  style: TextStyleLite,
  maxWidth: number,
): TextLayout {
  const lineHeight = lineHeightOf(style);
  // half-leading as in CSS: the excess line spacing is split above and below,
  // so the first line does not stick to the box's top edge.
  const ascent = (lineHeight - fontSizeOf(style)) / 2 + fontSizeOf(style) * ASCENT_RATIO;
  if (content === "") return { lines: [], lineHeight, ascent, width: 0, height: 0, leads: [], markers: [] };

  // Case first (the wrap must see the glyphs that are drawn), then runs-aware measure.
  const m = styledMeasure(measure, style);
  const paras = caseText(content, style).replace(/\r\n?/g, "\n").split("\n");
  // List markers: an item per non-empty paragraph, numbered in order.
  const markerOf: string[] = [];
  let ordinal = 0;
  for (const para of paras) markerOf.push(style.listKind && para.trim() !== "" ? markerFor(style, ++ordinal) : "");
  const markerCol = style.listKind
    ? Math.max(LIST_MIN_MARKER_EM * fontSizeOf(style), ...markerOf.map((k) => (k === "" ? 0 : measure(k)))) + LIST_GAP_EM * fontSizeOf(style)
    : 0;
  const lead = paragraphLead(markerCol, style);

  const lines: string[] = [];
  const leads: number[] = [];
  const markers: string[] = [];
  paras.forEach((para, pi) => {
    const before = lines.length;
    // The lead narrows the wrap; at least 1 so a huge indent still terminates (breakWord).
    const room = maxWidth > 0 && Number.isFinite(maxWidth) ? Math.max(1, maxWidth - lead) : maxWidth;
    wrapParagraph(m, para, room, lines);
    for (let i = before; i < lines.length; i++) {
      leads.push(lead);
      markers.push(i === before ? markerOf[pi] : "");
    }
  });
  let width = 0;
  lines.forEach((line, i) => {
    const paint = visible(line);
    width = Math.max(width, paint === "" ? 0 : leads[i] + m(paint));
  });
  return { lines, lineHeight, ascent, width, height: lines.length * lineHeight, leads, markers };
}

// Measure of ONE line with the given style, in world units.
//
// It is a function and not a ctx for the same reason as layoutText: measuring
// glyphs requires a 2D context, but whoever only needs to KNOW where the text ends
// (the export, see export/region.ts) must not become impure for it. In
// production it comes from a real canvas (export/exportScene.ts::canvasMeasure),
// in tests from a fake, deterministic measure.
//
// It lives here and not in export/svg.ts (where it was born) because by now TWO
// export modules use it -- the SVG generator and the region computation -- and the type
// that puts them in agreement is a property of text, not of a format.
export type MeasureText = (text: string, style: TextStyleLite) => number;

// A line of text ALREADY POSITIONED, in WORLD coordinates. The y is that of the
// alphabetic BASELINE (see drawText), not of the line's top edge.
// `width` is the line's PAINTED width (without trailing spaces, which are
// not seen): whoever draws ignores it, whoever needs to know how much space the
// text occupies uses it instead of measuring a second time.
export interface PlacedLine {
  text: string; x: number; y: number; width: number;
  // Present only when the line is not one plain run (small caps, scripts, a list marker):
  // the pieces to draw, each with its own position (baseline y) and size scale. Whoever
  // draws uses them INSTEAD of text/x/y.
  segments?: PlacedSegment[];
}
export interface PlacedSegment { text: string; x: number; y: number; scale: number }

/** The pieces a placed line is drawn with: its segments, or the line itself as one. */
export function segmentsOfLine(line: PlacedLine): PlacedSegment[] {
  return line.segments ?? [{ text: line.text, x: line.x, y: line.y, scale: 1 }];
}

// The lines a text node produces, with their position: exactly
// those the canvas paints, and in the same place.
//
// Extracted from drawText because it serves TWO consumers that must stay
// in agreement: the canvas (drawText, below) and the SVG export
// (export/svg.ts, which turns them into <tspan>s). If the lines' position were
// computed twice, the exported text would drift from the drawn one
// at the first layout change -- and it is exactly the thing you
// notice in the exported image.
//
// `measure` is a function for the same reason as layoutText: this way this
// piece stays verifiable without a ctx. Whoever draws passes
// (s) => ctx.measureText(s).width with ctx.font ALREADY set.
export function placeTextLines(measure: (s: string) => number, n: NodeLite): PlacedLine[] {
  const t = n.text;
  if (n.kind !== "text" || !t || t.content === "") return [];
  return placeLines(measure, n, t.style, layoutText(measure, t.content, t.style, innerWidth(n, t.style)));
}

// The real placement, starting from an ALREADY computed layout: it is private because
// it exists only so as not to run layoutText twice for whoever (textPaintBounds)
// needs both the placed lines and the layout's height.
function placeLines(
  measure: (s: string) => number,
  n: NodeLite,
  style: TextStyleLite,
  layout: TextLayout,
): PlacedLine[] {
  const out: PlacedLine[] = [];
  const m = styledMeasure(measure, style);
  const inset = insetOf(style);
  const inner = innerWidth(n, style);
  // Vertical alignment inside a box taller than the text; a text taller than its box
  // starts at the top (never above the box).
  const spare = n.height - 2 * inset - layout.height;
  const top = n.y + inset + (spare > 0 ? (style.verticalAlign === "middle" ? spare / 2 : style.verticalAlign === "bottom" ? spare : 0) : 0);
  const runs = needsRuns(style);
  for (let i = 0; i < layout.lines.length; i++) {
    // Trailing spaces are not drawn (they are invisible) but would widen
    // the measure, and with align center/right would shift the line.
    const line = visible(layout.lines[i]);
    // An empty line is not drawn but still occupies its vertical slot.
    if (line === "") continue;
    const width = m(line);
    const lead = layout.leads[i] ?? 0;
    const x = n.x + inset + lead + alignOffsetX(style.align, width, inner > 0 ? Math.max(0, inner - lead) : inner);
    const baseline = top + layout.ascent + i * layout.lineHeight;
    const placed: PlacedLine = { text: line, x, y: baseline, width };
    const marker = layout.markers[i] ?? "";
    if (runs || marker !== "") {
      const segments: PlacedSegment[] = [];
      if (marker !== "") {
        segments.push({ text: marker, x: n.x + inset + (style.indent && style.indent > 0 ? style.indent : 0), y: baseline, scale: 1 });
      }
      let cx = x;
      const shift = scriptShiftOf(style);
      for (const r of runsOf(line, style)) {
        segments.push({ text: r.text, x: cx, y: baseline + shift, scale: r.scale });
        cx += measure(r.text) * r.scale;
      }
      placed.segments = segments;
    }
    out.push(placed);
  }
  return out;
}

/**
 * The rectangle that a text node ACTUALLY PAINTS, which is not its box.
 *
 * The model's box is not a limit for drawing and never has been:
 * `drawText` places line `i` at `y = n.y + ascent + i * lineHeight` without
 * looking at `n.height`, `drawScene` clips nothing, and nobody rewrites
 * the measured height into the node (the editing textarea grows, the node
 * does not). A node created with a click is ONE line tall: it is enough to go to a new line
 * once for the text to leave the box and keep showing on screen.
 *
 * Whoever draws can afford to ignore it -- the screen canvas is as large
 * as the window. Whoever CROPS cannot: the export sizes the file on the bounds,
 * so with the model's box it would throw away everything below the
 * first line, silently and with a file that looks successful. That is why the
 * text measure enters even into the computation of the region to export.
 *
 * It is the UNION of the box and the lines, never a replacement: a box taller than
 * the text (dragged by the user, or left so after deleting
 * lines) remains part of what is exported, exactly as it is on screen.
 * Horizontal overflow counts like vertical, and exists in
 * both directions: a word wider than the box is broken but a
 * single glyph is not (breakWord never rejects a single character), and with
 * right alignment that remainder sticks out to the LEFT of the box.
 */
export function textPaintBounds(measure: MeasureText, n: NodeLite): Bounds {
  const box = { x: n.x, y: n.y, width: n.width, height: n.height };
  const t = n.text;
  if (n.kind !== "text" || !t || t.content === "") return box;

  const m = (s: string) => measure(s, t.style);
  const layout = layoutText(m, t.content, t.style, innerWidth(n, t.style));
  let minX = n.x;
  let maxX = n.x + n.width;
  for (const line of placeLines(m, n, t.style, layout)) {
    minX = Math.min(minX, line.x);
    maxX = Math.max(maxX, line.x + line.width);
    // A list marker sits left of the text.
    for (const seg of line.segments ?? []) minX = Math.min(minX, seg.x);
  }
  // Vertically the LAYOUT's height is used and not the last placed line:
  // empty lines paint nothing but occupy their slot, and the text's height
  // is the one the layout declares (layoutText invariant:
  // height === lines.length * lineHeight).
  const height = Math.max(n.height, layout.height);
  return { x: minX, y: n.y, width: maxX - minX, height };
}

// Draws the node's text in WORLD coordinates (the camera is already in the
// ctx's transform, as for the other shapes). The color is set by the
// caller (drawScene sets fillStyle and globalAlpha from the node): here only
// what concerns the text is touched.
export function drawText(ctx: CanvasRenderingContext2D, n: NodeLite): void {
  paintText(ctx, n, (line, x, y) => ctx.fillText(line, x, y));
}

// The text's STROKE. Twin of drawText -- same layout, same coordinates,
// same line by line -- and not a second measure: two independent layout paths
// would put the stroked glyphs out of phase with the filled ones at the first
// wrap change.
//
// DECLARED APPROXIMATION: a text's stroke is ALWAYS centered on the
// glyph's outline, whatever `align` is. INSIDE and OUTSIDE are obtained by
// clipping with the shape's path (see canvasRenderer.ts::strokeShape), and a
// glyph has no Path2D -- canvas 2D does not expose the text outline.
// The overhang counted in the bounds follows the SAME rule (half the weight for a
// text node, always: canvas/geometry.ts::strokeOutsetOfNode), so what
// is measured and what is painted remain the same thing.
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

  // ctx.font must be set BEFORE measuring: measureText uses the current font.
  ctx.font = fontString(t.style);
  // "liga" 0 maps to the one switch canvas has (it also turns kerning off); the other
  // OpenType features are CSS/SVG only. Reset explicitly: the ctx is shared state.
  const tr = ctx as CanvasRenderingContext2D & { textRendering?: string };
  if ("textRendering" in ctx) tr.textRendering = ligaturesOff(t.style) ? "optimizeSpeed" : "auto";
  // Never the default: textBaseline's initial value is "alphabetic" by
  // specification, but leaving it implicit means depending on the state left
  // by whoever drew before. The lines' y is computed with respect to the
  // alphabetic baseline, which is the only stable anchor across browsers and fonts
  // ("top" depends on the font's ascent metrics).
  ctx.textBaseline = "alphabetic";
  // Same reason: alignment is computed by alignOffsetX line by line
  // with respect to the node's box, not by the ctx.
  ctx.textAlign = "left";

  // placeTextLines (track 3) is the ONLY source of the lines' position --
  // the same one the SVG export consumes -- and paintLine (track 2) chooses
  // fill or stroke: the two tracks compose here without a second
  // measure of the layout.
  for (const line of placeTextLines((s) => ctx.measureText(s).width, n)) {
    for (const seg of segmentsOfLine(line)) {
      // Runs at another size (small caps, scripts) switch the font and switch back.
      if (seg.scale !== 1) ctx.font = fontString(t.style, seg.scale);
      paintLine(seg.text, seg.x, seg.y);
      if (seg.scale !== 1) ctx.font = fontString(t.style);
    }
  }
}
