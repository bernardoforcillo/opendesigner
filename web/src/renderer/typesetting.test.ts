import { describe, it, expect } from "vitest";
import { layoutRich, placeTextLines, trackedMeasure, type MeasureFor } from "./text";
import { resolveRich } from "../store/richText";
import { emptyScene, type NodeLite, type ResolvedParagraph, type SceneState, type TextLite, type TextStyleDefLite, type TextStyleLite } from "../store/types";

// 5 units per character at size 10 (width scales with the font size).
const mf: MeasureFor = (st) => (s) => s.length * (st.fontSize || 16) * 0.5;
const base: TextStyleLite = { fontFamily: "", fontSize: 10, fontWeight: "", lineHeight: 1, align: "left" };
const para = (over: Partial<ResolvedParagraph> = {}): ResolvedParagraph => ({ style: base, spaceBefore: 0, spaceAfter: 0, indentFirst: 0, indentLeft: 0, ...over });
const textOf = (l: { frags: { text: string }[] }) => l.frags.map((f) => f.text).join("");
const lay = (content: string, p: Partial<ResolvedParagraph>, width = 100, runs: { start: number; end: number; style: TextStyleLite }[] = []) =>
  layoutRich(mf, content, base, { paragraphs: [para(p)], runs }, width);

function node(text: TextLite): NodeLite {
  return { id: "t", parentId: "page1", orderKey: "a0", name: "t", visible: true, opacity: 1, x: 100, y: 200, width: 100, height: 20, rotation: 0, fills: [], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false, text };
}
const place = (content: string, p: Partial<ResolvedParagraph>, width = 100) => placeTextLines((s) => s.length * 5, node({ content, style: base, rich: { paragraphs: [para(p)], runs: [] } }), mf).map((l) => ({ ...l, node: width }));

describe("small caps and super/subscript", () => {
  it("draws lowercase as smaller capitals and keeps the content offsets", () => {
    const l = lay("Ab cd", { style: { ...base, smallCaps: true } });
    const frags = l.lines[0].frags;
    expect(frags.map((f) => f.text).join("")).toBe("AB CD");
    const small = frags.find((f) => f.text.includes("B"))!;
    expect(small.style.fontSize).toBe(8);
    expect(frags[0].style.fontSize).toBe(10); // the capital A keeps its size
    expect(frags.every((f) => f.style.smallCaps === undefined)).toBe(true);
    expect(l.lines[0].end).toBe(5);
  });
  it("shrinks and shifts super and subscripts", () => {
    const sup = lay("x2", { style: base }, 100, [{ start: 1, end: 2, style: { ...base, fontSize: 0, script: "super" } }]).lines[0].frags[1];
    expect(sup.style.fontSize).toBeCloseTo(5.8);
    expect(sup.style.baselineShift).toBeCloseTo(3.6);
    const sub = lay("x2", { style: base }, 100, [{ start: 1, end: 2, style: { ...base, fontSize: 0, script: "sub" } }]).lines[0].frags[1];
    expect(sub.style.baselineShift).toBeCloseTo(-1.4);
  });
});

describe("horizontal scale", () => {
  it("widens the measure", () => {
    const m = trackedMeasure((s) => s.length * 5, { ...base, horizontalScale: 1.5 });
    expect(m("abcd")).toBe(30);
  });
});

describe("tabs", () => {
  it("moves to the next explicit stop, then to the default grid", () => {
    const l = lay("a\tb\tc", { tabs: [{ position: 50 }] }, 400);
    const f = l.lines[0].frags;
    expect(f.map((x) => x.text)).toEqual(["a", "\t", "b", "\t", "c"]);
    expect(f[1].w).toBe(45); // 5 (a) -> stop 50
    // After "b" the line is at 55: the next default stop is 72.
    expect(5 + 45 + 5 + f[3].w!).toBe(72);
  });
  it("right-aligns the text after a right tab and fills the gap with the leader", () => {
    const l = lay("ab\t12", { tabs: [{ position: 80, align: "right", leader: "." }] }, 400);
    const f = l.lines[0].frags;
    expect(f[1].w).toBe(80 - 10 - 10); // stop - "ab" - "12"
    const placed = place("ab\t12", { tabs: [{ position: 80, align: "right", leader: "." }] });
    const leader = placed[0].segments!.find((s) => /^\.+$/.test(s.text))!;
    expect(leader.text.length).toBe(12); // 60 / 5
  });
});

