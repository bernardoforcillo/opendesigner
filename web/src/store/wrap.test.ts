import { describe, it, expect } from "vitest";
import { layoutRich, type MeasureFor } from "@/renderer/text";
import { deriveWrap, wrapOps, wrapRectsOf } from "@/store/wrap";
import { resolveScene } from "@/store/variables";
import { applyOp } from "@/store/applyOp";
import { emptyScene, type NodeLite, type SceneState, type TextStyleLite } from "@/store/types";

const mf: MeasureFor = (st) => (s) => s.length * (st.fontSize || 16) * 0.5;
const base: TextStyleLite = { fontFamily: "", fontSize: 10, fontWeight: "", lineHeight: 1, align: "left" };
const para = () => ({ style: base, spaceBefore: 0, spaceAfter: 0, indentFirst: 0, indentLeft: 0 });
const words = "aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll mmm nnn ooo ppp";

describe("layout around exclusions", () => {
  const lay = (ex: { x: number; y: number; width: number; height: number }[], width = 100) =>
    layoutRich(mf, words, base, { paragraphs: [para()], runs: [], exclusions: ex }, width);
  const text = (l: ReturnType<typeof lay>) => l.lines.map((x) => x.frags.map((f) => f.text).join(""));

  it("keeps the text on the wider side of an object", () => {
    // A box on the right half of the first two lines (y 0..20): they have 50 units on the left.
    const l = lay([{ x: 50, y: 0, width: 50, height: 20 }]);
    expect(l.lines[0].left).toBe(0);
    expect(text(l)[0]).toBe("aaa bbb"); // 7 chars = 35 <= 50
    expect(l.lines[2].left).toBe(0);
    expect(l.lines[2].width).toBeGreaterThan(50); // below the object the full width is back
  });
  it("puts the text on the right when that is the wider side", () => {
    const l = lay([{ x: 0, y: 0, width: 30, height: 10 }]);
    expect(l.lines[0].left).toBe(30);
    expect(l.lines[1].left).toBe(0);
  });
  it("jumps over an object that leaves no room", () => {
    const l = lay([{ x: -5, y: 0, width: 110, height: 25 }]);
    // Bands at y 0, 10, 20 touch the box (until 25): three empty lines, then the text starts.
    expect(l.lines.slice(0, 3).every((x) => x.frags.length === 0)).toBe(true);
    expect(text(l)[3]).toMatch(/^aaa/);
    expect(l.lines[3].top).toBe(30);
  });
  it("is the plain layout when nothing is in the way", () => {
    const plain = layoutRich(mf, words, base, { paragraphs: [para()], runs: [] }, 100);
    const far = lay([{ x: 0, y: 500, width: 100, height: 10 }]);
    expect(text(far)).toEqual(plain.lines.map((x) => x.frags.map((f) => f.text).join("")));
  });
});

const node = (over: Partial<NodeLite> & { id: string }): NodeLite => ({
  parentId: "page1", orderKey: "a0", name: over.id, visible: true, opacity: 1, x: 0, y: 0, width: 50, height: 50, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false, ...over,
});
function scene(): SceneState {
  let s = emptyScene("d", "d");
  for (const n of [
    node({ id: "t", kind: "text", x: 10, y: 20, width: 200, height: 100, orderKey: "a1", text: { content: "some text to wrap", style: base } }),
    node({ id: "pic", x: 150, y: 40, width: 60, height: 30, orderKey: "a2", meta: { "wrap.mode": "box", "wrap.offset": "4" } }),
    node({ id: "under", x: 0, y: 0, width: 300, height: 300, orderKey: "a0", meta: { "wrap.mode": "box" } }),
  ]) s = { ...s, nodes: s.nodes.set(n.id, n) };
  return s;
}

describe("wrap rects and derivation", () => {
  it("takes the objects above the text, relative to its corner, with their offset", () => {
    expect(wrapRectsOf(scene(), scene().nodes.get("t")!)).toEqual([{ x: 136, y: 16, width: 68, height: 38 }]);
  });
  it("ignores hidden objects and rotated frames", () => {
    const s = scene();
    const hidden = { ...s, nodes: s.nodes.set("pic", { ...s.nodes.get("pic")!, visible: false }) };
    expect(wrapRectsOf(hidden, hidden.nodes.get("t")!)).toEqual([]);
    expect(wrapRectsOf(s, { ...s.nodes.get("t")!, rotation: 10 })).toEqual([]);
  });
  it("gives the frame a rich layout carrying the exclusions, and leaves the document alone", () => {
    const s = scene();
    const out = deriveWrap(s);
    expect(out.nodes.get("t")!.text!.rich!.exclusions).toHaveLength(1);
    expect(s.nodes.get("t")!.text!.rich).toBeUndefined();
    expect(resolveScene(s).nodes.get("t")!.text!.rich!.exclusions).toHaveLength(1);
  });
  it("returns the scene itself when nothing wraps", () => {
    const s = emptyScene("d", "d");
    expect(deriveWrap(s)).toBe(s);
  });
  it("sets and clears the wrap with ops", () => {
    const s = scene();
    let next = s;
    for (const op of wrapOps(s, ["t"], "box", 10)) next = applyOp(next, op);
    expect(next.nodes.get("t")!.meta).toEqual({ "wrap.mode": "box", "wrap.offset": "10" });
    for (const op of wrapOps(next, ["t"], "")) next = applyOp(next, op);
    expect(next.nodes.get("t")!.meta).toBeUndefined();
  });
});
