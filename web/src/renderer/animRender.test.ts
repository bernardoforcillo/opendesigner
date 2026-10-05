import { describe, it, expect, beforeEach, vi } from "vitest";
import { drawScene } from "./canvasRenderer";
import { drawDash, perimeterOf, vectorDrawSubpaths } from "./animDraw";
import type { Camera } from "../canvas/camera";
import { baseScene, child } from "../flow/testSupport";
import { nodesWith } from "../store/nodeMap";
import { poseScene } from "../animation/pose";
import type { NodeLite, SceneState } from "../store/types";

// The renderer with a scene DERIVED from playback (animation/pose.ts): scale
// and the stroke being drawn (transient fields animScale/animDraw), and the off-view
// discarding that must not make a node vanish while its scale brings it into view.

class FakePath2D {
  ops: { op: string; args: unknown[] }[] = [];
  rect(...args: number[]) { this.ops.push({ op: "rect", args }); }
  roundRect(...args: unknown[]) { this.ops.push({ op: "roundRect", args }); }
  ellipse(...args: number[]) { this.ops.push({ op: "ellipse", args }); }
  addPath(p: unknown) { this.ops.push({ op: "addPath", args: [p] }); }
  moveTo(...args: number[]) { this.ops.push({ op: "moveTo", args }); }
  lineTo(...args: number[]) { this.ops.push({ op: "lineTo", args }); }
  bezierCurveTo(...args: number[]) { this.ops.push({ op: "bezierCurveTo", args }); }
  closePath() { this.ops.push({ op: "closePath", args: [] }); }
}

