import { describe, it, expect } from "vitest";
import { parseColor } from "./color";

const c255 = (c: ReturnType<typeof parseColor>) => c && [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255), Math.round(c.a * 1000) / 1000];

describe("parseColor", () => {
  it("esadecimale a 3, 4, 6 e 8 cifre", () => {
    expect(c255(parseColor("#f00"))).toEqual([255, 0, 0, 1]);
    expect(c255(parseColor("#F00A"))).toEqual([255, 0, 0, 0.667]);
    expect(c255(parseColor("#1b1340"))).toEqual([27, 19, 64, 1]);
    expect(c255(parseColor("#00ff0080"))).toEqual([0, 255, 0, 0.502]);
    expect(parseColor("#12")).toBeNull();
    expect(parseColor("#ggg")).toBeNull();
    expect(parseColor("#12345")).toBeNull();
  });

  it("rgb()/rgba() with commas, spaces, percentages and alpha", () => {
    expect(c255(parseColor("rgb(10, 20, 30)"))).toEqual([10, 20, 30, 1]);
    expect(c255(parseColor("rgba(10,20,30,.5)"))).toEqual([10, 20, 30, 0.5]);
    expect(c255(parseColor("rgb(10 20 30 / 50%)"))).toEqual([10, 20, 30, 0.5]);
    expect(c255(parseColor("rgb(100%, 0%, 50%)"))).toEqual([255, 0, 128, 1]);
    expect(c255(parseColor("rgb(300, -5, 0)"))).toEqual([255, 0, 0, 1]); // clamp
    expect(parseColor("rgb(1,2)")).toBeNull();
    expect(parseColor("rgb(a,b,c)")).toBeNull();
  });

  it("hsl()/hsla()", () => {
    expect(c255(parseColor("hsl(0, 100%, 50%)"))).toEqual([255, 0, 0, 1]);
    expect(c255(parseColor("hsl(120 100% 25%)"))).toEqual([0, 128, 0, 1]);
    expect(c255(parseColor("hsla(240, 100%, 50%, 0.25)"))).toEqual([0, 0, 255, 0.25]);
    expect(c255(parseColor("hsl(-120, 100%, 50%)"))).toEqual([0, 0, 255, 1]); // angoli negativi
    expect(c255(parseColor("hsl(0, 0%, 50%)"))).toEqual([128, 128, 128, 1]);
  });

  it("CSS names (any case) and transparent", () => {
    expect(c255(parseColor("red"))).toEqual([255, 0, 0, 1]);
    expect(c255(parseColor("  CornflowerBlue "))).toEqual([100, 149, 237, 1]);
    expect(c255(parseColor("rebeccapurple"))).toEqual([102, 51, 153, 1]);
    expect(c255(parseColor("transparent"))).toEqual([0, 0, 0, 0]);
    expect(parseColor("notacolor")).toBeNull();
    expect(parseColor("")).toBeNull();
    expect(parseColor("none")).toBeNull();
    expect(parseColor("currentColor")).toBeNull();
    expect(parseColor("url(#a)")).toBeNull();
  });
});
