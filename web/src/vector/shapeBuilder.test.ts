import { describe, it, expect } from "vitest";
import { nodesOf } from "../store/nodeMap";
import { applyOp } from "../store/applyOp";
import { emptyScene } from "../store/types";
import type { NodeLite, SceneState } from "../store/types";
import {
  builderFaces, builderSources, facesAlong, faceContains, polygonArea, shapeBuilderOps,
} from "./shapeBuilder";

const rect = (id: string, x: number, y: number, w: number, h: number, over: Partial<NodeLite> = {}): NodeLite => ({
  id, parentId: "page1", orderKey: `a${id}`, name: id, visible: true, opacity: 1, x, y, width: w, height: h, rotation: 0,
  fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
});
const sceneOf = (...ns: NodeLite[]): SceneState => ({ ...emptyScene("d", "t"), nodes: nodesOf(Object.fromEntries(ns.map((n) => [n.id, n]))) });
const areas = (s: SceneState, ids: string[]) => builderFaces(s, builderSources(s, ids)).map((f) => polygonArea(f.polygon)).sort((a, b) => a - b);

// Two 100 x 100 squares overlapping in a 50 x 50 square: three faces.
const two = () => sceneOf(rect("a", 0, 0, 100, 100), rect("b", 50, 50, 100, 100, { fills: [{ r: 0, g: 0, b: 1, a: 1 }], name: "blue" }));

describe("builderFaces", () => {
  it("two overlapping squares make three faces: two crescents and the overlap", () => {
    const s = two();
    const faces = builderFaces(s, builderSources(s, ["a", "b"]));
    expect(faces).toHaveLength(3);
    expect(areas(s, ["a", "b"])).toEqual([2500, 7500, 7500]);
    expect(faces.find((f) => f.members.length === 2)!.members).toEqual(["a", "b"]);
  });
  it("disjoint shapes stay one face each; a shape inside another leaves a ring and a core", () => {
    expect(areas(sceneOf(rect("a", 0, 0, 10, 10), rect("b", 50, 0, 10, 10)), ["a", "b"])).toEqual([100, 100]);
    const nested = sceneOf(rect("a", 0, 0, 100, 100), rect("b", 25, 25, 50, 50));
    const faces = builderFaces(nested, builderSources(nested, ["a", "b"]));
    expect(faces).toHaveLength(2);
    const ring = faces.find((f) => f.members.length === 1)!;
    expect(ring.polygon).toHaveLength(2); // outer + hole
    expect(polygonArea(ring.polygon)).toBe(7500);
  });
  it("a shape cut in two by another makes two faces", () => {
    const s = sceneOf(rect("a", 0, 0, 100, 20), rect("b", 40, -10, 20, 40));
    // a is cut into left and right by b: left 40x20, overlap 20x20, right 40x20, plus b's top and bottom nubs
    expect(builderFaces(s, builderSources(s, ["a", "b"]))).toHaveLength(5);
  });
  it("hidden shapes and shapes of another parent are not sources", () => {
    const s = sceneOf(rect("a", 0, 0, 10, 10), rect("b", 5, 5, 10, 10, { visible: false }), rect("f", 0, 0, 200, 200, { kind: "frame", fills: [] }), rect("c", 5, 5, 10, 10, { parentId: "f" }));
    expect(builderSources(s, ["a", "b"]).map((n) => n.id)).toEqual(["a"]);
    expect(builderSources(s, ["a", "c"])).toEqual([]);
  });
});

describe("hit-testing the faces", () => {
  const s = two();
  const faces = builderFaces(s, builderSources(s, ["a", "b"]));
  it("faceContains is false in a hole", () => {
    const nested = sceneOf(rect("a", 0, 0, 100, 100), rect("b", 25, 25, 50, 50));
    const f = builderFaces(nested, builderSources(nested, ["a", "b"])).find((q) => q.members.length === 1)!;
    expect(faceContains(f, 10, 10)).toBe(true);
    expect(faceContains(f, 50, 50)).toBe(false);
  });
  it("a drag collects every face it crosses, once", () => {
    const along = facesAlong(faces, [{ x: 10, y: 10 }, { x: 140, y: 140 }]);
    expect(along).toHaveLength(3);
    expect(facesAlong(faces, [{ x: 10, y: 10 }, { x: 20, y: 10 }])).toHaveLength(1);
    expect(facesAlong(faces, [{ x: 300, y: 300 }])).toEqual([]);
  });
});

