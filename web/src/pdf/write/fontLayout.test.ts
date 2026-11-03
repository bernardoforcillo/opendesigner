import { describe, it, expect } from "vitest";
import { buildSfnt } from "@/pdf/write/fontSubset";
import { parseFeatures, readGsub, type Glyph } from "@/pdf/write/fontLayout";

/** Serialises 16-bit words big-endian. */
const words = (...n: number[]): number[] => n.flatMap((x) => [(x >> 8) & 0xff, x & 0xff]);

// Glyph ids used by the fixture.
const F = 10, I = 11, LIG_FI = 50;

const ligature = words(1, 8, 1, 14, /* coverage */ 1, 1, F, /* set */ 1, 4, /* lig */ LIG_FI, 2, I);
const alternate = words(1, 8, 1, 14, /* coverage */ 1, 1, 20, /* set */ 2, 21, 22);
const singleDelta = words(1, 6, 5, /* coverage */ 1, 2, 30, 31);
const singleList = words(2, 12, 3, 60, 61, 62, /* coverage, format 2 range */ 2, 1, 40, 42, 0);
const extension = words(1, 1, 0, 8, /* inner single, delta 1 */ 1, 6, 1, 1, 1, 70);

/** A GSUB table with five lookups wired to the features liga, salt, ss01, smcp and ccmp. */
function gsub(): Uint8Array {
  const lookups: [number, number[]][] = [[4, ligature], [3, alternate], [1, singleDelta], [1, singleList], [7, extension]];
  const feats: [string, number][] = [["ccmp", 4], ["liga", 0], ["salt", 1], ["smcp", 3], ["ss01", 2]];

  const featureTables = feats.map(([, l]) => words(0, 1, l));
  const featList = [...words(feats.length)];
  let off = 2 + feats.length * 6;
  feats.forEach(([tag], i) => {
    featList.push(...[...tag].map((c) => c.charCodeAt(0)), ...words(off));
    off += featureTables[i]!.length;
  });
  for (const t of featureTables) featList.push(...t);

  const lookupTables = lookups.map(([type, sub]) => [...words(type, 0, 1, 8), ...sub]);
  const lookupList = [...words(lookups.length)];
  off = 2 + lookups.length * 2;
  for (const t of lookupTables) { lookupList.push(...words(off)); off += t.length; }
  for (const t of lookupTables) lookupList.push(...t);

  // version 1.0, no script list (offset 0 is never read), feature list at 10, lookup list after it
  return new Uint8Array([...words(1, 0, 0, 10, 10 + featList.length), ...featList, ...lookupList]);
}

const font = () => buildSfnt(new Map([["GSUB", gsub()]]));
const run = (...gids: number[]): Glyph[] => gids.map((gid, i) => ({ gid, text: String.fromCharCode(97 + i) }));
const gids = (g: Glyph[]) => g.map((x) => x.gid);
const on = (...tags: string[]) => new Map(tags.map((t) => [t, 1] as [string, number]));

describe("parseFeatures", () => {
  it("reads quoted tags with on, off, numbers and bare tags", () => {
    const m = parseFeatures(`"liga" 0, 'salt' 2, ss01, "smcp" on, "kern" off`);
    expect(m.get("liga")).toBe(0);
    expect(m.get("salt")).toBe(2);
    expect(m.get("ss01")).toBe(1);
    expect(m.get("smcp")).toBe(1);
    expect(m.get("kern")).toBe(0);
  });

  it("returns an empty map for nothing and skips malformed entries", () => {
    expect(parseFeatures(undefined).size).toBe(0);
    expect(parseFeatures("").size).toBe(0);
    expect(parseFeatures("toolong 1, ab, 'liga'").size).toBe(1);
  });
});

describe("readGsub", () => {
  it("returns null for a non-font and a font without GSUB", () => {
    expect(readGsub(new Uint8Array(40))).toBeNull();
    expect(readGsub(buildSfnt(new Map([["head", new Uint8Array(54)]])))).toBeNull();
  });

  it("returns null for a corrupt GSUB instead of throwing", () => {
    expect(readGsub(buildSfnt(new Map([["GSUB", new Uint8Array(4)]])))).toBeNull();
  });

  it("lists the feature tags the font offers", () => {
    expect([...readGsub(font())!.tags].sort()).toEqual(["ccmp", "liga", "salt", "smcp", "ss01"]);
  });

  it("substitutes a ligature and merges the source text into the ligature glyph", () => {
    const out = readGsub(font())!.apply(run(1, F, I, 2), on("liga"));
    expect(gids(out)).toEqual([1, LIG_FI, 2]);
    expect(out[1]!.text).toBe("bc");
  });

  it("leaves a partial ligature match and a disabled feature alone", () => {
    const g = readGsub(font())!;
    expect(gids(g.apply(run(F, 3), on("liga")))).toEqual([F, 3]);
    expect(gids(g.apply(run(F, I), on()))).toEqual([F, I]);
    expect(gids(g.apply(run(F, I), new Map([["liga", 0]])))).toEqual([F, I]);
    expect(gids(g.apply(run(F), on("liga")))).toEqual([F]); // run ends before the component
  });

  it("picks the alternate the feature value selects, and nothing when out of range", () => {
    const g = readGsub(font())!;
    expect(gids(g.apply(run(20), new Map([["salt", 1]])))).toEqual([21]);
    expect(gids(g.apply(run(20), new Map([["salt", 2]])))).toEqual([22]);
    expect(gids(g.apply(run(20), new Map([["salt", 3]])))).toEqual([20]);
  });

  it("applies single substitutions: delta, list with range coverage, and through an extension lookup", () => {
    const g = readGsub(font())!;
    expect(gids(g.apply(run(30, 31, 32), on("ss01")))).toEqual([35, 36, 32]);
    expect(gids(g.apply(run(40, 41, 42, 43), on("smcp")))).toEqual([60, 61, 62, 43]);
    expect(gids(g.apply(run(70), on("ccmp")))).toEqual([71]);
  });

  it("keeps the text of substituted glyphs and runs several features together", () => {
    const out = readGsub(font())!.apply(run(F, I, 30), on("liga", "ss01"));
    expect(gids(out)).toEqual([LIG_FI, 35]);
    expect(out.map((x) => x.text)).toEqual(["ab", "c"]);
  });

  it("ignores features the font does not have", () => {
    expect(gids(readGsub(font())!.apply(run(F, I), on("zzzz")))).toEqual([F, I]);
  });
});
