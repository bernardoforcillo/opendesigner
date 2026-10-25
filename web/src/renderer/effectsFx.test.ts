import { describe, it, expect } from "vitest";
import {
  BLUR_BANDS, FX_TILE, blurBands, expandGlass, noiseTile, overlayEffects, progressiveBlur, rampRadius, textureTile, tileUnit, withBandBlur, withExpandedGlass,
} from "./effectsFx";
import type { EffectLite, NodeLite } from "../store/types";
import type { NoiseLite, ProgressiveBlurLite } from "./effectsFx";
import { effectsOutset } from "./sceneIndex";
import { areValidEffects } from "../store/effects";
import { toEffectLite, toPbEffects } from "../store/types";
import { create } from "@bufbuild/protobuf";
import { EffectSchema } from "../gen/opendesigner/v1/opendesigner_pb";

const rect = (effects: EffectLite[], over: Partial<NodeLite> = {}): NodeLite => ({
  id: "r", parentId: "page1", orderKey: "a1", name: "r", visible: true, opacity: 1,
  x: 10, y: 20, width: 100, height: 200, rotation: 0, fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [],
  kind: "rect", cornerRadius: 0, clipsContent: false, effects, ...over,
});

const ramp = (over: Partial<ProgressiveBlurLite> = {}): ProgressiveBlurLite => ({
  kind: "progressiveBlur", startRadius: 0, endRadius: 16, x1: 0.5, y1: 0, x2: 0.5, y2: 1, background: false, ...over,
});
const noise = (over: Partial<NoiseLite> = {}): NoiseLite => ({
  kind: "noise", mode: "mono", size: 1, density: 1, opacity: 0.5, color: { r: 1, g: 0, b: 0, a: 1 }, color2: { r: 0, g: 0, b: 1, a: 1 }, seed: 3, ...over,
});

describe("progressive blur", () => {
  it("ramps linearly and holds before the start and past the end", () => {
    const e = ramp({ startRadius: 4, endRadius: 20 });
    expect(rampRadius(e, -1)).toBe(4);
    expect(rampRadius(e, 0.5)).toBe(12);
    expect(rampRadius(e, 2)).toBe(20);
    expect(rampRadius(ramp({ endRadius: 1e9 }), 1)).toBe(10000);
  });

  it("splits into bands whose radii rise along the ramp and which tile the node", () => {
    const n = rect([ramp()]);
    const bands = blurBands(n, ramp(), 0);
    expect(bands).toHaveLength(BLUR_BANDS);
    const radii = bands.map((b) => b.radius);
    expect(radii).toEqual([...radii].sort((a, b) => a - b));
    expect(radii[0]).toBeCloseTo(1); // (0.5 / 8) * 16
    expect(radii[BLUR_BANDS - 1]).toBeCloseTo(15);
    // Top to bottom over y 20..220: the first band reaches up past the node, the last down past it.
    const ys = (b: (typeof bands)[number]) => b.polygon.map((p) => p[1]);
    expect(Math.min(...ys(bands[0]))).toBeLessThan(20 - 1000);
    expect(Math.max(...ys(bands[BLUR_BANDS - 1]))).toBeGreaterThan(220 + 1000);
    // Neighbouring bands meet exactly (overlap 0): band i ends at y = 20 + 200 (i+1)/8.
    expect(Math.max(...ys(bands[2]).filter((y) => y < 1000))).toBeCloseTo(20 + (200 * 3) / 8);
  });

  it("works along any direction and survives a degenerate ramp", () => {
    const n = rect([]);
    const diag = blurBands(n, ramp({ x1: 0, y1: 0, x2: 1, y2: 1 }), 0);
    expect(diag).toHaveLength(BLUR_BANDS);
    const flat = blurBands(n, ramp({ x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.5 }), 0);
    expect(flat).toHaveLength(1);
  });

  it("picks the ramp by target and swaps it for a uniform blur per band", () => {
    const layer = ramp();
    const back = ramp({ background: true, endRadius: 8 });
    const n = rect([layer, back, { kind: "layerBlur", radius: 3 }]);
    expect(progressiveBlur(n, false)).toBe(layer);
    expect(progressiveBlur(n, true)).toBe(back);
    expect(progressiveBlur(rect([ramp({ endRadius: 0 })]), false)).toBeUndefined();
    const band = withBandBlur(n, layer, 5);
    expect(band.effects).toEqual([{ kind: "layerBlur", radius: 5 }, back]);
  });

  it("counts toward the node's paint outset", () => {
    expect(effectsOutset(rect([ramp({ endRadius: 10 })]))).toBe(30);
    expect(effectsOutset(rect([ramp({ endRadius: 10, background: true })]))).toBe(0);
  });
});

