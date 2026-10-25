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
  return /"(liga|clig)"\s*0|(^|,\s*)(liga|clig) off/.test(style?.fontFeatures ?? "");
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

/** Horizontal scale of the glyphs as a factor: 1 for none (the style stores a percentage, 0 = unset). */
export function hscaleOf(style: StyleX): number {
  const p = style?.textScale;
  return p !== undefined && p > 0 && Number.isFinite(p) ? p / 100 : 1;
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
  const h = hscaleOf(style);
  const sized = needsRuns(style) ? (s: string) => runsOf(s, style).reduce((w, r) => w + measure(r.text) * r.scale, 0) : measure;
  return h === 1 ? sized : (s) => sized(s) * h;
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

/** OpenType feature settings ("liga off, onum, ss01 2") as the CSS `font-feature-settings` value ('"liga" 0, "onum" 1, "ss01" 2'). */
export function cssFeatureSettings(features: string): string {
  return features.split(",").map((item) => item.trim()).filter((item) => /^("[A-Za-z0-9]{4}"|[A-Za-z0-9]{4})( (on|off|[0-9]{1,4}))?$/.test(item)).map((item) => {
    const [tag, value] = item.split(/\s+/);
    const quoted = tag.startsWith('"');
    return `"${tag.replace(/"/g, "")}"${value === undefined && quoted ? "" : ` ${value === "off" ? 0 : value === undefined || value === "on" ? 1 : value}`}`;
  }).join(", ");
}

/** Variable-font axes ("wght 650, wdth 90") as the CSS `font-variation-settings` value ('"wght" 650, "wdth" 90'). */
export function cssVariationSettings(variations: string): string {
  return variations.split(",").map((item) => item.trim()).filter((item) => /^[A-Za-z0-9]{4} -?[0-9]{1,4}(\.[0-9]{1,3})?$/.test(item)).map((item) => {
    const [tag, value] = item.split(/\s+/);
    return `"${tag}" ${value}`;
  }).join(", ");
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
//
// RICH lines (paragraph / character styles, see layoutRich) also carry `segments`: the pieces of the
// line with their own style and x, in world coordinates. `text` is then the whole line, and `x` the
// start of the first piece.
export interface PlacedSegment {
  text: string; x: number; width: number; style: TextStyleLite;
  // Present when the segment is not one run (small caps, scripts): the pieces to draw instead of text/x.
  pieces?: PlacedPiece[];
  // A list marker: drawn like text, but belongs to no run (it is not part of the line's text).
  marker?: boolean;
  /** `y` (instead of the line's baseline) and `angle` (radians, around (x, y)) are set for glyphs placed along a path. */
  y?: number; angle?: number; inline?: { id: string; height: number };
}
export interface PlacedLine {
  text: string; x: number; y: number; width: number; segments?: PlacedSegment[];
  // Present only when a plain (non-rich) line is not one run -- small caps, scripts, a list marker:
  // the pieces to draw, each with its own position (baseline y) and size scale. Whoever draws uses
  // them INSTEAD of text/x/y.
  pieces?: PlacedPiece[];
}
export interface PlacedPiece { text: string; x: number; y: number; scale: number }

/** The pieces a plain placed line is drawn with: its pieces, or the line itself as one. */
export function piecesOfLine(line: PlacedLine): PlacedPiece[] {
  return line.pieces ?? [{ text: line.text, x: line.x, y: line.y, scale: 1 }];
}

/** The pieces a segment of a rich line is drawn with: its own pieces, or the whole segment on the baseline. */
export function piecesOfSegment(seg: PlacedSegment, baseline: number): PlacedPiece[] {
  return seg.pieces ?? [{ text: seg.text, x: seg.x, y: seg.y ?? baseline, scale: 1 }];
}

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
  if (t.onPath && t.onPath.length >= 2 && measureFor) return placeOnPath(trackedMeasureFor(measureFor), n, t);
  // Formatted text needs to measure with several styles; without that it is laid out as plain text.
  if (t.rich && measureFor) {
    const tracked = trackedMeasureFor(measureFor);
    return placeRichLines(tracked, n, layoutRich(tracked, t.content, t.style, t.rich, innerWidth(n, t.style)));
  }
  const m = trackedMeasure(measure, t.style);
  return placeLines(m, n, t.style, layoutText(m, t.content, t.style, innerWidth(n, t.style)));
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
      const pieces: PlacedPiece[] = [];
      if (marker !== "") {
        pieces.push({ text: marker, x: n.x + inset + (style.indent && style.indent > 0 ? style.indent : 0), y: baseline, scale: 1 });
      }
      let cx = x;
      const shift = scriptShiftOf(style);
      for (const r of runsOf(line, style)) {
        pieces.push({ text: r.text, x: cx, y: baseline + shift, scale: r.scale });
        cx += measure(r.text) * r.scale * hscaleOf(style);
      }
      placed.pieces = pieces;
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
  if (t.rich) {
    const mf: MeasureFor = trackedMeasureFor((style) => (s) => measure(s, style));
    const layout = layoutRich(mf, t.content, t.style, t.rich, innerWidth(n, t.style));
    let minX = n.x, maxX = n.x + n.width;
    for (const line of placeRichLines(mf, n, layout)) {
      minX = Math.min(minX, line.x);
      maxX = Math.max(maxX, line.x + line.width);
      for (const seg of line.segments ?? []) { minX = Math.min(minX, seg.x); maxX = Math.max(maxX, seg.x + seg.width); }
    }
    return { x: minX, y: n.y, width: maxX - minX, height: Math.max(n.height, layout.height + 2 * insetOf(t.style)) };
  }

  const m = trackedMeasure((s: string) => measure(s, t.style), t.style);
  const layout = layoutText(m, t.content, t.style, innerWidth(n, t.style));
  let minX = n.x;
  let maxX = n.x + n.width;
  for (const line of placeLines(m, n, t.style, layout)) {
    minX = Math.min(minX, line.x);
    maxX = Math.max(maxX, line.x + line.width);
    // A list marker sits left of the text.
    for (const seg of line.pieces ?? []) minX = Math.min(minX, seg.x);
  }
  // Vertically the LAYOUT's height is used and not the last placed line:
  // empty lines paint nothing but occupy their slot, and the text's height
  // is the one the layout declares (layoutText invariant:
  // height === lines.length * lineHeight).
  const height = Math.max(n.height, layout.height + 2 * insetOf(t.style));
  return { x: minX, y: n.y, width: maxX - minX, height };
}

// Draws the node's text in WORLD coordinates (the camera is already in the
// ctx's transform, as for the other shapes). The color is set by the
// caller (drawScene sets fillStyle and globalAlpha from the node): here only
// what concerns the text is touched.
export function drawText(ctx: CanvasRenderingContext2D, n: NodeLite): void {
  if (n.text?.rich) {
    const boxes = paragraphDecorations(ctxMeasureFor(ctx), n);
    if (boxes.length > 0) {
      const fill = ctx.fillStyle, stroke = ctx.strokeStyle, lw = ctx.lineWidth;
      for (const d of boxes) {
        if (d.kind === "border") { ctx.strokeStyle = rgba(d.color); ctx.lineWidth = d.weight ?? 1; ctx.strokeRect(d.x, d.y, d.width, d.height); }
        else { ctx.fillStyle = rgba(d.color); ctx.fillRect(d.x, d.y, d.width, d.height); }
      }
      ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = lw;
    }
  }
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
      if ((seg as PlacedSegment).angle !== undefined) continue; // no underline along a path
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
  const raw = (s: string) => ctx.measureText(s).width;
  // One piece: raised/lowered by its baseline shift, stretched by its horizontal scale, in its own colour;
  // with letter spacing it is drawn character by character.
  const piece = (text: string, x: number, y: number, style: TextStyleLite, angle = 0) => {
    const ls = style.letterSpacing ?? 0;
    const sx = (style.horizontalScale ?? 1) * hscaleOf(style);
    const py = y - (style.baselineShift ?? 0);
    setKerning(ctx, style.noKerning ? "none" : "auto");
    const prevFill = ctx.fillStyle;
    if (style.color) ctx.fillStyle = `rgba(${Math.round(style.color.r * 255)},${Math.round(style.color.g * 255)},${Math.round(style.color.b * 255)},${style.color.a})`;
    if (sx !== 1 || angle) {
      ctx.save();
      ctx.translate(x, py);
      if (angle) ctx.rotate(angle);
      ctx.scale(sx, 1);
      if (ls === 0) paintLine(text, 0, 0);
      else for (const c of trackedOffsets(text, 0, ls / sx, raw)) paintLine(c.ch, c.x, 0);
      ctx.restore();
    } else if (ls === 0) paintLine(text, x, py);
    else for (const c of trackedOffsets(text, x, ls, raw)) paintLine(c.ch, c.x, py);
    if (style.color) ctx.fillStyle = prevFill;
  };
  for (const line of placeTextLines(raw, n, ctxMeasureFor(ctx))) {
    if (!line.segments) {
      for (const p of piecesOfLine(line)) {
        // Runs at another size (small caps, scripts) switch the font and switch back.
        if (p.scale !== 1) ctx.font = fontString(t.style, p.scale);
        piece(p.text, p.x, p.y, t.style);
        if (p.scale !== 1) ctx.font = fontString(t.style);
      }
      continue;
    }
    for (const seg of line.segments) {
      // Pieces of a segment (small caps, scripts, a marker) each have their own size and baseline.
      if ("textRendering" in ctx) tr.textRendering = ligaturesOff(seg.style) ? "optimizeSpeed" : "auto";
      for (const p of piecesOfSegment(seg, line.y)) {
        ctx.font = fontString(seg.style, p.scale);
        if (p.text !== "") piece(p.text, p.x, p.y, seg.style, seg.angle);
      }
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
interface Frag { text: string; style: TextStyleLite; at: number; w?: number; synthetic?: boolean; leader?: string; inline?: { id: string; height: number } }
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
  /** The paragraph this line belongs to (index into the content's "\n"-separated paragraphs). */
  para: number;
}
/** A box or line drawn behind/around a paragraph (shading, border, rules), in the text box's coordinates. */
export interface Decoration {
  kind: "shade" | "border" | "rule";
  x: number; y: number; width: number; height: number;
  color: { r: number; g: number; b: number; a: number };
  /** Border only: the stroke weight. */
  weight?: number;
}
export interface RichLayout { lines: RichLine[]; height: number; decorations?: Decoration[] }

// HANGING PUNCTUATION (optical margin alignment): the share of a character's advance that hangs outside the
// margin when it is the first (left) or last (right) character of a line. An approximation of what a
// typographer does by eye, not a font's own optical-bound data.
const HANG_LEFT: Record<string, number> = { "\u201c": 0.8, "\u2018": 0.8, '"': 0.8, "'": 0.8, "(": 0.5, "[": 0.5, "\u00ab": 0.6, "-": 0.6, "\u2013": 0.6, "\u2014": 0.6 };
const HANG_RIGHT: Record<string, number> = { ".": 1, ",": 1, ";": 0.8, ":": 0.8, "-": 0.8, "\u2013": 0.8, "\u2014": 0.8, "\u201d": 0.8, "\u2019": 0.8, '"': 0.8, "'": 0.8, ")": 0.4, "]": 0.4, "\u00bb": 0.6 };

const frag = (text: string, style: TextStyleLite, at: number): Frag => ({ text, style, at });

/** Tab stops past the last explicit one fall on multiples of this. */
export const DEFAULT_TAB = 36;
const RICH_SCRIPT_SCALE = 0.58;
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

// An object anchored in the text stands on the baseline: its whole height is above it.
const metricsOfFrag = (f: Frag) => (f.inline ? { ascent: f.inline.height, descent: 0 } : metricsOf(f.style));

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
      out = { ...out, fontSize: size * RICH_SCRIPT_SCALE, baselineShift: (out.baselineShift ?? 0) + (style.script === "super" ? size * 0.36 : -size * 0.14) };
    }
    per.set(key, out);
    return out;
  };
}

