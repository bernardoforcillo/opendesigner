import { describe, expect, it } from "vitest";
import { cmykToRgb, rgbToCmyk } from "@/color/cmyk";
import { iccComponents, labD50ToSrgb, looksLikeIcc, parseIcc, srgbToLabD50 } from "@/color/icc";

// A synthetic CMYK output profile (mft2 tables, Lab PCS) whose behaviour IS the plain device model darkened by a
// "dot gain": it has a known answer, so the reader's table walk, interpolation and Lab encoding can be checked.
const gain = (v: number) => v ** 1.2; // the paper swallows light: every ink is a bit stronger than nominal

function deviceRgb(c: number, m: number, y: number, k: number) {
  return { r: (1 - gain(c)) * (1 - gain(k)), g: (1 - gain(m)) * (1 - gain(k)), b: (1 - gain(y)) * (1 - gain(k)) };
}

function buildProfile(desc = "Test Coated"): Uint8Array {
  const A_GRID = 9, B_GRID = 17;
  const u16 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 65535);
  const enc = (L: number, a: number, b: number) => [(L / 100) * 65280, (a + 128) * 256, (b + 128) * 256].map((v) => Math.round(Math.min(65535, Math.max(0, v))));
  const dec = (v: number[]) => ({ L: (v[0]! / 65280) * 100, a: v[1]! / 256 - 128, b: v[2]! / 256 - 128 });
  const identity = (n: number) => Array.from({ length: n }, (_, i) => u16(i / (n - 1)));

  const lut = (inputs: number, outputs: number, grid: number, clut: number[]) => {
    const n = 2;
    const buf = new Uint8Array(52 + (n * inputs + clut.length + n * outputs) * 2);
    const dv = new DataView(buf.buffer);
    buf.set([..."mft2"].map((ch) => ch.charCodeAt(0)), 0);
    dv.setUint8(8, inputs); dv.setUint8(9, outputs); dv.setUint8(10, grid);
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => dv.setInt32(12 + i * 4, v * 65536));
    dv.setUint16(48, n); dv.setUint16(50, n);
    let p = 52;
    const put = (vals: number[]) => { for (const v of vals) { dv.setUint16(p, v); p += 2; } };
    for (let i = 0; i < inputs; i++) put(identity(n));
    put(clut);
    for (let i = 0; i < outputs; i++) put(identity(n));
    return buf;
  };

  const a2b: number[] = [];
  for (let c = 0; c < A_GRID; c++) for (let m = 0; m < A_GRID; m++) for (let y = 0; y < A_GRID; y++) for (let k = 0; k < A_GRID; k++) {
    const [L, a, b] = srgbToLabD50(deviceRgb(c / (A_GRID - 1), m / (A_GRID - 1), y / (A_GRID - 1), k / (A_GRID - 1)));
    a2b.push(...enc(L, a, b));
  }
  const b2a: number[] = [];
  const grid = (i: number) => Math.round((i / (B_GRID - 1)) * 65535);
  for (let i = 0; i < B_GRID; i++) for (let j = 0; j < B_GRID; j++) for (let l = 0; l < B_GRID; l++) {
    const { L, a, b } = dec([grid(i), grid(j), grid(l)]);
    const rgb = labD50ToSrgb(L, a, b);
    const p = rgbToCmyk(rgb);
    // invert the dot gain so that a round trip lands back on the colour
    b2a.push(...[p.c, p.m, p.y, p.k].map((v) => u16((v / 100) ** (1 / 1.2))));
  }
  const tagA = lut(4, 3, A_GRID, a2b), tagB = lut(3, 4, B_GRID, b2a);

  const text = new TextEncoder().encode(desc + "\0");
  const descTag = new Uint8Array(12 + text.length + 4);
  new DataView(descTag.buffer).setUint32(8, text.length);
  descTag.set([..."desc"].map((ch) => ch.charCodeAt(0)), 0);
  descTag.set(text, 12);

  const tags: [string, Uint8Array][] = [["A2B0", tagA], ["B2A0", tagB], ["desc", descTag]];
  const tableEnd = 132 + tags.length * 12;
  const total = tags.reduce((s, [, t]) => s + t.length, tableEnd);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, total);
  out.set([..."prtr"].map((ch) => ch.charCodeAt(0)), 12);
  out.set([..."CMYK"].map((ch) => ch.charCodeAt(0)), 16);
  out.set([..."Lab "].map((ch) => ch.charCodeAt(0)), 20);
  out.set([..."acsp"].map((ch) => ch.charCodeAt(0)), 36);
  dv.setUint32(128, tags.length);
  let off = tableEnd;
  tags.forEach(([name, t], i) => {
    out.set([...name].map((ch) => ch.charCodeAt(0)), 132 + i * 12);
    dv.setUint32(136 + i * 12, off); dv.setUint32(140 + i * 12, t.length);
    out.set(t, off); off += t.length;
  });
  return out;
}

