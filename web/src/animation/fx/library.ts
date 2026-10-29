// THE EFFECT LIBRARY: the EffectCraft effects OpenDesigner can draw (see fx/catalog.ts for all
// 307). An effect is a set of numeric PARAMETERS, each one animatable as a track named
// `fx.<effectId>.<paramId>` (animation/fx/props.ts), plus how to draw it with CanvasKit:
//   - `filter`:  a CanvasKit image filter / colour filter over the node's pixels (blur,
//                colour correction, morphology, offset, glow...);
//   - `overlay`: an SkSL shader drawn over the node's box inside the node's layer, blended
//                with `srcatop` (only where the node has pixels: grain, gradients, patterns)
//                or `dstin` (keeps the node where the shader is opaque: the wipes).
// This follows EffectCraft's parameter names, ranges and defaults where it has a counterpart
// (docs/effects.md). Effects of the catalog that need a pixel-level kernel CanvasKit cannot
// express here (keying, 3D, audio, simulation...) are listed but not drawable.
//
// Everything here is PURE data plus builders: no DOM, no store.

import type { CanvasKit, ColorFilter, ImageFilter } from "canvaskit-wasm";
import type { Histogram } from "@/animation/fx/stats";
import { KERNEL_FX } from "@/animation/fx/kernels";

export interface FxParam {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
}

export type FxValues = Readonly<Record<string, number>>;

export interface FxOverlay {
  sksl: string;
  /** The values of `uniform float p[12]` (the box is passed separately). */
  uniforms: (v: FxValues) => number[];
  /** srcatop: only where the node has pixels; dstin: a mask over the node; srcover: drawn over everything, also beyond the node (particles, text). */
  blend: "srcatop" | "dstin" | "srcover";
}

/** How a time effect combines the node's poses at other moments (see animation/pose.ts and renderer/ck). */
export type FxTimeMode = "plus" | "screen" | "lighten" | "darken" | "over" | "difference" | "displace";

export interface FxTime {
  /**
   * The poses to draw, in drawing order. `dt` is the offset in ms from the current time (0 is the node as it is now,
   * negative the past); `weight` its opacity. The node is posed again from the clip(s) at each of those times, so
   * this needs no stored frames and works the same when scrubbing, playing or exporting.
   */
  samples: { dt: number; weight: number }[];
  mode: FxTimeMode;
  /**
   * Only for mode "displace": the samples are DISPLACE_FRAMES frames followed by the node now (the map); each pixel shows
   * the frame the map picks. `uniforms` fill `uniform float p[12]` of DISPLACE_SKSL.
   */
  uniforms?: number[];
}

export interface FxKernel {
  sksl: string;
  /** box (x, y, w, h) is prepended by the renderer; these fill `uniform float p[12]`. */
  uniforms: number[];
  /**
   * Effects that look at the whole node first (Auto Levels, Equalize): the renderer reads back a small copy of the node, counts
   * it (fx/stats.ts) and this builds the 256 x 2 lookup table the shader gets as its second child, `uniform shader lut`.
   */
  lut?: (h: Histogram) => Uint8Array;
  /**
   * A second image for the shader (`uniform shader other`, after `src`, and after `lut` if any): "layer" is the layer the node
   * names in its `fx.<effect>.layer.<id>` track (an empty image if it names none or the node is gone), "original" is the node
   * drawn without any of the kernels (CC Composite).
   */
  other?: "layer" | "original";
  /** With `other: "layer"`: also a second layer, `uniform shader other2` (the node's `fx.<effect>.layer2.<id>` track). */
  other2?: true;
  /** Set by buildFx: the effect this kernel belongs to (to find its layer reference). */
  effect?: string;
}

/** A string parameter (animation/fx/props.ts stores its text in a track's name): not animated, edited in a dialog. */
export interface FxStringParam { id: string; label: string; default: string; multiline?: boolean }

/**
 * Text an effect has drawn over the node with the editor's own fonts (renderer/ck draws it as a text node, so wrapping, kerning,
 * weights and text on a path are the document's). Fractions are of the node's box; `path` units are of its shorter side, from
 * its centre.
 */
export interface FxTextSpec {
  content: string;
  fontFamily: string;
  fontWeight: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  align: "left" | "center" | "right";
  color: { r: number; g: number; b: number; a: number };
  opacity: number;
  /** the anchor of the text (centre) in the node's box and the width of its box as a fraction of the node's */
  ax: number;
  ay: number;
  width: number;
  /** "layer": run along the vector layer the effect names; or a polyline to run along (in units of the node's shorter side, from its centre) */
  path?: "layer" | { x: number; y: number }[];
}