describe("justification", () => {
  it("widens the spaces of every line but the last", () => {
    const l = lay("aaa bbb ccc ddd eee", { style: { ...base, align: "justify" } }, 40);
    expect(l.lines.map(textOf)).toEqual(["aaa bbb", "ccc ddd", "eee"]);
    expect(l.lines[0].justify).toBeCloseTo(5); // 40 - 35 = 5 over one space
    expect(l.lines[0].width).toBe(40);
    expect(l.lines[2].justify).toBeUndefined();
  });
  it("places words and widened spaces as segments that fill the width", () => {
    const placed = place("aaa bbb ccc", { style: { ...base, align: "justify" } });
    const first = placed[0];
    const last = first.segments![first.segments!.length - 1];
    expect(first.segments!.map((s) => s.text).join("")).toBe(first.text);
    expect(last.x + last.width - first.x).toBeLessThanOrEqual(100.0001);
  });
});

describe("hyphenation", () => {
  it("breaks a long word with a hyphen that is not in the content", () => {
    const l = lay("computer", { hyphenate: true }, 30);
    const texts = l.lines.map(textOf);
    expect(texts.join("")).toContain("-");
    expect(texts[0].endsWith("-")).toBe(true);
    expect(texts.map((t) => t.replace(/-$/, "")).join("")).toBe("computer");
    // The line ends before the hyphen: the content offsets are not shifted.
    expect(l.lines[0].end).toBe(texts[0].length - 1);
    expect(l.lines[1].frags[0].at).toBe(l.lines[0].end);
  });
  it("does not hyphenate without the setting", () => {
    expect(lay("computer", {}, 30).lines.map(textOf).join("").includes("-")).toBe(false);
  });
  it("starts the word on this line when its first part fits", () => {
    const l = lay("aa computer", { hyphenate: true }, 40);
    expect(textOf(l.lines[0])).toMatch(/^aa com-?/);
  });
});

describe("lists and drop caps", () => {
  it("sets a marker in the indent and the text after the list indent", () => {
    const l = lay("one two three four", { marker: "•", listIndent: 20, indentLeft: 10 }, 70);
    expect(l.lines[0].marker).toMatchObject({ text: "•", x: 10 });
    expect(l.lines.every((x) => x.left === 30)).toBe(true);
    expect(l.lines.slice(1).every((x) => x.marker === undefined)).toBe(true);
    expect(l.lines.map(textOf).join(" ")).toBe("one two three four");
  });
  it("draws the marker even for an empty item", () => {
    const placed = place("", { marker: "1." }).length;
    const withText = place("x", { marker: "1.", listIndent: 18 })[0];
    expect(placed).toBe(0); // empty content paints nothing at all
    expect(withText.segments![0].text).toBe("1.");
  });
  it("makes room for a drop cap on its lines and lowers it to the last of them", () => {
    const l = lay("Once upon a time there was a story that kept on going for a good while longer than anyone had expected", { dropLines: 3, dropChars: 1 }, 100);
    const drop = l.lines[0].drop!;
    expect(drop.text).toBe("O");
    expect(drop.style.baselineShift).toBeCloseTo(-20); // two lines of 10 below the first baseline
    expect(drop.style.fontSize).toBeGreaterThan(10 * 2);
    expect(l.lines[0].left).toBeCloseTo(drop.width);
    expect(l.lines[2].left).toBeCloseTo(drop.width);
    expect(l.lines[3].left).toBe(0);
    expect(textOf(l.lines[0]).startsWith("nce")).toBe(true);
    expect(l.lines[0].frags[0].at).toBe(1);
  });
  it("keeps the room of a drop cap taller than a short paragraph", () => {
    expect(lay("Hi", { dropLines: 4 }, 100).height).toBe(40);
  });
});

