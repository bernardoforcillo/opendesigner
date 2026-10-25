import { describe, it, expect } from "vitest";
import { layoutRich, placeTextLines, textPaintBounds, decorationBars, type MeasureFor } from "./text";
import { resolveRich } from "../store/richText";
import { emptyScene, type NodeLite, type ResolvedParagraph, type TextLite, type TextStyleDefLite, type TextStyleLite } from "../store/types";

// 10 units per character at size 10; width scales with the font size so a bigger piece measures more.
const mf: MeasureFor = (st) => (s) => s.length * (st.fontSize || 16) * (st.fontWeight === "700" ? 1 : 0.5);
const base: TextStyleLite = { fontFamily: "", fontSize: 10, fontWeight: "", lineHeight: 1, align: "left" };
const para = (over: Partial<ResolvedParagraph> = {}): ResolvedParagraph => ({ style: base, spaceBefore: 0, spaceAfter: 0, indentFirst: 0, indentLeft: 0, ...over });

function node(text: TextLite, over: Partial<NodeLite> = {}): NodeLite {
  return {
    id: "t", parentId: "page1", orderKey: "a0", name: "t", visible: true, opacity: 1, x: 100, y: 200, width: 100, height: 20, rotation: 0,
    fills: [], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false, text, ...over,
  };
}
const rich = (content: string, paragraphs: ResolvedParagraph[], runs: { start: number; end: number; style: TextStyleLite }[] = []): TextLite => ({
  content, style: base, rich: { paragraphs, runs },
});
const bold: TextStyleLite = { fontFamily: "", fontSize: 0, fontWeight: "700", lineHeight: 0, align: "left" };

describe("layoutRich", () => {
  it("wraps like plain text when nothing differs (5px per char at size 10, width 100 -> 20 chars)", () => {
    const l = layoutRich(mf, "aaaa bbbb cccc dddd eeee", base, { paragraphs: [para()], runs: [] }, 100);
    expect(l.lines.map((x) => x.frags.map((f) => f.text).join(""))).toEqual(["aaaa bbbb cccc dddd", "eeee"]);
    expect(l.height).toBe(20);
  });

  it("measures a character-styled piece with its own font and keeps one baseline", () => {
    const content = "aa bb";
    const l = layoutRich(mf, content, base, { paragraphs: [para()], runs: [{ start: 3, end: 5, style: bold }] }, 1000);
    expect(l.lines).toHaveLength(1);
    expect(l.lines[0].frags.map((f) => [f.text, f.style.fontWeight])).toEqual([["aa ", ""], ["bb", "700"]]);
    // 3 chars x 5 + 2 chars x 10
    expect(l.lines[0].width).toBe(35);
  });

  it("is as tall as its tallest piece", () => {
    const big: TextStyleLite = { ...bold, fontWeight: "", fontSize: 30 };
    const l = layoutRich(mf, "ab", base, { paragraphs: [para()], runs: [{ start: 1, end: 2, style: big }] }, 1000);
    expect(l.lines[0].height).toBe(30);
  });

  it("applies each paragraph's spacing, indents and alignment", () => {
    const content = "one\ntwo words here and more\nthree";
    const l = layoutRich(mf, content, base, {
      paragraphs: [para({ spaceAfter: 7 }), para({ spaceBefore: 3, indentFirst: 20, indentLeft: 10 }), para({ style: { ...base, align: "right" } })],
      runs: [],
    }, 100);
    const tops = l.lines.map((x) => x.top);
    expect(tops).toEqual([0, 20, 30, 40]); // 10 + 7 after + 3 before; two lines of 10; the third paragraph right after
    expect(l.lines[1].left).toBe(30); // indentLeft + indentFirst
    expect(l.lines[2].left).toBe(10); // indentLeft only on the next line (wrapped)
    expect(l.lines[3].left).toBe(100 - 25); // right aligned: width 100 - 5*5
    expect(l.lines).toHaveLength(4);
  });

  it("an empty paragraph keeps its line and the first paragraph ignores spaceBefore", () => {
    const l = layoutRich(mf, "\n\nx", base, { paragraphs: [para({ spaceBefore: 50 }), para(), para()], runs: [] }, 100);
    expect(l.lines.map((x) => x.top)).toEqual([0, 10, 20]);
  });

  it("breaks a word wider than the line by characters, never refusing a character", () => {
    const l = layoutRich(mf, "abcdefghij", base, { paragraphs: [para()], runs: [] }, 12);
    expect(l.lines.map((x) => x.frags.map((f) => f.text).join(""))).toEqual(["ab", "cd", "ef", "gh", "ij"]);
    const tiny = layoutRich(mf, "abc", base, { paragraphs: [para()], runs: [] }, 1);
    expect(tiny.lines).toHaveLength(3);
  });

  it("maps run offsets through \\r\\n line endings", () => {
    const l = layoutRich(mf, "a\r\nbc", base, { paragraphs: [para(), para()], runs: [{ start: 3, end: 5, style: bold }] }, 1000);
    expect(l.lines[1].frags).toEqual([{ text: "bc", at: 2, style: { ...base, fontWeight: "700" } }]);
  });
});

