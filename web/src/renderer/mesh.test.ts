import { describe, expect, it } from "vitest";
import { defaultMesh, meshBitmap, resizeMesh } from "./mesh";
import type { MeshLite } from "../store/types";

const red = { r: 1, g: 0, b: 0, a: 1 }, green = { r: 0, g: 1, b: 0, a: 1 }, blue = { r: 0, g: 0, b: 1, a: 1 }, white = { r: 1, g: 1, b: 1, a: 1 };
const four: MeshLite = { rows: 2, cols: 2, colors: [red, green, blue, white] };

const px = (data: Uint8ClampedArray, size: number, i: number, j: number) => Array.from(data.slice((j * size + i) * 4, (j * size + i) * 4 + 4));

describe("meshBitmap", () => {
  it("is each corner's color at that corner and a mix in the middle", () => {
    const S = 32, d = meshBitmap(four, S);
    expect(px(d, S, 0, 0)[0]).toBeGreaterThan(240);          // top-left is red
    expect(px(d, S, 0, 0)[1]).toBeLessThan(15);
    expect(px(d, S, S - 1, 0)[1]).toBeGreaterThan(240);      // top-right is green
    expect(px(d, S, 0, S - 1)[2]).toBeGreaterThan(240);      // bottom-left is blue
    const mid = px(d, S, S / 2, S / 2);
    expect(mid[0]).toBeGreaterThan(100);
    expect(mid[0]).toBeLessThan(160);
    expect(mid[3]).toBe(255);
  });

  it("fades a transparent corner out without turning it gray", () => {
    const m: MeshLite = { rows: 2, cols: 2, colors: [red, { ...red, a: 0 }, red, { ...red, a: 0 }] };
    const S = 16, d = meshBitmap(m, S);
    const right = px(d, S, S - 1, 4);
    expect(right[3]).toBeLessThan(40);
    const center = px(d, S, S / 2, 4);
    expect(center[0]).toBe(255);
    expect(center[1]).toBe(0);
  });

  it("works on a 3x3 grid, and every pixel is defined", () => {
    const d = meshBitmap(defaultMesh({ r: 0.4, g: 0.5, b: 0.9, a: 1 }), 8);
    expect(d).toHaveLength(8 * 8 * 4);
    expect(Array.from(d).every((v) => v >= 0 && v <= 255)).toBe(true);
  });
});

describe("defaultMesh / resizeMesh", () => {
  it("builds the grid it is asked for, lighter top-left than bottom-right", () => {
    const m = defaultMesh({ r: 0.5, g: 0.5, b: 0.5, a: 1 }, 3, 4);
    expect(m.colors).toHaveLength(12);
    expect(m.colors[0].r).toBeGreaterThan(m.colors[11].r);
  });

  it("keeps the corners when the grid grows or shrinks", () => {
    const g = resizeMesh(four, 3, 3);
    expect(g.colors).toHaveLength(9);
    expect(g.colors[0]).toEqual(red);
    expect(g.colors[2]).toEqual(green);
    expect(g.colors[6]).toEqual(blue);
    expect(g.colors[8]).toEqual(white);
    expect(g.colors[4].r).toBeCloseTo(0.5);
    expect(resizeMesh(g, 2, 2).colors[3]).toEqual(white);
  });
});
