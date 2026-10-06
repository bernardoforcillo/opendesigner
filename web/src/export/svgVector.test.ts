import { describe, it, expect } from "vitest";
import { nodesToSvg } from "./svg";
import type { NodeLite, SubPathLite } from "../store/types";

// The SVG export of VECTOR nodes (they used to come out as a gray rectangle) and of the
// strokes of rect/ellipse/vector.

const A = (x: number, y: number, o: Partial<{ inX: number; inY: number; outX: number; outY: number }> = {}) =>
  ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0, ...o });

function vec(subpaths: SubPathLite[], over: Partial<NodeLite> = {}): NodeLite {
  return {
    id: "v", parentId: "page1", orderKey: "a0", name: "v", visible: true, opacity: 1,
    x: 10, y: 20, width: 20, height: 20, rotation: 0,
    fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [], kind: "vector", cornerRadius: 0, clipsContent: false,
    vector: { subpaths }, ...over,
  };
}

const svg = (n: NodeLite) => nodesToSvg([n], { x: 0, y: 0, width: 100, height: 100 }, () => 10);

describe("nodesToSvg: vectors", () => {
  it("a closed outline -> <path> with world coordinates (node + anchor) and Z", () => {
    const out = svg(vec([{ closed: true, anchors: [A(0, 0), A(20, 0), A(20, 20)] }]));
    expect(out).toContain('d="M10 20C10 20 30 20 30 20C30 20 30 40 30 40C30 40 10 20 10 20Z"');
    expect(out).toContain('fill="rgb(255,0,0)"');
    expect(out).toContain('fill-rule="evenodd"'); // the renderer's historical default
  });

  it("handles are RELATIVE to the anchor", () => {
    const out = svg(vec([{ closed: false, anchors: [A(0, 0, { outX: 5, outY: 0 }), A(20, 20, { inX: -5, inY: 0 })] }]), );
    // without a stroke an open outline is not drawn (the canvas does not fill it)
    expect(out).not.toContain("<path");
    const withStroke = svg(vec(
      [{ closed: false, anchors: [A(0, 0, { outX: 5, outY: 0 }), A(20, 20, { inX: -5, inY: 0 })] }],
      { strokes: [{ color: { r: 0, g: 0, b: 1, a: 1 }, weight: 2, align: "center" }] },
    ));
    expect(withStroke).toContain('d="M10 20C15 20 25 40 30 40"');
    expect(withStroke).toContain('fill="none"');
    expect(withStroke).toContain('stroke="rgb(0,0,255)"');
    expect(withStroke).toContain('stroke-width="2"');
  });

  it("closed and open outlines of the same node: two <path>s, the open one without a fill", () => {
    const out = svg(vec(
      [{ closed: true, anchors: [A(0, 0), A(10, 0), A(10, 10)] }, { closed: false, anchors: [A(15, 15), A(20, 20)] }],
      { strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 1, align: "center" }] },
    ));
    expect(out.match(/<path /g)?.length).toBe(2);
    expect(out.match(/fill="none"/g)?.length).toBe(1);
  });

  it("fill-rule, capi, giunti, miter e tratteggio dai meta", () => {
    const out = svg(vec(
      [{ closed: false, anchors: [A(0, 0), A(20, 20)] }],
      {
        strokes: [{ color: { r: 0, g: 0, b: 0, a: 0.5 }, weight: 3, align: "center" }],
        meta: { "vector.fillRule": "nonzero", "stroke.cap": "round", "stroke.join": "bevel", "stroke.miter": "7", "stroke.dash": "4,2", "stroke.dashOffset": "1" },
      },
    ));
    for (const frag of [
      'stroke-opacity="0.5"', 'stroke-linecap="round"', 'stroke-linejoin="bevel"', 'stroke-miterlimit="7"',
      'stroke-dasharray="4 2"', 'stroke-dashoffset="1"',
    ]) expect(out).toContain(frag);
  });

  it("a gradient in the stroke becomes a reference in <defs>", () => {
    const out = svg(vec(
      [{ closed: false, anchors: [A(0, 0), A(20, 20)] }],
      {
        strokes: [{
          color: {
            r: 1, g: 0, b: 0, a: 1,
            gradient: { kind: "linear", x1: 0, y1: 0, x2: 1, y2: 0, stops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }] },
          },
          weight: 2, align: "center",
        }],
      },
    ));
    expect(out).toContain("<linearGradient");
    expect(out).toMatch(/stroke="url\(#g\d+\)"/);
  });

  it("rect and ellipse also export the stroke", () => {
    const stroke = [{ color: { r: 0, g: 1, b: 0, a: 1 }, weight: 4, align: "center" as const }];
    const base = { ...vec([]), kind: "rect" as const, vector: undefined, strokes: stroke, cornerRadius: 3 };
    expect(svg(base)).toMatch(/<rect[^>]*stroke="rgb\(0,255,0\)"[^>]*stroke-width="4"/);
    expect(svg({ ...base, kind: "ellipse" })).toMatch(/<ellipse[^>]*stroke="rgb\(0,255,0\)"/);
    // without a stroke: no stroke attribute (files do not change)
    expect(svg({ ...base, strokes: [] })).not.toContain("stroke");
  });
});