describe("placeTextLines / textPaintBounds with rich text", () => {
  it("places pieces left to right on the line's baseline, in world coordinates", () => {
    const n = node(rich("aa bb", [para()], [{ start: 3, end: 5, style: bold }]));
    const lines = placeTextLines((s) => s.length * 5, n, mf);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ text: "aa bb", x: 100, y: 200 + 8, width: 35 });
    expect(lines[0].segments!.map((s) => [s.text, s.x, s.width])).toEqual([["aa ", 100, 15], ["bb", 115, 20]]);
  });

  it("without a MeasureFor, or without rich, plain layout is untouched", () => {
    const withRich = node(rich("aa bb", [para()]));
    const plain = node({ content: "aa bb", style: base });
    expect(placeTextLines((s) => s.length * 5, withRich)).toEqual(placeTextLines((s) => s.length * 5, plain));
    expect(placeTextLines((s) => s.length * 5, plain, mf)[0].segments).toBeUndefined();
  });

  it("paint bounds cover the taller rich layout", () => {
    const n = node(rich("one\ntwo\nthree", [para(), para(), para()]), { height: 10 });
    expect(textPaintBounds((s, st) => mf(st)(s), n)).toMatchObject({ x: 100, y: 200, height: 30 });
  });
});

describe("resolveRich", () => {
  const def = (over: Partial<TextStyleDefLite> & { id: string }): TextStyleDefLite => ({ name: over.id, style: { ...base, fontSize: 0, lineHeight: 0 }, ...over });
  const scene = () => {
    const s = emptyScene("d", "d");
    s.textStyles = {
      body: def({ id: "body", style: { ...base, fontSize: 12, fontWeight: "400", lineHeight: 0 }, spaceAfter: 6 }),
      h1: def({ id: "h1", basedOn: "body", style: { ...base, fontSize: 32, fontWeight: "700", lineHeight: 0 }, spaceBefore: 12, nextStyleId: "body" }),
      em: def({ id: "em", kind: "character", style: { ...base, fontSize: 0, lineHeight: 0, italic: true } }),
    };
    return s;
  };

  it("folds basedOn chains and builds on the node's style", () => {
    const t: TextLite = { content: "Title\nText", style: { ...base, fontFamily: "Serif", lineHeight: 1.5 }, paragraphStyles: ["h1", "body"] };
    const r = resolveRich(scene(), t, t.style)!;
    expect(r.paragraphs[0]).toMatchObject({ spaceBefore: 12, spaceAfter: 6 });
    expect(r.paragraphs[0].style).toMatchObject({ fontFamily: "Serif", fontSize: 32, fontWeight: "700", lineHeight: 1.5 });
    expect(r.paragraphs[1].style).toMatchObject({ fontSize: 12, fontWeight: "400" });
  });

  it("returns null for formatting that resolves to nothing, so plain layout applies", () => {
    const t: TextLite = { content: "x", style: base, paragraphStyles: ["gone"], runs: [{ start: 0, end: 1, styleId: "body" }] };
    expect(resolveRich(scene(), t, t.style)).toBeNull();
  });

  it("resolves runs to the fields their character style sets", () => {
    const t: TextLite = { content: "abc", style: base, runs: [{ start: 1, end: 2, styleId: "em" }] };
    expect(resolveRich(scene(), t, t.style)!.runs).toEqual([{ start: 1, end: 2, style: expect.objectContaining({ italic: true, fontSize: 0 }) }]);
  });
});

describe("decorationBars", () => {
  it("draws an underline below and a strikethrough through the glyphs", () => {
    expect(decorationBars({ ...base, fontSize: 16, underline: true }, 100)).toEqual([{ y: 100 + 16 * 0.12, height: 1 }]);
    expect(decorationBars({ ...base, fontSize: 32, strikethrough: true }, 100)).toEqual([{ y: 100 - 32 * 0.3, height: 2 }]);
    expect(decorationBars(base, 100)).toEqual([]);
  });
});

