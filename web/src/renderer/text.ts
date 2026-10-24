import type { NodeLite, TextAlignLite, TextLite, TextStyleLite } from "../store/types";
import { hyphenPoints } from "./hyphenate";
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
export function fontString(style: TextStyleLite): string {
  return `${style.italic ? "italic " : ""}${fontWeightOf(style)} ${fontSizeOf(style)}px ${fontFamilyOf(style)}`;
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
//
// RICH lines (paragraph / character styles, see layoutRich) also carry `segments`: the pieces of the
// line with their own style and x, in world coordinates. `text` is then the whole line, and `x` the
// start of the first piece.
export interface PlacedSegment { text: string; x: number; width: number; style: TextStyleLite }
export interface PlacedLine { text: string; x: number; y: number; width: number; segments?: PlacedSegment[] }

/** A measure that can be asked for any style: `measureFor(style)(text)` is the width in world units. */
export type MeasureFor = (style: TextStyleLite) => (s: string) => number;

// LETTER SPACING (tracking): `style.letterSpacing` px are added after every character. Layout
// measures with it, and painting places the characters one by one (see paintTracked) so that every
// renderer -- canvas, GPU, and the SVG's `letter-spacing` -- agrees on where each one goes.
const charCount = (s: string) => Array.from(s).length;

/** `measure` plus the style's letter spacing (the measure itself when there is none). */
export function trackedMeasure(measure: (s: string) => number, style: TextStyleLite | undefined): (s: string) => number {
  const ls = style?.letterSpacing ?? 0;
  const sx = style?.horizontalScale ?? 1;
  if (ls === 0 && sx === 1) return measure;
  return (s) => measure(s) * sx + ls * charCount(s);
}

export function trackedMeasureFor(measureFor: MeasureFor): MeasureFor {
  return (style) => trackedMeasure(measureFor(style), style);
}

/**
 * The x of each character of `text` starting at `x`, for a style with letter spacing: where it would be
 * without spacing (so kerning inside the string is kept) plus `spacing` for each character before it.
 */
export function trackedOffsets(text: string, x: number, spacing: number, measure: (s: string) => number, scale = 1): { ch: string; x: number }[] {
  const chars = Array.from(text);
  return chars.map((ch, i) => ({ ch, x: x + (i === 0 ? 0 : measure(chars.slice(0, i).join("")) * scale) + i * spacing }));
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
export function placeTextLines(measure: (s: string) => number, n: NodeLite, measureFor?: MeasureFor): PlacedLine[] {
  const t = n.text;
  if (n.kind !== "text" || !t || t.content === "") return [];
  // Formatted text needs to measure with several styles; without that it is laid out as plain text.
  if (t.rich && measureFor) {
    const tracked = trackedMeasureFor(measureFor);
    return placeRichLines(tracked, n, layoutRich(tracked, t.content, t.style, t.rich, n.width));
  }
  const m = trackedMeasure(measure, t.style);
  return placeLines(m, n, t.style, layoutText(m, t.content, t.style, n.width));
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
  for (let i = 0; i < layout.lines.length; i++) {
    // Trailing spaces are not drawn (they are invisible) but would widen
    // the measure, and with align center/right would shift the line.
    const line = visible(layout.lines[i]);
    // An empty line is not drawn but still occupies its vertical slot.
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
  if (t.rich) {
    const mf: MeasureFor = trackedMeasureFor((style) => (s) => measure(s, style));
    const layout = layoutRich(mf, t.content, t.style, t.rich, n.width);
    let minX = n.x, maxX = n.x + n.width;
    for (const line of placeRichLines(mf, n, layout)) {
      minX = Math.min(minX, line.x);
      maxX = Math.max(maxX, line.x + line.width);
      for (const seg of line.segments ?? []) { minX = Math.min(minX, seg.x); maxX = Math.max(maxX, seg.x + seg.width); }
    }
    return { x: minX, y: n.y, width: maxX - minX, height: Math.max(n.height, layout.height) };
  }

  const m = trackedMeasure((s: string) => measure(s, t.style), t.style);
  const layout = layoutText(m, t.content, t.style, n.width);
  let minX = n.x;
  let maxX = n.x + n.width;
  for (const line of placeLines(m, n, t.style, layout)) {
    minX = Math.min(minX, line.x);
    maxX = Math.max(maxX, line.x + line.width);
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
  drawDecorations(ctx, n);
}

// Underline and strikethrough: thin bars in the fill colour (set by the caller), under each piece of
// every line that asks for them -- the node's own style for plain lines, the piece's for rich ones.
function drawDecorations(ctx: CanvasRenderingContext2D, n: NodeLite): void {
  const t = n.text;
  if (n.kind !== "text" || !t || t.content === "") return;
  const anyOn = t.style.underline || t.style.strikethrough || t.rich?.paragraphs.some((p) => p.style.underline || p.style.strikethrough) ||
    t.rich?.runs.some((r) => r.style.underline || r.style.strikethrough);
  if (!anyOn) return;
  const lines = placeTextLines((s) => ctx.measureText(s).width, n, ctxMeasureFor(ctx));
  for (const line of lines) {
    const pieces = line.segments ?? [{ text: line.text, x: line.x, width: line.width, style: t.style }];
    for (const seg of pieces) {
      for (const bar of decorationBars(seg.style, line.y - (seg.style.baselineShift ?? 0))) ctx.fillRect(seg.x, bar.y, seg.width, bar.height);
    }
  }
}

/** The bars a style asks for under a piece whose baseline is at `baseline`: y and thickness, in world units. */
export function decorationBars(style: TextStyleLite, baseline: number): { y: number; height: number }[] {
  const size = fontSizeOf(style);
  const height = Math.max(1, size / 16);
  const bars: { y: number; height: number }[] = [];
  if (style.underline) bars.push({ y: baseline + size * 0.12, height });
  if (style.strikethrough) bars.push({ y: baseline - size * 0.3, height });
  return bars;
}

// ctx.fontKerning exists in current browsers; elsewhere (and in tests) kerning is simply the font's.
function setKerning(ctx: CanvasRenderingContext2D, value: "auto" | "none"): void {
  if ("fontKerning" in ctx) ctx.fontKerning = value;
}

/** A MeasureFor on a 2D context: it sets the font before every measure, so styles can alternate freely. */
export function ctxMeasureFor(ctx: CanvasRenderingContext2D): MeasureFor {
  return (style) => {
    const font = fontString(style);
    const kerning = style.noKerning ? "none" : "auto";
    return (s) => { ctx.font = font; setKerning(ctx, kerning); return ctx.measureText(s).width; };
  };
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
  const raw = (s: string) => ctx.measureText(s).width;
  // One piece: raised/lowered by its baseline shift, stretched by its horizontal scale, in its own colour;
  // with letter spacing it is drawn character by character.
  const piece = (text: string, x: number, y: number, style: TextStyleLite) => {
    const ls = style.letterSpacing ?? 0;
    const sx = style.horizontalScale ?? 1;
    const py = y - (style.baselineShift ?? 0);
    setKerning(ctx, style.noKerning ? "none" : "auto");
    const prevFill = ctx.fillStyle;
    if (style.color) ctx.fillStyle = `rgba(${Math.round(style.color.r * 255)},${Math.round(style.color.g * 255)},${Math.round(style.color.b * 255)},${style.color.a})`;
    if (sx !== 1) {
      ctx.save();
      ctx.translate(x, py);
      ctx.scale(sx, 1);
      if (ls === 0) paintLine(text, 0, 0);
      else for (const c of trackedOffsets(text, 0, ls / sx, raw)) paintLine(c.ch, c.x, 0);
      ctx.restore();
    } else if (ls === 0) paintLine(text, x, py);
    else for (const c of trackedOffsets(text, x, ls, raw)) paintLine(c.ch, c.x, py);
    if (style.color) ctx.fillStyle = prevFill;
  };
  for (const line of placeTextLines(raw, n, ctxMeasureFor(ctx))) {
    if (!line.segments) { piece(line.text, line.x, line.y, t.style); continue; }
    for (const seg of line.segments) {
      ctx.font = fontString(seg.style);
      if (seg.text !== "") piece(seg.text, seg.x, line.y, seg.style);
    }
  }
}


// --- rich layout ----------------------------------------------------------------------------------
//
// Text with paragraph styles and character styles (store/richText.ts resolves the style ids into
// `rich`). Same greedy wrapping as layoutText -- words separated by single spaces, a word wider than the
// line broken by characters, trailing spaces hanging -- but every character has its own style: the
// paragraph's, overridden by the character style of the run it falls in. A line is as tall as its
// tallest piece, pieces sit on one baseline, and paragraphs add their spacing and indents.
// On top of that, formatted text knows: small capitals and super/subscript (pieces re-styled before
// wrapping), tab stops with leaders, hyphenation, justified lines, list markers and drop caps.
// Text without `rich` never comes through here: plain text keeps the layout above, unchanged.

// `at` is where the piece starts in the (newline-normalized) content: it is what lets a caller know how
// much of the text a set of lines used (threaded frames flow the rest into the next frame).
// `w` is a width fixed by the layout (a tab), `synthetic` a character that is not in the content (the
// hyphen at a break), `leader` what fills a tab.
interface Frag { text: string; style: TextStyleLite; at: number; w?: number; synthetic?: boolean; leader?: string }
export interface RichLine {
  /** The pieces, in order. */
  frags: Frag[];
  /** Painted width of the pieces (trailing spaces not counted). */
  width: number;
  /** Top of the line, from the top of the text box. */
  top: number;
  height: number;
  /** Baseline, from the top of the line. */
  ascent: number;
  /** Left edge of the first piece, from the box's left edge. */
  left: number;
  /** Where the line ends in the normalized content (just after its last character). */
  end: number;
  /** Extra width added to every space of a justified line. */
  justify?: number;
  /** The list marker in front of the first line of a list paragraph, with its x from the box's left edge. */
  marker?: { text: string; style: TextStyleLite; x: number };
  /** The drop cap of the paragraph (on its first line), with its x from the box's left edge and its width. */
  drop?: { text: string; style: TextStyleLite; x: number; width: number };
}
export interface RichLayout { lines: RichLine[]; height: number }

const frag = (text: string, style: TextStyleLite, at: number): Frag => ({ text, style, at });

/** Tab stops past the last explicit one fall on multiples of this. */
export const DEFAULT_TAB = 36;
const SMALL_CAPS_SCALE = 0.8;
const SCRIPT_SCALE = 0.58;
const DROP_CAP_HEIGHT = 0.7;
const DROP_CAP_GAP = 0.15;

// Run boundaries in the NORMALIZED content ("\r\n" and "\r" are one "\n"): runs index the raw content.
function normalizedOffsets(raw: string): ((i: number) => number) | null {
  if (!raw.includes("\r")) return null;
  const map = new Array<number>(raw.length + 1);
  let out = 0;
  for (let i = 0; i < raw.length; i++) {
    map[i] = out;
    if (raw[i] === "\r") { if (raw[i + 1] === "\n") { map[i + 1] = out; i++; map[i] = out; } out++; }
    else out++;
  }
  map[raw.length] = out;
  return (i) => map[Math.min(i, raw.length)];
}

function metricsOf(style: TextStyleLite) {
  const size = fontSizeOf(style);
  const lh = lineHeightOf(style);
  const ascent = (lh - size) / 2 + size * ASCENT_RATIO;
  return { ascent, descent: lh - ascent };
}

type ParagraphLite = NonNullable<TextLite["rich"]>["paragraphs"][number];

// Styles derived from a piece's (small caps lowercase, super/subscript), cached so equal pieces share one
// object and neighbours merge into one segment.
function derivedStyles() {
  const cache = new Map<TextStyleLite, Map<string, TextStyleLite>>();
  return (style: TextStyleLite, lower: boolean): TextStyleLite => {
    const key = lower ? "l" : "n";
    let per = cache.get(style);
    if (!per) { per = new Map(); cache.set(style, per); }
    const hit = per.get(key);
    if (hit) return hit;
    const { smallCaps: _c, script: _s, ...rest } = style;
    void _c; void _s;
    let out: TextStyleLite = rest;
    if (lower) out = { ...out, fontSize: fontSizeOf(style) * SMALL_CAPS_SCALE };
    if (style.script) {
      const size = fontSizeOf(out);
      out = { ...out, fontSize: size * SCRIPT_SCALE, baselineShift: (out.baselineShift ?? 0) + (style.script === "super" ? size * 0.36 : -size * 0.14) };
    }
    per.set(key, out);
    return out;
  };
}

// Pieces re-styled for what the layout must do itself: tabs become their own piece, small capitals are
// split into lowercase (drawn as smaller capitals) and the rest, super/subscript shrink and shift.
function expandPieces(pieces: Frag[]): Frag[] {
  const derive = derivedStyles();
  const out: Frag[] = [];
  for (const piece of pieces) {
    let off = piece.at;
    for (const part of piece.text.split(/(\t)/)) {
      if (part === "") continue;
      if (part === "\t") { out.push(frag("\t", piece.style, off)); off += 1; continue; }
      const st = piece.style;
      if (!st.smallCaps && !st.script) { out.push(frag(part, st, off)); off += part.length; continue; }
      let chunk = "", lower = false, chunkAt = off;
      const flush = () => { if (chunk !== "") out.push(frag(chunk, derive(st, lower && !!st.smallCaps), chunkAt)); chunk = ""; };
      for (const ch of Array.from(part)) {
        const up = st.smallCaps ? ch.toUpperCase() : ch;
        const isLower = !!st.smallCaps && up !== ch && up.length === ch.length;
        if (isLower !== lower) { flush(); lower = isLower; chunkAt = off; }
        chunk += isLower ? up : ch;
        off += ch.length;
      }
      flush();
    }
  }
  return out;
}

export function layoutRich(
  measureFor: MeasureFor,
  content: string,
  base: TextStyleLite,
  rich: NonNullable<TextLite["rich"]>,
  maxWidth: number,
): RichLayout {
  const text = content.replace(/\r\n?/g, "\n");
  const norm = normalizedOffsets(content);
  const runs = rich.runs.map((r) => ({ start: norm ? norm(r.start) : r.start, end: norm ? norm(r.end) : r.end, style: r.style }));
  const lines: RichLine[] = [];
  let y = 0;
  let offset = 0;
  const paragraphs = text.split("\n");
  paragraphs.forEach((para, pi) => {
    const pr: ParagraphLite = rich.paragraphs[pi] ?? { style: base, spaceBefore: 0, spaceAfter: 0, indentFirst: 0, indentLeft: 0 };
    // The pieces of the paragraph: split at run boundaries.
    let pieces: Frag[] = [];
    const end = offset + para.length;
    let pos = offset;
    while (pos < end) {
      const run = runs.find((r) => r.start <= pos && pos < r.end);
      const next = Math.min(end, run ? run.end : Math.min(...runs.filter((r) => r.start > pos).map((r) => r.start), end));
      pieces.push(frag(text.slice(pos, next), run ? overlayStyle(pr.style, run.style) : pr.style, pos));
      pos = next;
    }
    const paraStart = offset;
    offset = end + 1;

    if (pi > 0) y += pr.spaceBefore;
    const paraTop = y;
    const lh0 = metricsOf(pr.style).ascent + metricsOf(pr.style).descent;

    // Drop cap: the first characters, large, spanning `dropLines` lines; those lines make room for it.
    let drop: RichLine["drop"];
    let dropLen = 0;
    const dropLines = pr.dropLines && pr.dropLines >= 2 ? pr.dropLines : 0;
    if (dropLines > 0 && pieces.length > 0 && pieces[0].text !== "" && !/^\s/.test(pieces[0].text)) {
      let want = pr.dropChars && pr.dropChars > 0 ? pr.dropChars : 1;
      let taken = "";
      const rest: Frag[] = [];
      for (const pc of pieces) {
        if (want <= 0) { rest.push(pc); continue; }
        let cut = 0;
        for (const ch of Array.from(pc.text)) { if (want <= 0) break; taken += ch; cut += ch.length; want--; }
        if (cut < pc.text.length) rest.push(frag(pc.text.slice(cut), pc.style, pc.at + cut));
      }
      if (taken !== "" && !/\s/.test(taken)) {
        const size = fontSizeOf(pieces[0].style);
        const bigSize = ((dropLines - 1) * lh0 + DROP_CAP_HEIGHT * size) / DROP_CAP_HEIGHT;
        const style: TextStyleLite = { ...pieces[0].style, fontSize: bigSize, lineHeight: 1, baselineShift: -((dropLines - 1) * lh0) };
        dropLen = taken.length;
        drop = { text: taken, style, x: pr.indentLeft, width: measureFor(style)(taken) + size * DROP_CAP_GAP };
        pieces = rest;
      }
    }

    const listed = pr.marker !== undefined;
    // Where line `i` of this paragraph starts, from the box's left edge.
    const leftOf = (i: number) => pr.indentLeft + (listed ? pr.listIndent ?? 0 : i === 0 ? pr.indentFirst : 0) + (drop && i < dropLines ? drop.width : 0);
    const limitAt = (i: number) => (maxWidth > 0 ? maxWidth - leftOf(i) : Infinity);

    const built = wrapPieces(measureFor, expandPieces(pieces), pr, limitAt, leftOf);
    // An empty paragraph is an empty line: it keeps its height.
    if (built.length === 0) built.push({ frags: [], width: 0 });
    // Justified: every line but the paragraph's last gets its spaces widened to fill the line.
    if (pr.style.align === "justify" && maxWidth > 0) {
      built.forEach((l, li) => {
        if (li === built.length - 1) return;
        const spaces = l.frags.reduce((n, f) => (f.w === undefined ? n + (f.text.split(" ").length - 1) : n), 0);
        const room = limitAt(li) - l.width;
        if (spaces > 0 && room > 0) { l.justify = room / spaces; l.width = limitAt(li); }
      });
    }
    for (const [li, l] of built.entries()) {
      const empty = l.frags.length === 0;
      const m = empty ? metricsOf(pr.style) : l.frags.map((f) => metricsOf(f.style)).reduce((a, b) => ({ ascent: Math.max(a.ascent, b.ascent), descent: Math.max(a.descent, b.descent) }));
      const height = m.ascent + m.descent;
      // On the baseline grid: the line moves down to the next grid line when its baseline falls between two.
      if (pr.alignToGrid && rich.grid) {
        const g = rich.grid;
        const baseline = g.boxY + y + m.ascent;
        const target = g.start + Math.ceil((baseline - g.start) / g.increment - 1e-9) * g.increment;
        if (target > baseline) y += target - baseline;
      }
      const lineWidth = maxWidth > 0 ? limitAt(li) : 0;
      const left = leftOf(li) + alignOffsetX(pr.style.align, l.width, lineWidth);
      const last = [...l.frags].reverse().find((f) => !f.synthetic);
      lines.push({
        frags: l.frags, width: l.width, top: y, height, ascent: m.ascent, left, end: last ? last.at + last.text.length : paraStart + dropLen,
        ...(l.justify ? { justify: l.justify } : {}),
        ...(li === 0 && listed ? { marker: { text: pr.marker!, style: pr.style, x: pr.indentLeft } } : {}),
        ...(li === 0 && drop ? { drop } : {}),
      });
      y += height;
    }
    // A drop cap taller than the paragraph keeps its room.
    if (drop && y < paraTop + dropLines * lh0) y = paraTop + dropLines * lh0;
    if (pi < paragraphs.length - 1) y += pr.spaceAfter;
  });
  return { lines, height: y };
}

// `over` is a character style (only its set fields count) on top of the paragraph's resolved style.
function overlayStyle(base: TextStyleLite, over: TextStyleLite): TextStyleLite {
  const out: TextStyleLite = {
    ...base,
    fontFamily: over.fontFamily !== "" ? over.fontFamily : base.fontFamily,
    fontSize: over.fontSize > 0 ? over.fontSize : base.fontSize,
    fontWeight: over.fontWeight !== "" ? over.fontWeight : base.fontWeight,
  };
  if (over.italic) out.italic = true;
  if (over.underline) out.underline = true;
  if (over.strikethrough) out.strikethrough = true;
  if (over.letterSpacing) out.letterSpacing = over.letterSpacing;
  if (over.smallCaps) out.smallCaps = true;
  if (over.script) out.script = over.script;
  if (over.horizontalScale) out.horizontalScale = over.horizontalScale;
  if (over.noKerning) out.noKerning = true;
  if (over.color) out.color = over.color;
  return out;
}

interface Built { frags: Frag[]; width: number; justify?: number }

// Splits the frags of a word after `n` UTF-16 units.
function splitFrags(frags: Frag[], n: number): [Frag[], Frag[]] {
  const head: Frag[] = [], tail: Frag[] = [];
  let used = 0;
  for (const f of frags) {
    if (used + f.text.length <= n) { head.push(f); used += f.text.length; continue; }
    if (used >= n) { tail.push(f); used += f.text.length; continue; }
    const cut = n - used;
    head.push(frag(f.text.slice(0, cut), f.style, f.at));
    tail.push(frag(f.text.slice(cut), f.style, f.at + cut));
    used += f.text.length;
  }
  return [head, tail];
}

// Greedy wrap of one paragraph's pieces. `limitAt(i)` is the room of line i (after its indents) and
// `leftOf(i)` where it starts, which tab stops need.
function wrapPieces(measureFor: MeasureFor, pieces: Frag[], pr: ParagraphLite, limitAt: (i: number) => number, leftOf: (i: number) => number): Built[] {
  if (pieces.length === 0) return [];
  const width = (f: Frag) => (f.w !== undefined ? f.w : f.text === "" ? 0 : measureFor(f.style)(f.text));
  // Words: runs of non-space characters, each with the style of its characters; the space before a
  // word is its separator and has its own style. A tab is a word of its own.
  interface Word { frags: Frag[]; sep: Frag | null; tab?: Frag }
  const words: Word[] = [];
  let cur: Word = { frags: [], sep: null };
  for (const piece of pieces) {
    if (piece.text === "\t") { words.push(cur); words.push({ frags: [], sep: null, tab: piece }); cur = { frags: [], sep: null }; continue; }
    let off = piece.at;
    piece.text.split(" ").forEach((part, i) => {
      if (i > 0) { words.push(cur); cur = { frags: [], sep: frag(" ", piece.style, off) }; off += 1; }
      if (part !== "") cur.frags.push(frag(part, piece.style, off));
      off += part.length;
    });
  }
  words.push(cur);

  const out: Built[] = [];
  const wordWidth = (w: Word) => w.frags.reduce((n, f) => n + width(f), 0);
  const tail = () => out[out.length - 1];
  const place = (frags: Frag[]) => {
    for (const f of frags) {
      const line = tail();
      const last = line.frags[line.frags.length - 1];
      const plain = f.w === undefined && !f.synthetic && !!last && last.w === undefined && !last.synthetic;
      if (plain && last.style === f.style && last.at + last.text.length === f.at) last.text += f.text; else line.frags.push({ ...f });
      line.width += width(f);
    }
  };
  const newLine = () => { out.push({ frags: [], width: 0 }); };
  const tabs = pr.tabs ?? [];

  // Width of the text after word `i` up to the next tab: what a right or centre tab has to make room for.
  const followWidth = (i: number) => {
    let n = 0;
    for (let k = i + 1; k < words.length && !words[k].tab; k++) n += (words[k].sep ? width(words[k].sep!) : 0) + wordWidth(words[k]);
    return n;
  };
  // The first stop beyond x (absolute, from the box's left edge): an explicit one, else the default grid.
  const stopAfter = (x: number) => tabs.find((t) => t.position > x + 0.5) ?? { position: (Math.floor(x / DEFAULT_TAB) + 1) * DEFAULT_TAB, align: undefined, leader: undefined };

  // The room for `head` + a hyphen on a line with `room` left, and the split that fits (the latest one).
  const hyphenSplit = (w: Word, room: number): { head: Frag[]; tail: Frag[]; hyphen: Frag } | null => {
    if (!pr.hyphenate) return null;
    const textOf = w.frags.map((f) => f.text).join("");
    const points = hyphenPoints(textOf);
    if (points.length === 0) return null;
    const units: number[] = [0];
    for (const ch of Array.from(textOf)) units.push(units[units.length - 1] + ch.length);
    for (let k = points.length - 1; k >= 0; k--) {
      const [head, rest] = splitFrags(w.frags, units[points[k]]);
      const lastHead = head[head.length - 1];
      if (!lastHead) continue;
      const hyphen: Frag = { text: "-", style: lastHead.style, at: lastHead.at + lastHead.text.length, synthetic: true };
      if (head.reduce((n, f) => n + width(f), 0) + width(hyphen) <= room) return { head, tail: rest, hyphen };
    }
    return null;
  };

  words.forEach((w0, wi) => {
    if (w0.tab) {
      if (out.length === 0) newLine();
      const li = out.length - 1;
      const at = leftOf(li) + tail().width;
      const stop = stopAfter(at);
      const follow = stop.align === "right" ? followWidth(wi) : stop.align === "center" ? followWidth(wi) / 2 : 0;
      const tw = Math.max(0, stop.position - at - follow);
      // A tab that would run past the line is dropped at the break.
      if (tail().width + tw > limitAt(li) && tail().frags.length > 0) { newLine(); return; }
      place([{ ...w0.tab, w: tw, ...(stop.leader ? { leader: stop.leader } : {}) }]);
      return;
    }
    let w: Word | null = w0;
    while (w) {
      const ww = wordWidth(w);
      if (out.length === 0) {
        newLine();
      } else {
        const li = out.length - 1;
        const sepW: number = w.sep ? width(w.sep) : 0;
        if (tail().width + sepW + ww <= limitAt(li)) { if (w.sep) place([w.sep]); place(w.frags); w = null; break; }
        // Does not fit: a hyphen may let the start of it stay on this line.
        const split: ReturnType<typeof hyphenSplit> = tail().frags.length > 0 ? hyphenSplit(w, limitAt(li) - tail().width - sepW) : null;
        if (split) {
          if (w.sep) place([w.sep]);
          place([...split.head, split.hyphen]);
          newLine();
          w = { frags: split.tail, sep: null };
          continue;
        }
        newLine();
      }
      // First word on a line (the separator is dropped at a soft break).
      const li = out.length - 1;
      if (w.frags.length === 0 || ww <= limitAt(li)) { place(w.frags); w = null; break; }
      const split: ReturnType<typeof hyphenSplit> = hyphenSplit(w, limitAt(li));
      if (split) {
        place([...split.head, split.hyphen]);
        newLine();
        w = { frags: split.tail, sep: null };
        continue;
      }
      // Too wide alone: break it by characters; a single character is never refused.
      for (const f of w.frags) {
        let at = f.at;
        for (const ch of Array.from(f.text)) {
          const cw = measureFor(f.style)(ch);
          if (tail().frags.length > 0 && tail().width + cw > limitAt(out.length - 1)) newLine();
          place([frag(ch, f.style, at)]);
          at += ch.length;
        }
      }
      w = null;
    }
  });
  // Trailing spaces hang: they are not part of the painted width (they were never placed).
  return out;
}

/** The lines of a rich layout placed in WORLD coordinates (the text box's top-left is n.x, n.y). */
function placeRichLines(measureFor: MeasureFor, n: NodeLite, layout: RichLayout): PlacedLine[] {
  const out: PlacedLine[] = [];
  for (const l of layout.lines) {
    const hasText = l.frags.some((f) => f.text !== "" || f.w !== undefined);
    if (!hasText && !l.marker && !l.drop) continue;
    let x = n.x + l.left;
    const segments: PlacedSegment[] = [];
    const body: PlacedSegment[] = [];
    for (const f of l.frags) {
      const m = measureFor(f.style);
      if (f.w !== undefined) {
        // A tab: its leader repeated to fill it, or nothing.
        const lw = f.leader ? m(f.leader) : 0;
        const fill = f.leader && lw > 0 ? f.leader.repeat(Math.max(0, Math.floor(f.w / lw))) : "";
        body.push({ text: fill, x, width: f.w, style: f.style });
        x += f.w;
      } else if (l.justify) {
        // Justified: the words and the (widened) spaces are pieces of their own.
        f.text.split(" ").forEach((part, i) => {
          if (i > 0) { const sw = m(" ") + l.justify!; body.push({ text: " ", x, width: sw, style: f.style }); x += sw; }
          if (part !== "") { const w = m(part); body.push({ text: part, x, width: w, style: f.style }); x += w; }
        });
      } else {
        const w = m(f.text);
        body.push({ text: f.text, x, width: w, style: f.style });
        x += w;
      }
    }
    if (l.marker) segments.push({ text: l.marker.text, x: n.x + l.marker.x, width: measureFor(l.marker.style)(l.marker.text), style: l.marker.style });
    if (l.drop) segments.push({ text: l.drop.text, x: n.x + l.drop.x, width: l.drop.width, style: l.drop.style });
    segments.push(...body);
    out.push({
      text: body.map((s) => s.text).join(""),
      x: n.x + l.left,
      y: n.y + l.top + l.ascent,
      width: l.width,
      segments,
    });
  }
  return out;
}
