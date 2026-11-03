import { sfntKind, sfntTables } from "@/pdf/sfnt";

// FONT SUBSETTING for the PDF. Only TrueType outlines (a `glyf` table) are subset: the glyphs the text does not use are
// emptied and the table is rewritten, while every glyph keeps its id, so the CID -> glyph mapping the PDF writes
// (Identity) stays valid and no remapping is needed. Composite glyphs keep the parts they are built from. Every table the
// PDF does not need (cmap, name, GSUB, GPOS, kern, OS/2, post...) is dropped; the layout was done before embedding.
// CFF outlines (an `OTTO` font) are embedded whole: subsetting a CFF charstring set is not done.

const KEEP_TABLES = ["head", "hhea", "maxp", "hmtx", "cvt ", "fpgm", "prep"];

function checksum(b: Uint8Array): number {
  let sum = 0;
  const n = b.length & ~3;
  for (let i = 0; i < n; i += 4) sum = (sum + (((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0)) >>> 0;
  if (b.length > n) {
    let last = 0;
    for (let i = n; i < b.length; i++) last |= b[i]! << (24 - 8 * (i - n));
    sum = (sum + (last >>> 0)) >>> 0;
  }
  return sum;
}

/** Writes an sfnt (TrueType flavour) from a table map; fills the directory and the head checksum adjustment. */
export function buildSfnt(tables: Map<string, Uint8Array>): Uint8Array {
  const tags = [...tables.keys()].sort();
  const n = tags.length;
  let pow = 1, log = 0;
  while (pow * 2 <= n) { pow *= 2; log++; }
  let size = 12 + n * 16;
  const padded = tags.map((t) => (tables.get(t)!.length + 3) & ~3);
  for (const p of padded) size += p;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x00010000);
  v.setUint16(4, n); v.setUint16(6, pow * 16); v.setUint16(8, log); v.setUint16(10, n * 16 - pow * 16);
  let off = 12 + n * 16;
  let headAt = -1;
  tags.forEach((t, i) => {
    const data = tables.get(t)!;
    const rec = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[rec + k] = t.charCodeAt(k);
    out.set(data, off);
    if (t === "head") { headAt = off; v.setUint32(off + 8, 0); }
    v.setUint32(rec + 4, checksum(out.subarray(off, off + padded[i]!)));
    v.setUint32(rec + 8, off); v.setUint32(rec + 12, data.length);
    off += padded[i]!;
  });
  if (headAt >= 0) v.setUint32(headAt + 8, (0xb1b0afba - checksum(out)) >>> 0);
  return out;
}

/** The TrueType font reduced to `keep` (glyph ids; 0 is always kept), or null when it cannot be subset (CFF, malformed). */
export function subsetTrueType(data: Uint8Array, keep: Iterable<number>): Uint8Array | null {
  if (sfntKind(data) !== "ttf") return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  try {
    const t = sfntTables(v);
    const head = t.get("head"), maxp = t.get("maxp"), loca = t.get("loca"), glyf = t.get("glyf");
    if (!head || !maxp || !loca || !glyf || !t.get("hhea") || !t.get("hmtx")) return null;
    const numGlyphs = v.getUint16(maxp.offset + 4);
    const long = v.getInt16(head.offset + 50) === 1;
    const at = (g: number) => (long ? v.getUint32(loca.offset + g * 4) : v.getUint16(loca.offset + g * 2) * 2);
    if (loca.length < (numGlyphs + 1) * (long ? 4 : 2)) return null;

    const want = new Set<number>();
    const queue = [0, ...[...keep].filter((g) => g > 0 && g < numGlyphs)];
    while (queue.length) {
      const g = queue.pop()!;
      if (want.has(g)) continue;
      want.add(g);
      const s = at(g), e = at(g + 1);
      if (e - s < 10 || s + 10 > glyf.length) continue;
      if (v.getInt16(glyf.offset + s) >= 0) continue; // a simple glyph
      let p = s + 10;
      for (let guard = 0; guard < 256; guard++) {
        const flags = v.getUint16(glyf.offset + p), part = v.getUint16(glyf.offset + p + 2);
        if (part < numGlyphs) queue.push(part);
        p += 4 + (flags & 1 ? 4 : 2) + (flags & 0x8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0);
        if (!(flags & 0x20)) break;
      }
    }

    const chunks: Uint8Array[] = [];
    const newLoca = new Uint8Array((numGlyphs + 1) * 4);
    const lv = new DataView(newLoca.buffer);
    let pos = 0;
    for (let g = 0; g < numGlyphs; g++) {
      lv.setUint32(g * 4, pos);
      if (!want.has(g)) continue;
      const s = at(g), e = at(g + 1);
      if (e <= s) continue;
      const c = new Uint8Array((e - s + 3) & ~3);
      c.set(data.subarray(glyf.offset + s, glyf.offset + e));
      chunks.push(c);
      pos += c.length;
    }
    lv.setUint32(numGlyphs * 4, pos);
    const newGlyf = new Uint8Array(pos);
    let o = 0;
    for (const c of chunks) { newGlyf.set(c, o); o += c.length; }

    const out = new Map<string, Uint8Array>();
    for (const tag of KEEP_TABLES) {
      const tb = t.get(tag);
      if (tb) out.set(tag, data.slice(tb.offset, tb.offset + tb.length));
    }
    out.set("glyf", newGlyf);
    out.set("loca", newLoca);
    const headCopy = out.get("head")!;
    new DataView(headCopy.buffer, headCopy.byteOffset).setInt16(50, 1); // the new loca is long
    return buildSfnt(out);
  } catch {
    return null;
  }
}

/** Six capital letters from the glyph set: the `ABCDEF+` prefix the PDF spec asks of a subset font's name. */
export function subsetTag(gids: readonly number[]): string {
  let h = 2166136261;
  for (const g of gids) h = Math.imul(h ^ g, 16777619) >>> 0;
  let s = "";
  for (let i = 0; i < 6; i++) { s += String.fromCharCode(65 + (h % 26)); h = (Math.imul(h, 1103515245) + 12345) >>> 0; }
  return s;
}