describe("sRGB <-> Lab D50", () => {
  it("round trips and puts white at L 100", () => {
    const [L, a, b] = srgbToLabD50({ r: 1, g: 1, b: 1 });
    expect(L).toBeCloseTo(100, 1); expect(Math.abs(a)).toBeLessThan(0.5); expect(Math.abs(b)).toBeLessThan(0.5);
    const c = { r: 0.2, g: 0.5, b: 0.8 };
    const back = labD50ToSrgb(...srgbToLabD50(c));
    expect(back.r).toBeCloseTo(c.r, 2); expect(back.g).toBeCloseTo(c.g, 2); expect(back.b).toBeCloseTo(c.b, 2);
  });
});

describe("parseIcc", () => {
  const bytes = buildProfile();
  const icc = parseIcc(bytes)!;

  it("recognises and describes a profile", () => {
    expect(looksLikeIcc(bytes)).toBe(true);
    expect(iccComponents(bytes)).toBe(4);
    expect(icc.colorSpace).toBe("CMYK");
    expect(icc.description).toBe("Test Coated");
  });

  it("converts CMYK to RGB through the table: darker than the plain device conversion", () => {
    const managed = icc.cmykToRgb({ c: 100, m: 0, y: 0, k: 0 });
    const plain = cmykToRgb({ c: 100, m: 0, y: 0, k: 0 });
    expect(managed.r).toBeLessThan(0.2);
    expect(plain.r).toBe(0);
    const mid = icc.cmykToRgb({ c: 50, m: 0, y: 0, k: 0 });
    expect(mid.r).toBeCloseTo(deviceRgb(0.5, 0, 0, 0).r, 1); // interpolated between grid points
    expect(icc.cmykToRgb({ c: 0, m: 0, y: 0, k: 0 }).g).toBeGreaterThan(0.98);
  });

  it("converts RGB to CMYK and back near where it started (inside the gamut)", () => {
    const rgb = { r: 0.8, g: 0.4, b: 0.3 };
    const cmyk = icc.rgbToCmyk(rgb);
    expect(cmyk.k).toBeLessThan(40);
    const back = icc.cmykToRgb(cmyk);
    expect(Math.abs(back.r - rgb.r)).toBeLessThan(0.05);
    expect(Math.abs(back.g - rgb.g)).toBeLessThan(0.05);
    expect(Math.abs(back.b - rgb.b)).toBeLessThan(0.05);
  });

  it("returns null for what it cannot use", () => {
    expect(parseIcc(new Uint8Array(10))).toBeNull();
    expect(looksLikeIcc(new Uint8Array(400))).toBe(false);
    const cut = bytes.slice(0, 300);
    new DataView(cut.buffer).setUint32(0, 300);
    expect(parseIcc(cut)).toBeNull();
    const rgbSpace = bytes.slice();
    rgbSpace.set([..."RGB "].map((c) => c.charCodeAt(0)), 16);
    expect(parseIcc(rgbSpace)).toBeNull();
    expect(iccComponents(rgbSpace)).toBe(3);
  });
});
