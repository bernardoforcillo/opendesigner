import { describe, it, expect } from "vitest";
import { cameraToFit, isFullyVisible } from "./camera";

describe("cameraToFit", () => {
  it("centra il rettangolo nella vista", () => {
    const cam = cameraToFit({ x: 100, y: 200, width: 200, height: 100 }, 1000, 800, 80, 1);
    // il centro del rettangolo (200, 250) finisce al centro della vista (500, 400)
    expect(200 * cam.zoom + cam.x).toBeCloseTo(500);
    expect(250 * cam.zoom + cam.y).toBeCloseTo(400);
  });

  it("non ingrandisce oltre maxZoom: una schermata piccola non riempie lo schermo", () => {
    expect(cameraToFit({ x: 0, y: 0, width: 50, height: 50 }, 1000, 800).zoom).toBe(1);
  });

  it("rimpicciolisce per far stare un rettangolo grande, margine compreso", () => {
    const cam = cameraToFit({ x: 0, y: 0, width: 4000, height: 1000 }, 1000, 800, 100);
    expect(cam.zoom).toBeCloseTo(800 / 4000);
    expect(isFullyVisible({ x: 0, y: 0, width: 4000, height: 1000 }, cam, 1000, 800, 0)).toBe(true);
  });

  it("rettangolo degenere: nessun NaN", () => {
    const cam = cameraToFit({ x: 5, y: 5, width: 0, height: 0 }, 400, 300);
    expect(Number.isFinite(cam.zoom) && Number.isFinite(cam.x) && Number.isFinite(cam.y)).toBe(true);
  });
});

describe("isFullyVisible", () => {
  const cam = { x: 0, y: 0, zoom: 1 };
  it("dentro la vista col margine: sì; sporgente: no", () => {
    expect(isFullyVisible({ x: 100, y: 100, width: 200, height: 200 }, cam, 800, 600)).toBe(true);
    expect(isFullyVisible({ x: 700, y: 100, width: 200, height: 200 }, cam, 800, 600)).toBe(false);
    expect(isFullyVisible({ x: 10, y: 100, width: 100, height: 100 }, cam, 800, 600)).toBe(false); // dentro il margine di 24
  });

  it("tiene conto di zoom e pan", () => {
    expect(isFullyVisible({ x: 1000, y: 1000, width: 100, height: 100 }, { x: -900, y: -900, zoom: 1 }, 800, 600)).toBe(true);
    expect(isFullyVisible({ x: 0, y: 0, width: 1000, height: 1000 }, { x: 0, y: 0, zoom: 1 }, 800, 600)).toBe(false);
  });
});
