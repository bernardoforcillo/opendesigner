import { describe, it, expect } from "vitest";
import { nodesToSvg } from "./svg";
import type { EffectLite, NodeLite } from "../store/types";

const measure = (s: string) => s.length * 10;
const FULL = { x: 0, y: 0, width: 200, height: 200 };

const node = (kind: NodeLite["kind"], effects: EffectLite[], over: Partial<NodeLite> = {}): NodeLite => ({
  id: "n", parentId: "page1", orderKey: "a1", name: "n", visible: true, opacity: 1,
  x: 10, y: 20, width: 100, height: 60, rotation: 0,
  fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [], kind, cornerRadius: 0, clipsContent: false, effects, ...over,
});

const noise: EffectLite = { kind: "noise", mode: "mono", size: 2, density: 1, opacity: 0.5, color: { r: 0, g: 0, b: 0, a: 1 }, color2: { r: 1, g: 1, b: 1, a: 1 }, seed: 1 };

describe("nodesToSvg — progressive blur, noise, texture and glass", () => {
  it("exports a progressive layer blur as a uniform blur of the ramp's mean radius", () => {
    const svg = nodesToSvg([node("rect", [{ kind: "progressiveBlur", startRadius: 2, endRadius: 10, x1: 0, y1: 0, x2: 0, y2: 1, background: false }])], FULL, measure);
    expect(svg).toContain('<feGaussianBlur stdDeviation="6"/>');
  });

  it("leaves a progressive background blur out (no standalone SVG form)", () => {
    const svg = nodesToSvg([node("rect", [{ kind: "progressiveBlur", startRadius: 2, endRadius: 10, x1: 0, y1: 0, x2: 0, y2: 1, background: true }])], FULL, measure);
    expect(svg).not.toContain("feGaussianBlur");
  });

  it("embeds the seeded grain as a pixelated PNG pattern over the node's outline", () => {
    const svg = nodesToSvg([node("rect", [noise], { cornerRadius: 8 })], FULL, measure);
    expect(svg).toContain('<pattern id="p0" x="10" y="20" width="128" height="128" patternUnits="userSpaceOnUse">');
    expect(svg).toContain("data:image/png;base64,");
    expect(svg).toContain("image-rendering:pixelated");
    expect(svg).toContain('fill="url(#p0)"');
    expect(svg).toContain('rx="8"');
    // The same node twice draws the same grain.
    expect(nodesToSvg([node("rect", [noise])], FULL, measure)).toBe(nodesToSvg([node("rect", [noise])], FULL, measure));
  });

  it("draws the overlay on an ellipse as an ellipse, and not on text", () => {
    expect(nodesToSvg([node("ellipse", [noise])], FULL, measure)).toMatch(/<ellipse[^>]*fill="url\(#p0\)"/);
    const text = node("text", [noise], { text: { content: "hi", style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" } } });
    expect(nodesToSvg([text], FULL, measure)).not.toContain("<pattern");
  });

  it("exports glass as a light edge (inner shadows) plus the grain", () => {
    const svg = nodesToSvg([node("rect", [{ kind: "glass", frost: 12, light: 0.5, lightAngle: 90, noise: 0.5 }])], FULL, measure);
    expect(svg).toContain("<feOffset");
    expect(svg).toContain("<pattern");
  });
});