type Call = { op: string; args: unknown[] };
function recordingCtx() {
  const calls: Call[] = [];
  const rec = (op: string) => (...args: unknown[]) => { calls.push({ op, args }); };
  const fills: unknown[] = [];
  const strokes: { path: unknown; dash: number[] }[] = [];
  let dash: number[] = [];
  const ctx = {
    canvas: { width: 800, height: 600 },
    font: "", textBaseline: "", textAlign: "", fillStyle: "", globalAlpha: 1, strokeStyle: "", lineWidth: 0, lineCap: "", lineJoin: "",
    setTransform: () => {}, clearRect: () => {},
    save: rec("save"), restore: rec("restore"), translate: rec("translate"), rotate: rec("rotate"), scale: rec("scale"),
    transform: rec("transform"), clip: () => {},
    setLineDash: (d: number[]) => { dash = d; calls.push({ op: "setLineDash", args: [d] }); },
    fill: (p: unknown) => { fills.push(p); },
    stroke: (p: unknown) => { strokes.push({ path: p, dash }); },
    measureText: (s: string) => ({ width: s.length * 10 }),
    fillText: () => {}, strokeText: () => {}, fillRect: () => {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, fills, strokes };
}
const CAM = { x: 0, y: 0, zoom: 1 } as Camera;

function node(id: string, parentId: string, x: number, y: number, w: number, h: number, over: Partial<NodeLite> = {}): NodeLite {
  return { ...child(id, parentId, x, y), width: w, height: h, fills: [{ r: 1, g: 0, b: 0, a: 1 }], ...over };
}
function sceneWith(nodes: Record<string, NodeLite>): SceneState {
  return { ...baseScene(), nodes: nodesWith(baseScene().nodes.delete("A").delete("B").delete("C").delete("btn").delete("loose"), nodes) };
}

beforeEach(() => { vi.stubGlobal("Path2D", FakePath2D); });

describe("scala animata (animScale)", () => {
  it("a scaled node is drawn around its own center, in the same save/restore", () => {
    const s = sceneWith({ r: node("r", "page1", 10, 20, 100, 50) });
    const p = poseScene(s, new Map([["r", { scale: 2 }]]));
    const f = recordingCtx();
    drawScene(f.ctx, p, CAM);
    const ops = f.calls.map((c) => c.op);
    expect(ops.slice(0, 5)).toEqual(["save", "translate", "rotate", "scale", "translate"]);
    expect(f.calls[1].args).toEqual([60, 45]);
    expect(f.calls[3].args).toEqual([2, 2]);
    expect(f.calls[4].args).toEqual([-60, -45]);
    expect(f.fills).toHaveLength(1);
    // save e restore in pari
    expect(ops.filter((o) => o === "save").length).toBe(ops.filter((o) => o === "restore").length);
  });

  it("a still scene does NOT emit scale (no extra cost)", () => {
    const s = sceneWith({ r: node("r", "page1", 10, 20, 100, 50) });
    const f = recordingCtx();
    drawScene(f.ctx, s, CAM);
    expect(f.calls.some((c) => c.op === "scale")).toBe(false);
  });

  it("the children of a scaled frame descend with the scale in the matrix", () => {
    const s = sceneWith({
      fr: node("fr", "page1", 0, 0, 200, 100, { kind: "frame", fills: [] }),
      c: node("c", "fr", 10, 10, 20, 20),
    });
    const p = poseScene(s, new Map([["fr", { scale: 3 }]]));
    const f = recordingCtx();
    drawScene(f.ctx, p, CAM);
    const t = f.calls.find((c) => c.op === "transform")!.args as number[];
    // scale 3 around the center (100,50): a=d=3, e = 100-300 = -200, f = 50-150 = -100
    expect(t).toEqual([3, 0, 0, 3, -200, -100]);
  });
});

describe("off-view discarding with animated scales", () => {
  // The view is 800x600; the rectangle sits at x 900..1000: outside. Scale 12 around (950,25) -> covers the view.
  const outside = () => sceneWith({ r: node("r", "page1", 900, 0, 100, 50) });

  it("out of view and still: discarded", () => {
    const f = recordingCtx();
    drawScene(f.ctx, outside(), CAM);
    expect(f.fills).toHaveLength(0);
  });

  it("with the scale that brings it into view: drawn (no discarding for scaled nodes)", () => {
    const p = poseScene(outside(), new Map([["r", { scale: 12 }]]));
    const f = recordingCtx();
    drawScene(f.ctx, p, CAM);
    expect(f.fills).toHaveLength(1);
  });

  it("without the marker the same scene would be discarded (the bypass is the marker, nothing else)", () => {
    const p = poseScene(outside(), new Map([["r", { scale: 12 }]]));
    const f = recordingCtx();
    drawScene(f.ctx, { ...p, anim: undefined }, CAM);
    expect(f.fills).toHaveLength(0);
  });

  it("the descendants and ancestors of a scaled node are not discarded", () => {
    const s = sceneWith({
      fr: node("fr", "page1", 900, 0, 100, 100, { kind: "frame", fills: [], clipsContent: false }),
      c: node("c", "fr", 0, 0, 50, 50),
      far: node("far", "page1", 5000, 5000, 10, 10), // a distant, still sibling stays discarded
    });
    const p = poseScene(s, new Map([["fr", { scale: 12 }]]));
    const f = recordingCtx();
    drawScene(f.ctx, p, CAM);
    expect(f.fills).toHaveLength(1); // the child c: no fill for the frame (without fills) nor for `far`
  });

  it("the animated scale of a node inside a frame keeps the ancestor alive too", () => {
    const s = sceneWith({
      fr: node("fr", "page1", 900, 0, 100, 100, { kind: "frame", fills: [{ r: 0, g: 0, b: 1, a: 1 }], clipsContent: false }),
      c: node("c", "fr", 0, 0, 50, 50),
    });
    const p = poseScene(s, new Map([["c", { scale: 40 }]]));
    const f = recordingCtx();
    drawScene(f.ctx, p, CAM);
    // frame (ancestor, not scaled but with a scaled child) and child: both drawn
    expect(f.fills).toHaveLength(2);
  });
});

describe("the stroke being drawn (animDraw)", () => {
  it("rect with stroke: dashing = fraction of the perimeter, then restored", () => {
    const s = sceneWith({ r: node("r", "page1", 0, 0, 100, 50, { strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 2, align: "center" }] }) });
    const p = poseScene(s, new Map([["r", { draw: 0.25 }]]));
    const f = recordingCtx();
    drawScene(f.ctx, p, CAM);
    expect(f.strokes).toHaveLength(1);
    expect(f.strokes[0].dash).toEqual([300 * 0.25, 301]); // perimetro 2*(100+50)
    expect(f.calls.filter((c) => c.op === "setLineDash").map((c) => c.args[0])).toEqual([[75, 301], []]);
  });

  it("draw = 1 does not dash", () => {
    const s = sceneWith({ r: node("r", "page1", 0, 0, 100, 50, { strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 2, align: "center" }] }) });
    const p = poseScene(s, new Map([["r", { draw: 1 }]]));
    const f = recordingCtx();
    drawScene(f.ctx, p, CAM);
    expect(f.calls.some((c) => c.op === "setLineDash")).toBe(false);
  });

  const vec = (draw: number) => {
    const s = sceneWith({
      v: node("v", "page1", 0, 0, 100, 0, {
        kind: "vector",
        vector: { subpaths: [
          { closed: false, anchors: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 100, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }] },
          { closed: false, anchors: [{ x: 0, y: 10, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 50, y: 10, inX: 0, inY: 0, outX: 0, outY: 0 }] },
        ] },
      }),
    });
    return poseScene(s, new Map([["v", { draw }]]));
  };

  it("vector: each outline for the fraction of ITS OWN length, without fill", () => {
    const f = recordingCtx();
    drawScene(f.ctx, vec(0.5), CAM);
    expect(f.fills).toHaveLength(0);
    expect(f.strokes.map((s) => s.dash.map((n) => Math.round(n)))).toEqual([[50, 101], [25, 51]]);
    expect(f.calls.at(-1)).toBeDefined();
  });

  it("vector at draw = 1: the normal drawing (fill and stroke)", () => {
    const f = recordingCtx();
    drawScene(f.ctx, vec(1), CAM);
    expect(f.calls.some((c) => c.op === "setLineDash")).toBe(false);
  });

  it("measures: perimeters and lengths", () => {
    expect(perimeterOf({ kind: "rect", width: 100, height: 50, cornerRadius: 0 })).toBe(300);
    expect(perimeterOf({ kind: "frame", width: 100, height: 50, cornerRadius: 20 })).toBe(300); // the frame has sharp corners
    // a rounded rectangle is shorter than a sharp one: 300 - 8r + 2πr
    expect(perimeterOf({ kind: "rect", width: 100, height: 50, cornerRadius: 10 })).toBeCloseTo(300 - 80 + 20 * Math.PI, 6);
    // the radius does not exceed half the short side: a "pill"
    expect(perimeterOf({ kind: "rect", width: 100, height: 50, cornerRadius: 999 })).toBeCloseTo(300 - 8 * 25 + 50 * Math.PI, 6);
    // circle: 2πr
    expect(perimeterOf({ kind: "ellipse", width: 100, height: 100, cornerRadius: 0 })).toBeCloseTo(100 * Math.PI, 6);
    expect(drawDash(200, 0.5)).toEqual([100, 201]);
    expect(drawDash(200, 5)).toEqual([200, 201]); // limitato a 1
    expect(drawDash(200, -1)).toEqual([0, 201]);
    const lens = vectorDrawSubpaths(vec(0.5).nodes.at("v")).map((s) => Math.round(s.length));
    expect(lens).toEqual([100, 50]);
  });
});