describe("noise and texture tiles", () => {
  it("is deterministic per seed and differs between seeds", () => {
    expect(noiseTile(noise())).toEqual(noiseTile(noise()));
    expect(noiseTile(noise({ seed: 4 }))).not.toEqual(noiseTile(noise()));
    expect(noiseTile(noise()).length).toBe(FX_TILE * FX_TILE * 4);
  });

  it("mono makes grey grains, duo the two colours, multi any colour", () => {
    const mono = noiseTile(noise());
    for (let i = 0; i < mono.length; i += 4) {
      expect(mono[i]).toBe(mono[i + 1]);
      expect(mono[i + 3]).toBe(128); // 0.5 of 255, rounded by the clamped array
    }
    const duo = noiseTile(noise({ mode: "duo" }));
    const seen = new Set<string>();
    for (let i = 0; i < duo.length; i += 4) seen.add(`${duo[i]},${duo[i + 1]},${duo[i + 2]}`);
    expect([...seen].sort()).toEqual(["0,0,255", "255,0,0"]);
    const multi = noiseTile(noise({ mode: "multi" }));
    const colours = new Set<string>();
    for (let i = 0; i < multi.length; i += 4) colours.add(`${multi[i]},${multi[i + 1]},${multi[i + 2]}`);
    expect(colours.size).toBeGreaterThan(100);
  });

  it("density sets the share of grains that show and keeps their layout", () => {
    const share = (t: Uint8ClampedArray) => { let n = 0; for (let i = 3; i < t.length; i += 4) if (t[i] > 0) n++; return n / (t.length / 4); };
    expect(share(noiseTile(noise({ density: 0 })))).toBe(0);
    expect(share(noiseTile(noise({ density: 1 })))).toBe(1);
    expect(share(noiseTile(noise({ density: 0.25 })))).toBeGreaterThan(0.2);
    expect(share(noiseTile(noise({ density: 0.25 })))).toBeLessThan(0.3);
    const lo = noiseTile(noise({ density: 0.2 }));
    const hi = noiseTile(noise({ density: 0.6 }));
    for (let i = 3; i < lo.length; i += 4) if (lo[i] > 0) expect(hi[i]).toBeGreaterThan(0);
  });

  it("texture tiles are soft, seeded and repeat seamlessly", () => {
    const t = textureTile({ kind: "texture", scale: 8, intensity: 1, seed: 5 });
    expect(t).toEqual(textureTile({ kind: "texture", scale: 8, intensity: 1, seed: 5 }));
    const a = (x: number, y: number) => t[((y % FX_TILE) * FX_TILE + (x % FX_TILE)) * 4 + 3];
    // Neighbouring pixels differ little, including across the wrap-around edge.
    for (let y = 0; y < FX_TILE; y += 7) {
      expect(Math.abs(a(0, y) - a(FX_TILE - 1, y))).toBeLessThan(100);
      expect(Math.abs(a(10, y) - a(11, y))).toBeLessThan(100); // steepest possible slope is ~96 per pixel
    }
    const quiet = textureTile({ kind: "texture", scale: 8, intensity: 0, seed: 5 });
    expect(Math.max(...Array.from(quiet).filter((_, i) => i % 4 === 3))).toBe(0);
  });

  it("maps tile pixels to world units: grain size for noise, a texture blob is 8 tile pixels", () => {
    expect(tileUnit(noise({ size: 3 }))).toBe(3);
    expect(tileUnit(noise({ size: 0 }))).toBe(1);
    expect(tileUnit({ kind: "texture", scale: 16, intensity: 1, seed: 1 })).toBe(2);
    expect(tileUnit({ kind: "texture", scale: 0, intensity: 1, seed: 1 })).toBe(1);
  });

  it("lists the overlays of a node in order", () => {
    const n = rect([{ kind: "dropShadow", color: { r: 0, g: 0, b: 0, a: 1 }, offsetX: 0, offsetY: 0, blur: 0 }, noise(), { kind: "texture", scale: 8, intensity: 1, seed: 1 }]);
    expect(overlayEffects(n).map((e) => e.kind)).toEqual(["noise", "texture"]);
  });
});