export interface FxDef {
  id: string;
  params: readonly FxParam[];
  /** Image filter over the node's pixels, given the filter built so far (or null). */
  filter?: (CK: CanvasKit, v: FxValues, input: ImageFilter | null, track: (o: { delete(): void }) => void) => ImageFilter | null;
  overlay?: (v: FxValues) => FxOverlay;
  /**
   * A shader that READS the node's pixels: the node is first drawn offscreen (renderer/ck), and the SkSL gets it as
   * `uniform shader src` (sampled in the node's local coordinates), producing the node's new pixels. This is what
   * distortions, convolutions, mosaics and keyers need. Several kernels chain, each reading the previous one.
   */
  kernel?: (v: FxValues) => FxKernel;
  /**
   * A TIME effect: draws the node as it is at other moments (echo, motion blur, posterize time...). `t` is the
   * current time in ms. Resolved by animation/pose.ts, which re-samples the clip; the renderer only combines them.
   */
  time?: (v: FxValues, t: number) => FxTime;
  /** String parameters (the text of Basic Text...), and how the text is drawn from them and the numeric parameters. */
  strings?: readonly FxStringParam[];
  text?: (v: FxValues, s: Readonly<Record<string, string>>) => FxTextSpec;
  /** With `text`: a layer can be named (the path to run along) but is not required. */
  layerOptional?: true;
  /** The effect takes a second layer chosen in the editor (a `fx.<effect>.layer.<node>` track). */
  needsLayer?: 1 | 2;
  /** No pixels at all: the effect only carries values for expressions (EffectCraft's Expression Controls). */
  carrier?: true;
  /** How far beyond the node's box the effect paints (world units). */
  outset?: (v: FxValues) => number;
}

const P = (id: string, label: string, min: number, max: number, def: number, step = 1, unit?: string): FxParam => ({
  id, label, min, max, step, default: def, unit,
});

// --- colour matrices (4x5, row-major, offsets in 0..1) --------------------------------

type M = number[];
const IDENTITY: M = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
const LUMA = [0.2126, 0.7152, 0.0722] as const;

/** a after b (apply b first). */
export function mulM(a: M, b: M): M {
  const out = new Array<number>(20).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 5; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[r * 5 + k] * b[k * 5 + c];
      if (c === 4) s += a[r * 5 + 4];
      out[r * 5 + c] = s;
    }
  }
  return out;
}

export const saturationM = (s: number): M => {
  const [lr, lg, lb] = LUMA;
  const i = 1 - s;
  return [
    lr * i + s, lg * i, lb * i, 0, 0,
    lr * i, lg * i + s, lb * i, 0, 0,
    lr * i, lg * i, lb * i + s, 0, 0,
    0, 0, 0, 1, 0,
  ];
};

export const hueM = (deg: number): M => {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const [lr, lg, lb] = LUMA;
  return [
    lr + c * (1 - lr) - s * lr, lg - c * lg - s * lg, lb - c * lb + s * (1 - lb), 0, 0,
    lr - c * lr + s * 0.143, lg + c * (1 - lg) + s * 0.14, lb - c * lb - s * 0.283, 0, 0,
    lr - c * lr - s * (1 - lr), lg - c * lg + s * lg, lb + c * (1 - lb) + s * lb, 0, 0,
    0, 0, 0, 1, 0,
  ];
};

/** out = in * gain + offset on the colour channels (alpha untouched). */
export const gainOffsetM = (gr: number, gg: number, gb: number, or: number, og: number, ob: number): M => [
  gr, 0, 0, 0, or, 0, gg, 0, 0, og, 0, 0, gb, 0, ob, 0, 0, 0, 1, 0,
];

/** Hue (0..360), saturation, value 0..1 -> rgb 0..1. */
export function hsv(h: number, s: number, v: number): [number, number, number] {
  const k = (n: number) => (n + h / 60) % 6;
  const f = (n: number) => v - v * s * Math.max(0, Math.min(k(n), 4 - k(n), 1));
  return [f(5), f(3), f(1)];
}

/** Mixes the matrix with the identity by `amount` (0..1). */
const lerpM = (m: M, amount: number): M => m.map((x, i) => IDENTITY[i] + (x - IDENTITY[i]) * amount);

