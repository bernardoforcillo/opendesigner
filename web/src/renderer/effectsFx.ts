import type { EffectLite, NodeLite } from "@/store/types";

// THE TYPE-AND-EFFECTS EFFECTS (docs/effects.md): progressive blur, noise, texture and
// glass. Pure helpers shared by the 2D canvas, the CanvasKit renderer and the SVG export:
// nothing here touches a canvas, so all of it is checked in Node.

export type ProgressiveBlurLite = Extract<EffectLite, { kind: "progressiveBlur" }>;
export type NoiseLite = Extract<EffectLite, { kind: "noise" }>;
export type TextureLite = Extract<EffectLite, { kind: "texture" }>;
export type GlassLite = Extract<EffectLite, { kind: "glass" }>;

/** Radii above this draw as this (the model keeps the number). */
export const MAX_BLUR_RADIUS = 10000;
/** A progressive blur is drawn as this many bands of one uniform radius each. */
export const BLUR_BANDS = 8;
/** The side of a noise or texture tile, in tile pixels (a tile repeats). */
export const FX_TILE = 64;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---- glass ------------------------------------------------------------------------

/**
 * Glass is sugar over three other effects: the frosted backdrop (background blur), a fine
 * white grain and a light edge (two inner shadows, a bright one on the side the light
 * comes from and a faint dark one opposite). Renderers expand it before drawing, so glass
 * needs no drawing code of its own and exports like its parts.
 */
export function expandGlass(effects: readonly EffectLite[]): EffectLite[] {
  const out: EffectLite[] = [];
  for (const e of effects) {
    if (e.kind !== "glass") { out.push(e); continue; }
    const a = (e.lightAngle * Math.PI) / 180;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    if (e.frost > 0) out.push({ kind: "backgroundBlur", radius: e.frost });
    if (e.noise > 0) {
      const white = { r: 1, g: 1, b: 1, a: 1 };
      out.push({ kind: "noise", mode: "mono", size: 1, density: 0.5, opacity: clamp(e.noise, 0, 1) * 0.4, color: white, color2: white, seed: 1 });
    }
    if (e.light > 0) {
      out.push({ kind: "innerShadow", color: { r: 1, g: 1, b: 1, a: clamp(e.light, 0, 1) }, offsetX: dx * 1.5, offsetY: dy * 1.5, blur: 1 });
      out.push({ kind: "innerShadow", color: { r: 0, g: 0, b: 0, a: clamp(e.light, 0, 1) * 0.25 }, offsetX: -dx * 1.5, offsetY: -dy * 1.5, blur: 1 });
    }
  }
  return out;
}

/** `n` with its glass effects expanded (the same node when it has none). */
export function withExpandedGlass(n: NodeLite): NodeLite {
  if (!n.effects || !n.effects.some((e) => e.kind === "glass")) return n;
  return { ...n, effects: expandGlass(n.effects) };
}

// ---- progressive blur ---------------------------------------------------------------

export function progressiveBlur(n: NodeLite, background: boolean): ProgressiveBlurLite | undefined {
  return n.effects?.find((e): e is ProgressiveBlurLite =>
    e.kind === "progressiveBlur" && e.background === background && Math.max(e.startRadius, e.endRadius) > 0);
}

/** The radius at parameter t (0 at the start point, 1 at the end), held before and after. */
export function rampRadius(e: ProgressiveBlurLite, t: number): number {
  return clamp(e.startRadius + (e.endRadius - e.startRadius) * clamp(t, 0, 1), 0, MAX_BLUR_RADIUS);
}

export interface BlurBand {
  radius: number;
  /** The band's polygon in world coordinates (a quad covering far beyond the node across the ramp). */
  polygon: [number, number][];
}

/**
 * The bands a progressive blur is drawn with: BLUR_BANDS strips across the ramp, the first
 * and last reaching out to infinity (the radius is held there), each with the radius at its
 * middle. Neighbouring strips overlap by `overlap` world units so the clip's antialiasing
 * leaves no seam.
 */
export function blurBands(n: NodeLite, e: ProgressiveBlurLite, overlap = 0.5): BlurBand[] {
  const p1x = n.x + e.x1 * n.width;
  const p1y = n.y + e.y1 * n.height;
  const dx = (e.x2 - e.x1) * n.width;
  const dy = (e.y2 - e.y1) * n.height;
  const len = Math.hypot(dx, dy);
  const far = (n.width + n.height) * 4 + 4096;
  if (!(len > 1e-9)) return [{ radius: rampRadius(e, 0), polygon: [[n.x - far, n.y - far], [n.x + far, n.y - far], [n.x + far, n.y + far], [n.x - far, n.y + far]] }];
  const ux = dx / len;
  const uy = dy / len;
  const vx = -uy;
  const vy = ux;
  const bands: BlurBand[] = [];
  for (let i = 0; i < BLUR_BANDS; i++) {
    const s0 = i === 0 ? -far : (i / BLUR_BANDS) * len - overlap;
    const s1 = i === BLUR_BANDS - 1 ? far + len : ((i + 1) / BLUR_BANDS) * len + overlap;
    const pt = (s: number, side: number): [number, number] => [p1x + ux * s + vx * far * side, p1y + uy * s + vy * far * side];
    bands.push({ radius: rampRadius(e, (i + 0.5) / BLUR_BANDS), polygon: [pt(s0, -1), pt(s1, -1), pt(s1, 1), pt(s0, 1)] });
  }
  return bands;
}

