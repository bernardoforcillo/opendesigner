// IMAGE STATISTICS for the effects that look at the whole node before changing it (Auto Levels, Auto Contrast, Auto Color,
// Equalize). The renderer reads back a small copy of the node's pixels (ckRenderer.ts::drawLayerBody), `histogram` counts
// them and a builder turns the counts into a lookup table the shader reads (fx/kit.ts::lutKern).
//
// PURE: no CanvasKit, no DOM. A LUT is 256 x 2 RGBA bytes: row 0 maps R, G, B (in .r .g .b), row 1 maps luma (in .r).

export interface Histogram {
  /** counts per 8-bit value, weighted by alpha (0..255), of unpremultiplied R, G, B and luma */
  bins: [Float64Array, Float64Array, Float64Array, Float64Array];
  /** total weight (sum of alpha / 255) */
  total: number;
}

const luma8 = (r: number, g: number, b: number) => Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);

/** Histogram of RGBA8888 UNPREMULTIPLIED pixels; transparent pixels weigh nothing. */
export function histogram(px: ArrayLike<number>): Histogram {
  const bins: Histogram["bins"] = [new Float64Array(256), new Float64Array(256), new Float64Array(256), new Float64Array(256)];
  let total = 0;
  for (let i = 0; i + 3 < px.length; i += 4) {
    const w = px[i + 3] / 255;
    if (w <= 0) continue;
    bins[0][px[i]] += w;
    bins[1][px[i + 1]] += w;
    bins[2][px[i + 2]] += w;
    bins[3][luma8(px[i], px[i + 1], px[i + 2])] += w;
    total += w;
  }
  return { bins, total };
}

/** The smallest value v such that at least `fraction` of the weight lies at or below v (0..255). */
export function percentile(bin: Float64Array, total: number, fraction: number): number {
  if (total <= 0) return 0;
  const goal = total * Math.min(1, Math.max(0, fraction));
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += bin[v];
    if (acc >= goal && (goal > 0 || bin[v] > 0)) return v;
  }
  return 255;
}

/** The mean value (0..255) of the weight between lo and hi, or null if there is none. */
function meanBetween(bin: Float64Array, lo: number, hi: number): number | null {
  let w = 0, s = 0;
  for (let v = Math.ceil(lo); v <= Math.floor(hi); v++) { w += bin[v]; s += bin[v] * v; }
  return w > 0 ? s / w : null;
}

type Map256 = (v: number) => number;
const clamp8 = (v: number) => Math.min(255, Math.max(0, v));

/** A LUT from one mapping per channel and one for luma, mixed with the identity by `amount` (0..1). */
export function lutFrom(r: Map256, g: Map256, b: Map256, l: Map256, amount = 1): Uint8Array {
  const out = new Uint8Array(256 * 2 * 4);
  const mix = (m: Map256, v: number) => clamp8(Math.round(v + (m(v) - v) * amount));
  for (let v = 0; v < 256; v++) {
    out.set([mix(r, v), mix(g, v), mix(b, v), 255], v * 4);
    out.set([mix(l, v), 0, 0, 255], (256 + v) * 4);
  }
  return out;
}

export const stretch = (lo: number, hi: number, gamma = 1): Map256 => {
  // a flat channel has nothing to stretch: leave it alone
  if (hi - lo < 2) return (v) => v;
  const span = hi - lo;
  return (v) => 255 * Math.pow(Math.min(1, Math.max(0, (v - lo) / span)), 1 / gamma);
};

export interface LevelsOptions { blackClip: number; whiteClip: number; blend: number }

/** Auto Levels: each channel is stretched on its own so that `blackClip`/`whiteClip` percent of it clips. */
export function autoLevelsLut(h: Histogram, o: LevelsOptions): Uint8Array {
  const f = (i: number) => stretch(percentile(h.bins[i], h.total, o.blackClip / 100), percentile(h.bins[i], h.total, 1 - o.whiteClip / 100));
  return lutFrom(f(0), f(1), f(2), f(3), o.blend);
}

/** Auto Contrast: the same stretch for all channels, taken from the luma. */
export function autoContrastLut(h: Histogram, o: LevelsOptions): Uint8Array {
  const m = stretch(percentile(h.bins[3], h.total, o.blackClip / 100), percentile(h.bins[3], h.total, 1 - o.whiteClip / 100));
  return lutFrom(m, m, m, m, o.blend);
}

/** Auto Color: per-channel levels, then (optionally) a gamma per channel that pulls the mid-tones to neutral grey. */
export function autoColorLut(h: Histogram, o: LevelsOptions & { snapNeutral: boolean }): Uint8Array {
  const lv = [0, 1, 2].map((i) => stretch(percentile(h.bins[i], h.total, o.blackClip / 100), percentile(h.bins[i], h.total, 1 - o.whiteClip / 100)));
  const gamma = [1, 1, 1];
  if (o.snapNeutral) {
    // mean of each channel's mid-range (after levels), then the gamma that brings it to the average of the three
    const means = [0, 1, 2].map((i) => {
      const lo = percentile(h.bins[i], h.total, 0.25), hi = percentile(h.bins[i], h.total, 0.75);
      const m = meanBetween(h.bins[i], lo, hi);
      return lv[i](m ?? 128) / 255;
    });
    const target = (means[0] + means[1] + means[2]) / 3;
    for (let i = 0; i < 3; i++) {
      const m = Math.min(0.95, Math.max(0.05, means[i])), t = Math.min(0.95, Math.max(0.05, target));
      gamma[i] = Math.log(m) / Math.log(t);
    }
  }
  const ch = (i: number): Map256 => (v) => 255 * Math.pow(lv[i](v) / 255, 1 / Math.max(0.2, Math.min(5, gamma[i])));
  const l = stretch(percentile(h.bins[3], h.total, o.blackClip / 100), percentile(h.bins[3], h.total, 1 - o.whiteClip / 100));
  return lutFrom(ch(0), ch(1), ch(2), l, o.blend);
}

export type EqualizeMethod = "rgb" | "brightness" | "photoshop";

/** Equalize: the cumulative distribution as the mapping. `photoshop` spreads the brightness range evenly (first to last used level). */
export function equalizeLut(h: Histogram, method: EqualizeMethod, amount: number): Uint8Array {
  const cdf = (bin: Float64Array): Map256 => {
    const acc = new Float64Array(256);
    let s = 0;
    for (let v = 0; v < 256; v++) { s += bin[v]; acc[v] = s; }
    const total = Math.max(s, 1e-9);
    if (method === "photoshop") {
      // spread the levels actually used evenly over 0..255
      let first = 0, last = 255;
      while (first < 255 && bin[first] === 0) first++;
      while (last > 0 && bin[last] === 0) last--;
      const span = Math.max(acc[last] - acc[first], 1e-9);
      return (v) => (v <= first ? 0 : v >= last ? 255 : 255 * ((acc[v] - acc[first]) / span));
    }
    return (v) => 255 * (acc[v] / total);
  };
  const lum = cdf(h.bins[3]);
  if (method === "rgb") return lutFrom(cdf(h.bins[0]), cdf(h.bins[1]), cdf(h.bins[2]), lum, amount);
  return lutFrom(lum, lum, lum, lum, amount);
}
