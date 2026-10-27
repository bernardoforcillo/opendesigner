import { describe, it, expect } from "vitest";
import { DEVICES, deviceById, deviceGeometry } from "@/flow/devices";

const screen = { left: 100, top: 80, width: 360, height: 640 };

describe("deviceById", () => {
  it("knows the five devices and falls back to the generic frame", () => {
    expect(DEVICES.map((d) => d.id)).toEqual(["generic", "phone", "tablet", "desktop", "none"]);
    expect(deviceById("tablet").label).toBe("Tablet");
    expect(deviceById("toaster").id).toBe("generic");
    expect(deviceById(null).id).toBe("generic");
  });
});

describe("deviceGeometry", () => {
  it("the generic frame is the 8px bezel the player always had", () => {
    const g = deviceGeometry(deviceById("generic"), screen);
    expect(g.body).toEqual({ left: 92, top: 72, width: 376, height: 656, radius: 22 });
    expect(g.screenRadius).toBe(14);
    expect(g.parts).toEqual([]);
  });

  it("a phone has an island and a home bar INSIDE the screen, centred, and a rounder body", () => {
    const g = deviceGeometry(deviceById("phone"), screen);
    expect(g.body).toMatchObject({ left: 88, top: 68, width: 384, height: 664, radius: 46 });
    const island = g.parts.find((p) => p.kind === "island")!;
    expect(island.left + island.width / 2).toBe(screen.left + screen.width / 2);
    expect(island.top).toBeGreaterThanOrEqual(screen.top);
    expect(island.width).toBe(108); // 30% of the width
    const bar = g.parts.find((p) => p.kind === "homebar")!;
    expect(bar.top + bar.height).toBeLessThanOrEqual(screen.top + screen.height);
  });

  it("the island is clamped on very small and very large screens", () => {
    expect(deviceGeometry(deviceById("phone"), { ...screen, width: 100 }).parts.find((p) => p.kind === "island")!.width).toBe(60);
    expect(deviceGeometry(deviceById("phone"), { ...screen, width: 900 }).parts.find((p) => p.kind === "island")!.width).toBe(120);
  });

  it("a tablet has its camera in the top bezel", () => {
    const g = deviceGeometry(deviceById("tablet"), screen);
    expect(g.body).toMatchObject({ left: 80, top: 60, width: 400, height: 680 });
    const cam = g.parts.find((p) => p.kind === "camera")!;
    expect(cam.top).toBeLessThan(screen.top);
    expect(cam.top + cam.height).toBeGreaterThan(g.body!.top);
  });

  it("a desktop is a browser window: a title bar above the screen with three buttons and an address bar", () => {
    const g = deviceGeometry(deviceById("desktop"), screen);
    expect(g.body).toMatchObject({ left: 100, top: 44, width: 360, height: 676, radius: 10 });
    expect(g.screenRadius).toBe(0);
    expect(g.parts.filter((p) => p.kind === "dot").map((p) => p.index)).toEqual([0, 1, 2]);
    const bar = g.parts.find((p) => p.kind === "titlebar")!;
    expect(bar).toMatchObject({ left: 100, top: 44, width: 360, height: 36 });
    const addr = g.parts.find((p) => p.kind === "address")!;
    expect(addr.left + addr.width / 2).toBe(screen.left + screen.width / 2);
  });

  it("a narrow desktop screen drops the address bar instead of squeezing it", () => {
    expect(deviceGeometry(deviceById("desktop"), { ...screen, width: 200 }).parts.some((p) => p.kind === "address")).toBe(false);
  });

  it("no frame draws nothing and does not round the screen", () => {
    expect(deviceGeometry(deviceById("none"), screen)).toEqual({ body: null, screenRadius: 0, parts: [] });
  });
});
