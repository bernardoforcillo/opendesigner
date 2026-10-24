import { describe, it, expect } from "vitest";
import { placeTextLines, type MeasureFor } from "../renderer/text";
import { deriveTextPaths, pathTargetOf, textOnPathOps } from "./textPath";
import { applyOp } from "./applyOp";
import { emptyScene, type NodeLite, type SceneState, type TextStyleLite } from "./types";

const mf: MeasureFor = (st) => (s) => s.length * (st.fontSize || 16) * 0.5;
const style: TextStyleLite = { fontFamily: "", fontSize: 10, fontWeight: "", lineHeight: 1, align: "left" };
const node = (over: Partial<NodeLite> & { id: string }): NodeLite => ({
  parentId: "page1", orderKey: "a0", name: over.id, visible: true, opacity: 1, x: 0, y: 0, width: 50, height: 50, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
});
const anchor = (x: number, y: number) => ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0 });

function scene(over: Partial<NodeLite> = {}): SceneState {
  let s = emptyScene("d", "d");
  const vec = node({ id: "v", kind: "vector", x: 100, y: 200, width: 200, height: 0, vector: { subpaths: [{ closed: false, anchors: [anchor(0, 0), anchor(200, 0)] }] } });
  const txt = node({ id: "t", kind: "text", x: 5, y: 5, width: 40, height: 12, rotation: 30, orderKey: "a1", meta: { "text.path": "v" }, text: { content: "abc def", style }, ...over });
  for (const n of [vec, txt]) s = { ...s, nodes: s.nodes.set(n.id, n) };
  return s;
}

describe("text on a path", () => {
  it("derives the polyline in the text's parent space and a box around it", () => {
    const s = scene();
    const t = deriveTextPaths(s).nodes.get("t")!;
    expect(t.text!.onPath).toEqual([{ x: 100, y: 200 }, { x: 300, y: 200 }]);
    expect(t).toMatchObject({ x: 90, y: 190, width: 220, height: 20, rotation: 0 });
    expect(s.nodes.get("t")!.text!.onPath).toBeUndefined();
  });
  it("sets the glyphs one after another along a horizontal path, with no turn", () => {
    const t = deriveTextPaths(scene()).nodes.get("t")!;
    const [line] = placeTextLines((s) => s.length * 5, t, mf);
    const segs = line.segments!;
    expect(segs.map((g) => g.text).join("")).toBe("abcdef"); // the space advances but is not a piece
    expect(segs[0]).toMatchObject({ x: 100, y: 200, angle: 0 });
    expect(segs[1].x).toBeCloseTo(105);
    expect(segs[3].x).toBeCloseTo(120); // after "abc " = 4 glyphs
  });
  it("follows a slope and turns the glyphs", () => {
    let s = scene();
    s = { ...s, nodes: s.nodes.set("v", { ...s.nodes.get("v")!, vector: { subpaths: [{ closed: false, anchors: [anchor(0, 0), anchor(0, 200)] }] } }) };
    const [line] = placeTextLines((x) => x.length * 5, deriveTextPaths(s).nodes.get("t")!, mf);
    expect(line.segments![0].angle).toBeCloseTo(Math.PI / 2);
    expect(line.segments![1].y).toBeCloseTo(205);
  });
  it("centres the text on the path and cuts what runs past its end", () => {
    const centred = deriveTextPaths(scene({ text: { content: "ab", style: { ...style, align: "center" } } })).nodes.get("t")!;
    expect(placeTextLines((x) => x.length * 5, centred, mf)[0].segments![0].x).toBeCloseTo(100 + (200 - 10) / 2);
    const long = deriveTextPaths(scene({ text: { content: "x".repeat(100), style } })).nodes.get("t")!;
    expect(placeTextLines((x) => x.length * 5, long, mf)[0].segments!.length).toBe(40);
  });
  it("ignores a dangling link", () => {
    const s = scene({ meta: { "text.path": "gone" } });
    expect(pathTargetOf(s, s.nodes.get("t")!)).toBeNull();
    expect(deriveTextPaths(s)).toBe(s);
  });
  it("links and unlinks with ops", () => {
    const s = scene({ meta: undefined });
    let next = s;
    for (const op of textOnPathOps(s, "t", "v")) next = applyOp(next, op);
    expect(next.nodes.get("t")!.meta).toEqual({ "text.path": "v" });
    for (const op of textOnPathOps(next, "t", "")) next = applyOp(next, op);
    expect(next.nodes.get("t")!.meta).toBeUndefined();
    expect(textOnPathOps(s, "t", "t")).toEqual([]);
  });
});
