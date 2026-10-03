import { describe, it, expect } from "vitest";
import {
  EASING_PRESETS, clampBezier, curvePath, dragControl, easingToBezier, formatBezier, fromPx, nudgeControl, presetIdOf, toPx,
  type CurveBox,
} from "./easingEdit";
import { isValidEasing } from "./engine";

const BOX: CurveBox = { width: 168, height: 124, pad: 18 };

describe("easingEdit", () => {
  it("presetIdOf riconosce i nomi, la curva personalizzata e ripiega su lineare", () => {
    expect(presetIdOf("")).toBe("linear");
    expect(presetIdOf("easeOut")).toBe("easeOut");
    expect(presetIdOf("spring")).toBe("spring");
    expect(presetIdOf("cubic-bezier(0.1,0.2,0.3,0.4)")).toBe("custom");
    expect(presetIdOf("cubic-bezier(2,0,1,1)")).toBe("linear"); // ascissa fuori [0,1]: non valida
    expect(presetIdOf("boh")).toBe("linear");
  });

  it("easingToBezier: le curve con nome sono le Bézier CSS", () => {
    expect(easingToBezier("easeInOut")).toEqual([0.42, 0, 0.58, 1]);
    expect(easingToBezier("linear")).toEqual([0, 0, 1, 1]);
    expect(easingToBezier("cubic-bezier(0.1,0.2,0.3,0.4)")).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("formatBezier produce sempre una specifica valida per SetClip e limita i punti", () => {
    for (const b of [[0.25, 0.1, 0.25, 1], [-3, 9, 5, -9], [0, 0, 1, 1], [0.123456, 0.5, 0.5, 1.5]] as const) {
      expect(isValidEasing(formatBezier([...b]))).toBe(true);
    }
    expect(clampBezier([-3, 9, 5, -9])).toEqual([0, 2, 1, -1]);
    expect(formatBezier([0.123456, 0.5, 0.5, 1.5])).toBe("cubic-bezier(0.123,0.5,0.5,1.5)");
  });

  it("toPx / fromPx sono l'uno l'inverso dell'altro", () => {
    for (const [x, y] of [[0, 0], [1, 1], [0.3, 0.7], [0.5, -0.4]]) {
      const p = toPx(BOX, x, y);
      const q = fromPx(BOX, p.x, p.y);
      expect(q.x).toBeCloseTo(x);
      expect(q.y).toBeCloseTo(y);
    }
    // y verso il basso: 1 sta più in alto di 0
    expect(toPx(BOX, 0, 1).y).toBeLessThan(toPx(BOX, 0, 0).y);
  });

  it("curvePath parte da (0,0) e arriva a (1,1)", () => {
    const d = curvePath("easeInOut", BOX);
    const a = toPx(BOX, 0, 0), b = toPx(BOX, 1, 1);
    expect(d.startsWith(`M${a.x.toFixed(1)} ${a.y.toFixed(1)}`)).toBe(true);
    expect(d.endsWith(`L${b.x.toFixed(1)} ${b.y.toFixed(1)}`)).toBe(true);
  });

  it("dragControl porta il punto dove si trascina (anche partendo da una curva con nome)", () => {
    const target = toPx(BOX, 0.8, 1.4);
    const spec = dragControl("easeIn", 1, BOX, target.x, target.y);
    expect(spec).toBe("cubic-bezier(0.42,0,0.8,1.4)"); // il primo punto resta quello di easeIn
    const first = toPx(BOX, 0.1, 0.9);
    expect(dragControl(spec, 0, BOX, first.x, first.y)).toBe("cubic-bezier(0.1,0.9,0.8,1.4)");
  });

  it("dragControl limita: ascisse in [0,1]", () => {
    const outside = toPx(BOX, 3, 0.5);
    expect(dragControl("linear", 0, BOX, outside.x, outside.y)).toBe("cubic-bezier(1,0.5,1,1)");
  });

  it("nudgeControl: frecce", () => {
    expect(nudgeControl("linear", 1, 0.1, -0.2)).toBe("cubic-bezier(0,0,1,0.8)"); // l'ascissa 1.1 si limita a 1
  });

  it("il menu offre tutte le curve con nome valide", () => {
    expect(EASING_PRESETS.every((p) => isValidEasing(p.id))).toBe(true);
  });
});
