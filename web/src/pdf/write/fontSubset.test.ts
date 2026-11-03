import { describe, it, expect } from "vitest";
import { sfntKind, sfntTables } from "@/pdf/sfnt";
import { buildSfnt, subsetTag, subsetTrueType } from "@/pdf/write/fontSubset";

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);

/** A glyph record: simple (1 contour) or composite (-1) made of `parts`, padded to `size` bytes. */
function glyph(size: number, fill: number, parts?: number[]): Uint8Array {
  const g = bytes(size, fill);
  const v = new DataView(g.buffer);
  v.setInt16(0, parts ? -1 : 1);
  if (parts) {
    let p = 10;
    parts.forEach((part, i) => {
      v.setUint16(p, i < parts.length - 1 ? 0x20 : 0); // MORE_COMPONENTS, byte args
      v.setUint16(p + 2, part);
      p += 6;
    });
  }
  return g;
}

/** A TrueType font with the given glyph records and a SHORT loca. Glyph ids are the array indices. */
function makeFont(glyphs: Uint8Array[]): Uint8Array {
  const head = new Uint8Array(54);
  new DataView(head.buffer).setInt16(50, 0); // short loca
  const maxp = new Uint8Array(6);
  new DataView(maxp.buffer).setUint16(4, glyphs.length);
  const loca = new Uint8Array((glyphs.length + 1) * 2);
  const lv = new DataView(loca.buffer);
  let pos = 0;
  glyphs.forEach((g, i) => { lv.setUint16(i * 2, pos / 2); pos += g.length; });
  lv.setUint16(glyphs.length * 2, pos / 2);
  const glyf = new Uint8Array(pos);
  let o = 0;
  for (const g of glyphs) { glyf.set(g, o); o += g.length; }
  return buildSfnt(new Map([
    ["head", head], ["hhea", bytes(36, 0)], ["maxp", maxp], ["hmtx", bytes(glyphs.length * 4, 0)],
    ["loca", loca], ["glyf", glyf], ["cmap", bytes(12, 0)], ["GSUB", bytes(10, 0)], ["name", bytes(8, 0)],
  ]));
}

/** Which glyph ids of a (subset) font have outline data, read from its long loca. */
function present(font: Uint8Array): boolean[] {
  const v = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const t = sfntTables(v);
  const n = v.getUint16(t.get("maxp")!.offset + 4);
  const loca = t.get("loca")!;
  const out: boolean[] = [];
  for (let g = 0; g < n; g++) out.push(v.getUint32(loca.offset + (g + 1) * 4) > v.getUint32(loca.offset + g * 4));
  return out;
}

describe("buildSfnt", () => {
  it("writes a valid directory with sorted tags, aligned tables and a head checksum adjustment", () => {
    const font = buildSfnt(new Map([["zzzz", bytes(5, 7)], ["head", new Uint8Array(54)], ["aaaa", bytes(4, 1)]]));
    expect(sfntKind(font)).toBe("ttf");
    const v = new DataView(font.buffer);
    expect(v.getUint16(4)).toBe(3);
    expect(v.getUint16(6)).toBe(32); // searchRange = 2^1 * 16
    expect(v.getUint16(8)).toBe(1); // entrySelector
    expect(v.getUint16(10)).toBe(16); // rangeShift = 3*16 - 32
    const t = sfntTables(v);
    expect([...t.keys()]).toEqual(["aaaa", "head", "zzzz"]);
    for (const { offset } of t.values()) expect(offset % 4).toBe(0);
    expect(t.get("zzzz")!.length).toBe(5);
    // The whole file must sum to 0xB1B0AFBA once the adjustment is in.
    let sum = 0;
    for (let i = 0; i < font.length; i += 4) sum = (sum + v.getUint32(i)) >>> 0;
    expect(sum).toBe(0xb1b0afba);
  });
});

