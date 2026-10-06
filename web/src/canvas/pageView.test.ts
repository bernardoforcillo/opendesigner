import { describe, expect, it } from "vitest";
import { PageCameras, fitPage } from "./pageView";
import { nodesOf } from "../store/nodeMap";
import { emptyScene } from "../store/types";
import type { NodeLite } from "../store/types";

const rect = (id: string, parentId: string, x: number, y: number, w: number, h: number): NodeLite => ({
  id, parentId, orderKey: id, name: id, visible: true, opacity: 1, x, y, width: w, height: h, rotation: 0,
  fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
});
const scene = () => ({ ...emptyScene("d", "t"), pages: [{ id: "p1", name: "1" }, { id: "p2", name: "2" }], nodes: nodesOf({ a: rect("a", "p2", 1000, 500, 400, 200) }) });

describe("page cameras", () => {
  it("frames a page's own content and not another page's", () => {
    const cam = fitPage(scene(), "p2", 800, 600)!;
    // The content's center lands at the box's center.
    expect(cam.x + 1200 * cam.zoom).toBeCloseTo(400);
    expect(cam.y + 600 * cam.zoom).toBeCloseTo(300);
    expect(fitPage(scene(), "p1", 800, 600)).toBeNull();
  });

  it("remembers the camera a page was left with, and falls back for an empty one", () => {
    const pc = new PageCameras();
    const fallback = { x: 1, y: 2, zoom: 3 };
    expect(pc.restore(scene(), "p1", 800, 600, fallback)).toEqual(fallback);
    pc.save("p1", { x: 10, y: 20, zoom: 0.5 });
    expect(pc.restore(scene(), "p1", 800, 600, fallback)).toEqual({ x: 10, y: 20, zoom: 0.5 });
    expect(pc.restore(scene(), "p2", 800, 600, fallback).zoom).toBeLessThanOrEqual(1);
  });
});
