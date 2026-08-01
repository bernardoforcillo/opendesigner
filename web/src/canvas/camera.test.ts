import { describe, it, expect } from "vitest";
import { screenToWorld, worldToScreen, zoomAt, panBy, MIN_ZOOM, MAX_ZOOM } from "./camera";

const cam = { x: 100, y: 50, zoom: 2 };

describe("camera", () => {
  it("round-trips screen <-> world", () => {
    const w = screenToWorld(cam, 300, 250);
    expect(w).toEqual({ x: 100, y: 100 });
    expect(worldToScreen(cam, w.x, w.y)).toEqual({ x: 300, y: 250 });
  });

  it("zoomAt keeps the point under the cursor fixed", () => {
    const sx = 300, sy = 250;
    const before = screenToWorld(cam, sx, sy);
    const next = zoomAt(cam, 1.25, sx, sy);
    const after = screenToWorld(next, sx, sy);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(next.zoom).toBeCloseTo(2.5, 6);
  });

  it("clamps zoom to the allowed range", () => {
    expect(zoomAt(cam, 1e6, 0, 0).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(cam, 1e-6, 0, 0).zoom).toBe(MIN_ZOOM);
  });

  it("clamping still keeps the cursor anchored", () => {
    const sx = 10, sy = 20;
    const before = screenToWorld(cam, sx, sy);
    const after = screenToWorld(zoomAt(cam, 1e6, sx, sy), sx, sy);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("pans in screen pixels regardless of zoom", () => {
    expect(panBy(cam, 10, -5)).toEqual({ x: 110, y: 45, zoom: 2 });
  });
});
