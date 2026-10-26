import { describe, it, expect, vi } from "vitest";
import { angularStart, colorAtStops, gradientBitmap, gradientDrawable, gradientPosition } from "@/renderer/gradientBitmap";
import { paintStyle } from "@/renderer/canvasRenderer";
import { nodesToSvg } from "@/export/svg";
import type { FillLite, GradientLite, NodeLite } from "@/store/types";

const red = { r: 1, g: 0, b: 0, a: 1 };
const blue = { r: 0, g: 0, b: 1, a: 1 };
const g = (kind: GradientLite["kind"], over: Partial<GradientLite> = {}): GradientLite => ({
  kind, stops: [{ color: red, position: 0 }, { color: blue, position: 1 }], x1: 0.5, y1: 0.5, x2: 1, y2: 0.5, ...over,
});

describe("gradientPosition", () => {
  it("angular: 0 toward the second point, growing clockwise (y down)", () => {
    const a = g("angular");
    expect(gradientPosition(a, 150, 50, 100, 100)).toBeCloseTo(0, 5); // right of the center
    expect(gradientPosition(a, 50, 100, 100, 100)).toBeCloseTo(0.25, 5); // below: a quarter turn clockwise
    expect(gradientPosition(a, 0, 50, 100, 100)).toBeCloseTo(0.5, 5); // left
    expect(gradientPosition(a, 50, 0, 100, 100)).toBeCloseTo(0.75, 5); // above
  });

  it("angular: the start follows the second point", () => {
    const a = g("angular", { x2: 0.5, y2: 1 }); // 0% points down
    expect(angularStart(a, 100, 100)).toBeCloseTo(Math.PI / 2, 5);
    expect(gradientPosition(a, 50, 100, 100, 100)).toBeCloseTo(0, 5);
    expect(gradientPosition(a, 0, 50, 100, 100)).toBeCloseTo(0.25, 5);
  });

  it("diamond: constant |dx|+|dy| bands, 1 where it equals the p1-p2 distance", () => {
    const d = g("diamond");
    expect(gradientPosition(d, 50, 50, 100, 100)).toBe(0);
    expect(gradientPosition(d, 100, 50, 100, 100)).toBeCloseTo(1, 5);
    expect(gradientPosition(d, 75, 75, 100, 100)).toBeCloseTo(1, 5); // same band as the right-hand point
    expect(gradientPosition(d, 25, 50, 100, 100)).toBeCloseTo(0.5, 5);
  });
});

describe("gradientBitmap", () => {
  it("samples the stops: diamond center is the first color, beyond the diamond the last", () => {
    const px = gradientBitmap(g("diamond"), 100, 100, 8, 0);
    const at = (i: number, j: number) => Array.from(px.slice((j * 8 + i) * 4, (j * 8 + i) * 4 + 4));
    expect(at(0, 0)).toEqual([0, 0, 255, 255]); // a corner is outside the diamond
    expect(at(3, 3)[0]).toBeGreaterThan(150); // next to the center: mostly red
  });

  it("padding repeats the edge", () => {
    const px = gradientBitmap(g("diamond"), 100, 100, 4, 1);
    expect(Array.from(px.slice(0, 4))).toEqual(Array.from(px.slice((1 * 6 + 1) * 4, (1 * 6 + 1) * 4 + 4)));
  });

  it("colorAtStops interpolates and extends the ends", () => {
    const stops = g("angular").stops;
    expect(colorAtStops(stops, -1)).toEqual(red);
    expect(colorAtStops(stops, 2)).toEqual(blue);
    expect(colorAtStops(stops, 0.5)).toEqual({ r: 0.5, g: 0, b: 0.5, a: 1 });
  });

  it("gradientDrawable rejects a null axis and a single stop", () => {
    expect(gradientDrawable(g("angular"), 10, 10)).toBe(true);
    expect(gradientDrawable(g("angular", { x2: 0.5 }), 10, 10)).toBe(false);
    expect(gradientDrawable(g("diamond", { stops: [{ color: red, position: 0 }] }), 10, 10)).toBe(false);
  });
});

const node = { x: 100, y: 50, width: 200, height: 100 } as NodeLite;
const fill = (gr: GradientLite): FillLite => ({ ...red, gradient: gr });

describe("paintStyle: angular and diamond", () => {
  it("angular uses createConicGradient with the start angle and the center", () => {
    const stops: [number, string][] = [];
    const conic = { addColorStop: (o: number, c: string) => stops.push([o, c]) };
    const ctx = { createConicGradient: vi.fn(() => conic) } as unknown as CanvasRenderingContext2D;
    expect(paintStyle(ctx, fill(g("angular")), node)).toBe(conic);
    expect((ctx as unknown as { createConicGradient: ReturnType<typeof vi.fn> }).createConicGradient).toHaveBeenCalledWith(0, 200, 100);
    expect(stops).toHaveLength(2);
  });

  it("angular without createConicGradient falls back to the flat color", () => {
    expect(paintStyle({} as CanvasRenderingContext2D, fill(g("angular")), node)).toBe("rgba(255, 0, 0, 1)");
  });

  it("diamond without a canvas environment falls back to the flat color", () => {
    expect(paintStyle({} as CanvasRenderingContext2D, fill(g("diamond")), node)).toBe("rgba(255, 0, 0, 1)");
  });
});

describe("SVG export: angular and diamond", () => {
  const n = (gr: GradientLite) => ({
    id: "a", parentId: "p", orderKey: "a0", name: "a", visible: true, opacity: 1, x: 0, y: 0, width: 100, height: 100, rotation: 0,
    fills: [fill(gr)], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
  }) as NodeLite;
  const measure = (s: string) => s.length * 10;
  it.each(["angular", "diamond"] as const)("%s goes out as an embedded bitmap pattern", (kind) => {
    const svg = nodesToSvg([n(g(kind))], { x: 0, y: 0, width: 100, height: 100 }, measure);
    expect(svg).toContain("<pattern");
    expect(svg).toContain("data:image/png;base64,");
    expect(svg).toContain('fill="url(#p0)"');
  });
});
