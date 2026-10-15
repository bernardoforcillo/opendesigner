import { describe, expect, it } from "vitest";
import { cmykString, cmykToRgb, rgbToCmyk } from "./cmyk";

describe("cmyk", () => {
  it("converts the primaries and the extremes", () => {
    expect(rgbToCmyk({ r: 1, g: 0, b: 0 })).toEqual({ c: 0, m: 100, y: 100, k: 0 });
    expect(rgbToCmyk({ r: 0, g: 0, b: 0 })).toEqual({ c: 0, m: 0, y: 0, k: 100 });
    expect(rgbToCmyk({ r: 1, g: 1, b: 1 })).toEqual({ c: 0, m: 0, y: 0, k: 0 });
    expect(rgbToCmyk({ r: 0.5, g: 0.5, b: 0.5 })).toEqual({ c: 0, m: 0, y: 0, k: 50 });
    expect(cmykToRgb({ c: 0, m: 0, y: 0, k: 100 })).toEqual({ r: 0, g: 0, b: 0 });
    expect(cmykToRgb({ c: 100, m: 0, y: 0, k: 0 })).toEqual({ r: 0, g: 1, b: 1 });
  });

  it("round-trips a color to the rounding of one decimal", () => {
    for (const rgb of [{ r: 0.2, g: 0.4, b: 0.8 }, { r: 0.9, g: 0.1, b: 0.3 }, { r: 0.33, g: 0.66, b: 0.99 }]) {
      const back = cmykToRgb(rgbToCmyk(rgb));
      expect(back.r).toBeCloseTo(rgb.r, 2);
      expect(back.g).toBeCloseTo(rgb.g, 2);
      expect(back.b).toBeCloseTo(rgb.b, 2);
    }
  });

  it("clamps what is out of range and formats", () => {
    expect(cmykToRgb({ c: 200, m: -5, y: 0, k: 0 })).toEqual({ r: 0, g: 1, b: 1 });
    expect(cmykString({ c: 10, m: 20, y: 0, k: 5 })).toBe("cmyk(10% 20% 0% 5%)");
  });
});
