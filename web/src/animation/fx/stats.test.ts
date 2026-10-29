import { describe, it, expect } from "vitest";
import { autoColorLut, autoContrastLut, autoLevelsLut, equalizeLut, histogram, percentile } from "@/animation/fx/stats";

// RGBA pixels from a list of [r, g, b] (opaque), or with an alpha as a fourth value
const px = (...c: number[][]) => Uint8Array.from(c.flatMap(([r, g, b, a = 255]) => [r, g, b, a]));
const ramp = (lo: number, hi: number, n = 256) => px(...Array.from({ length: n }, (_, i) => { const v = Math.round(lo + ((hi - lo) * i) / (n - 1)); return [v, v, v]; }));
// row 0 of the LUT maps R, G, B; row 1 the luma
const mapR = (lut: Uint8Array, v: number) => lut[v * 4];
const mapG = (lut: Uint8Array, v: number) => lut[v * 4 + 1];
const mapB = (lut: Uint8Array, v: number) => lut[v * 4 + 2];
const mapL = (lut: Uint8Array, v: number) => lut[(256 + v) * 4];

describe("histogram", () => {
  it("counts channels and luma, weighting by alpha and skipping transparent pixels", () => {
    const h = histogram(px([10, 20, 30], [10, 20, 30, 128], [200, 200, 200, 0]));
    expect(h.total).toBeCloseTo(1 + 128 / 255);
    expect(h.bins[0][10]).toBeCloseTo(1 + 128 / 255);
    expect(h.bins[1][20]).toBeCloseTo(1 + 128 / 255);
    expect(h.bins[0][200]).toBe(0);
  });
  it("percentile finds the clip points", () => {
    const h = histogram(ramp(0, 255));
    expect(percentile(h.bins[0], h.total, 0)).toBe(0);
    expect(percentile(h.bins[0], h.total, 1)).toBe(255);
    expect(percentile(h.bins[0], h.total, 0.5)).toBeGreaterThan(120);
    expect(percentile(h.bins[0], h.total, 0.5)).toBeLessThan(135);
  });
});

describe("auto levels / contrast / color", () => {
  const opts = { blackClip: 0, whiteClip: 0, blend: 1 };
  it("stretches a low-contrast channel to the full range", () => {
    const lut = autoLevelsLut(histogram(ramp(80, 160)), opts);
    expect(mapR(lut, 80)).toBe(0);
    expect(mapR(lut, 160)).toBe(255);
    expect(mapR(lut, 120)).toBeGreaterThan(120);
    expect(mapR(lut, 120)).toBeLessThan(135);
  });
  it("levels each channel on its own; contrast uses one curve for all", () => {
    const img = px(...Array.from({ length: 64 }, (_, i) => [50 + i, 100 + i * 2, 20 + i]));
    const lv = autoLevelsLut(histogram(img), opts);
    expect(mapR(lv, 50)).toBe(0);
    expect(mapG(lv, 100)).toBe(0);
    expect(mapB(lv, 83)).toBeGreaterThan(100);
    const ct = autoContrastLut(histogram(img), opts);
    expect(mapR(ct, 100)).toBe(mapG(ct, 100));
    expect(mapG(ct, 100)).toBe(mapB(ct, 100));
  });
  it("a flat image is left alone", () => {
    const lut = autoLevelsLut(histogram(px([90, 90, 90], [90, 90, 90])), opts);
    expect(mapR(lut, 90)).toBe(90);
  });
  it("blend mixes with the identity", () => {
    const lut = autoLevelsLut(histogram(ramp(80, 160)), { ...opts, blend: 0.5 });
    expect(mapR(lut, 80)).toBe(40);
  });
  it("clipping percentages push the points inward", () => {
    const img = ramp(0, 255, 1000);
    const lut = autoLevelsLut(histogram(img), { blackClip: 10, whiteClip: 10, blend: 1 });
    expect(mapR(lut, 20)).toBe(0);
    expect(mapR(lut, 235)).toBe(255);
  });
  it("auto color snaps a mid-tone cast toward neutral", () => {
    // full-range ramps (so levels change nothing) whose mid-tones differ: red is lifted, blue is pushed down
    const img = px(...Array.from({ length: 256 }, (_, i) => { const t = i / 255; return [Math.round(255 * t ** 0.6), i, Math.round(255 * t ** 1.6)]; }));
    const h = histogram(img);
    const mid = [Math.round(255 * 0.5 ** 0.6), 128, Math.round(255 * 0.5 ** 1.6)];
    const spreadOf = (l: Uint8Array) => { const o = [mapR(l, mid[0]), mapG(l, mid[1]), mapB(l, mid[2])]; return Math.max(...o) - Math.min(...o); };
    const plain = autoColorLut(h, { blackClip: 0, whiteClip: 0, blend: 1, snapNeutral: false });
    const snapped = autoColorLut(h, { blackClip: 0, whiteClip: 0, blend: 1, snapNeutral: true });
    expect(spreadOf(plain)).toBeGreaterThan(60);
    expect(spreadOf(snapped)).toBeLessThan(spreadOf(plain) / 2);
    // the ends stay where they are
    expect([mapR(snapped, 0), mapR(snapped, 255), mapB(snapped, 255)]).toEqual([0, 255, 255]);
  });
});

describe("equalize", () => {
  const dark = px(...Array.from({ length: 200 }, (_, i) => { const v = 10 + (i % 40); return [v, v, v]; }));
  it("spreads a dark image over the whole range", () => {
    const lut = equalizeLut(histogram(dark), "rgb", 1);
    expect(mapR(lut, 10)).toBeLessThan(15);
    expect(mapR(lut, 49)).toBe(255);
    expect(mapR(lut, 30)).toBeGreaterThan(100);
  });
  it("is monotonic and amount 0 is the identity", () => {
    const lut = equalizeLut(histogram(dark), "brightness", 1);
    for (let v = 1; v < 256; v++) expect(mapL(lut, v)).toBeGreaterThanOrEqual(mapL(lut, v - 1));
    const none = equalizeLut(histogram(dark), "rgb", 0);
    for (const v of [0, 17, 128, 255]) expect(mapR(none, v)).toBe(v);
  });
  it("photoshop style maps the first used level to 0 and the last to 255", () => {
    const lut = equalizeLut(histogram(dark), "photoshop", 1);
    expect(mapL(lut, 10)).toBe(0);
    expect(mapL(lut, 49)).toBe(255);
  });
});
