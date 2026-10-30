import { describe, it, expect } from "vitest";
import { exportRegion } from "@/export/region";
import { nodesToSvg } from "@/export/svg";
import { emptyScene } from "@/store/types";
import type { MeasureText } from "@/renderer/text";
import type { NodeLite, SceneState } from "@/store/types";

const measure: MeasureText = (s) => s.length * 10;

function node(over: Partial<NodeLite> & { id: string }): NodeLite {
  return {
    parentId: "page1", orderKey: "a1", name: over.id, visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    ...over,
  };
}
function sceneWith(...nodes: NodeLite[]): SceneState {
  const s = emptyScene("doc", "Untitled");
  for (const n of nodes) s.nodes = s.nodes.set(n.id, n);
  return s;
}

// outer (100,100 200x200, clips) > inner (20,20 100x100, clips) > leaf (child space)
const outer = node({ id: "outer", kind: "frame", x: 100, y: 100, width: 200, height: 200, clipsContent: true });
const inner = (over: Partial<NodeLite> = {}) =>
  node({ id: "inner", kind: "frame", parentId: "outer", x: 20, y: 20, width: 100, height: 100, clipsContent: true, ...over });

describe("nested frames in export", () => {
  it("children leave in world space, carrying every clipping frame", () => {
    const s = sceneWith(outer, inner(), node({ id: "leaf", parentId: "inner", x: 10, y: 10, width: 20, height: 20 }));
    const r = exportRegion(s, [], "page", measure)!;
    const leaf = r.nodes.find((n) => n.id === "leaf")!;
    expect([leaf.x, leaf.y]).toEqual([130, 130]);
    expect(leaf.exportClips).toEqual([
      { x: 100, y: 100, width: 200, height: 200, rotation: 0 },
      { x: 120, y: 120, width: 100, height: 100, rotation: 0 },
    ]);
  });

  it("a child fully outside its clipping frame is dropped and does not widen the bounds", () => {
    const s = sceneWith(outer, node({ id: "gone", parentId: "outer", x: 500, y: 500 }));
    const r = exportRegion(s, [], "page", measure)!;
    expect(r.nodes.map((n) => n.id)).toEqual(["outer"]);
    expect(r.bounds).toEqual({ x: 100, y: 100, width: 200, height: 200 });
  });

  it("a child partly outside is cut in the bounds", () => {
    const s = sceneWith(outer, node({ id: "edge", parentId: "outer", x: 190, y: 190, width: 50, height: 50 }));
    const r = exportRegion(s, [], "page", measure)!;
    expect(r.bounds).toEqual({ x: 100, y: 100, width: 200, height: 200 });
  });

  it("a selected child is lifted: positioned in the world, not cut by the frames around it", () => {
    const s = sceneWith(outer, inner(), node({ id: "leaf", parentId: "inner", x: 200, y: 0, width: 20, height: 20 }));
    const r = exportRegion(s, ["leaf"], "selection", measure)!;
    expect(r.nodes.map((n) => n.id)).toEqual(["leaf"]);
    expect(r.nodes[0].exportClips).toBeUndefined();
    expect(r.bounds).toEqual({ x: 320, y: 120, width: 20, height: 20 });
  });

  it("a rotated frame turns its children around the frame's centre", () => {
    const s = sceneWith(
      node({ id: "f", kind: "frame", x: 0, y: 0, width: 100, height: 100, rotation: 90, clipsContent: true }),
      node({ id: "c", parentId: "f", x: 0, y: 0, width: 20, height: 20 }),
    );
    const c = exportRegion(s, [], "page", measure)!.nodes.find((n) => n.id === "c")!;
    expect(c.rotation).toBeCloseTo(90);
    expect(c.x + 10).toBeCloseTo(90);
    expect(c.y + 10).toBeCloseTo(10);
  });

  it("a frame that does not clip adds no clip", () => {
    const s = sceneWith(node({ id: "f", kind: "frame", x: 5, y: 5, width: 50, height: 50 }), node({ id: "c", parentId: "f", x: 100, y: 100 }));
    const c = exportRegion(s, [], "page", measure)!.nodes.find((n) => n.id === "c")!;
    expect(c.exportClips).toBeUndefined();
    expect([c.x, c.y]).toEqual([105, 105]);
  });

  it("SVG nests one clipPath per frame and reuses identical ones", () => {
    const s = sceneWith(outer, inner(),
      node({ id: "l1", parentId: "inner", x: 0, y: 0 }),
      node({ id: "l2", parentId: "inner", x: 5, y: 5, orderKey: "a2" }));
    const r = exportRegion(s, [], "page", measure)!;
    const svg = nodesToSvg(r.nodes, r.bounds, measure);
    expect(svg.match(/<clipPath id="f\d+"/g)?.length).toBe(2);
    expect(svg).toMatch(/<g clip-path="url\(#f0\)"><g clip-path="url\(#f1\)"><rect/);
  });
});
