import { describe, it, expect } from "vitest";
import { buildPdf, type PdfPageSpec } from "@/pdf/write/pdfDocument";
import { effectBitmap, gaussianBlur } from "@/pdf/write/pdfEffects";
import type { NodeLite } from "@/store/types";

const alphaAt = (b: NonNullable<ReturnType<typeof effectBitmap>>, i: number, j: number) => b.rgba[(j * b.width + i) * 4 + 3]!;

describe("effectBitmap", () => {
  const shape = { kind: "rect" as const, w: 40, h: 20, r: 0 };
  it("a blurred drop shadow is soft: solid in the middle, fading outside the shape", () => {
    const b = effectBitmap(shape, { mode: "drop", color: { r: 0, g: 0, b: 0, a: 1 }, dx: 0, dy: 0, sigma: 4 })!;
    expect(b.x).toBeLessThan(0);
    const mid = alphaAt(b, b.width >> 1, b.height >> 1);
    const outside = alphaAt(b, 1, b.height >> 1);
    expect(mid).toBeGreaterThan(240);
    expect(outside).toBeLessThan(mid);
    // At the shape's edge the blurred coverage is about half.
    const s = b.width / b.w;
    const edge = alphaAt(b, Math.round((-b.x) * s), b.height >> 1);
    expect(edge).toBeGreaterThan(60);
    expect(edge).toBeLessThan(200);
  });
  it("an inner shadow is clear in the middle and opaque at the edges, shifted by its offset", () => {
    const b = effectBitmap({ kind: "rect", w: 60, h: 60, r: 0 }, { mode: "inner", color: { r: 0, g: 0, b: 0, a: 1 }, dx: 6, dy: 0, sigma: 2 })!;
    const s = b.width / b.w;
    const y = b.height >> 1;
    const left = alphaAt(b, Math.round((-b.x + 1) * s), y);
    const right = alphaAt(b, Math.round((-b.x + 59) * s), y);
    expect(left).toBeGreaterThan(200); // the offset leaves the left edge uncovered
    expect(right).toBeLessThan(10);
  });
  it("the colour alpha scales the bitmap and an empty shape gives nothing", () => {
    const b = effectBitmap(shape, { mode: "blur", color: { r: 1, g: 0, b: 0, a: 0.5 }, sigma: 0 })!;
    expect(alphaAt(b, b.width >> 1, b.height >> 1)).toBe(128);
    expect(effectBitmap({ ...shape, w: 0 }, { mode: "blur", color: { r: 0, g: 0, b: 0, a: 1 }, sigma: 1 })).toBeNull();
  });
  it("blur keeps the total mass", () => {
    const src = new Float32Array(21 * 21);
    src[10 * 21 + 10] = 1;
    const out = gaussianBlur(src, 21, 21, 2);
    expect(out.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 3);
  });
});

function node(over: Partial<NodeLite> & { id: string }): NodeLite {
  return {
    parentId: "page1", orderKey: "a1", name: over.id, visible: true, opacity: 1,
    x: 20, y: 20, width: 60, height: 40, rotation: 0,
    fills: [{ r: 0, g: 0, b: 1, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    ...over,
  };
}
const page = (nodes: NodeLite[]): PdfPageSpec => ({
  name: "P", media: { x: 0, y: 0, width: 200, height: 100 }, trim: { x: 0, y: 0, width: 200, height: 100 }, bleed: 0, nodes,
});
const build = (nodes: NodeLite[]) => buildPdf({
  pages: [page(nodes)], images: new Map(), faces: [], scene: { variables: {}, collections: {} }, measure: (s: string) => s.length * 8,
  title: "T", created: new Date(Date.UTC(2026, 0, 1)),
});
const text = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

describe("PDF effects", () => {
  it("a gradient with a transparent stop gets a luminosity soft mask", async () => {
    const stops = [{ color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 }, { color: { r: 1, g: 0, b: 0, a: 0 }, position: 1 }];
    const { bytes, report } = await build([node({ id: "g", fills: [{ r: 1, g: 0, b: 0, a: 1, gradient: { kind: "linear", x1: 0, y1: 0, x2: 1, y2: 0, stops } }] })]);
    const raw = text(bytes);
    expect(raw).toContain("/S/Luminosity");
    expect(raw).toContain("/ColorSpace/DeviceGray/Coords");
    expect(report.transparency).toBe(true);
  });
  it("an opaque gradient gets no soft mask", async () => {
    const stops = [{ color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 }, { color: { r: 0, g: 0, b: 1, a: 1 }, position: 1 }];
    const { bytes } = await build([node({ id: "g", fills: [{ r: 1, g: 0, b: 0, a: 1, gradient: { kind: "linear", x1: 0, y1: 0, x2: 1, y2: 0, stops } }] })]);
    expect(text(bytes)).not.toContain("/S/Luminosity");
  });
  it("blurred shadow, inner shadow and layer blur of a rectangle become bitmaps and are not reported as lost", async () => {
    const black = { r: 0, g: 0, b: 0, a: 0.5 };
    const { bytes, report } = await build([
      node({ id: "s", effects: [{ kind: "dropShadow", color: black, offsetX: 3, offsetY: 3, blur: 8 }, { kind: "innerShadow", color: black, offsetX: 0, offsetY: 2, blur: 4 }] }),
      node({ id: "b", x: 100, effects: [{ kind: "layerBlur", radius: 3 }] }),
    ]);
    expect(report.flattened).toEqual([]);
    expect(report.transparency).toBe(true);
    expect(text(bytes)).toContain("/SMask");
  });
  it("a vector's blurred shadow and a background blur are still reported", async () => {
    const tri = { subpaths: [{ closed: true, anchors: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 30, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 15, y: 30, inX: 0, inY: 0, outX: 0, outY: 0 }] }] };
    const { report } = await build([
      node({ id: "v", kind: "vector", vector: tri, effects: [{ kind: "dropShadow", color: { r: 0, g: 0, b: 0, a: 1 }, offsetX: 2, offsetY: 2, blur: 6 }] }),
      node({ id: "bg", x: 100, effects: [{ kind: "backgroundBlur", radius: 8 }] }),
    ]);
    expect([...report.flattened].sort()).toEqual(["bg", "v"]);
  });
});

