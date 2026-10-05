import { describe, it, expect } from "vitest";
import type { Bounds } from "../canvas/geometry";
import { SnapIndex, prepareSnapTargets, snapBounds, snapLines, snapMoving } from "./snap";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Targets with many exact coincidences (values on a grid): that is where
// the tie-break rules and the deduplication of positions matter.
function targets(r: () => number, n: number, grid: number): Bounds[] {
  return Array.from({ length: n }, () => ({
    x: Math.round(r() * 40) * grid, y: Math.round(r() * 40) * grid,
    width: Math.round(1 + r() * 8) * grid, height: Math.round(1 + r() * 8) * grid,
  }));
}

describe("SnapIndex: same result as the linear scan", () => {
  it.each([1, 2, 3, 4, 5, 6])("seed %i: identical snap and guides over hundreds of requests", (seed) => {
    const r = rng(seed);
    // grid = 0.5 produces exact floating-point values; 0.1 produces
    // rounding errors, which is where a naive window would get it wrong.
    for (const grid of [0.5, 0.1, 7]) {
      const ts = targets(r, 80, grid);
      const index = prepareSnapTargets(ts);
      for (let i = 0; i < 120; i++) {
        const box: Bounds = {
          x: r() * 40 * grid, y: r() * 40 * grid, width: 1 + r() * 8 * grid, height: 1 + r() * 8 * grid,
        };
        // Half of the time the box sits EXACTLY on a line, for the ties.
        if (i % 2 === 0) {
          const t = ts[Math.floor(r() * ts.length)];
          box.x = t.x + (r() < 0.5 ? 0 : t.width) - (r() < 0.5 ? 0 : box.width);
          box.y = t.y + t.height / 2 - box.height / 2;
        }
        const threshold = [0, 0.3, 1, 6, 25][i % 5];
        const slow = snapBounds(box, ts, threshold);
        const fast = snapBounds(box, index, threshold);
        expect(fast).toEqual(slow);
      }
    }
  });

  it("partial moving lines (the resize): only the edges that move snap", () => {
    const r = rng(11);
    const ts = targets(r, 60, 0.25);
    const index = new SnapIndex(ts);
    for (let i = 0; i < 100; i++) {
      const box: Bounds = { x: r() * 10, y: r() * 10, width: 3, height: 2 };
      const moving = { x: [snapLines(box, "x")[2]], y: [] as number[] };
      expect(snapMoving(box, moving, index, 1)).toEqual(snapMoving(box, moving, ts, 1));
    }
  });

  it("an empty set of targets does not snap", () => {
    const index = prepareSnapTargets([]);
    expect(snapBounds({ x: 0, y: 0, width: 5, height: 5 }, index, 10)).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("negative or NaN threshold: no snap, as before", () => {
    const ts = [{ x: 0, y: 0, width: 10, height: 10 }];
    const index = prepareSnapTargets(ts);
    const box = { x: 0, y: 0, width: 10, height: 10 };
    expect(snapBounds(box, index, -1)).toEqual(snapBounds(box, ts, -1));
    expect(snapBounds(box, index, NaN)).toEqual(snapBounds(box, ts, NaN));
  });

  it("with 20,000 targets a request costs fractions of a millisecond", () => {
    const r = rng(3);
    const ts = targets(r, 20000, 1.3);
    const index = prepareSnapTargets(ts);
    const box = { x: 50, y: 50, width: 30, height: 20 };
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) snapBounds({ ...box, x: box.x + i * 0.37 }, index, 6);
    const perCall = (performance.now() - t0) / 200;
    expect(perCall).toBeLessThan(1.5); // the linear scan cost ~5 ms
  });
});