describe("subsetTrueType", () => {
  it("keeps glyph 0 and the requested glyphs, empties the rest, and preserves glyph ids", () => {
    const font = makeFont([glyph(12, 1), glyph(14, 2), glyph(16, 3), glyph(20, 4)]);
    const sub = subsetTrueType(font, [2])!;
    expect(sub).not.toBeNull();
    expect(present(sub)).toEqual([true, false, true, false]);
    const v = new DataView(sub.buffer);
    const t = sfntTables(v);
    expect(v.getUint16(t.get("maxp")!.offset + 4)).toBe(4); // numGlyphs unchanged
    expect(v.getInt16(t.get("head")!.offset + 50)).toBe(1); // loca is now long
    // The kept outline bytes are copied verbatim.
    const glyf = t.get("glyf")!;
    const loca = t.get("loca")!;
    const s = v.getUint32(loca.offset + 2 * 4);
    expect(sub[glyf.offset + s + 10]).toBe(3);
    expect(sub.length).toBeLessThan(font.length + 64);
  });

  it("drops the tables the PDF does not need", () => {
    const sub = subsetTrueType(makeFont([glyph(12, 1), glyph(12, 2)]), [1])!;
    const tags = [...sfntTables(new DataView(sub.buffer)).keys()];
    expect(tags).toEqual(["glyf", "head", "hhea", "hmtx", "loca", "maxp"]);
  });

  it("keeps the parts a composite glyph is built from, transitively", () => {
    // 1 -> composite of 2 and 3; 3 -> composite of 4; 5 is unrelated.
    const font = makeFont([glyph(12, 1), glyph(24, 9, [2, 3]), glyph(12, 2), glyph(16, 9, [4]), glyph(12, 4), glyph(12, 5)]);
    const sub = subsetTrueType(font, [1])!;
    expect(present(sub)).toEqual([true, true, true, true, true, false]);
  });

  it("handles word-sized composite arguments and scale fields when walking components", () => {
    // A composite whose first part uses ARG_1_AND_2_ARE_WORDS | WE_HAVE_A_SCALE (0x0001|0x0008|0x0020).
    const g = new Uint8Array(10 + 4 + 4 + 2 + 6);
    const dv = new DataView(g.buffer);
    dv.setInt16(0, -1);
    dv.setUint16(10, 0x0001 | 0x0008 | 0x0020);
    dv.setUint16(12, 2);
    dv.setUint16(10 + 4 + 4 + 2, 0); // second part: no flags
    dv.setUint16(10 + 4 + 4 + 2 + 2, 3);
    const font = makeFont([glyph(12, 1), g, glyph(12, 2), glyph(12, 3), glyph(12, 4)]);
    const sub = subsetTrueType(font, [1])!;
    expect(present(sub)).toEqual([true, true, true, true, false]);
  });

  it("ignores out-of-range and zero glyph ids, and survives a composite cycle", () => {
    const font = makeFont([glyph(12, 1), glyph(16, 9, [1]), glyph(12, 2)]);
    const sub = subsetTrueType(font, [0, 99, 1])!;
    expect(present(sub)).toEqual([true, true, false]);
  });

  it("returns null for a CFF font, a non-font and a TrueType font without glyf", () => {
    const otto = new Uint8Array(32);
    new DataView(otto.buffer).setUint32(0, 0x4f54544f);
    expect(subsetTrueType(otto, [1])).toBeNull();
    expect(subsetTrueType(new Uint8Array(40), [1])).toBeNull();
    expect(subsetTrueType(buildSfnt(new Map([["head", new Uint8Array(54)]])), [1])).toBeNull();
  });

  it("returns null when loca is shorter than numGlyphs requires", () => {
    const font = makeFont([glyph(12, 1), glyph(12, 2)]);
    const v = new DataView(font.buffer);
    const t = sfntTables(v);
    // Claim more glyphs than loca covers.
    v.setUint16(t.get("maxp")!.offset + 4, 50);
    expect(subsetTrueType(font, [1])).toBeNull();
  });
});

describe("subsetTag", () => {
  it("is six capital letters, stable for a glyph set and different for another", () => {
    const a = subsetTag([1, 2, 3]);
    expect(a).toMatch(/^[A-Z]{6}$/);
    expect(subsetTag([1, 2, 3])).toBe(a);
    expect(subsetTag([1, 2, 4])).not.toBe(a);
  });
});
