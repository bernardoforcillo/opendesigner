// ICC PROFILES -- enough of the ICC format to do profile-managed RGB <-> CMYK for a printer's CMYK profile.
//
// SCOPE (honest): a CMYK output profile (FOGRA39, SWOP, GRACoL ...) carries two lookup tables, A2B0 (CMYK to the
// profile connection space, "perceptual") and B2A0 (back). Both are read here when they are the legacy `mft1` / `mft2`
// tables with a Lab connection space, which is what those profiles ship as. RGB is taken to be sRGB. NOT done: v4
// `mAB ` tables, XYZ connection spaces, the other intents (A2B1/A2B2), black-point compensation, gamut mapping beyond
// clipping. A profile this reader cannot use gives `null` from `parseIcc` and the editor falls back to the plain
// device conversion. See docs/color-management.md.

import type { Cmyk, Rgb } from "@/color/cmyk";

export interface IccProfile {
  /** The device colour space (always "CMYK": the only kind this reader converts for). */
  colorSpace: "CMYK";
  /** The profile's description (the name a person knows it by), "" when it has none. */
  description: string;
  /** Profile-managed conversions (percent CMYK, 0..1 RGB, sRGB). */
  rgbToCmyk(rgb: Rgb): Cmyk;
  cmykToRgb(cmyk: Cmyk): Rgb;
}

interface Lut {
  inputs: number;
  outputs: number;
  grid: number;
  inTables: Float64Array[];
  clut: Float64Array;
  outTables: Float64Array[];
  /** mft2 (16-bit) and mft1 (8-bit) encode Lab differently. */
  legacy16: boolean;
}

const sig = (b: DataView, o: number) => String.fromCharCode(b.getUint8(o), b.getUint8(o + 1), b.getUint8(o + 2), b.getUint8(o + 3));
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function readLut(dv: DataView, off: number, size: number): Lut | null {
  if (off < 0 || size < 52 || off + size > dv.byteLength) return null;
  const type = sig(dv, off);
  if (type !== "mft1" && type !== "mft2") return null;
  const inputs = dv.getUint8(off + 8), outputs = dv.getUint8(off + 9), grid = dv.getUint8(off + 10);
  if (inputs < 1 || inputs > 4 || (outputs !== 3 && outputs !== 4) || grid < 2) return null;
  const is16 = type === "mft2";
  let p = off + 48;
  let inN = 256, outN = 256;
  if (is16) { inN = dv.getUint16(p); outN = dv.getUint16(p + 2); p += 4; }
  if (inN < 2 || outN < 2) return null;
  const clutN = grid ** inputs * outputs;
  const w = is16 ? 2 : 1;
  if (p + (inN * inputs + clutN + outN * outputs) * w > off + size) return null;
  const take = (n: number): Float64Array => {
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = is16 ? dv.getUint16(p + i * 2) / 65535 : dv.getUint8(p + i) / 255;
    p += n * w;
    return a;
  };
  const inTables = Array.from({ length: inputs }, () => take(inN));
  const clut = take(clutN);
  const outTables = Array.from({ length: outputs }, () => take(outN));
  return { inputs, outputs, grid, inTables, clut, outTables, legacy16: is16 };
}

function table1d(t: Float64Array, x: number): number {
  const f = clamp01(x) * (t.length - 1);
  const i = Math.min(t.length - 2, Math.floor(f));
  const u = f - i;
  return t[i]! * (1 - u) + t[i + 1]! * u;
}

/** Evaluate a table at `input` (each 0..1): input curves, multilinear CLUT interpolation, output curves. */
function evalLut(l: Lut, input: readonly number[]): number[] {
  const pos = input.map((x, i) => clamp01(table1d(l.inTables[i]!, x)) * (l.grid - 1));
  const lo = pos.map((p) => Math.min(l.grid - 2, Math.floor(p)));
  const fr = pos.map((p, i) => p - lo[i]!);
  const out = new Array<number>(l.outputs).fill(0);
  for (let corner = 0; corner < 1 << l.inputs; corner++) {
    let weight = 1, index = 0;
    for (let d = 0; d < l.inputs; d++) {
      const hi = (corner >> d) & 1;
      weight *= hi ? fr[d]! : 1 - fr[d]!;
      index = index * l.grid + lo[d]! + hi; // the first input varies slowest
    }
    if (weight === 0) continue;
    for (let o = 0; o < l.outputs; o++) out[o]! += weight * l.clut[index * l.outputs + o]!;
  }
  return out.map((v, o) => clamp01(table1d(l.outTables[o]!, v)));
}

// Lab as the tables encode it. mft2 (legacy 16-bit): L 0..100 -> 0..0xFF00, a / b -128..127.996 -> 0..0xFFFF with 0 at 0x8000.
// mft1 (8-bit): L 0..100 -> 0..255, a / b -128..127 -> 0..255 with 0 at 128. `v` is the table value as a fraction of full scale.
const labFrom = (v: number[], legacy16: boolean): [number, number, number] =>
  legacy16 ? [(v[0]! * 65535 / 65280) * 100, (v[1]! * 65535) / 256 - 128, (v[2]! * 65535) / 256 - 128] : [v[0]! * 100, v[1]! * 255 - 128, v[2]! * 255 - 128];