/** `n` with the progressive effect `e` replaced by a uniform layer blur of `radius`, placed first. */
export function withBandBlur(n: NodeLite, e: ProgressiveBlurLite, radius: number): NodeLite {
  const rest = (n.effects ?? []).filter((x) => x !== e && !(x.kind === "layerBlur"));
  return { ...n, effects: [{ kind: "layerBlur", radius }, ...rest] };
}

// ---- noise and texture ---------------------------------------------------------------

// A small deterministic generator (mulberry32): the same seed draws the same grain on every
// renderer and every run, which the exports and the tests rely on.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The grain size in world units: 0 means the default 1. */
export function noiseGrain(e: NoiseLite): number {
  return e.size > 0 ? e.size : 1;
}

/**
 * One repeating tile of grain, FX_TILE x FX_TILE RGBA bytes (not premultiplied).
 * MONO: grey grains; DUO: each grain is `color` or `color2`; MULTI: random colours.
 * `density` is the share of grains that show, `opacity` their alpha.
 */
export function noiseTile(e: NoiseLite): Uint8ClampedArray {
  const rnd = mulberry32(e.seed);
  const out = new Uint8ClampedArray(FX_TILE * FX_TILE * 4);
  const alpha = clamp(e.opacity, 0, 1) * 255;
  const density = clamp(e.density, 0, 1);
  const byte = (v: number) => clamp(v, 0, 1) * 255;
  for (let i = 0; i < FX_TILE * FX_TILE; i++) {
    // Always draw the same number of randoms per grain so a changed density keeps the layout.
    const show = rnd();
    const r1 = rnd();
    const r2 = rnd();
    const r3 = rnd();
    const o = i * 4;
    if (show >= density) continue; // alpha stays 0
    if (e.mode === "multi") {
      out[o] = byte(r1); out[o + 1] = byte(r2); out[o + 2] = byte(r3);
    } else if (e.mode === "duo") {
      const c = r1 < 0.5 ? e.color : e.color2;
      out[o] = byte(c.r); out[o + 1] = byte(c.g); out[o + 2] = byte(c.b);
    } else {
      out[o] = out[o + 1] = out[o + 2] = byte(r1);
    }
    out[o + 3] = alpha;
  }
  return out;
}

/** The blob size of a texture in world units: 0 means the default 8. */
export function textureScale(e: TextureLite): number {
  return e.scale > 0 ? e.scale : 8;
}

/**
 * One repeating tile of soft mottling: value noise on an 8x8 lattice (wrapping, so the tile
 * repeats seamlessly), smoothstep-interpolated. Light blobs are white, dark ones black,
 * both with alpha growing from the mid-tone, scaled by `intensity`.
 */
export function textureTile(e: TextureLite): Uint8ClampedArray {
  const cells = 8;
  const rnd = mulberry32(e.seed);
  const lattice = Array.from({ length: cells * cells }, () => rnd());
  const at = (x: number, y: number) => lattice[(((y % cells) + cells) % cells) * cells + (((x % cells) + cells) % cells)];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const out = new Uint8ClampedArray(FX_TILE * FX_TILE * 4);
  const intensity = clamp(e.intensity, 0, 1);
  for (let y = 0; y < FX_TILE; y++) {
    for (let x = 0; x < FX_TILE; x++) {
      const gx = (x / FX_TILE) * cells;
      const gy = (y / FX_TILE) * cells;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const tx = smooth(gx - x0);
      const ty = smooth(gy - y0);
      const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
      const bot = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
      const v = top * (1 - ty) + bot * ty; // 0..1
      const o = (y * FX_TILE + x) * 4;
      const light = v >= 0.5;
      out[o] = out[o + 1] = out[o + 2] = light ? 255 : 0;
      out[o + 3] = Math.abs(v - 0.5) * 2 * intensity * 255;
    }
  }
  return out;
}

/** World units per tile pixel of an overlay: a noise grain is `size`, a texture blob (8 tile pixels) is `scale`. */
export function tileUnit(e: NoiseLite | TextureLite): number {
  return e.kind === "noise" ? noiseGrain(e) : textureScale(e) / 8;
}

/** The tile bytes of an overlay. */
export function overlayTile(e: NoiseLite | TextureLite): Uint8ClampedArray {
  return e.kind === "noise" ? noiseTile(e) : textureTile(e);
}

/** The overlays a node draws over itself, in order: noise and texture effects (after glass is expanded). */
export function overlayEffects(n: NodeLite): (NoiseLite | TextureLite)[] {
  return n.effects?.filter((e): e is NoiseLite | TextureLite => e.kind === "noise" || e.kind === "texture") ?? [];
}
