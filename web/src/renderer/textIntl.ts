import { isRtl } from "@/renderer/bidi";
import type { TextAlignLite, TextStyleLite } from "@/store/types";

// INTERNATIONAL TEXT: paragraph direction and vertical writing (docs/text-international.md). Standalone (no import of
// renderer/text.ts) so the layout can use it without a cycle: the metrics it needs come in as parameters.

/** The direction a text is set in: the style's, else the first strong character decides. */
export function directionOf(content: string, style: Pick<TextStyleLite, "direction"> | undefined): "ltr" | "rtl" {
  if (style?.direction) return style.direction;
  return isRtl(content) ? "rtl" : "ltr";
}

/**
 * The alignment the layout uses. In a paragraph the author SET to right-to-left, left and right mean start and end, so
 * the default (left) puts the text at the right edge. Auto direction never mirrors: a document that has Arabic text with
 * the default alignment keeps drawing it where it was.
 */
export function effectiveAlign(align: TextAlignLite, style: Pick<TextStyleLite, "direction">): TextAlignLite {
  if (style.direction !== "rtl") return align;
  if (align === "center") return align;
  return align === "right" ? "left" : "right"; // left / justify -> right edge, right -> left edge (center is symmetric)
}

export const isVertical = (style: Pick<TextStyleLite, "writingMode"> | undefined): boolean => style?.writingMode === "vertical";

export interface VerticalMetrics {
  /** Box (world) the text sits in, and the padding inside it. */
  x: number; y: number; width: number; height: number; inset: number;
  /** Glyph cell: the font size. */
  size: number;
  /** Distance between two columns (font size x line height). */
  pitch: number;
  /** Baseline offset of a glyph inside its cell. */
  ascent: number;
  align: TextAlignLite;
  /** Width of one character, for centring it on the column. */
  measure: (ch: string) => number;
}

export interface VerticalGlyph { text: string; x: number; y: number; width: number }

/**
 * vertical-rl: characters stand upright one under another, each in a square cell, columns run from the right edge to
 * the left, a line break starts a new column. A column breaks where the box height is used up (a box without height
 * does not wrap). Alignment is along the column: left = top, center = middle, right = bottom.
 * Latin letters are upright too (a real vertical typesetter turns them sideways: deferred, docs/text-international.md).
 */
export function layoutVertical(paragraphs: readonly string[], m: VerticalMetrics): { glyphs: VerticalGlyph[]; columns: number } {
  const room = m.height > 0 ? Math.max(m.size, m.height - 2 * m.inset) : Infinity;
  const perColumn = Math.max(1, Math.floor(room / m.size + 1e-9));
  const columns: string[][] = [];
  for (const para of paragraphs) {
    const chars = Array.from(para);
    if (chars.length === 0) { columns.push([]); continue; }
    for (let i = 0; i < chars.length; i += perColumn) columns.push(chars.slice(i, i + perColumn));
  }
  const right = m.x + m.width - m.inset;
  const glyphs: VerticalGlyph[] = [];
  columns.forEach((col, ci) => {
    const centre = right - m.pitch * (ci + 0.5);
    const used = col.length * m.size;
    const spare = Number.isFinite(room) ? Math.max(0, room - used) : 0;
    const start = m.y + m.inset + (m.align === "center" ? spare / 2 : m.align === "right" ? spare : 0);
    col.forEach((ch, ri) => {
      if (/^\s$/.test(ch)) return; // the cell is taken, nothing is drawn
      const w = m.measure(ch);
      glyphs.push({ text: ch, x: centre - w / 2, y: start + ri * m.size + m.ascent, width: w });
    });
  });
  return { glyphs, columns: columns.length };
}
