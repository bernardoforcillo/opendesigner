import { describe, expect, it } from "vitest";
import { joinNodesOps, offsetOps, pathToolOps, setPathOps } from "./editOps";
import { nodesOf } from "../store/nodeMap";
import { emptyScene } from "../store/types";
import type { AnchorLite, NodeLite, SubPathLite } from "../store/types";

const pt = (x: number, y: number): AnchorLite => ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0 });
const vec = (id: string, x: number, y: number, ...sps: SubPathLite[]): NodeLite => ({
  id, parentId: "page1", orderKey: `a${id}`, name: id, visible: true, opacity: 1, x, y, width: 10, height: 10, rotation: 0,
  fills: [], strokes: [], kind: "vector", cornerRadius: 0, clipsContent: false, vector: { subpaths: sps },
});
const open = (...p: [number, number][]): SubPathLite => ({ anchors: p.map(([x, y]) => pt(x, y)), closed: false });
const sq = (s: number): SubPathLite => ({ anchors: [pt(0, 0), pt(s, 0), pt(s, s), pt(0, s)], closed: true });

describe("setPathOps", () => {
  it("replaces the path and refits the box, in one pair of ops", () => {
    const n = vec("v", 100, 50, open([0, 0], [10, 10]));
    const ops = setPathOps(n, [open([5, 5], [25, 15])]);
    expect(ops.map((o) => o.kind.case)).toEqual(["setVectorPath", "setProps"]);
    const props = ops[1].kind.value as { patch: { x: number; y: number; width: number; height: number } };
    expect(props.patch).toMatchObject({ x: 105, y: 55, width: 20, height: 10 });
  });
});

describe("pathToolOps / offsetOps", () => {
  it("does nothing for a rotated node, a non-vector, or an edit that changes nothing", () => {
    expect(pathToolOps({ ...vec("v", 0, 0, sq(10)), rotation: 30 }, "smooth")).toEqual([]);
    expect(pathToolOps(vec("v", 0, 0, sq(10)), "corner")).toEqual([]);
    expect(offsetOps({ ...vec("v", 0, 0, sq(10)), kind: "rect" }, 5)).toEqual([]);
  });

  it("simplifies, and offsets a closed shape while leaving the open path alone", () => {
    const n = vec("v", 0, 0, open([0, 0], [5, 0], [10, 0], [10, 10]));
    expect(pathToolOps(n, "simplify", 0.5)).toHaveLength(2);
    const both = vec("v", 0, 0, sq(10), open([20, 0], [30, 0]));
    const ops = offsetOps(both, 2);
    expect(ops).toHaveLength(2);
    const sps = (ops[0].kind.value as { subpaths: unknown[] }).subpaths;
    expect(sps.length).toBeGreaterThanOrEqual(2);
  });
});

describe("joinNodesOps", () => {
  it("merges two open paths into the first node and deletes the second", () => {
    const scene = { ...emptyScene("d", "t"), nodes: nodesOf({ a: vec("a", 0, 0, open([0, 0], [10, 0])), b: vec("b", 10, 0, open([0, 0], [0, 10])) }) };
    const r = joinNodesOps(scene, "a", "b")!;
    expect(r.selection).toEqual(["a"]);
    expect(r.ops.map((o) => o.kind.case)).toEqual(["setVectorPath", "setProps", "deleteNode"]);
    const sps = (r.ops[0].kind.value as { subpaths: { anchors: unknown[] }[] }).subpaths;
    expect(sps).toHaveLength(1);
    expect(sps[0].anchors).toHaveLength(3);
  });

  it("refuses closed paths and nodes in different parents", () => {
    const scene = { ...emptyScene("d", "t"), nodes: nodesOf({ a: vec("a", 0, 0, sq(10)), b: vec("b", 0, 0, open([0, 0], [1, 1])), c: { ...vec("c", 0, 0, open([0, 0], [1, 1])), parentId: "other" } }) };
    expect(joinNodesOps(scene, "a", "b")).toBeNull();
    expect(joinNodesOps(scene, "b", "c")).toBeNull();
  });
});
