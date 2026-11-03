import { describe, it, expect } from "vitest";
import { cjkSplit } from "@/renderer/cjk";
import { placeTextLines, textPaintBounds } from "@/renderer/text";
import { directionOf, effectiveAlign, layoutVertical } from "@/renderer/textIntl";
import { toPbTextStyle, toTextStyleLite } from "@/store/types";
import type { NodeLite, TextStyleLite } from "@/store/types";
import { create } from "@bufbuild/protobuf";
import { TextStyleSchema } from "@/gen/opendesigner/v1/opendesigner_pb";

const measure = (s: string) => s.length * 10;
const style = (over: Partial<TextStyleLite> = {}): TextStyleLite =>
  ({ fontFamily: "Inter, sans-serif", fontSize: 20, fontWeight: "400", lineHeight: 1.5, align: "left", ...over });
const node = (content: string, st: TextStyleLite, over: Partial<NodeLite> = {}): NodeLite => ({
  id: "t", parentId: "p", orderKey: "a0", name: "T", visible: true, opacity: 1, x: 100, y: 50, width: 200, height: 100, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false, text: { content, style: st }, ...over,
});

describe("paragraph direction", () => {
  it("uses the style, else the first strong character", () => {
    expect(directionOf("hello", style())).toBe("ltr");
    expect(directionOf("مرحبا", style())).toBe("rtl");
    expect(directionOf("hello", style({ direction: "rtl" }))).toBe("rtl");
    expect(directionOf("مرحبا", style({ direction: "ltr" }))).toBe("ltr");
  });
  it("mirrors left and right only when the author set right-to-left", () => {
    expect(effectiveAlign("left", style({ direction: "rtl" }))).toBe("right");
    expect(effectiveAlign("right", style({ direction: "rtl" }))).toBe("left");
    expect(effectiveAlign("center", style({ direction: "rtl" }))).toBe("center");
    expect(effectiveAlign("left", style())).toBe("left");
    expect(effectiveAlign("left", style({ direction: "ltr" }))).toBe("left");
  });
  it("puts a right-to-left paragraph at the right edge of its box, with the indent reserved there", () => {
    const [ltr] = placeTextLines(measure, node("abc", style()));
    const [rtl] = placeTextLines(measure, node("abc", style({ direction: "rtl" })));
    expect(ltr!.x).toBe(100);
    expect(rtl!.x).toBe(100 + 200 - 30);
    const [indented] = placeTextLines(measure, node("abc", style({ direction: "rtl", indent: 20 })));
    expect(indented!.x).toBe(100 + (200 - 20) - 30);
  });
});

describe("vertical writing", () => {
  const vstyle = style({ writingMode: "vertical" });
  it("stacks upright characters in a column at the right edge, a line break starts the next column to its left", () => {
    const lines = placeTextLines(measure, node("ab\ncd", vstyle));
    expect(lines.map((l) => l.text)).toEqual(["a", "b", "c", "d"]);
    // the cell is the font size (20), the column pitch is 30 (size x line height), centred on 100+200-15
    expect(lines[0]!.x).toBe(285 - 5);
    expect(lines[1]!.y - lines[0]!.y).toBe(20);
    expect(lines[2]!.x).toBe(lines[0]!.x - 30);
    expect(lines[2]!.y).toBe(lines[0]!.y);
  });
  it("wraps a column where the box height is used up, and keeps blank cells", () => {
    const lines = placeTextLines(measure, node("abc d", vstyle, { height: 60 })); // 3 cells per column
    expect(lines.map((l) => l.text)).toEqual(["a", "b", "c", "d"]);
    expect(lines[3]!.x).toBe(lines[0]!.x - 30); // the space and d went to the second column
    const col2 = layoutVertical(["ab c"], { x: 0, y: 0, width: 100, height: 40, inset: 0, size: 20, pitch: 20, ascent: 16, align: "left", measure });
    expect(col2.columns).toBe(2);
  });
  it("aligns along the column", () => {
    const top = placeTextLines(measure, node("ab", vstyle))[0]!.y;
    const middle = placeTextLines(measure, node("ab", style({ writingMode: "vertical", align: "center" })))[0]!.y;
    const bottom = placeTextLines(measure, node("ab", style({ writingMode: "vertical", align: "right" })))[0]!.y;
    expect(middle - top).toBe((100 - 40) / 2);
    expect(bottom - top).toBe(100 - 40);
  });
  it("counts the columns in the paint bounds", () => {
    const b = textPaintBounds((s) => s.length * 10, node("a\nb\nc\nd\ne\nf\ng\nh", vstyle));
    expect(b.x).toBeLessThan(100); // 8 columns of 30 do not fit in 200
  });
});

describe("spaceless scripts", () => {
  it("breaks Thai at word boundaries when the platform has a word segmenter", () => {
    const parts = cjkSplit("สวัสดีครับ");
    expect(parts.join("")).toBe("สวัสดีครับ");
    if (typeof (Intl as unknown as { Segmenter?: unknown }).Segmenter === "function") expect(parts.length).toBeGreaterThan(1);
  });
  it("leaves Latin words whole", () => {
    expect(cjkSplit("hello")).toEqual(["hello"]);
  });
});

describe("style round trip", () => {
  it("keeps direction and writing mode through the protobuf style", () => {
    const lite = style({ direction: "rtl", writingMode: "vertical" });
    const back = toTextStyleLite(create(TextStyleSchema, toPbTextStyle(lite)));
    expect(back.direction).toBe("rtl");
    expect(back.writingMode).toBe("vertical");
    const plain = toTextStyleLite(create(TextStyleSchema, toPbTextStyle(style())));
    expect(plain.direction).toBeUndefined();
    expect(plain.writingMode).toBeUndefined();
  });
});
