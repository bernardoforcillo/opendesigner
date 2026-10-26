import { describe, it, expect } from "vitest";
import { layoutRich, paragraphDecorations, cssVariationSettings, type MeasureFor } from "@/renderer/text";
import { nodesToSvg } from "@/export/svg";
import { setThreadMeasure } from "@/store/threads";
import { resolveScene } from "@/store/variables";
import { emptyScene, type NodeLite, type ResolvedParagraph, type SceneState, type TextLite, type TextStyleLite } from "@/store/types";

// 5 units per character at size 10.
const mf: MeasureFor = (st) => (s) => s.length * (st.fontSize || 10) * 0.5;
const base: TextStyleLite = { fontFamily: "", fontSize: 10, fontWeight: "", lineHeight: 1, align: "left" };
const para = (over: Partial<ResolvedParagraph> = {}): ResolvedParagraph => ({ style: base, spaceBefore: 0, spaceAfter: 0, indentFirst: 0, indentLeft: 0, ...over });
const rich = (content: string, paragraphs: ResolvedParagraph[]): TextLite => ({ content, style: base, rich: { paragraphs, runs: [] } });
const node = (text: TextLite, over: Partial<NodeLite> = {}): NodeLite => ({
  id: "t", parentId: "page1", orderKey: "a0", name: "t", visible: true, opacity: 1, x: 100, y: 200, width: 100, height: 100, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false, text, ...over,
});
const BLACK = { r: 0, g: 0, b: 0, a: 1 };

describe("shading, border and rules", () => {
  it("a shaded paragraph with an offset gets a box around its lines", () => {
    const l = layoutRich(mf, "aaaa", base, { paragraphs: [para({ shading: { r: 1, g: 1, b: 0, a: 1 }, shadingOffset: 3 })], runs: [] }, 100);
    expect(l.decorations).toEqual([{ kind: "shade", x: -3, y: -3, width: 106, height: 16, color: { r: 1, g: 1, b: 0, a: 1 } }]);
  });
  it("a border is a box with a weight; rules sit above and below, indented and offset", () => {
    const l = layoutRich(mf, "aaaa", base, {
      paragraphs: [para({ borderColor: BLACK, borderWeight: 2, ruleAbove: { weight: 1, offset: 4, indentLeft: 5 }, ruleBelow: { weight: 2, color: { r: 1, g: 0, b: 0, a: 1 }, columnWidth: true, indentRight: 10 } })], runs: [],
    }, 100);
    const d = l.decorations!;
    expect(d.find((x) => x.kind === "border")).toMatchObject({ x: 0, y: 0, width: 100, height: 10, weight: 2 });
    expect(d.filter((x) => x.kind === "rule")).toEqual([
      { kind: "rule", x: 5, y: -5, width: 95, height: 1, color: BLACK },
      { kind: "rule", x: 0, y: 10, width: 90, height: 2, color: { r: 1, g: 0, b: 0, a: 1 } },
    ]);
  });
  it("lays them out in world coordinates, behind a text that has none otherwise", () => {
    const n = node(rich("aaaa", [para({ shading: { r: 1, g: 1, b: 0, a: 1 } })]));
    expect(paragraphDecorations(mf, n)).toEqual([{ kind: "shade", x: 100, y: 200, width: 100, height: 10, color: { r: 1, g: 1, b: 0, a: 1 } }]);
    expect(paragraphDecorations(mf, node(rich("aaaa", [para()])))).toEqual([]);
    expect(paragraphDecorations(mf, node({ content: "aaaa", style: base }))).toEqual([]);
  });
  it("the SVG draws them before the text", () => {
    const n = node(rich("aaaa", [para({ shading: { r: 1, g: 1, b: 0, a: 0.5 }, borderColor: BLACK, borderWeight: 1 })]));
    const svg = nodesToSvg([n], { x: 0, y: 0, width: 400, height: 400 }, (s, st) => s.length * (st.fontSize || 10) * 0.5);
    expect(svg).toMatch(/<rect x="100" y="200" width="100" height="10" fill="rgb\(255,255,0\)" fill-opacity="0.5"\/><rect[^>]*stroke="rgb\(0,0,0\)"[^>]*stroke-width="1"\/><text/);
  });
});

