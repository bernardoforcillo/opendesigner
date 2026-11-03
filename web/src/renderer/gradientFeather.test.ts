import { describe, it, expect } from "vitest";
import { FEATHER_BANDS, featherBands, gradientFeather, rampOpacity } from "@/renderer/effectsFx";
import type { GradientFeatherLite } from "@/renderer/effectsFx";
import { areValidEffects } from "@/store/effects";
import { toEffectLite, toPbEffects } from "@/store/types";
import type { EffectLite, NodeLite } from "@/store/types";
import { create } from "@bufbuild/protobuf";
import { EffectSchema } from "@/gen/opendesigner/v1/opendesigner_pb";

const rect = (effects: EffectLite[]): NodeLite => ({
  id: "r", parentId: "page1", orderKey: "a1", name: "r", visible: true, opacity: 1,
  x: 10, y: 20, width: 100, height: 200, rotation: 0, fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [],
  kind: "rect", cornerRadius: 0, clipsContent: false, effects,
});
const fe = (over: Partial<GradientFeatherLite> = {}): GradientFeatherLite => ({
  kind: "gradientFeather", startOpacity: 1, endOpacity: 0, x1: 0.5, y1: 0, x2: 0.5, y2: 1, ...over,
});
const pb = (e: EffectLite) => toPbEffects([e]).map((x) => create(EffectSchema, x));

describe("gradient feather", () => {
  it("ramps the opacity linearly and holds it before the start and past the end", () => {
    const e = fe({ startOpacity: 0.8, endOpacity: 0.2 });
    expect(rampOpacity(e, -1)).toBe(0.8);
    expect(rampOpacity(e, 0.5)).toBeCloseTo(0.5);
    expect(rampOpacity(e, 3)).toBeCloseTo(0.2);
  });
  it("is ignored when it would change nothing", () => {
    expect(gradientFeather(rect([fe({ endOpacity: 1 })]))).toBeUndefined();
    expect(gradientFeather(rect([fe()]))).toBeDefined();
  });
  it("splits into strips whose opacity falls along the ramp", () => {
    const bands = featherBands(rect([fe()]), fe());
    expect(bands).toHaveLength(FEATHER_BANDS);
    const o = bands.map((b) => b.opacity);
    expect(o).toEqual([...o].sort((a, b) => b - a));
    expect(o[0]).toBeGreaterThan(0.9);
    expect(o[o.length - 1]).toBeLessThan(0.1);
  });
  it("a zero-length ramp is one band", () => {
    expect(featherBands(rect([]), fe({ y2: 0 }))).toHaveLength(1);
  });
  it("round-trips through the wire format and is validated like Go", () => {
    const e = fe({ startOpacity: 0.9, endOpacity: 0.1, x1: 0, x2: 1, y2: 0 });
    const wire = pb(e);
    expect(wire[0].kind.case).toBe("gradientFeather");
    expect(toEffectLite(wire[0])).toEqual(e);
    expect(areValidEffects(wire)).toBe(true);
    expect(areValidEffects(pb(fe({ endOpacity: 1.5 })))).toBe(false);
    expect(areValidEffects(pb(fe({ y2: Infinity })))).toBe(false);
  });
});