// Pieces re-styled for what the layout must do itself: tabs become their own piece, small capitals are
// split into lowercase (drawn as smaller capitals) and the rest, super/subscript shrink and shift.
function expandPieces(pieces: Frag[], inlines: ReadonlyMap<number, { id: string; width: number; height: number }>): Frag[] {
  const derive = derivedStyles();
  const out: Frag[] = [];
  for (const piece of pieces) {
    let off = piece.at;
    for (const part of piece.text.split(/(\t|\uFFFC)/)) {
      if (part === "") continue;
      if (part === "\t") { out.push(frag("\t", piece.style, off)); off += 1; continue; }
      if (part === "\uFFFC") {
        // An anchored object: a box in the line. One whose node is gone leaves nothing (but still counts as a character).
        const o = inlines.get(off);
        if (o) out.push({ ...frag("\uFFFC", piece.style, off), w: o.width, inline: { id: o.id, height: o.height } });
        off += 1;
        continue;
      }
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
  const inlineMap = new Map((rich.inlines ?? []).map((o) => [norm ? norm(o.at) : o.at, o] as const));
  const runs = rich.runs.map((r) => ({ start: norm ? norm(r.start) : r.start, end: norm ? norm(r.end) : r.end, style: r.style }));
  const lines: RichLine[] = [];
  let decorations: Decoration[] | undefined;
  let y = 0;
  let offset = 0;
  const paragraphs = text.split("\n");
  const ownOf = (pi: number): ParagraphLite => rich.paragraphs[pi] ?? { style: base, spaceBefore: 0, spaceAfter: 0, indentFirst: 0, indentLeft: 0 };
  // Lists of the paragraph STYLE (listKind): an item per non-empty paragraph of a list style, numbered in
  // order (a paragraph that is not an item restarts the count). The marker column is as wide as the widest
  // marker of the node, so every item's text lines up.
  const markerOf: string[] = [];
  let ordinal = 0;
  let lastKind = "";
  paragraphs.forEach((para, pi) => {
    const kind = ownOf(pi).style.listKind ?? "";
    if (kind !== lastKind) ordinal = 0;
    lastKind = kind;
    markerOf.push(kind !== "" && para.trim() !== "" ? markerFor(ownOf(pi).style, ++ordinal) : "");
  });
  let markerCol = 0;
  paragraphs.forEach((_, pi) => {
    const st = ownOf(pi).style;
    if (!st.listKind) return;
    const mw = markerOf[pi] === "" ? 0 : styledMeasure(measureFor(st), st)(markerOf[pi]);
    markerCol = Math.max(markerCol, Math.max(LIST_MIN_MARKER_EM * fontSizeOf(st), mw) + LIST_GAP_EM * fontSizeOf(st));
  });
  paragraphs.forEach((para, pi) => {
    const own = ownOf(pi);
    // The paragraph's lead (indent plus the marker column) narrows its wrap like a left indent.
    const lead = paragraphLead(own.style.listKind ? markerCol : 0, own.style);
    const pr: ParagraphLite = lead > 0 ? { ...own, indentLeft: own.indentLeft + lead } : own;
    // The pieces of the paragraph: split at run boundaries, CASED (the wrap must see the glyphs that are drawn).
    let pieces: Frag[] = [];
    const end = offset + para.length;
    let pos = offset;
    let prev = "";
    while (pos < end) {
      const run = runs.find((r) => r.start <= pos && pos < r.end);
      const next = Math.min(end, run ? run.end : Math.min(...runs.filter((r) => r.start > pos).map((r) => r.start), end));
      const style = run ? overlayStyle(pr.style, run.style) : pr.style;
      const raw = text.slice(pos, next);
      pieces.push(frag(caseAfter(prev, raw, style), style, pos));
      prev = raw.slice(-1);
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
    // Where line `i` of this paragraph starts, and how much room it has, from the box's left edge. Objects that wrap
    // the text take a bite out of the band the line sits in (its top is estimated from the paragraph's line height).
    const plainLeft = (i: number) => pr.indentLeft + (listed ? pr.listIndent ?? 0 : i === 0 ? pr.indentFirst : 0) + (drop && i < dropLines ? drop.width : 0);
    const exclusions = rich.exclusions ?? [];
    const bands = new Map<number, { left: number; room: number }>();
    const bandAt = (i: number) => {
      const hit = bands.get(i);
      if (hit) return hit;
      const left0 = plainLeft(i);
      let spans: [number, number][] = [[left0, maxWidth > 0 ? maxWidth : Infinity]];
      if (exclusions.length > 0 && maxWidth > 0) {
        const top = paraTop + i * lh0, bottom = top + lh0;
        for (const o of exclusions) {
          if (o.y >= bottom || o.y + o.height <= top) continue;
          spans = spans.flatMap(([a, b]) => [[a, Math.min(b, o.x)], [Math.max(a, o.x + o.width), b]].filter(([x, z]) => z - x > 0) as [number, number][]);
        }
      }
      // The wider side of what is left.
      const best = spans.reduce<[number, number] | null>((w, sp) => (!w || sp[1] - sp[0] > w[1] - w[0] ? sp : w), null);
      const out = best ? { left: best[0], room: best[1] - best[0] } : { left: left0, room: 0 };
      bands.set(i, out);
      return out;
    };
    const leftOf = (i: number) => (exclusions.length > 0 ? bandAt(i).left : plainLeft(i));
    const limitAt = (i: number) => (maxWidth > 0 ? (exclusions.length > 0 ? bandAt(i).room : maxWidth - plainLeft(i)) : Infinity);
    // A line with no room for even a couple of letters is left empty: the text jumps over the object.
    const minRoom = fontSizeOf(pr.style) * 1.5;
    const blocked = exclusions.length > 0 && maxWidth > 0 ? (i: number) => limitAt(i) < minRoom : undefined;

    const built = wrapPieces(measureFor, expandPieces(pieces, inlineMap), pr, limitAt, leftOf, blocked);
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
    const paraFirstLine = lines.length;
    for (const [li, l] of built.entries()) {
      const empty = l.frags.length === 0;
      const m = empty ? metricsOf(pr.style) : (l.frags.some((f) => f.inline) ? [...l.frags.map(metricsOfFrag), metricsOf(pr.style)] : l.frags.map(metricsOfFrag)).reduce((a, b) => ({ ascent: Math.max(a.ascent, b.ascent), descent: Math.max(a.descent, b.descent) }));
      const height = m.ascent + m.descent;
      // On the baseline grid: the line moves down to the next grid line when its baseline falls between two.
      if (pr.alignToGrid && rich.grid) {
        const g = rich.grid;
        const baseline = g.boxY + y + m.ascent;
        const target = g.start + Math.ceil((baseline - g.start) / g.increment - 1e-9) * g.increment;
        if (target > baseline) y += target - baseline;
      }
      const lineWidth = maxWidth > 0 ? limitAt(li) : 0;
      let left = leftOf(li) + alignOffsetX(pr.style.align, l.width, lineWidth);
      const last = [...l.frags].reverse().find((f) => !f.synthetic);
      // Optical margin: punctuation at the edge hangs outside the margin; a justified line spreads its slack over its spaces.
      if (pr.opticalMargin && l.frags.length > 0 && pr.style.align !== "center") {
        const firstFrag = l.frags.find((f) => f.text !== "" && f.w === undefined && !f.inline);
        const lastFrag = [...l.frags].reverse().find((f) => f.text !== "" && f.w === undefined && !f.inline && !f.synthetic);
        const hangL = firstFrag && pr.style.align !== "right" && !(li === 0 && (listed || drop)) ? (HANG_LEFT[firstFrag.text[0]!] ?? 0) * measureFor(firstFrag.style)(firstFrag.text[0]!) : 0;
        const trimmed = lastFrag?.text.replace(/\s+$/, "") ?? "";
        const hangR = lastFrag && pr.style.align !== "left" && trimmed !== "" ? (HANG_RIGHT[trimmed[trimmed.length - 1]!] ?? 0) * measureFor(lastFrag.style)(trimmed[trimmed.length - 1]!) : 0;
        if (pr.style.align === "right") left += hangR;
        else if (pr.style.align === "justify" && l.justify) {
          const spaces = l.frags.reduce((n, f) => (f.w === undefined ? n + (f.text.split(" ").length - 1) : n), 0);
          if (spaces > 0) l.justify += (hangL + hangR) / spaces;
          left -= hangL;
        } else left -= hangL;
      }
      lines.push({
        frags: l.frags, width: l.width, top: y, height, ascent: m.ascent, left, end: last ? last.at + last.text.length : paraStart + dropLen, para: pi,
        ...(l.justify ? { justify: l.justify } : {}),
        ...(li === 0 && listed ? { marker: { text: pr.marker!, style: pr.style, x: pr.indentLeft } } : {}),
        ...(li === 0 && !listed && markerOf[pi] !== "" ? { marker: { text: markerOf[pi], style: markerStyle(own.style), x: own.indentLeft + own.indentFirst + (own.style.indent && own.style.indent > 0 ? own.style.indent : 0) } } : {}),
        ...(li === 0 && drop ? { drop } : {}),
      });
      y += height;
    }
    // A drop cap taller than the paragraph keeps its room.
    if (drop && y < paraTop + dropLines * lh0) y = paraTop + dropLines * lh0;
    // Shading, border and rules sit around the paragraph's lines.
    if (pr.shading || pr.borderColor || pr.ruleAbove || pr.ruleBelow) {
      const mine = lines.slice(paraFirstLine);
      const off = pr.shadingOffset ?? 0;
      const x0 = pr.indentLeft;
      const textRight = mine.reduce((r, l) => Math.max(r, l.left + l.width), x0);
      const right = maxWidth > 0 ? maxWidth : textRight;
      const box = { x: x0 - off, y: paraTop - off, width: right - x0 + 2 * off, height: y - paraTop + 2 * off };
      (decorations ??= []);
      if (pr.shading) decorations.push({ kind: "shade", ...box, color: pr.shading });
      if (pr.borderColor && pr.borderWeight) decorations.push({ kind: "border", ...box, color: pr.borderColor, weight: pr.borderWeight });
      for (const [r, above] of [[pr.ruleAbove, true], [pr.ruleBelow, false]] as const) {
        if (!r) continue;
        const rx = (r.columnWidth ? 0 : x0) + (r.indentLeft ?? 0);
        const rw = (r.columnWidth && maxWidth > 0 ? maxWidth : right) - rx - (r.indentRight ?? 0);
        const ry = above ? paraTop - off - (r.offset ?? 0) - r.weight : y + off + (r.offset ?? 0);
        decorations.push({ kind: "rule", x: rx, y: ry, width: rw, height: r.weight, color: r.color ?? { r: 0, g: 0, b: 0, a: 1 } });
      }
    }
    if (pi < paragraphs.length - 1) y += pr.spaceAfter;
  });
  return { lines, height: y, ...(decorations ? { decorations } : {}) };
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
  if (over.fontFeatures) out.fontFeatures = over.fontFeatures;
  if (over.fontVariations) out.fontVariations = over.fontVariations;
  // Character-level type settings; list, indent, vertical alignment and inset are paragraph / box
  // settings and stay the paragraph's.
  if (over.textCase) out.textCase = over.textCase;
  if (over.textScript) out.textScript = over.textScript;
  if (over.textScale) out.textScale = over.textScale;
  return out;
}

/** A list marker is drawn in its paragraph's font, never underlined, cased or raised. */
function markerStyle(style: TextStyleLite): TextStyleLite {
  const { underline: _u, strikethrough: _s, textCase: _c, textScript: _t, ...rest } = style;
  return rest;
}

/** `text` as drawn in `style`, given the character just before it in the paragraph (title case needs it). */
function caseAfter(prev: string, text: string, style: TextStyleLite): string {
  if (!style.textCase || style.textCase === "smallCaps" || text === "") return text;
  const shown = caseText(prev + text, style).slice(prev.length);
  return shown.length === text.length ? shown : text;
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
function wrapPieces(measureFor: MeasureFor, pieces: Frag[], pr: ParagraphLite, limitAt: (i: number) => number, leftOf: (i: number) => number, blocked?: (i: number) => boolean): Built[] {
  if (pieces.length === 0) return [];
  const width = (f: Frag) => (f.w !== undefined ? f.w : f.text === "" ? 0 : measureFor(f.style)(f.text));
  // Words: runs of non-space characters, each with the style of its characters; the space before a
  // word is its separator and has its own style. A tab is a word of its own.
  interface Word { frags: Frag[]; sep: Frag | null; tab?: Frag }
  const words: Word[] = [];
  let cur: Word = { frags: [], sep: null };
  for (const piece of pieces) {
    if (piece.text === "\t") { words.push(cur); words.push({ frags: [], sep: null, tab: piece }); cur = { frags: [], sep: null }; continue; }
    if (piece.inline) { words.push(cur); words.push({ frags: [piece], sep: null }); cur = { frags: [], sep: null }; continue; }
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
  const newLine = () => {
    out.push({ frags: [], width: 0 });
    // Lines hidden behind an object stay empty (bounded: an object is not taller than the page).
    for (let guard = 0; blocked && blocked(out.length - 1) && guard < 500; guard++) out.push({ frags: [], width: 0 });
  };
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
        // An anchored object cannot be broken: it overflows.
        if (f.w !== undefined) { place([f]); continue; }
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

/**
 * Shading, borders and rules of the paragraphs, in WORLD coordinates (the text box's top-left is n.x, n.y); they
 * are painted BEHIND the text. Empty for text with no such paragraph style.
 */
export function paragraphDecorations(measureFor: MeasureFor, n: NodeLite): Decoration[] {
  const t = n.text;
  if (n.kind !== "text" || !t?.rich || t.content === "" || t.onPath) return [];
  if (!t.rich.paragraphs.some((p) => p.shading || p.borderColor || p.ruleAbove || p.ruleBelow)) return [];
  const layout = layoutRich(trackedMeasureFor(measureFor), t.content, t.style, t.rich, n.width);
  return (layout.decorations ?? []).map((d) => ({ ...d, x: d.x + n.x, y: d.y + n.y }));
}

const rgba = (c: { r: number; g: number; b: number; a: number }) => `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a})`;

/** The lines of a rich layout placed in WORLD coordinates (the text box's top-left is n.x, n.y). */
function placeRichLines(measureFor: MeasureFor, n: NodeLite, layout: RichLayout): PlacedLine[] {
  const out: PlacedLine[] = [];
  // The box-level settings come from the text's own style: inset, and the vertical alignment in a box
  // taller than the text (a taller text starts at the top).
  const own = n.text?.style;
  const inset = insetOf(own);
  const spare = n.height - 2 * inset - layout.height;
  const top = n.y + inset + (spare > 0 ? (own?.verticalAlign === "middle" ? spare / 2 : own?.verticalAlign === "bottom" ? spare : 0) : 0);
  for (const l of layout.lines) {
    const hasText = l.frags.some((f) => f.text !== "" || f.w !== undefined);
    if (!hasText && !l.marker && !l.drop) continue;
    const baseline = top + l.top + l.ascent;
    let x = n.x + inset + l.left;
    const segments: PlacedSegment[] = [];
    const body: PlacedSegment[] = [];
    for (const f of l.frags) {
      const m = measureFor(f.style);
      if (f.inline) {
        body.push({ text: "", x, width: f.w!, style: f.style, inline: f.inline });
        x += f.w!;
      } else if (f.w !== undefined) {
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
        const w = styledMeasure(m, f.style)(f.text);
        const seg: PlacedSegment = { text: f.text, x, width: w, style: f.style };
        if (needsRuns(f.style)) {
          // Small caps and scripts: runs at another size, on a shifted baseline.
          const h = hscaleOf(f.style);
          const shift = scriptShiftOf(f.style);
          let cx = x;
          seg.pieces = runsOf(f.text, f.style).map((r) => {
            const piece = { text: r.text, x: cx, y: baseline + shift, scale: r.scale };
            cx += m(r.text) * r.scale * h;
            return piece;
          });
        }
        body.push(seg);
        x += w;
      }
    }
    if (l.marker) segments.push({ text: l.marker.text, x: n.x + inset + l.marker.x, width: styledMeasure(measureFor(l.marker.style), l.marker.style)(l.marker.text), style: l.marker.style, marker: true });
    if (l.drop) segments.push({ text: l.drop.text, x: n.x + inset + l.drop.x, width: l.drop.width, style: l.drop.style });
    segments.push(...body);
    out.push({
      text: body.map((s) => s.text).join(""),
      x: n.x + inset + l.left,
      y: baseline,
      width: l.width,
      segments,
    });
  }
  return out;
}

// --- text on a path -------------------------------------------------------------------------------

// The first paragraph of the text set on a single line along the polyline `t.onPath` (the derived field
// of store/textPath.ts): every character is placed at its advance along the path and turned to follow it.
// Alignment moves the start (centre / right of the path's length); characters past its end are dropped.
function placeOnPath(measureFor: MeasureFor, n: NodeLite, t: TextLite): PlacedLine[] {
  const pts = t.onPath!;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const length = cum[cum.length - 1];
  if (!(length > 0)) return [];
  // The glyphs with their styles: from the formatted layout of one unbounded line, or the node's own style.
  const pieces: { text: string; style: TextStyleLite }[] = t.rich
    ? (layoutRich(measureFor, t.content, t.style, t.rich, 0).lines[0]?.frags ?? []).filter((f) => f.w === undefined).map((f) => ({ text: f.text, style: f.style }))
    : [{ text: t.content.replace(/\r\n?/g, "\n").split("\n")[0], style: t.style }];
  const glyphs = pieces.flatMap((p) => Array.from(p.text).map((ch) => ({ ch, style: p.style, w: measureFor(p.style)(ch) })));
  const total = glyphs.reduce((s, g) => s + g.w, 0);
  const align = t.rich?.paragraphs[0]?.style.align ?? t.style.align;
  let s = align === "center" ? (length - total) / 2 : align === "right" ? length - total : 0;
  s = Math.max(0, s);
  const at = (d: number) => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const seg = cum[i] - cum[i - 1] || 1;
    const f = (d - cum[i - 1]) / seg;
    return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f, angle: Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x) };
  };
  const segments: PlacedSegment[] = [];
  for (const g of glyphs) {
    const mid = s + g.w / 2;
    if (mid > length) break;
    const p = at(mid);
    const shift = g.style.baselineShift ?? 0;
    // The origin of the glyph: half its advance back along the tangent, raised by its baseline shift.
    const x = p.x - (g.w / 2) * Math.cos(p.angle) + shift * Math.sin(p.angle);
    const y = p.y - (g.w / 2) * Math.sin(p.angle) - shift * Math.cos(p.angle);
    const { baselineShift: _b, ...style } = g.style;
    void _b;
    if (g.ch.trim() !== "") segments.push({ text: g.ch, x, y, width: g.w, style, angle: p.angle });
    s += g.w;
  }
  void n;
  if (segments.length === 0) return [];
  return [{ text: segments.map((g) => g.text).join(""), x: segments[0].x, y: segments[0].y!, width: total, segments }];
}

// --- anchored objects -----------------------------------------------------------------------------

/**
 * Where the objects anchored in a text sit, in the space of the text's parent: the top-left of each, its box standing
 * on the baseline of its line. Empty for a text without anchored objects.
 */
export function inlinePositions(measureFor: MeasureFor, n: NodeLite): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const t = n.text;
  if (n.kind !== "text" || !t?.rich?.inlines?.length) return out;
  const tracked = trackedMeasureFor(measureFor);
  const layout = layoutRich(tracked, t.content, t.style, t.rich, n.width);
  for (const l of layout.lines) {
    let x = n.x + l.left;
    for (const f of l.frags) {
      if (f.inline) {
        out.set(f.inline.id, { x, y: n.y + l.top + l.ascent - f.inline.height });
        x += f.w!;
      } else if (f.w !== undefined) x += f.w;
      else x += tracked(f.style)(f.text) + (l.justify ? (f.text.split(" ").length - 1) * l.justify : 0);
    }
  }
  return out;
}
