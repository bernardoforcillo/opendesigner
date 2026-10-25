// A MINIMAL READER OF AN SFNT FONT (TrueType / OpenType): just enough to answer "does this
// font draw these characters?". pdf.js hands back the fonts embedded in a PDF as sfnt data,
// but they are SUBSETS and their character map is not always Unicode: before registering one
// as a document font, the characters the PDF actually uses must be there, or the text would
// come out as missing-glyph boxes.

const u16 = (v: DataView, o: number) => v.getUint16(o);
const u32 = (v: DataView, o: number) => v.getUint32(o);

/** The file type by magic bytes, or null when it is not an sfnt we can serve as a font. */
export function sfntKind(data: Uint8Array): "ttf" | "otf" | null {
  if (data.length < 12) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = u32(v, 0);
  if (tag === 0x00010000 || tag === 0x74727565 /* true */) return "ttf";
  if (tag === 0x4f54544f /* OTTO */) return "otf";
  return null;
}

interface Table { offset: number; length: number }

function tables(v: DataView): Map<string, Table> {
  const n = u16(v, 4);
  const out = new Map<string, Table>();
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > v.byteLength) break;
    const tag = String.fromCharCode(v.getUint8(rec), v.getUint8(rec + 1), v.getUint8(rec + 2), v.getUint8(rec + 3));
    out.set(tag, { offset: u32(v, rec + 8), length: u32(v, rec + 12) });
  }
  return out;
}

/**
 * A lookup `codePoint -> glyph id` (0 = no glyph) from the best Unicode cmap subtable, or
 * null when the font has none (a symbolic or malformed font).
 */
export function unicodeCmap(data: Uint8Array): ((cp: number) => number) | null {
  if (!sfntKind(data)) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  try {
    const cmap = tables(v).get("cmap");
    if (!cmap) return null;
    const count = u16(v, cmap.offset + 2);
    let best: { off: number; rank: number } | null = null;
    for (let i = 0; i < count; i++) {
      const rec = cmap.offset + 4 + i * 8;
      const platform = u16(v, rec), encoding = u16(v, rec + 2), off = cmap.offset + u32(v, rec + 4);
      const format = u16(v, off);
      // Prefer full Unicode (format 12), then the BMP (format 4), on a Unicode platform.
      const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
      if (!unicode || (format !== 4 && format !== 12)) continue;
      const rank = format === 12 ? 2 : 1;
      if (!best || rank > best.rank) best = { off, rank };
    }
    if (!best) return null;
    const off = best.off;
    if (u16(v, off) === 12) {
      const groups = u32(v, off + 12);
      return (cp) => {
        for (let g = 0; g < groups; g++) {
          const rec = off + 16 + g * 12;
          const start = u32(v, rec), end = u32(v, rec + 4);
          if (cp >= start && cp <= end) return u32(v, rec + 8) + (cp - start);
        }
        return 0;
      };
    }
    const segX2 = u16(v, off + 6);
    const seg = segX2 / 2;
    const endCodes = off + 14, startCodes = endCodes + segX2 + 2, deltas = startCodes + segX2, ranges = deltas + segX2;
    return (cp) => {
      if (cp > 0xffff) return 0;
      for (let s = 0; s < seg; s++) {
        if (cp > u16(v, endCodes + s * 2)) continue;
        if (cp < u16(v, startCodes + s * 2)) return 0;
        const delta = u16(v, deltas + s * 2), ro = u16(v, ranges + s * 2);
        if (ro === 0) return (cp + delta) & 0xffff;
        const g = u16(v, ranges + s * 2 + ro + (cp - u16(v, startCodes + s * 2)) * 2);
        return g === 0 ? 0 : (g + delta) & 0xffff;
      }
      return 0;
    };
  } catch {
    return null;
  }
}

/** Does the font have a glyph for every non-space character of `text`? */
export function coversText(data: Uint8Array, text: string): boolean {
  const map = unicodeCmap(data);
  if (!map) return false;
  for (const ch of text) {
    if (/\s/u.test(ch)) continue;
    if (map(ch.codePointAt(0)!) === 0) return false;
  }
  return true;
}
export { tables as sfntTables };