describe("transparency flattening (PDF/X-1a, X-3)", () => {
  const buildX = (nodes: NodeLite[], pdfx: "x1a" | "x3" | "x4") => buildPdf({
    pages: [page(nodes)], images: new Map(), faces: [], scene: { variables: {}, collections: {} }, measure: (s: string) => s.length * 8,
    title: "T", created: new Date(Date.UTC(2026, 0, 1)), pdfx, condition: "FOGRA39",
  });
  const stops = [{ color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 }, { color: { r: 1, g: 0, b: 0, a: 0 }, position: 1 }];

  it("opacity becomes a lighter colour: no ExtGState alpha, no group", async () => {
    const nodes = [node({ id: "o", opacity: 0.5, fills: [{ r: 0, g: 0, b: 0, a: 1 }] })];
    expect(text((await buildX(nodes, "x4")).bytes)).toContain("/ca 0.5");
    const x1a = await buildX(nodes, "x1a");
    const raw = text(x1a.bytes);
    expect(raw).not.toContain("/ca ");
    expect(raw).not.toContain("/Group");
    expect(raw).not.toContain("/SMask");
    expect(x1a.report.transparency).toBe(false);
    expect(x1a.report.transparencyFlattened).toBe(true);
    // Black at 50% over white paper is 50% K in the CMYK document.
    expect(raw).toContain("0 0 0 0.5 k");
  });
  it("X-3 flattens too, with RGB mixed toward white", async () => {
    const { bytes, report } = await buildX([node({ id: "o", fills: [{ r: 0, g: 0, b: 0, a: 0.25 }] })], "x3");
    expect(text(bytes)).toContain("0.75 0.75 0.75 rg");
    expect(report.transparency).toBe(false);
  });
  it("gradient transparency stops are lightened, with no soft mask", async () => {
    const { bytes, report } = await buildX([node({ id: "g", fills: [{ r: 1, g: 0, b: 0, a: 1, gradient: { kind: "linear", x1: 0, y1: 0, x2: 1, y2: 0, stops } }] })], "x1a");
    const raw = text(bytes);
    expect(raw).not.toContain("/S/Luminosity");
    expect(raw).toContain("/C1[0 0 0 0]");
    expect(report.transparency).toBe(false);
    expect(report.transparencyFlattened).toBe(true);
  });
  it("blurs fall back to the hard stand-in and are listed; blend modes are dropped and listed", async () => {
    const { bytes, report } = await buildX([
      node({ id: "s", effects: [{ kind: "dropShadow", color: { r: 0, g: 0, b: 0, a: 0.5 }, offsetX: 3, offsetY: 3, blur: 8 }] }),
      node({ id: "m", x: 100, blendMode: "multiply" }),
    ], "x1a");
    expect([...report.flattened].sort()).toEqual(["m", "s"]);
    expect(report.transparency).toBe(false);
    expect(text(bytes)).not.toContain("/SMask");
    expect(text(bytes)).not.toContain("/BM");
  });
  const mesh = (a: number) => ({ r: 1, g: 0, b: 0, a, mesh: { rows: 2, cols: 2, colors: [1, 2, 3, 4].map(() => ({ r: 1, g: 0, b: 0, a })) } });
  it("a mesh with alpha colours under X-1a/X-3 reports no transparency", async () => {
    for (const x of ["x1a", "x3"] as const) {
      const { bytes, report } = await buildX([node({ id: "m", fills: [mesh(0.5)] })], x);
      expect(text(bytes)).not.toContain("/SMask");
      expect(report.transparency).toBe(false);
      expect(report.transparencyFlattened).toBe(true);
    }
    expect((await buildX([node({ id: "m", fills: [mesh(0.5)] })], "x4")).report.transparency).toBe(true);
  });
  it("node opacity is baked into a mesh fill under flattening", async () => {
    const full = await buildX([node({ id: "m", fills: [mesh(1)] })], "x1a");
    expect(full.report.transparencyFlattened).toBe(false);
    const faded = await buildX([node({ id: "m", opacity: 0.5, fills: [mesh(1)] })], "x1a");
    expect(faded.report.transparency).toBe(false);
    expect(faded.report.transparencyFlattened).toBe(true);
  });
  it("without a PDF/X standard nothing is flattened", async () => {
    const { report } = await build([node({ id: "o", opacity: 0.5 })]);
    expect(report.transparencyFlattened).toBe(false);
    expect(report.transparency).toBe(true);
  });
});
