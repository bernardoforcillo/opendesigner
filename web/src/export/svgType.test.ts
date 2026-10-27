import { describe, it, expect } from "vitest";
import { nodesToSvg } from "@/export/svg";
import type { NodeLite, TextStyleLite } from "@/store/types";

// 10 units per character, as in svg.test.ts.
const measure = (s: string) => s.length * 10;
const FULL = { x: 0, y: 0, width: 400, height: 200 };

function textNode(content: string, st: Partial<TextStyleLite>): NodeLite {
  return {
    id: "t", parentId: "page1", orderKey: "a1", name: "t", visible: true, opacity: 1,
    x: 0, y: 0, width: 200, height: 40, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false,
    text: { content, style: { fontFamily: "", fontSize: 10, fontWeight: "", lineHeight: 0, align: "left", ...st } },
  };
}

describe("nodesToSvg — type extras", () => {
  it("writes the cased text", () => {
    const svg = nodesToSvg([textNode("Hello", { textCase: "upper" })], FULL, measure);
    expect(svg).toContain(">HELLO</tspan>");
  });

  it("draws small caps as one tspan per run, the small ones at 0.8 of the size", () => {
    const svg = nodesToSvg([textNode("Ab", { textCase: "smallCaps" })], FULL, measure);
    expect(svg).toContain('<tspan x="0" y="9">A</tspan>');
    expect(svg).toContain('<tspan x="10" y="9" font-size="8">B</tspan>');
  });

  it("shrinks and shifts a superscript", () => {
    const svg = nodesToSvg([textNode("x", { textScript: "super" })], FULL, measure);
    expect(svg).toContain('font-size="6.5"');
    expect(svg).toMatch(/<tspan x="0" y="[\d.]+" font-size="6.5">x<\/tspan>/);
  });

  it("puts the list marker and the hanging text in their own tspans", () => {
    const svg = nodesToSvg([textNode("one\ntwo", { listKind: "bullet" })], FULL, measure);
    expect(svg).toContain("•</tspan>");
    expect(svg).toContain('<tspan x="14" y="9">one</tspan>');
  });

  it("carries OpenType features as font-feature-settings, and drops an unsafe string", () => {
    const ok = nodesToSvg([textNode("1", { fontFeatures: '"tnum", "liga" 0' })], FULL, measure);
    expect(ok).toContain('style="font-feature-settings:&quot;tnum&quot;, &quot;liga&quot; 0"');
    const bad = nodesToSvg([textNode("1", { fontFeatures: '"x";fill:red' })], FULL, measure);
    expect(bad).not.toContain("font-feature-settings");
  });
});