describe("glass", () => {
  it("expands into a backdrop blur, a white grain and a light and a dark edge", () => {
    const out = expandGlass([{ kind: "glass", frost: 12, light: 0.6, lightAngle: 0, noise: 0.5 }]);
    expect(out.map((e) => e.kind)).toEqual(["backgroundBlur", "noise", "innerShadow", "innerShadow"]);
    expect(out[0]).toEqual({ kind: "backgroundBlur", radius: 12 });
    const [light, dark] = [out[2], out[3]] as Extract<EffectLite, { kind: "innerShadow" }>[];
    // Light from the left: the bright edge is cast in the +x direction, the dark one opposite.
    expect(light.offsetX).toBeGreaterThan(0);
    expect(dark.offsetX).toBeLessThan(0);
    expect(light.color).toEqual({ r: 1, g: 1, b: 1, a: 0.6 });
  });

  it("leaves other effects alone, drops disabled parts and keeps a glass-free node identical", () => {
    const plain = rect([{ kind: "layerBlur", radius: 2 }]);
    expect(withExpandedGlass(plain)).toBe(plain);
    const out = expandGlass([{ kind: "layerBlur", radius: 2 }, { kind: "glass", frost: 0, light: 0, lightAngle: 90, noise: 0 }]);
    expect(out).toEqual([{ kind: "layerBlur", radius: 2 }]);
  });
});

describe("wire", () => {
  it("round-trips every new effect through the protobuf shape", () => {
    const all: EffectLite[] = [ramp({ background: true }), noise({ mode: "duo" }), { kind: "texture", scale: 6, intensity: 0.3, seed: 2 }, { kind: "glass", frost: 9, light: 0.4, lightAngle: 30, noise: 0.1 }];
    const back = toPbEffects(all).map((e) => toEffectLite(create(EffectSchema, e)));
    expect(back).toEqual(all);
  });

  it("validates ranges like core.validateEffects", () => {
    const pb = (e: EffectLite) => create(EffectSchema, toPbEffects([e])[0]);
    expect(areValidEffects([pb(ramp()), pb(noise()), pb({ kind: "texture", scale: 8, intensity: 1, seed: 1 }), pb({ kind: "glass", frost: 1, light: 1, lightAngle: -45, noise: 0 })])).toBe(true);
    for (const bad of [
      ramp({ endRadius: -1 }), ramp({ endRadius: 1e9 }), ramp({ x1: NaN }),
      noise({ density: 1.5 }), noise({ opacity: -0.1 }), noise({ size: -1 }),
      { kind: "texture", scale: 8, intensity: 2, seed: 1 } as EffectLite,
      { kind: "glass", frost: 1, light: 3, lightAngle: 0, noise: 0 } as EffectLite,
      { kind: "glass", frost: 1, light: 1, lightAngle: Infinity, noise: 0 } as EffectLite,
    ]) expect(areValidEffects([pb(bad)])).toBe(false);
  });
});