import { trackedMeasure, trackedOffsets } from "./text";

describe("letter spacing", () => {
  const base5 = (s: string) => s.length * 5;

  it("adds the spacing after every character (a negative one tightens), and nothing without it", () => {
    expect(trackedMeasure(base5, { ...base, letterSpacing: 2 })("abcd")).toBe(28);
    expect(trackedMeasure(base5, { ...base, letterSpacing: -1 })("abcd")).toBe(16);
    expect(trackedMeasure(base5, base)).toBe(base5);
    // Characters, not UTF-16 units: an emoji is one.
    expect(trackedMeasure(() => 10, { ...base, letterSpacing: 3 })("a😀")).toBe(16);
  });

  it("wraps plain text with the tracking included", () => {
    const n = node({ content: "aaa bbb", style: { ...base, letterSpacing: 5 } }, { width: 40 });
    // "aaa" = 3 x (5 + 5) = 30, "aaa bbb" = 70 > 40: two lines.
    const lines = placeTextLines(base5, n);
    expect(lines.map((l) => l.text)).toEqual(["aaa", "bbb"]);
    expect(lines[0].width).toBe(30);
    const untracked = placeTextLines(base5, node({ content: "aaa bbb", style: base }, { width: 40 }));
    expect(untracked.map((l) => l.text)).toEqual(["aaa bbb"]);
  });

  it("measures rich pieces with their own tracking and reports where each character goes", () => {
    const loose: TextStyleLite = { ...bold, fontWeight: "", letterSpacing: 4 };
    const n = node(rich("aa bb", [para()], [{ start: 3, end: 5, style: loose }]));
    const [line] = placeTextLines((s) => s.length * 5, n, mf);
    // "aa " (15, no tracking) then "bb" at the base size 10 -> 2 x 5 + 2 x 4.
    expect(line.segments!.map((s) => [s.text, s.width])).toEqual([["aa ", 15], ["bb", 18]]);
    expect(trackedOffsets("abc", 100, 4, (s) => s.length * 5)).toEqual([{ ch: "a", x: 100 }, { ch: "b", x: 109 }, { ch: "c", x: 118 }]);
    expect(trackedOffsets("", 0, 4, base5)).toEqual([]);
  });
});

describe("the baseline grid", () => {
  // Lines are 10 tall (size 10, line height 1); the grid is every 12 starting at 0; the box is at world y 0.
  const grid = { increment: 12, start: 0, boxY: 0 };
  const onGrid = (extra: Partial<ResolvedParagraph> = {}) => para({ alignToGrid: true, ...extra });

  it("moves each line down to the next grid line and carries the shift to what follows", () => {
    const l = layoutRich(mf, "a\nb\nc", base, { paragraphs: [onGrid(), onGrid(), onGrid()], runs: [], grid }, 100);
    // ascent of a line = (10 - 10)/2 + 8 = 8: baselines at 8, then grid lines 12, 24, 36.
    const baselines = l.lines.map((x) => x.top + x.ascent);
    expect(baselines).toEqual([12, 24, 36]);
  });

  it("leaves paragraphs that do not ask for it alone, and skips the grid when the document has none", () => {
    const a = layoutRich(mf, "a\nb", base, { paragraphs: [onGrid(), para()], runs: [], grid }, 100);
    expect(a.lines.map((x) => x.top + x.ascent)).toEqual([12, 22]); // b follows the shifted line at its natural spacing (10 below)
    const b = layoutRich(mf, "a\nb", base, { paragraphs: [onGrid(), onGrid()], runs: [] }, 100);
    expect(b.lines.map((x) => x.top)).toEqual([0, 10]);
  });

  it("counts from where the text box is on the page", () => {
    const l = layoutRich(mf, "a", base, { paragraphs: [onGrid()], runs: [], grid: { ...grid, boxY: 5 } }, 100);
    // Baseline at 5 + 8 = 13 -> the next grid line is 24, so the line moves down by 11.
    expect(l.lines[0].top + l.lines[0].ascent).toBe(19);
  });

  it("leaves a line that is already on a grid line where it is", () => {
    const l = layoutRich(mf, "a", base, { paragraphs: [onGrid()], runs: [], grid: { increment: 8, start: 0, boxY: 0 } }, 100);
    expect(l.lines[0].top).toBe(0);
  });
});
