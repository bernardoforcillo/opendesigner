import type { NodeLite, TextAlignLite, TextLite, TextStyleLite } from "../store/types";
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
  return ls === 0 ? measure : (s) => measure(s) + ls * charCount(s);
}

export function trackedMeasureFor(measureFor: MeasureFor): MeasureFor {
  return (style) => trackedMeasure(measureFor(style), style);
}

/**
 * The x of each character of `text` starting at `x`, for a style with letter spacing: where it would be
 * without spacing (so kerning inside the string is kept) plus `spacing` for each character before it.
 */
export function trackedOffsets(text: string, x: number, spacing: number, measure: (s: string) => number): { ch: string; x: number }[] {
  const chars = Array.from(text);
  return chars.map((ch, i) => ({ ch, x: x + (i === 0 ? 0 : measure(chars.slice(0, i).join(""))) + i * spacing }));
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
      for (const bar of decorationBars(seg.style, line.y)) ctx.fillRect(seg.x, bar.y, seg.width, bar.height);
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

/** A MeasureFor on a 2D context: it sets the font before every measure, so styles can alternate freely. */
export function ctxMeasureFor(ctx: CanvasRenderingContext2D): MeasureFor {
  return (style) => {
    const font = fontString(style);
    return (s) => { ctx.font = font; return ctx.measureText(s).width; };
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
  // A piece with letter spacing is drawn character by character; one without, in one go.
  const piece = (text: string, x: number, y: number, style: TextStyleLite) => {
    const ls = style.letterSpacing ?? 0;
    if (ls === 0) { paintLine(text, x, y); return; }
    for (const c of trackedOffsets(text, x, ls, raw)) paintLine(c.ch, c.x, y);
  };
  for (const line of placeTextLines(raw, n, ctxMeasureFor(ctx))) {
    if (!line.segments) { piece(line.text, line.x, line.y, t.style); continue; }
    for (const seg of line.segments) {
      ctx.font = fontString(seg.style);
      piece(seg.text, seg.x, line.y, seg.style);
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
// Text without `rich` never comes through here: plain text keeps the layout above, unchanged.

// `at` is where the piece starts in the (newline-normalized) content: it is what lets a caller know how
// much of the text a set of lines used (threaded frames flow the rest into the next frame).
interface Frag { text: string; style: TextStyleLite; at: number }
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
}
export interface RichLayout { lines: RichLine[]; height: number }

const frag = (text: string, style: TextStyleLite, at: number): Frag => ({ text, style, at });

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
    const pr = rich.paragraphs[pi] ?? { style: base, spaceBefore: 0, spaceAfter: 0, indentFirst: 0, indentLeft: 0 };
    // The pieces of the paragraph: split at run boundaries.
    const pieces: Frag[] = [];
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
    const built = wrapPieces(measureFor, pieces, pr, maxWidth);
    // An empty paragraph is an empty line: it keeps its height.
    if (built.length === 0) built.push({ frags: [], width: 0 });
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
      const lineWidth = maxWidth > 0 ? maxWidth - pr.indentLeft - (li === 0 ? pr.indentFirst : 0) : 0;
      const left = pr.indentLeft + (li === 0 ? pr.indentFirst : 0) + alignOffsetX(pr.style.align, l.width, lineWidth);
      const last = l.frags[l.frags.length - 1];
      lines.push({ frags: l.frags, width: l.width, top: y, height, ascent: m.ascent, left, end: last ? last.at + last.text.length : paraStart });
      y += height;
    }
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
  return out;
}

interface Built { frags: Frag[]; width: number }

// Greedy wrap of one paragraph's pieces.
function wrapPieces(measureFor: MeasureFor, pieces: Frag[], pr: NonNullable<TextLite["rich"]>["paragraphs"][number], maxWidth: number): Built[] {
  if (pieces.length === 0) return [];
  const width = (f: Frag) => (f.text === "" ? 0 : measureFor(f.style)(f.text));
  // Words: runs of non-space characters, each with the style of its characters; the space before a
  // word is its separator and has its own style.
  interface Word { frags: Frag[]; sep: Frag | null }
  const words: Word[] = [];
  let cur: Word = { frags: [], sep: null };
  for (const piece of pieces) {
    let off = piece.at;
    piece.text.split(" ").forEach((part, i) => {
      if (i > 0) { words.push(cur); cur = { frags: [], sep: frag(" ", piece.style, off) }; off += 1; }
      if (part !== "") cur.frags.push(frag(part, piece.style, off));
      off += part.length;
    });
  }
  words.push(cur);

  const limit = (first: boolean) => (maxWidth > 0 ? maxWidth - pr.indentLeft - (first ? pr.indentFirst : 0) : Infinity);
  const out: Built[] = [];
  const wordWidth = (w: Word) => w.frags.reduce((n, f) => n + width(f), 0);
  const tail = () => out[out.length - 1];
  const place = (frags: Frag[]) => {
    for (const f of frags) {
      const line = tail();
      const last = line.frags[line.frags.length - 1];
      if (last && last.style === f.style && last.at + last.text.length === f.at) last.text += f.text; else line.frags.push(frag(f.text, f.style, f.at));
      line.width += width(f);
    }
  };
  const newLine = () => { out.push({ frags: [], width: 0 }); };
  for (const w of words) {
    const ww = wordWidth(w);
    if (out.length === 0) {
      newLine();
    } else {
      const sepW = w.sep ? width(w.sep) : 0;
      if (tail().width + sepW + ww <= limit(out.length === 1)) { if (w.sep) place([w.sep]); place(w.frags); continue; }
      newLine();
    }
    // First word on a line (the separator is dropped at a soft break).
    if (ww <= limit(out.length === 1) || w.frags.length === 0) { place(w.frags); continue; }
    // Too wide alone: break it by characters; a single character is never refused.
    for (const f of w.frags) {
      let at = f.at;
      for (const ch of Array.from(f.text)) {
        const cw = measureFor(f.style)(ch);
        if (tail().frags.length > 0 && tail().width + cw > limit(out.length === 1)) newLine();
        place([frag(ch, f.style, at)]);
        at += ch.length;
      }
    }
  }
  // Trailing spaces hang: they are not part of the painted width (they were never placed).
  return out;
}

/** The lines of a rich layout placed in WORLD coordinates (the text box's top-left is n.x, n.y). */
function placeRichLines(measureFor: MeasureFor, n: NodeLite, layout: RichLayout): PlacedLine[] {
  const out: PlacedLine[] = [];
  for (const l of layout.lines) {
    if (l.frags.length === 0 || l.frags.every((f) => f.text === "")) continue;
    let x = n.x + l.left;
    const segments: PlacedSegment[] = [];
    for (const f of l.frags) {
      const w = measureFor(f.style)(f.text);
      segments.push({ text: f.text, x, width: w, style: f.style });
      x += w;
    }
    out.push({
      text: segments.map((s) => s.text).join(""),
      x: n.x + l.left,
      y: n.y + l.top + l.ascent,
      width: l.width,
      segments,
    });
  }
  return out;
}