const colorFx = (build: (v: FxValues) => M) =>
  (CK: CanvasKit, v: FxValues, input: ImageFilter | null, track: (o: { delete(): void }) => void): ImageFilter => {
    const cf: ColorFilter = CK.ColorFilter.MakeMatrix(build(v));
    const f = CK.ImageFilter.MakeColorFilter(cf, input);
    track(cf); track(f);
    return f;
  };

// --- SkSL overlays -------------------------------------------------------------------

// Every overlay shader gets the node's box (x, y, w, h) in the node's local space and p[0..7].
const HEAD = `uniform float4 box; uniform float p[12];
float2 uv(float2 xy) { return (xy - box.xy) / max(box.zw, float2(1.0)); }
float hash21(float2 q) { return fract(sin(dot(q, float2(127.1, 311.7))) * 43758.5453); }
float vnoise(float2 q) {
  float2 i = floor(q), f = fract(q); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + float2(1, 0)), f.x), mix(hash21(i + float2(0, 1)), hash21(i + float2(1, 1)), f.x), f.y);
}
half4 tint(float3 c, float a) { return half4(half3(c * a), half(a)); }
`;
const sksl = (body: string) => `${HEAD}half4 main(float2 xy) {\n${body}\n}`;
const pad = (...n: number[]) => { const o = n.slice(0, 12); while (o.length < 12) o.push(0); return o; };

const wipe = (body: string): FxOverlay["sksl"] => sksl(`${body}\n  return half4(half(clamp(m, 0.0, 1.0)));`);

// --- the effects ---------------------------------------------------------------------