describe("shapeBuilderOps", () => {
  const run = (s: SceneState, picked: number[], mode: "merge" | "remove") => {
    const sources = builderSources(s, ["a", "b"]);
    const faces = builderFaces(s, sources);
    const res = shapeBuilderOps(s, sources, faces, picked, mode)!;
    const out = res.ops.reduce(applyOp, s);
    return { res, out, faces };
  };
  const along = (s: SceneState) => {
    const faces = builderFaces(s, builderSources(s, ["a", "b"]));
    return facesAlong(faces, [{ x: 10, y: 10 }, { x: 140, y: 140 }]);
  };
  const vecArea = (n: NodeLite) => {
    let total = 0;
    n.vector!.subpaths.forEach((sp, i) => {
      let a = 0;
      for (let k = 0; k < sp.anchors.length; k++) { const p = sp.anchors[k], q = sp.anchors[(k + 1) % sp.anchors.length]; a += p.x * q.y - q.x * p.y; }
      total += (i === 0 ? 1 : -1) * Math.abs(a / 2);
    });
    return total;
  };

  it("merging every face along a drag rebuilds the union as ONE vector and removes the sources", () => {
    const s = two();
    const { res, out } = run(s, along(s), "merge");
    expect(res.selection).toHaveLength(1);
    expect(out.nodes.has("a")).toBe(false);
    expect(out.nodes.has("b")).toBe(false);
    const n = out.nodes.at(res.selection[0]);
    expect(n.kind).toBe("vector");
    expect(vecArea(n)).toBeCloseTo(17500, 3);
    // the style comes from the topmost shape under the merged faces (b, blue)
    expect(n.fills[0]).toMatchObject({ r: 0, b: 1 });
  });
  it("merging two faces leaves the third as a shape of its own", () => {
    const s = two();
    const faces = builderFaces(s, builderSources(s, ["a", "b"]));
    const overlap = faces.findIndex((f) => f.members.length === 2);
    const onlyA = faces.findIndex((f) => f.members.length === 1 && f.members[0] === "a");
    const { res, out } = run(s, [overlap, onlyA], "merge");
    expect(res.selection).toHaveLength(2);
    const areasOut = res.selection.map((id) => vecArea(out.nodes.at(id))).sort((x, y) => x - y);
    expect(areasOut[0]).toBeCloseTo(7500, 3); // b's crescent
    expect(areasOut[1]).toBeCloseTo(10000, 3); // all of a (its crescent + the overlap)
  });
  it("Alt removes the faces it crosses", () => {
    const s = two();
    const faces = builderFaces(s, builderSources(s, ["a", "b"]));
    const overlap = faces.findIndex((f) => f.members.length === 2);
    const { res, out } = run(s, [overlap], "remove");
    expect(res.selection).toHaveLength(2);
    const total = res.selection.reduce((t, id) => t + vecArea(out.nodes.at(id)), 0);
    expect(total).toBeCloseTo(15000, 3);
  });
  it("rotated sources are cut where they are drawn, and new vectors sit in the parent's space", () => {
    const s = sceneOf(rect("a", 0, 0, 100, 100, { rotation: 45, x: 100, y: 0 }), rect("b", 60, 20, 100, 60));
    const faces = builderFaces(s, builderSources(s, ["a", "b"]));
    expect(faces.length).toBeGreaterThanOrEqual(3);
    const res = shapeBuilderOps(s, builderSources(s, ["a", "b"]), faces, [0, 1], "merge")!;
    const out = res.ops.reduce(applyOp, s);
    const union = vecArea(out.nodes.at(res.selection[res.selection.length - 1]));
    expect(union).toBeGreaterThan(0);
  });
  it("returns null with nothing picked", () => {
    const s = two();
    const sources = builderSources(s, ["a", "b"]);
    expect(shapeBuilderOps(s, sources, builderFaces(s, sources), [], "merge")).toBeNull();
  });
});
