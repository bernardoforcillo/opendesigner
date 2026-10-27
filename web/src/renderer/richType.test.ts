import { describe, it, expect } from "vitest";
import { BULLET, hscaleOf, layoutRich, layoutText, piecesOfSegment, placeTextLines, styledMeasure, textPaintBounds, type MeasureFor } from "@/renderer/text";
import { flattenStyle, overlay, resolveRich } from "@/store/richText";
import { isValidTextStyleDef } from "@/store/typography";
import { toPbTextStyle, toTextStyleLite, emptyScene } from "@/store/types";
import type { NodeLite, ResolvedParagraph, TextLite, TextStyleDefLite, TextStyleLite } from "@/store/types";
import { TextStyleDefSchema, TextStyleKind } from "@/gen/opendesigner/v1/opendesigner_pb";
import { create } from "@bufbuild/protobuf";

// 10 units per character at size 10 (width scales with the size), like richLayout.test.ts.
const mf: MeasureFor = (st) => (s) => s.length * (st.fontSize || 16);
const base: TextStyleLite = { fontFamily: "", fontSize: 10, fontWeight: "", lineHeight: 1, align: "left" };
const para = (over: Partial<ResolvedParagraph> = {}): ResolvedParagraph => ({ style: base, spaceBefore: 0, spaceAfter: 0, indentFirst: 0, indentLeft: 0, ...over });
const noStyle: TextStyleLite = { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" };

function node(text: TextLite, over: Partial<NodeLite> = {}): NodeLite {
  return {
    id: "t", parentId: "page1", orderKey: "a0", name: "t", visible: true, opacity: 1, x: 100, y: 200, width: 300, height: 20, rotation: 0,
    fills: [], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false, text, ...over,
  };
}
const richText = (content: string, style: TextStyleLite, paragraphs: ResolvedParagraph[], runs: { start: number; end: number; style: TextStyleLite }[] = []): TextLite => ({
  content, style, rich: { paragraphs, runs },
});
const m = (s: string) => s.length * 10;

describe("horizontal text scale", () => {
  it("is a factor of the percentage, 1 when unset", () => {
    expect(hscaleOf(base)).toBe(1);
    expect(hscaleOf({ ...base, textScale: 150 })).toBe(1.5);
    expect(hscaleOf({ ...base, textScale: 0 })).toBe(1);
  });

  it("widens the measure, the wrap and the placed width of plain text", () => {
    const st = { ...base, textScale: 200 };
    expect(styledMeasure(m, st)("abc")).toBe(60);
    // 40 units per 2 chars -> "aaa bbb" no longer fits in 100.
    expect(layoutText(m, "aa bb", st, 90).lines).toEqual(["aa", "bb"]);
    expect(layoutText(m, "aa bb", base, 90).lines).toEqual(["aa bb"]);
    const line = placeTextLines(m, node({ content: "abc", style: st }))[0];
    expect(line.width).toBe(60);
  });

  it("composes with small caps: pieces advance by size and scale", () => {
    const st = { ...base, textCase: "smallCaps" as const, textScale: 200 };
    const line = placeTextLines(m, node({ content: "Ab", style: st }))[0];
    expect(line.pieces?.map((p) => [p.text, p.x])).toEqual([["A", 100], ["B", 120]]);
    expect(line.width).toBe(2 * (10 + 8));
  });

  it("applies to a character-styled run only, and moves what follows", () => {
    const wide = { ...noStyle, textScale: 300 };
    const l = placeTextLines(m, node(richText("abcd", base, [para()], [{ start: 1, end: 3, style: wide }]), { x: 0 }), mf)[0];
    expect(l.segments?.map((s) => [s.text, s.x, s.width])).toEqual([["a", 0, 10], ["bc", 10, 60], ["d", 70, 10]]);
  });

  it("round-trips the proto and is validated like Go", () => {
    expect(toTextStyleLite(create(TextStyleDefSchema, { style: { textScale: 125 } }).style).textScale).toBe(125);
    expect(toTextStyleLite(undefined).textScale).toBeUndefined();
    expect(toPbTextStyle({ ...base, textScale: 80 }).textScale).toBe(80);
    const def = (textScale: number, kind = TextStyleKind.PARAGRAPH, extra: object = {}) =>
      create(TextStyleDefSchema, { id: "s", name: "s", kind, style: { textScale, ...extra } });
    const scene = emptyScene("d", "d");
    for (const ok of [0, 1, 100, 1000]) expect(isValidTextStyleDef(scene, def(ok))).toBe(true);
    for (const bad of [0.5, 1001, NaN, -3]) expect(isValidTextStyleDef(scene, def(bad))).toBe(false);
  });
});

describe("rich text honours the type extras", () => {
  it("cases every piece, a run's own case winning over the paragraph's", () => {
    const upper: TextStyleLite = { ...noStyle, textCase: "upper" };
    const lower: TextStyleLite = { ...noStyle, textCase: "lower" };
    const t = richText("ab cd ef", base, [para()], [{ start: 3, end: 5, style: upper }]);
    expect(placeTextLines(m, node(t), mf)[0].text).toBe("ab CD ef");
    const t2 = richText("AB cd", base, [para({ style: { ...base, textCase: "upper" } })], [{ start: 0, end: 2, style: lower }]);
    expect(placeTextLines(m, node(t2), mf)[0].text).toBe("ab CD");
    // The wrap sees the cased glyphs: ß-like length changes are not applied, offsets stay the typed ones.
    const l = layoutRich(mf, "ab cd", base, { paragraphs: [para({ style: { ...base, textCase: "upper" } })], runs: [] }, 1000);
    expect(l.lines[0].end).toBe(5);
  });

  it("title case continues across a run boundary", () => {
    const bold: TextStyleLite = { ...noStyle, fontWeight: "700" };
    const t = richText("hello world", base, [para({ style: { ...base, textCase: "title" } })], [{ start: 2, end: 5, style: bold }]);
    expect(placeTextLines(m, node(t), mf)[0].text).toBe("Hello World");
  });

  it("draws small caps and superscript runs as pieces on their own scale and baseline", () => {
    const sc: TextStyleLite = { ...noStyle, textCase: "smallCaps" };
    const sup: TextStyleLite = { ...noStyle, textScript: "super" };
    const t = richText("ab c", base, [para()], [{ start: 0, end: 2, style: sc }, { start: 3, end: 4, style: sup }]);
    const line = placeTextLines(m, node(t), mf)[0];
    const [first, , last] = line.segments!;
    expect(piecesOfSegment(first, line.y).map((p) => [p.text, p.scale])).toEqual([["AB", 0.8]]);
    // Small caps measure 0.8 of the capitals.
    expect(first.width).toBeCloseTo(16);
    const sp = piecesOfSegment(last, line.y)[0];
    expect(sp.scale).toBe(0.65);
    expect(sp.y).toBeLessThan(line.y);
    expect(last.width).toBeCloseTo(6.5);
  });

  it("makes a list paragraph style: marker in the hanging column, items numbered in order", () => {
    const list: TextStyleLite = { ...base, listKind: "numbered" };
    const t = richText("one\n\ntwo\nplain", base, [para({ style: list }), para({ style: list }), para({ style: list }), para()]);
    const lines = placeTextLines(m, node(t, { x: 0 }), mf);
    const marker = (i: number) => lines[i].segments!.find((s) => s.marker);
    expect(marker(0)?.text).toBe("1.");
    // The empty paragraph is not an item and not counted.
    expect(marker(1)?.text).toBe("2.");
    expect(lines).toHaveLength(3);
    // Column: max(0.9em, "1." = 20) + 0.4em = 24; the text of every item starts there; a non-item starts at 0.
    expect(lines[0].x).toBe(24);
    expect(lines[1].x).toBe(24);
    expect(lines[2].x).toBe(0);
    expect(marker(0)?.x).toBe(0);
    expect(lines[0].text).toBe("one");
  });

  it("bullets a paragraph style and indents, narrowing the wrap by the lead", () => {
    const list: TextStyleLite = { ...base, listKind: "bullet", indent: 6 };
    const t = richText("aaaa bbbb", base, [para({ style: list })]);
    const lay = layoutRich(mf, t.content, base, t.rich!, 60);
    // lead = 6 + (max(9, 10) + 4) = 20 -> 40 left: one word per line.
    expect(lay.lines.map((l) => l.frags.map((f) => f.text).join(""))).toEqual(["aaaa", "bbbb"]);
    expect(lay.lines[0].marker).toMatchObject({ text: BULLET, x: 6 });
    expect(lay.lines[1].marker).toBeUndefined();
    expect(lay.lines[0].left).toBe(20);
  });

  it("insets the box and aligns vertically, like plain text", () => {
    const st: TextStyleLite = { ...base, inset: 5, verticalAlign: "middle" };
    const t = richText("ab", st, [para({ style: st })]);
    const n = node(t, { x: 0, y: 0, width: 100, height: 60 });
    const line = placeTextLines(m, n, mf)[0];
    // spare = 60 - 10 - 10 = 40 -> top 5 + 20; baseline = top + ascent (0.8 * 10 + 0 half-leading).
    expect(line.x).toBe(5);
    expect(line.y).toBeCloseTo(25 + 8);
    const bottom = placeTextLines(m, node(richText("ab", { ...st, verticalAlign: "bottom" }, [para({ style: st })]), { x: 0, y: 0, width: 100, height: 60 }), mf)[0];
    expect(bottom.y).toBeCloseTo(5 + 40 + 8);
    // The plain path agrees with it, line for line.
    const plain = placeTextLines(m, node({ content: "ab", style: st }, { x: 0, y: 0, width: 100, height: 60 }))[0];
    expect(plain.y).toBeCloseTo(line.y);
    expect(plain.x).toBe(line.x);
  });

  it("wraps inside the inset and reports the bounds with it", () => {
    const st: TextStyleLite = { ...base, inset: 10 };
    const t = richText("aaaa bbbb", st, [para({ style: st })]);
    const n = node(t, { x: 0, y: 0, width: 60, height: 10 });
    const lines = placeTextLines(m, n, mf);
    expect(lines.map((l) => l.text)).toEqual(["aaaa", "bbbb"]);
    const bounds = textPaintBounds((s, style) => mf(style)(s), n);
    // two 10px lines + the inset above and below.
    expect(bounds.height).toBe(40);
  });

  it("keeps a text without rich in the plain path, unchanged", () => {
    const plain = placeTextLines(m, node({ content: "ab", style: { ...base, textCase: "upper" } }))[0];
    expect(plain.segments).toBeUndefined();
    expect(plain.text).toBe("AB");
  });
});

describe("styles carry the extras", () => {
  const def = (id: string, style: TextStyleLite, over: Partial<TextStyleDefLite> = {}): TextStyleDefLite => ({ id, name: id, style, ...over });

  it("overlay inherits what the paragraph style leaves unset and takes what it sets", () => {
    const node1: TextStyleLite = { ...base, textCase: "upper", inset: 4, fontFeatures: '"tnum"', textScale: 90 };
    const out = overlay(node1, { ...noStyle, listKind: "bullet", textScale: 120 });
    expect(out).toMatchObject({ textCase: "upper", inset: 4, fontFeatures: '"tnum"', listKind: "bullet", textScale: 120 });
    // Nothing set anywhere adds no keys.
    expect(Object.keys(overlay(base, noStyle)).sort()).toEqual(["align", "fontFamily", "fontSize", "fontWeight", "lineHeight"]);
  });

  it("folds a based-on chain with the new fields", () => {
    const scene = emptyScene("d", "d");
    scene.textStyles = {
      a: def("a", { ...noStyle, textCase: "upper", indent: 8 }),
      b: def("b", { ...noStyle, listKind: "bullet" }, { basedOn: "a" }),
    };
    expect(flattenStyle(scene.textStyles, "b")?.style).toMatchObject({ textCase: "upper", indent: 8, listKind: "bullet" });
  });

  it("resolves a paragraph style and a character style into a drawn list with cased runs", () => {
    const scene = emptyScene("d", "d");
    scene.textStyles = {
      items: def("items", { ...noStyle, listKind: "bullet" }),
      caps: def("caps", { ...noStyle, textCase: "upper" }, { kind: "character" }),
    };
    const t: TextLite = { content: "ab cd", style: base, paragraphStyles: ["items"], runs: [{ start: 3, end: 5, styleId: "caps" }] };
    const rich = resolveRich(scene, t, base)!;
    const line = placeTextLines(m, node({ ...t, rich }, { x: 0 }), mf)[0];
    expect(line.text).toBe("ab CD");
    expect(line.segments![0]).toMatchObject({ marker: true, text: BULLET });
  });
});