const labTo = (L: number, a: number, b: number, legacy16: boolean): number[] =>
  legacy16 ? [clamp01((L / 100) * 65280 / 65535), clamp01(((a + 128) * 256) / 65535), clamp01(((b + 128) * 256) / 65535)] : [clamp01(L / 100), clamp01((a + 128) / 255), clamp01((b + 128) / 255)];

// sRGB <-> Lab (D50), through XYZ D50 (the Bradford-adapted sRGB matrices).
const D50 = [0.9642, 1, 0.8249] as const;
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
const finv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));

export function srgbToLabD50(rgb: Rgb): [number, number, number] {
  const r = lin(clamp01(rgb.r)), g = lin(clamp01(rgb.g)), b = lin(clamp01(rgb.b));
  const X = 0.4360747 * r + 0.3850649 * g + 0.1430804 * b;
  const Y = 0.2225045 * r + 0.7168786 * g + 0.0606169 * b;
  const Z = 0.0139322 * r + 0.0971045 * g + 0.7141733 * b;
  const fx = f(X / D50[0]), fy = f(Y / D50[1]), fz = f(Z / D50[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labD50ToSrgb(L: number, a: number, b: number): Rgb {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const X = finv(fx) * D50[0], Y = finv(fy) * D50[1], Z = finv(fz) * D50[2];
  const r = 3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z;
  const g = -0.9787684 * X + 1.9161415 * Y + 0.033454 * Z;
  const bl = 0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z;
  return { r: gam(clamp01(r)), g: gam(clamp01(g)), b: gam(clamp01(bl)) };
}

// eslint-disable-next-line no-control-regex
const printable = (s: string) => s.replace(/[\u0000-\u001f]/g, "").trim();

function description(dv: DataView, off: number, size: number): string {
  if (off < 0 || off + size > dv.byteLength || size < 12) return "";
  try {
    const type = sig(dv, off);
    if (type === "desc") {
      const n = dv.getUint32(off + 8);
      let s = "";
      for (let i = 0; i < n - 1 && off + 12 + i < dv.byteLength; i++) s += String.fromCharCode(dv.getUint8(off + 12 + i));
      return printable(s);
    }
    if (type === "mluc" && size >= 28) {
      const len = dv.getUint32(off + 20), start = dv.getUint32(off + 24);
      let s = "";
      for (let i = 0; i < len / 2; i++) s += String.fromCharCode(dv.getUint16(off + start + i * 2));
      return printable(s);
    }
  } catch { /* a damaged name is no name */ }
  return "";
}

/** True for bytes that look like an ICC profile (header size, `acsp` signature). Cheap; `parseIcc` is the real check. */
export function looksLikeIcc(bytes: Uint8Array): boolean {
  if (bytes.length < 132) return false;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return dv.getUint32(0) <= bytes.length && sig(dv, 36) === "acsp";
}

/** The number of components of an embedded profile's device space (the PDF stream's /N: 4 for CMYK, 3 for RGB), or null. */
export function iccComponents(bytes: Uint8Array): 3 | 4 | null {
  if (!looksLikeIcc(bytes)) return null;
  const s = sig(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 16);
  return s === "CMYK" ? 4 : s === "RGB " ? 3 : null;
}

/**
 * Reads a CMYK output profile. Null when the bytes are not an ICC profile, or are one this reader cannot use (see the
 * scope note above): the caller then keeps the device conversion.
 */
export function parseIcc(bytes: Uint8Array): IccProfile | null {
  if (!looksLikeIcc(bytes)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (sig(dv, 16) !== "CMYK" || sig(dv, 20) !== "Lab ") return null;
  const count = dv.getUint32(128);
  if (count > 200 || 132 + count * 12 > bytes.length) return null;
  const tags = new Map<string, [number, number]>();
  for (let i = 0; i < count; i++) tags.set(sig(dv, 132 + i * 12), [dv.getUint32(136 + i * 12), dv.getUint32(140 + i * 12)]);
  const a2bTag = tags.get("A2B0"), b2aTag = tags.get("B2A0");
  if (!a2bTag || !b2aTag) return null;
  const a2b = readLut(dv, ...a2bTag), b2a = readLut(dv, ...b2aTag);
  if (!a2b || !b2a || a2b.inputs !== 4 || a2b.outputs !== 3 || b2a.inputs !== 3 || b2a.outputs !== 4) return null;
  const desc = tags.get("desc");
  return {
    colorSpace: "CMYK",
    description: desc ? description(dv, ...desc) : "",
    rgbToCmyk(rgb) {
      const [L, a, b] = srgbToLabD50(rgb);
      const o = evalLut(b2a, labTo(L, a, b, b2a.legacy16));
      const pct = (v: number) => Math.round(v * 1000) / 10;
      return { c: pct(o[0]!), m: pct(o[1]!), y: pct(o[2]!), k: pct(o[3]!) };
    },
    cmykToRgb(c) {
      const o = evalLut(a2b, [c.c / 100, c.m / 100, c.y / 100, c.k / 100].map(clamp01));
      const [L, a, b] = labFrom(o, a2b.legacy16);
      return labD50ToSrgb(L, a, b);
    },
  };
}