describe("optical margin alignment", () => {
  it("hangs an opening quote outside the left margin and a period outside the right one", () => {
    const l = layoutRich(mf, "“ab", base, { paragraphs: [para({ opticalMargin: true })], runs: [] }, 100);
    expect(l.lines[0]!.left).toBe(-4); // 0.8 of the 5-unit quote
    const r = layoutRich(mf, "ab.", base, { paragraphs: [para({ opticalMargin: true, style: { ...base, align: "right" } })], runs: [] }, 100);
    expect(r.lines[0]!.left).toBe(100 - 15 + 5);
  });
  it("is off by default and leaves centred text alone", () => {
    expect(layoutRich(mf, "“ab", base, { paragraphs: [para()], runs: [] }, 100).lines[0]!.left).toBe(0);
    const c = layoutRich(mf, "“ab.", base, { paragraphs: [para({ opticalMargin: true, style: { ...base, align: "center" } })], runs: [] }, 100);
    expect(c.lines[0]!.left).toBe((100 - 20) / 2);
  });
});

describe("variable font axes", () => {
  it("become the CSS value, dropping malformed items", () => {
    expect(cssVariationSettings("wght 650, wdth 90, nope")).toBe('"wght" 650, "wdth" 90');
  });
  it("go to the SVG", () => {
    const n = node({ content: "hi", style: { ...base, fontVariations: "wght 650" } });
    const svg = nodesToSvg([n], { x: 0, y: 0, width: 400, height: 400 }, (s) => s.length * 5);
    expect(svg).toContain('font-variation-settings:&quot;wght&quot; 650');
  });
});

describe("keeps in a threaded story", () => {
  function chain(paragraphs: string[], styles: string[], defs: SceneState["textStyles"], height = 30): SceneState {
    setThreadMeasure((st) => (s) => s.length * (st.fontSize || 10) * 0.5);
    const s = emptyScene("d", "D");
    s.textStyles = defs;
    // Frame A holds 3 lines of 10 units; frame B is tall.
    const a: NodeLite = node({ content: paragraphs.join("\n"), style: base, paragraphStyles: styles }, { id: "A", width: 20, height, x: 0, y: 0, meta: { "text.next": "B" } });
    const b: NodeLite = node({ content: "", style: base }, { id: "B", width: 20, height: 200, x: 100, y: 0 });
    s.nodes = s.nodes.set("A", a).set("B", b);
    return s;
  }
  const def = (id: string, over: Partial<SceneState["textStyles"][string]> = {}) => ({ id, name: id, style: { ...base }, ...over });

  it("an orphan rule pushes a paragraph that would leave one line at the bottom", () => {
    // width 20 = 4 chars/line. P0 = 1 line, P1 = "aaaabbbbcccc" 3 lines. 3 lines fit: P0 + 2 lines of P1.
    const s = chain(["xx", "aaaabbbbcccc"], ["p0", "p1"], { p0: def("p0"), p1: def("p1", { keepFirstLines: 3 }) });
    const out = resolveScene(s);
    expect(out.nodes.get("A")!.text!.content).toBe("xx");
    expect(out.nodes.get("B")!.text!.content).toBe("aaaabbbbcccc");
  });
  it("without the rule the paragraph splits where the frame ends", () => {
    const s = chain(["xx", "aaaabbbbcccc"], ["p0", "p1"], { p0: def("p0"), p1: def("p1") });
    const out = resolveScene(s);
    expect(out.nodes.get("A")!.text!.content).toBe("xx\naaaabbbb");
  });
  it("keep with next carries a heading over with its paragraph", () => {
    const s = chain(["xx", "hh", "aaaabbbb"], ["p0", "h", "p0"], { p0: def("p0"), h: def("h", { keepWithNext: true }) }, 20);
    const out = resolveScene(s);
    expect(out.nodes.get("A")!.text!.content).toBe("xx");
    expect(out.nodes.get("B")!.text!.content).toBe("hh\naaaabbbb");
  });
});