describe("resolving lists, tabs and nested styles", () => {
  const def = (id: string, over: Partial<TextStyleDefLite> = {}): TextStyleDefLite => ({ id, name: id, style: { ...base, fontSize: 0, fontWeight: "", lineHeight: 0 }, ...over });
  const scene = (styles: TextStyleDefLite[]): SceneState => ({ ...emptyScene("d", "d"), textStyles: Object.fromEntries(styles.map((s) => [s.id, s])) });

  it("numbers consecutive paragraphs of a numbered style and restarts after another", () => {
    const s = scene([def("n", { listKind: "number", listMarker: "#)" }), def("b", { listKind: "bullet" }), def("plain")]);
    const r = resolveRich(s, { content: "a\nb\nc\nd\ne", style: base, paragraphStyles: ["n", "n", "plain", "n", "b"] }, base)!;
    expect(r.paragraphs.map((p) => p.marker)).toEqual(["1)", "2)", undefined, "1)", "•"]);
    expect(r.paragraphs[0].listIndent).toBe(18);
  });
  it("counts in roman or alphabetic styles", () => {
    const s = scene([def("n", { listKind: "number", listNumberStyle: "i", listIndent: 24 })]);
    const r = resolveRich(s, { content: "a\nb\nc", style: base, paragraphStyles: ["n", "n", "n"] }, base)!;
    expect(r.paragraphs.map((p) => p.marker)).toEqual(["i.", "ii.", "iii."]);
    expect(r.paragraphs[0].listIndent).toBe(24);
  });
  it("carries tabs, drop caps and hyphenation to the paragraph, inheriting from the base style", () => {
    const s = scene([def("root", { hyphenate: true, tabStops: [{ position: 40 }] }), def("child", { basedOn: "root", dropCapLines: 3 })]);
    const r = resolveRich(s, { content: "x", style: base, paragraphStyles: ["child"] }, base)!;
    expect(r.paragraphs[0]).toMatchObject({ hyphenate: true, tabs: [{ position: 40 }], dropLines: 3, dropChars: 1 });
  });
  it("applies a nested character style up to a delimiter, leaving explicit runs alone", () => {
    const s = scene([def("p", { nestedStyles: [{ styleId: "bold", delimiter: ":", count: 1, inclusive: true }] }), def("bold", { kind: "character", style: { ...base, fontSize: 0, fontWeight: "700", lineHeight: 0 } }), def("it", { kind: "character", style: { ...base, fontSize: 0, fontWeight: "", lineHeight: 0, italic: true } })]);
    const r = resolveRich(s, { content: "Label: body\nTitle: more", style: base, paragraphStyles: ["p", "p"], runs: [{ start: 2, end: 3, styleId: "it" }] }, base)!;
    const spans = r.runs.map((x) => [x.start, x.end, x.style.fontWeight || (x.style.italic ? "italic" : "")]);
    expect(spans).toEqual([[0, 2, "700"], [2, 3, "italic"], [3, 6, "700"], [12, 18, "700"]]);
  });
  it("applies the style to the whole paragraph when the delimiter is missing", () => {
    const s = scene([def("p", { nestedStyles: [{ styleId: "bold", delimiter: ":", count: 2 }] }), def("bold", { kind: "character", style: { ...base, fontSize: 0, fontWeight: "700", lineHeight: 0 } })]);
    const r = resolveRich(s, { content: "a: b", style: base, paragraphStyles: ["p"] }, base)!;
    expect(r.runs.map((x) => [x.start, x.end])).toEqual([[0, 4]]);
  });
});
