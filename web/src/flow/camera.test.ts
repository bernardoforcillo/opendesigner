import { describe, it, expect } from "vitest";
import { cameraToFit, isFullyVisible } from "./camera";

describe("cameraToFit", () => {
  it("centers the rectangle in the view", () => {
    const cam = cameraToFit({ x: 100, y: 200, width: 200, height: 100 }, 1000, 800, 80, 1);
    // the rectangle's center (200, 250) ends up at the center of the view (500, 400)
    expect(200 * cam.zoom + cam.x).toBeCloseTo(500);
    expect(250 * cam.zoom + cam.y).toBeCloseTo(400);
  });

  it("does not zoom in beyond maxZoom: a small screen does not fill the screen", () => {
    expect(cameraToFit({ x: 0, y: 0, width: 50, height: 50 }, 1000, 800).zoom).toBe(1);
  });

  it("zooms out to fit a large rectangle, margin included", () => {
    const cam = cameraToFit({ x: 0, y: 0, width: 4000, height: 1000 }, 1000, 800, 100);
    expect(cam.zoom).toBeCloseTo(800 / 4000);
    expect(isFullyVisible({ x: 0, y: 0, width: 4000, height: 1000 }, cam, 1000, 800, 0)).toBe(true);
  });

  it("degenerate rectangle: no NaN", () => {
    const cam = cameraToFit({ x: 5, y: 5, width: 0, height: 0 }, 400, 300);
    expect(Number.isFinite(cam.zoom) && Number.isFinite(cam.x) && Number.isFinite(cam.y)).toBe(true);
  });
});

describe("isFullyVisible", () => {
  const cam = { x: 0, y: 0, zoom: 1 };
  it("inside the view with the margin: yes; sticking out: no", () => {
    expect(isFullyVisible({ x: 100, y: 100, width: 200, height: 200 }, cam, 800, 600)).toBe(true);
    expect(isFullyVisible({ x: 700, y: 100, width: 200, height: 200 }, cam, 800, 600)).toBe(false);
    expect(isFullyVisible({ x: 10, y: 100, width: 100, height: 100 }, cam, 800, 600)).toBe(false); // inside the 24 margin
  });

  it("takes zoom and pan into account", () => {
    expect(isFullyVisible({ x: 1000, y: 1000, width: 100, height: 100 }, { x: -900, y: -900, zoom: 1 }, 800, 600)).toBe(true);
    expect(isFullyVisible({ x: 0, y: 0, width: 1000, height: 1000 }, { x: 0, y: 0, zoom: 1 }, 800, 600)).toBe(false);
  });
});
