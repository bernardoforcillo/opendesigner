import { describe, it, expect } from "vitest";
import { nodesToSvg } from "@/export/svg";
import type { NodeLite } from "@/store/types";

const measure = (s: string) => s.length * 10;
const FULL = { x: 0, y: 0, width: 200, height: 200 };

function node(over: Partial<NodeLite> & { id: string }): NodeLite {
  return {
    parentId: "page1", orderKey: "a1", name: over.id, visible: true, opacity: 1,
    x: 0, y: 0, width: 100, height: 100, rotation: 0,
    fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    ...over,
  };
}
const svg = (...nodes: NodeLite[]) => nodesToSvg(nodes, FULL, measure);
const black = { r: 0, g: 0, b: 0, a: 1 };

describe("nodesToSvg: polygon, star, arcs and corners", () => {
  it("a polygon and a star are paths of their computed outline", () => {
    const out = svg(node({ id: "p", kind: "polygon", sides: 4 }), node({ id: "s", kind: "star", points: 5, innerRatio: 0.4 }));
    expect(out).toContain('d="M50 0L100 50L50 100L0 50Z"');
    expect((out.match(/<path /g) ?? []).length).toBe(2);
    expect(out).toContain('fill-rule="evenodd"');
  });

  it("an ellipse with a sweep or a ring is a path; a plain one stays an <ellipse>", () => {
    expect(svg(node({ id: "e", kind: "ellipse" }))).toContain("<ellipse");
    const pie = svg(node({ id: "e", kind: "ellipse", arcSweep: 90 }));
    expect(pie).not.toContain("<ellipse");
    expect(pie).toContain("<path");
    const ring = svg(node({ id: "e", kind: "ellipse", innerRatio: 0.5 }));
    expect((ring.match(/M/g) ?? []).length).toBe(2); // two contours
  });

  it("a smoothed or independent-corner rectangle is a path; a plain rounded one stays a <rect rx>", () => {
    expect(svg(node({ id: "r", cornerRadius: 10 }))).toContain('rx="10"');
    const smooth = svg(node({ id: "r", cornerRadius: 10, cornerSmoothing: 0.6 }));
    expect(smooth).not.toContain("<rect");
    expect(smooth).toContain("C");
    expect(svg(node({ id: "r", radii: { topLeft: 20, topRight: 0, bottomRight: 0, bottomLeft: 0 } }))).not.toContain("<rect");
  });

  it("a computed outline carries its stroke", () => {
    const out = svg(node({ id: "p", kind: "polygon", sides: 3, strokes: [{ color: black, weight: 3, align: "center" }] }));
    expect(out).toContain('stroke-width="3"');
  });

  it("a computed mask clips by its path", () => {
    const out = svg(node({ id: "m", kind: "star", points: 5, innerRatio: 0.5, isMask: true }), node({ id: "under", orderKey: "a2" }));
    expect(out).toContain("<clipPath");
    expect(out).toContain('clip-rule="evenodd"');
  });
});

describe("nodesToSvg: per-side strokes and arrowheads", () => {
  it("per-side weights are a filled band, with no stroke attribute", () => {
    const out = svg(node({ id: "r", strokes: [{ color: black, weight: 6, align: "inside", sides: { top: 0, right: 0, bottom: 6, left: 0 } }] }));
    expect(out).not.toContain("stroke=");
    // outer = the box, inner = the box without the bottom 6
    expect(out).toContain('d="M0 0h100v100h-100zM0 0h100v94h-100z"');
    expect(out).toContain('fill-rule="evenodd"');
  });

  const line = (strokeOver: object) => node({
    id: "l", kind: "vector", fills: [], width: 100, height: 0,
    vector: { subpaths: [{ closed: false, anchors: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 100, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }] }] },
    strokes: [{ color: black, weight: 2, align: "center", ...strokeOver }],
  });

  it("an end cap adds a head whose tip is on the end point", () => {
    const out = svg(line({ endCap: "triangle" }));
    expect(out).toContain('d="M100 0L92 3.6L92 -3.6Z"');
  });

  it("an arrow is an open V stroked with the stroke's weight; no caps, no extra elements", () => {
    const out = svg(line({ startCap: "arrow" }));
    expect(out).toContain('d="M8 -3.6L0 0L8 3.6"');
    expect((svg(line({})).match(/<path /g) ?? []).length).toBe(1);
  });
});
