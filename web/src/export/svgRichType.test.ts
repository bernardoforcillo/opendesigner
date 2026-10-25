import { describe, it, expect } from "vitest";
import { nodesToSvg } from "./svg";
import type { NodeLite, TextStyleLite } from "../store/types";

const FULL = { x: 0, y: 0, width: 400, height: 200 };
// 10 units per character at size 10, scaled by the size.
const measure = (s: string, st: TextStyleLite) => s.length * (st.fontSize || 10);
const none: TextStyleLite = { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" };

function textNode(content: string, st: Partial<TextStyleLite>): NodeLite {
  return {
    id: "t", parentId: "page1", orderKey: "a1", name: "t", visible: true, opacity: 1,
    x: 0, y: 0, width: 200, height: 40, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false,
    text: { content, style: { fontFamily: "", fontSize: 10, fontWeight: "", lineHeight: 0, align: "left", ...st } },
  };
}

function withRich(n: NodeLite, paragraphs: number, runs: { start: number; end: number; style: TextStyleLite }[]): NodeLite {
  const style = n.text!.style;
  const p = { style, spaceBefore: 0, spaceAfter: 0, indentFirst: 0, indentLeft: 0 };
  return { ...n, text: { ...n.text!, rich: { paragraphs: Array.from({ length: paragraphs }, () => p), runs } } };
}

describe("nodesToSvg — horizontal scale and rich type", () => {
  it("scales the text horizontally and divides x by the factor", () => {
    const svg = nodesToSvg([textNode("ab", { textScale: 200 })], FULL, measure);
    expect(svg).toContain('transform="scale(2 1)"');
    expect(svg).toContain('<tspan x="0" y="9">ab</tspan>');
    expect(nodesToSvg([textNode("ab", { textScale: 100 })], FULL, measure)).not.toContain("scale(");
  });

  it("keeps a rich run of another scale in its own <text>", () => {
    const n = withRich(textNode("abc", {}), 1, [{ start: 1, end: 2, style: { ...none, textScale: 50 } }]);
    const svg = nodesToSvg([n], FULL, measure);
    expect(svg.match(/<text /g)).toHaveLength(2);
    expect(svg).toContain('transform="scale(0.5 1)"');
    // "a" is 10 wide, so the scaled run starts at x=10, which is 20 once divided by 0.5.
    expect(svg).toContain('<tspan x="20" y="9">b</tspan>');
  });

  it("writes the cased runs, the list marker and the superscript pieces of a rich text", () => {
    const n = withRich(textNode("ab\ncd", { listKind: "bullet" }), 2, [
      { start: 0, end: 1, style: { ...none, textCase: "upper" } },
      { start: 4, end: 5, style: { ...none, textScript: "super" } },
    ]);
    const svg = nodesToSvg([n], FULL, measure);
    expect(svg).toContain(">A</tspan>");
    expect(svg).toContain(">•</tspan>");
    expect(svg).toMatch(/font-size="6.5">d<\/tspan>/);
    expect(svg).not.toContain(">a</tspan>");
  });

  it("insets and vertically aligns a rich text", () => {
    const n = { ...withRich(textNode("ab", { inset: 6, verticalAlign: "bottom" }), 1, []), height: 60 };
    const svg = nodesToSvg([n], FULL, measure);
    // Bottom: 60 - 2 * 6 - 12 (one line of 1.2) = 36 spare, starting at the inset 6.
    expect(svg).toContain('<tspan x="6" y="');
    expect(svg).toMatch(/y="(5[0-9]|4[0-9])(\.\d+)?"/);
  });
});
