import { describe, it, expect, vi } from "vitest";
import { paintStyle } from "./canvasRenderer";
import type { FillLite, NodeLite } from "../store/types";

const node = { x: 100, y: 50, width: 200, height: 100 } as NodeLite;
const grad = (kind: "linear" | "radial", over: Partial<NonNullable<FillLite["gradient"]>> = {}): FillLite => ({
  r: 1, g: 0, b: 0, a: 1,
  gradient: {
    kind,
    stops: [
      { color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 },
      { color: { r: 0, g: 0, b: 1, a: 1 }, position: 1 },
    ],
    x1: 0, y1: 0, x2: 1, y2: 0, ...over,
  },
});

function ctxMock() {
  const stops: [number, string][] = [];
  const g = { addColorStop: (o: number, c: string) => stops.push([o, c]) };
  const ctx = {
    createLinearGradient: vi.fn(() => g),
    createRadialGradient: vi.fn(() => g),
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, raw: ctx, stops, g };
}

describe("paintStyle", () => {
  it("a solid stays a CSS string", () => {
    const { ctx } = ctxMock();
    expect(paintStyle(ctx, { r: 1, g: 0, b: 0, a: 1 }, node)).toBe("rgba(255, 0, 0, 1)");
  });

  it("linear: denormalizes the axis on the node's box", () => {
    const { ctx, raw, stops, g } = ctxMock();
    expect(paintStyle(ctx, grad("linear"), node)).toBe(g);
    expect(raw.createLinearGradient).toHaveBeenCalledWith(100, 50, 300, 50);
    expect(stops).toEqual([[0, "rgba(255, 0, 0, 1)"], [1, "rgba(0, 0, 255, 1)"]]);
  });

  it("radial: center at (x1,y1), radius = distance between the two points", () => {
    const { ctx, raw } = ctxMock();
    paintStyle(ctx, grad("radial", { x1: 0.5, y1: 0.5, x2: 1, y2: 0.5 }), node);
    expect(raw.createRadialGradient).toHaveBeenCalledWith(200, 100, 0, 200, 100, 100);
  });

  it("a degenerate gradient falls back to the flat color", () => {
    const { ctx } = ctxMock();
    expect(paintStyle(ctx, grad("linear", { x2: 0, y2: 0 }), node)).toBe("rgba(255, 0, 0, 1)");
    const one = grad("linear");
    one.gradient!.stops = one.gradient!.stops.slice(0, 1);
    expect(paintStyle(ctx, one, node)).toBe("rgba(255, 0, 0, 1)");
  });
});
