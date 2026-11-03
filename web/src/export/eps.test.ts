import { describe, it, expect } from "vitest";
import { nodesToEps, psString } from "@/export/eps";
import type { NodeLite } from "@/store/types";

const measure = (s: string) => s.length * 10;
const FULL = { x: 0, y: 0, width: 200, height: 100 };

function node(over: Partial<NodeLite> & { id: string }): NodeLite {
  return {
    parentId: "page1", orderKey: "a1", name: over.id, visible: true, opacity: 1,
    x: 10, y: 20, width: 100, height: 50, rotation: 0,
    fills: [{ r: 1, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    ...over,
  };
}
const eps = (...nodes: NodeLite[]) => nodesToEps(nodes, FULL, measure);

describe("nodesToEps", () => {
  it("writes the EPS header with the bounding box in points", () => {
    const { eps: out } = eps();
    expect(out.startsWith("%!PS-Adobe-3.0 EPSF-3.0\n")).toBe(true);
    expect(out).toContain("%%BoundingBox: 0 0 150 75");
    expect(out).toContain("%%EndComments");
    expect(out.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(/^[\x00-\x7f]*$/.test(out)).toBe(true);
  });

  it("fills a rectangle with its colour", () => {
    const { eps: out, warnings } = eps(node({ id: "r" }));
    expect(out).toContain("10 20 moveto\n110 20 lineto\n110 70 lineto\n10 70 lineto\nclosepath");
    expect(out).toContain("1 0 0 setrgbcolor");
    expect(out).toContain("eofill");
    expect(warnings).toEqual([]);
  });

  it("draws an ellipse with four curves and a stroke with its style", () => {
    const { eps: out } = eps(node({ id: "e", kind: "ellipse", fills: [], strokes: [{ color: { r: 0, g: 0, b: 1, a: 1 }, weight: 3, align: "center" }] }));
    expect((out.match(/curveto/g) ?? []).length).toBeGreaterThanOrEqual(4);
    // like the canvas, a shape with no fill gets the default grey
    expect(out).toContain("0.8 0.8 0.8 setrgbcolor");
    expect(out).toContain("3 setlinewidth 0 setlinecap 0 setlinejoin");
    expect(out).toContain("stroke");
  });

  it("draws polygons and open vectors", () => {
    expect((eps(node({ id: "p", kind: "polygon", sides: 5 })).eps.match(/lineto/g) ?? []).length).toBeGreaterThanOrEqual(4);
    const v = node({
      id: "v", kind: "vector", fills: [], strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 2, align: "center" }],
      vector: { subpaths: [{ closed: false, anchors: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 5, outY: 0 }, { x: 40, y: 40, inX: -5, inY: 0, outX: 0, outY: 0 }] }] },
    });
    const { eps: out } = eps(v);
    expect(out).toContain("10 20 moveto");
    expect(out).toContain("curveto");
    // the only closepath is the page clip in the header: the open path itself is not closed
    expect((out.match(/closepath/g) ?? []).length).toBe(1);
  });

  it("flattens alpha against white and says so", () => {
    const { eps: out, warnings } = eps(node({ id: "r", fills: [{ r: 0, g: 0, b: 0, a: 0.5 }] }));
    expect(out).toContain("0.5 0.5 0.5 setrgbcolor");
    expect(warnings.join()).toMatch(/transparency/);
  });

  it("flattens gradients and replaces images with a placeholder, with warnings", () => {
    const grad = node({ id: "g", fills: [{ r: 0, g: 0, b: 0, a: 1, gradient: { kind: "linear", x1: 0, y1: 0, x2: 1, y2: 0, stops: [{ position: 0, color: { r: 1, g: 1, b: 1, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 0, a: 1 } }] } }] });
    const img = node({ id: "i", kind: "image", image: { assetHash: "abc" } as NodeLite["image"] });
    const r = eps(grad, img);
    expect(r.eps).toContain("0.5 0.5 0.5 setrgbcolor");
    expect(r.warnings.join()).toMatch(/gradients/);
    expect(r.warnings.join()).toMatch(/images/);
  });

  it("places text at the layout's baseline in a base-14 font", () => {
    const t = node({
      id: "t", kind: "text", fills: [{ r: 0, g: 0, b: 0, a: 1 }],
      text: { content: "Hi (you)", style: { fontFamily: "Inter", fontSize: 16, fontWeight: "700", lineHeight: 1.2, align: "left" } },
    });
    const { eps: out, warnings } = eps(t);
    expect(out).toContain("/Helvetica-Bold-L1 /Helvetica-Bold reencode");
    expect(out).toContain("(Hi \\(you\\)) show");
    expect(out).toContain("16 scalefont setfont");
    expect(warnings.join()).toMatch(/fonts are not embedded/);
  });

  it("clips the siblings above a mask", () => {
    const mask = node({ id: "m", kind: "ellipse", isMask: true });
    const { eps: out } = eps(mask, node({ id: "r" }));
    expect(out).toContain("eoclip");
    expect(out.split("eofill").length).toBe(2);
  });
});

describe("psString", () => {
  it("escapes delimiters, encodes Latin-1 as octal and replaces the rest", () => {
    expect(psString("a(b)\\c")).toBe("(a\\(b\\)\\\\c)");
    expect(psString("caffè")).toBe("(caff\\350)");
    expect(psString("日")).toBe("(?)");
    expect(psString("it’s – ok")).toBe("(it's - ok)");
  });
});
