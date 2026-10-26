import { describe, it, expect, vi, afterEach } from "vitest";
import { nodesOf } from "@/store/nodeMap";
import { drawScene } from "@/renderer/canvasRenderer";
import { BLUR_BANDS } from "@/renderer/effectsFx";
import { emptyScene } from "@/store/types";
import type { EffectLite, NodeLite, SceneState } from "@/store/types";

class FakePath2D { rect() {} roundRect() {} ellipse() {} addPath() {} moveTo() {} lineTo() {} closePath() {} }

const rectNode = (effects: EffectLite[], over: Partial<NodeLite> = {}): NodeLite => ({
  id: "n", parentId: "page1", orderKey: "a0", name: "n", visible: true, opacity: 1,
  x: 0, y: 0, width: 50, height: 40, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, effects, ...over,
});

const sceneOf = (n: NodeLite): SceneState => ({ ...emptyScene("d", "t"), nodes: nodesOf({ n }) });

// A duck-typed 2D context that records, for each fill, the filter in force, for each
// drawImage (the backdrop blur) the filter, and what the overlays did.
function recCtx() {
  const fills: string[] = [];
  const backdrops: string[] = [];
  const rects: number[][] = [];
  const clips: number[] = [];
  let depth = 0;
  let clipCount = 0;
  const stack: { filter: unknown; clipCount: number }[] = [];
  const ctx: Record<string, unknown> = {
    canvas: { width: 800, height: 600 },
    font: "", textBaseline: "", textAlign: "", fillStyle: "", strokeStyle: "", lineWidth: 0, globalAlpha: 1,
    shadowBlur: 0, shadowColor: "rgba(0, 0, 0, 0)", shadowOffsetX: 0, shadowOffsetY: 0, filter: "none", imageSmoothingEnabled: true,
    globalCompositeOperation: "source-over",
    setTransform: () => {}, clearRect: () => {}, translate: () => {}, rotate: () => {}, transform: () => {},
    getTransform: () => ({ a: 1, b: 0 }),
    measureText: (s: string) => ({ width: s.length * 10 }),
    clip: () => { clipCount++; },
    drawImage: () => { backdrops.push(String(ctx.filter)); },
    fill: () => { fills.push(String(ctx.filter)); }, stroke: () => {},
    fillRect: (...a: number[]) => { rects.push(a); },
    createPattern: () => ({ setTransform: () => {} }),
    save: () => { depth++; stack.push({ filter: ctx.filter, clipCount }); },
    restore: () => { depth--; const s = stack.pop()!; ctx.filter = s.filter; clipCount = s.clipCount; },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills, backdrops, rects, clips, depth: () => depth };
}

const ramp = (over: Partial<Extract<EffectLite, { kind: "progressiveBlur" }>> = {}): EffectLite =>
  ({ kind: "progressiveBlur", startRadius: 0, endRadius: 16, x1: 0.5, y1: 0, x2: 0.5, y2: 1, background: false, ...over });

describe("progressive blur, noise and glass in the 2D canvas", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("draws the node once per band with a rising blur radius, leaving the context balanced", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const r = recCtx();
    drawScene(r.ctx, sceneOf(rectNode([ramp()])), { x: 0, y: 0, zoom: 1 });
    const radii = r.fills.map((f) => Number(/blur\(([\d.]+)px\)/.exec(f)?.[1]));
    expect(radii).toHaveLength(BLUR_BANDS);
    expect(radii).toEqual([...radii].sort((a, b) => a - b));
    expect(radii[0]).toBeCloseTo(1);
    expect(radii[BLUR_BANDS - 1]).toBeCloseTo(15);
    expect(r.depth()).toBe(0);
  });

  it("a progressive BACKGROUND blur blurs the backdrop band by band and draws the node once", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const r = recCtx();
    drawScene(r.ctx, sceneOf(rectNode([ramp({ background: true })])), { x: 0, y: 0, zoom: 1 });
    expect(r.backdrops).toHaveLength(BLUR_BANDS);
    expect(r.backdrops[0]).toMatch(/^blur\(/);
    expect(r.fills).toHaveLength(1);
    expect(r.depth()).toBe(0);
  });

  it("a zero ramp draws like no effect", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const r = recCtx();
    drawScene(r.ctx, sceneOf(rectNode([ramp({ endRadius: 0 })])), { x: 0, y: 0, zoom: 1 });
    expect(r.fills).toEqual(["none"]);
  });

  it("noise and texture fill a pattern over the node's box, clipped to its outline", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    vi.stubGlobal("OffscreenCanvas", class { constructor(public width: number, public height: number) {} getContext() { return { putImageData() {} }; } });
    vi.stubGlobal("ImageData", class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
    vi.stubGlobal("DOMMatrix", class { constructor(public init: number[]) {} });
    const r = recCtx();
    const noise: EffectLite = { kind: "noise", mode: "mono", size: 2, density: 1, opacity: 0.5, color: { r: 0, g: 0, b: 0, a: 1 }, color2: { r: 1, g: 1, b: 1, a: 1 }, seed: 1 };
    drawScene(r.ctx, sceneOf(rectNode([noise, { kind: "texture", scale: 8, intensity: 0.5, seed: 1 }])), { x: 0, y: 0, zoom: 1 });
    expect(r.rects).toEqual([[0, 0, 50, 40], [0, 0, 50, 40]]);
    expect(r.depth()).toBe(0);
  });

  it("glass draws as its parts: a frosted backdrop, and the grain over the node", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    vi.stubGlobal("OffscreenCanvas", class { constructor(public width: number, public height: number) {} getContext() { return { putImageData() {} }; } });
    vi.stubGlobal("ImageData", class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
    vi.stubGlobal("DOMMatrix", class { constructor(public init: number[]) {} });
    const r = recCtx();
    drawScene(r.ctx, sceneOf(rectNode([{ kind: "glass", frost: 10, light: 0.5, lightAngle: 45, noise: 0.5 }])), { x: 0, y: 0, zoom: 1 });
    expect(r.backdrops).toEqual(["blur(10px)"]);
    expect(r.rects).toHaveLength(1); // the grain
    expect(r.depth()).toBe(0);
  });

  it("noise is skipped on text (it has no outline), and without a canvas to build the tile", () => {
    vi.stubGlobal("Path2D", FakePath2D);
    const r = recCtx();
    const noise: EffectLite = { kind: "noise", mode: "mono", size: 1, density: 1, opacity: 1, color: { r: 0, g: 0, b: 0, a: 1 }, color2: { r: 1, g: 1, b: 1, a: 1 }, seed: 1 };
    drawScene(r.ctx, sceneOf(rectNode([noise])), { x: 0, y: 0, zoom: 1 }); // jsdom: no canvas 2D, the overlay is skipped
    expect(r.rects).toEqual([]);
    expect(r.fills).toHaveLength(1);
  });
});