const BASE_FX: readonly FxDef[] = [
  // Blur & Sharpen ---------------------------------------------------------------------
  {
    id: "ec.blur.gaussian",
    params: [P("blurriness", "Blurriness", 0, 250, 10, 0.5), P("dimensions", "Dimensions (0 H&V, 1 H, 2 V)", 0, 2, 0)],
    filter: (CK, v, input, track) => {
      const s = v.blurriness / 2, d = Math.round(v.dimensions);
      if (s <= 0) return input;
      const f = CK.ImageFilter.MakeBlur(d === 2 ? 0 : s, d === 1 ? 0 : s, CK.TileMode.Decal, input);
      track(f);
      return f;
    },
    outset: (v) => v.blurriness * 1.5,
  },
  {
    id: "ec.blur.fastbox",
    params: [P("blurriness", "Blurriness", 0, 250, 10, 0.5), P("iterations", "Iterations", 1, 5, 1)],
    filter: (CK, v, input, track) => {
      // A box blur of n passes tends to a Gaussian of the same total variance.
      const s = (v.blurriness / 2) * Math.sqrt(Math.max(1, v.iterations)) * 0.75;
      if (s <= 0) return input;
      const f = CK.ImageFilter.MakeBlur(s, s, CK.TileMode.Decal, input);
      track(f);
      return f;
    },
    outset: (v) => v.blurriness * 1.5,
  },
  {
    id: "ec.blur.directional",
    params: [P("direction", "Direction", -360, 360, 0, 1, "°"), P("length", "Blur Length", 0, 1000, 10, 0.5)],
    filter: (CK, v, input, track) => {
      const s = v.length / 3;
      if (s <= 0) return input;
      const a = (v.direction * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
      const opts = { filter: CK.FilterMode.Linear, mipmap: CK.MipmapMode.None };
      // rotate the content so the blur axis is horizontal, blur in X, rotate back
      const fwd = CK.ImageFilter.MakeMatrixTransform([c, sn, 0, -sn, c, 0, 0, 0, 1], opts, input);
      const blur = CK.ImageFilter.MakeBlur(s, 0, CK.TileMode.Decal, fwd);
      const back = CK.ImageFilter.MakeMatrixTransform([c, -sn, 0, sn, c, 0, 0, 0, 1], opts, blur);
      track(fwd); track(blur); track(back);
      return back;
    },
    outset: (v) => v.length,
  },
  // Colour correction -----------------------------------------------------------------
  {
    id: "ec.color.brightnesscontrast",
    params: [P("brightness", "Brightness", -150, 150, 0), P("contrast", "Contrast", -100, 100, 0)],
    filter: colorFx((v) => {
      const k = 1 + v.contrast / 100, b = v.brightness / 255;
      return gainOffsetM(k, k, k, b + 0.5 * (1 - k), b + 0.5 * (1 - k), b + 0.5 * (1 - k));
    }),
  },
  {
    id: "ec.color.huesaturation",
    params: [P("hue", "Master Hue", -180, 180, 0, 1, "°"), P("saturation", "Master Saturation", -100, 100, 0), P("lightness", "Master Lightness", -100, 100, 0)],
    filter: colorFx((v) => {
      const l = v.lightness / 100;
      const light = l >= 0 ? gainOffsetM(1 - l, 1 - l, 1 - l, l, l, l) : gainOffsetM(1 + l, 1 + l, 1 + l, 0, 0, 0);
      return mulM(light, mulM(saturationM(1 + v.saturation / 100), hueM(v.hue)));
    }),
  },
  {
    id: "ec.color.exposure",
    params: [P("exposure", "Exposure", -5, 5, 0, 0.05), P("offset", "Offset", -1, 1, 0, 0.01)],
    filter: colorFx((v) => { const g = 2 ** v.exposure; return gainOffsetM(g, g, g, v.offset, v.offset, v.offset); }),
  },
  {
    id: "ec.color.gammapedestalgain",
    params: [P("gain", "Gain", 0, 4, 1, 0.01), P("pedestal", "Pedestal", -1, 1, 0, 0.01)],
    filter: colorFx((v) => gainOffsetM(v.gain, v.gain, v.gain, v.pedestal, v.pedestal, v.pedestal)),
  },
  {
    id: "ec.color.levels",
    params: [
      P("inBlack", "Input Black", 0, 255, 0), P("inWhite", "Input White", 0, 255, 255),
      P("outBlack", "Output Black", 0, 255, 0), P("outWhite", "Output White", 0, 255, 255),
    ],
    filter: colorFx((v) => {
      const span = Math.max(1, v.inWhite - v.inBlack);
      const g = (v.outWhite - v.outBlack) / span;
      const o = (v.outBlack - v.inBlack * g) / 255;
      return gainOffsetM(g, g, g, o, o, o);
    }),
  },
  {
    id: "ec.color.vibrance",
    params: [P("vibrance", "Vibrance", -100, 100, 0)],
    filter: colorFx((v) => saturationM(1 + v.vibrance / 100)),
  },
  {
    id: "ec.color.blackwhite",
    params: [P("amount", "Amount", 0, 100, 100)],
    filter: colorFx((v) => lerpM(saturationM(0), v.amount / 100)),
  },
  {
    id: "ec.color.tint",
    params: [P("hue", "Map White To (hue)", 0, 360, 40, 1, "°"), P("amount", "Amount to Tint", 0, 100, 100)],
    filter: colorFx((v) => {
      const [r, g, b] = hsv(v.hue, 0.6, 1);
      const [lr, lg, lb] = LUMA;
      const mono: M = [lr * r, lg * r, lb * r, 0, 0, lr * g, lg * g, lb * g, 0, 0, lr * b, lg * b, lb * b, 0, 0, 0, 0, 0, 1, 0];
      return lerpM(mono, v.amount / 100);
    }),
  },
  {
    id: "ec.color.photofilter",
    params: [P("hue", "Filter Hue", 0, 360, 30, 1, "°"), P("density", "Density", 0, 100, 25)],
    filter: colorFx((v) => {
      const [r, g, b] = hsv(v.hue, 0.8, 1), d = v.density / 100;
      return gainOffsetM(1 - d + d * r, 1 - d + d * g, 1 - d + d * b, 0, 0, 0);
    }),
  },
  {
    id: "ec.color.colorbalance",
    params: [P("red", "Red", -100, 100, 0), P("green", "Green", -100, 100, 0), P("blue", "Blue", -100, 100, 0)],
    filter: colorFx((v) => gainOffsetM(1, 1, 1, v.red / 255, v.green / 255, v.blue / 255)),
  },
  {
    id: "ec.color.channelmixer",
    params: [
      P("rr", "Red-Red", -200, 200, 100), P("rg", "Red-Green", -200, 200, 0), P("rb", "Red-Blue", -200, 200, 0),
      P("gr", "Green-Red", -200, 200, 0), P("gg", "Green-Green", -200, 200, 100), P("gb", "Green-Blue", -200, 200, 0),
      P("br", "Blue-Red", -200, 200, 0), P("bg", "Blue-Green", -200, 200, 0), P("bb", "Blue-Blue", -200, 200, 100),
    ],
    filter: colorFx((v) => [
      v.rr / 100, v.rg / 100, v.rb / 100, 0, 0,
      v.gr / 100, v.gg / 100, v.gb / 100, 0, 0,
      v.br / 100, v.bg / 100, v.bb / 100, 0, 0,
      0, 0, 0, 1, 0,
    ]),
  },
  // Channel ---------------------------------------------------------------------------
  {
    id: "ec.channel.invert",
    params: [P("blend", "Blend With Original", 0, 100, 0)],
    filter: colorFx((v) => lerpM(gainOffsetM(-1, -1, -1, 1, 1, 1), 1 - v.blend / 100)),
  },
  {
    id: "ec.channel.minimax",
    params: [P("radius", "Radius", 0, 100, 2), P("operation", "Operation (0 Minimum, 1 Maximum)", 0, 1, 1)],
    filter: (CK, v, input, track) => {
      const r = Math.round(v.radius);
      if (r <= 0) return input;
      const f = v.operation >= 0.5 ? CK.ImageFilter.MakeDilate(r, r, input) : CK.ImageFilter.MakeErode(r, r, input);
      track(f);
      return f;
    },
    outset: (v) => v.radius,
  },
  // Stylize ---------------------------------------------------------------------------
  {
    id: "ec.stylize.threshold",
    params: [P("level", "Level", 0, 255, 128)],
    filter: colorFx((v) => {
      const [lr, lg, lb] = LUMA, k = 255;
      const o = (-v.level * k) / 255;
      return [lr * k, lg * k, lb * k, 0, o, lr * k, lg * k, lb * k, 0, o, lr * k, lg * k, lb * k, 0, o, 0, 0, 0, 1, 0];
    }),
  },
  {
    id: "ec.stylize.strobe",
    params: [P("opacity", "Strobe Opacity", 0, 100, 100), P("level", "Level (0 normal, 1 flash)", 0, 1, 0, 0.01)],
    filter: colorFx((v) => {
      const k = (v.opacity / 100) * v.level;
      return lerpM(gainOffsetM(0, 0, 0, 1, 1, 1), k);
    }),
  },
  {
    id: "ec.stylize.glow",
    params: [P("radius", "Glow Radius", 0, 500, 10, 0.5), P("intensity", "Glow Intensity", 0, 5, 1, 0.05)],
    filter: (CK, v, input, track) => {
      const s = v.radius / 2;
      if (s <= 0 || v.intensity <= 0) return input;
      const halo = CK.ImageFilter.MakeBlur(s, s, CK.TileMode.Decal, input);
      const cf = CK.ColorFilter.MakeMatrix(gainOffsetM(v.intensity, v.intensity, v.intensity, 0, 0, 0).map((x, i) => (i === 18 ? v.intensity : x)));
      const lit = CK.ImageFilter.MakeColorFilter(cf, halo);
      const out = CK.ImageFilter.MakeBlend(CK.BlendMode.Plus, lit, input);
      track(halo); track(cf); track(lit); track(out);
      return out;
    },
    outset: (v) => v.radius * 1.5,
  },
  // Distort ---------------------------------------------------------------------------
  {
    id: "ec.distort.offset",
    params: [P("x", "Shift X", -2000, 2000, 0), P("y", "Shift Y", -2000, 2000, 0)],
    filter: (CK, v, input, track) => {
      const f = CK.ImageFilter.MakeOffset(v.x, v.y, input);
      track(f);
      return f;
    },
    outset: (v) => Math.max(Math.abs(v.x), Math.abs(v.y)),
  },
  // Noise & Grain ---------------------------------------------------------------------
  {
    id: "ec.noise.noise",
    params: [P("amount", "Amount of Noise", 0, 100, 20), P("seed", "Seed", 0, 1000, 1)],
    overlay: (v) => ({
      blend: "srcatop",
      sksl: sksl("float n = hash21(floor(xy) + p[1]) - 0.5; float a = abs(n) * 2.0 * p[0];\n  return tint(n > 0.0 ? float3(1.0) : float3(0.0), a);"),
      uniforms: (w) => pad(w.amount / 100, w.seed),
    }),
  },
  {
    id: "ec.noise.addgrain",
    params: [P("intensity", "Intensity", 0, 10, 1, 0.05), P("size", "Size", 0.1, 10, 1, 0.05), P("seed", "Seed", 0, 1000, 1)],
    overlay: () => ({
      blend: "srcatop",
      sksl: sksl("float n = hash21(floor(xy / max(p[1], 0.1)) + p[2]) - 0.5; float a = clamp(abs(n) * 2.0 * p[0] * 0.5, 0.0, 1.0);\n  return tint(n > 0.0 ? float3(1.0) : float3(0.0), a);"),
      uniforms: (w) => pad(w.intensity, w.size, w.seed),
    }),
  },
  {
    id: "ec.noise.fractal",
    params: [
      P("scale", "Scale", 5, 2000, 100), P("contrast", "Contrast", 0, 400, 100), P("opacity", "Opacity", 0, 100, 50),
      P("evolution", "Evolution", -3600, 3600, 0, 1, "°"),
    ],
    overlay: () => ({
      blend: "srcatop",
      sksl: sksl(`float2 q = (xy - box.xy) / max(p[0], 1.0);
  float e = p[3] * 0.0174533;
  float n = 0.0, amp = 0.5;
  for (int i = 0; i < 5; i++) { n += amp * vnoise(q + float2(e * 0.5, e * 0.3)); q *= 2.0; amp *= 0.5; }
  n = clamp((n - 0.5) * p[1] + 0.5, 0.0, 1.0);
  return tint(float3(n), p[2]);`),
      uniforms: (w) => pad(w.scale, w.contrast / 100, w.opacity / 100, w.evolution),
    }),
  },
  // Generate --------------------------------------------------------------------------
  {
    id: "ec.generate.fill",
    params: [P("hue", "Color (hue)", 0, 360, 0, 1, "°"), P("saturation", "Saturation", 0, 100, 100), P("value", "Brightness", 0, 100, 100), P("opacity", "Opacity", 0, 100, 100)],
    overlay: () => ({
      blend: "srcatop",
      sksl: sksl("return tint(float3(p[0], p[1], p[2]), p[3]);"),
      uniforms: (w) => pad(...hsv(w.hue, w.saturation / 100, w.value / 100), w.opacity / 100),
    }),
  },
  {
    id: "ec.generate.gradientramp",
    params: [
      P("angle", "Angle", -360, 360, 0, 1, "°"), P("startHue", "Start Hue", 0, 360, 0, 1, "°"), P("endHue", "End Hue", 0, 360, 240, 1, "°"),
      P("shape", "Shape (0 linear, 1 radial)", 0, 1, 0), P("opacity", "Opacity", 0, 100, 100),
    ],
    overlay: () => ({
      blend: "srcatop",
      sksl: sksl(`float2 q = uv(xy) - 0.5;
  float a = p[0];
  float t = p[8] > 0.5 ? clamp(length(q) * 2.0, 0.0, 1.0) : clamp(dot(q, float2(cos(a), sin(a))) + 0.5, 0.0, 1.0);
  float3 c0 = float3(p[1], p[2], p[3]), c1 = float3(p[4], p[5], p[6]);
  return tint(mix(c0, c1, t), p[7]);`),
      uniforms: (w) => pad((w.angle * Math.PI) / 180, ...hsv(w.startHue, 0.8, 1), ...hsv(w.endHue, 0.8, 1), w.opacity / 100, w.shape),
    }),
  },
  {
    id: "ec.generate.checkerboard",
    params: [P("size", "Size", 2, 500, 40), P("opacity", "Opacity", 0, 100, 50)],
    overlay: () => ({
      blend: "srcatop",
      sksl: sksl(`float2 c = floor((xy - box.xy) / max(p[0], 1.0));
  float on = mod(c.x + c.y, 2.0);
  return tint(float3(0.0), on * p[1]);`),
      uniforms: (w) => pad(w.size, w.opacity / 100),
    }),
  },
  {
    id: "ec.generate.grid",
    params: [P("size", "Size", 4, 500, 40), P("border", "Border", 0.5, 50, 1, 0.5), P("opacity", "Opacity", 0, 100, 60)],
    overlay: () => ({
      blend: "srcatop",
      sksl: sksl(`float2 g = mod(xy - box.xy, max(p[0], 1.0));
  float line = (g.x < p[1] || g.y < p[1]) ? 1.0 : 0.0;
  return tint(float3(1.0), line * p[2]);`),
      uniforms: (w) => pad(w.size, w.border, w.opacity / 100),
    }),
  },
  {
    id: "ec.generate.circle",
    params: [P("radius", "Radius", 0, 2000, 100), P("feather", "Feather", 0, 500, 0), P("hue", "Hue", 0, 360, 0, 1, "°"), P("opacity", "Opacity", 0, 100, 100), P("invert", "Invert", 0, 1, 0)],
    overlay: () => ({
      blend: "srcatop",
      sksl: sksl(`float d = length(xy - (box.xy + box.zw * 0.5));
  float m = 1.0 - smoothstep(p[0] - p[1] * 0.5, p[0] + p[1] * 0.5 + 0.001, d);
  if (p[5] > 0.5) m = 1.0 - m;
  return tint(float3(p[2], p[3], p[4]), m * p[6]);`),
      uniforms: (w) => pad(w.radius, w.feather, ...hsv(w.hue, 0.8, 1), w.invert, w.opacity / 100),
    }),
  },
  {
    id: "ec.generate.radiowaves",
    params: [P("frequency", "Frequency", 0.5, 50, 6, 0.1), P("scale", "Wave Length", 4, 1000, 40), P("opacity", "Opacity", 0, 100, 60), P("phase", "Phase", -3600, 3600, 0, 1, "°")],
    overlay: () => ({
      blend: "srcatop",
      sksl: sksl(`float d = length(xy - (box.xy + box.zw * 0.5)) / max(p[1], 1.0);
  float w = 0.5 + 0.5 * sin(6.2831853 * (d * p[0] / 6.0) - p[3] * 0.0174533);
  return tint(float3(1.0), w * p[2]);`),
      uniforms: (w) => pad(w.frequency, w.scale, w.opacity / 100, w.phase),
    }),
  },
  {
    id: "ec.generate.cclightsweep",
    params: [P("position", "Center", -100, 200, 0), P("width", "Width", 1, 100, 20), P("angle", "Direction", -360, 360, 20, 1, "°"), P("intensity", "Intensity", 0, 100, 60)],
    overlay: () => ({
      blend: "srcatop",
      sksl: sksl(`float2 q = uv(xy) - 0.5;
  float a = p[2];
  float t = dot(q, float2(cos(a), sin(a))) + 0.5;
  float m = exp(-pow((t - p[0]) / max(p[1], 0.001), 2.0));
  return tint(float3(1.0), m * p[3]);`),
      uniforms: (w) => pad(w.position / 100, w.width / 100, (w.angle * Math.PI) / 180, w.intensity / 100),
    }),
  },
  {
    id: "ec.stylize.ccvignette",
    params: [P("amount", "Amount", 0, 100, 50), P("size", "Size", 0, 150, 70)],
    overlay: () => ({
      blend: "srcatop",
      sksl: sksl(`float d = length((uv(xy) - 0.5) * 2.0);
  float m = smoothstep(p[1], p[1] + 0.8, d);
  return tint(float3(0.0), m * p[0]);`),
      uniforms: (w) => pad(w.amount / 100, w.size / 100),
    }),
  },
  // Transition ------------------------------------------------------------------------
  {
    id: "ec.transition.linearwipe",
    params: [P("completion", "Transition Completion", 0, 100, 50), P("angle", "Wipe Angle", -360, 360, 90, 1, "°"), P("feather", "Feather", 0, 500, 0)],
    overlay: () => ({
      blend: "dstin",
      sksl: wipe(`float2 d = float2(sin(p[1]), -cos(p[1]));
  float2 q = xy - (box.xy + box.zw * 0.5);
  float ext = abs(box.z * d.x) + abs(box.w * d.y);
  float t = dot(q, d) + ext * 0.5;
  float thr = (ext + p[2]) * p[0] - p[2] * 0.5;
  float m = smoothstep(thr - p[2] * 0.5, thr + p[2] * 0.5 + 0.001, t);
  m = p[0] <= 0.0 ? 1.0 : m;`),
      uniforms: (w) => pad(w.completion / 100, (w.angle * Math.PI) / 180, w.feather),
    }),
  },
  {
    id: "ec.transition.radialwipe",
    params: [P("completion", "Transition Completion", 0, 100, 50), P("startAngle", "Start Angle", -360, 360, 0, 1, "°"), P("feather", "Feather", 0, 100, 0)],
    overlay: () => ({
      blend: "dstin",
      sksl: wipe(`float2 q = xy - (box.xy + box.zw * 0.5);
  float a = atan(q.x, -q.y) - p[1];
  a = mod(a, 6.2831853) / 6.2831853;
  float f = max(p[2], 0.0001);
  float m = 1.0 - smoothstep(p[0] - f, p[0] + 0.0001, a);
  m = p[0] <= 0.0 ? 1.0 : m;`),
      uniforms: (w) => pad(w.completion / 100, (w.startAngle * Math.PI) / 180, w.feather / 100),
    }),
  },
  {
    id: "ec.transition.iriswipe",
    params: [P("completion", "Transition Completion", 0, 100, 50), P("feather", "Feather", 0, 500, 0)],
    overlay: () => ({
      blend: "dstin",
      sksl: wipe(`float2 h = box.zw * 0.5;
  float rmax = length(h);
  float d = length(xy - (box.xy + h));
  float r = rmax * (1.0 - p[0]);
  float m = smoothstep(r - p[1] * 0.5, r + p[1] * 0.5 + 0.001, d);
  m = p[0] <= 0.0 ? 1.0 : m;`),
      uniforms: (w) => pad(w.completion / 100, w.feather),
    }),
  },
  {
    id: "ec.transition.venetian",
    params: [P("completion", "Transition Completion", 0, 100, 50), P("direction", "Direction", -360, 360, 0, 1, "°"), P("width", "Width", 1, 500, 40)],
    overlay: () => ({
      blend: "dstin",
      sksl: wipe(`float2 d = float2(cos(p[1]), sin(p[1]));
  float t = dot(xy - box.xy, d) / max(p[2], 1.0);
  float m = fract(t) < p[0] ? 0.0 : 1.0;
  m = p[0] <= 0.0 ? 1.0 : m;`),
      uniforms: (w) => pad(w.completion / 100, (w.direction * Math.PI) / 180, w.width),
    }),
  },
  {
    id: "ec.transition.blockdissolve",
    params: [P("completion", "Transition Completion", 0, 100, 50), P("block", "Block Size", 1, 500, 20), P("seed", "Random Seed", 0, 1000, 1)],
    overlay: () => ({
      blend: "dstin",
      sksl: wipe(`float2 c = floor((xy - box.xy) / max(p[1], 1.0));
  float m = hash21(c + p[2]) < p[0] ? 0.0 : 1.0;
  m = p[0] <= 0.0 ? 1.0 : m;`),
      uniforms: (w) => pad(w.completion / 100, w.block, w.seed),
    }),
  },
];

// Effects EffectCraft keeps under another id with the same behaviour (legacy versions, VR variants of 2D effects).
const ALL = [...BASE_FX, ...KERNEL_FX];
const ALIASES: [alias: string, of: string][] = [
  ["ec.obsolete.gaussianlegacy", "ec.blur.gaussian"], ["ec.noise.medianlegacy", "ec.noise.median"],
  ["ec.vr.blur", "ec.blur.gaussian"], ["ec.vr.sharpen", "ec.blur.sharpen"], ["ec.vr.glow", "ec.stylize.glow"],
  ["ec.vr.denoise", "ec.blur.smart"], ["ec.noise.removegrain", "ec.blur.smart"], ["ec.vr.fractalnoise", "ec.noise.fractal"],
  ["ec.vr.colorgradients", "ec.generate.gradientramp"], ["ec.blur.camerashakedeblur", "ec.blur.unsharp"],
  ["ec.obsolete.lightning", "ec.generate.advancedlightning"], ["ec.key.spill", "ec.key.advancedspill"],
  ["ec.matte.mattechoker", "ec.matte.simplechoker"], ["ec.transition.ccimagewipe", "ec.transition.gradientwipe"],
  ["ec.distort.ccripplepulse", "ec.distort.ripple"], ["ec.distort.ccpowerpin", "ec.distort.cornerpin"],
  ["ec.sim.ccscatterize", "ec.stylize.scatter"], ["ec.distort.smear", "ec.distort.ccsmear"], ["ec.stylize.ccrepetile", "ec.stylize.motiontile"],
];
export const FX_LIBRARY: readonly FxDef[] = [
  ...ALL,
  ...ALIASES.flatMap(([id, of]) => {
    const src = ALL.find((d) => d.id === of);
    return src ? [{ ...src, id }] : [];
  }),
];

const BY_ID = new Map<string, FxDef>(FX_LIBRARY.map((d) => [d.id, d]));

export const fxDef = (id: string): FxDef | undefined => BY_ID.get(id);
export const hasFx = (id: string): boolean => BY_ID.has(id);

/** The parameter `paramId` of effect `id`, if both exist. */
export function fxParam(id: string, paramId: string): FxParam | undefined {
  return BY_ID.get(id)?.params.find((p) => p.id === paramId);
}

/** The string parameters of `def`: `given` over the defaults. */
export function resolveStrings(def: FxDef, given: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of def.strings ?? []) out[p.id] = given?.[p.id] ?? p.default;
  return out;
}

/** The values of effect `id`: `given` over the defaults, clamped to each parameter's range. */
export function resolveFx(def: FxDef, given: FxValues | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of def.params) {
    const v = given?.[p.id];
    out[p.id] = v === undefined || !Number.isFinite(v) ? p.default : Math.min(p.max, Math.max(p.min, v));
  }
  return out;
}
