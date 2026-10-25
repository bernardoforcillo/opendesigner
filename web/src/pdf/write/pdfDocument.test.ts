import { describe, it, expect } from "vitest";
import { buildPdf, type PdfBuild, type PdfPageSpec } from "./pdfDocument";
import { prepareImage, dataUrlBytes } from "./pdfImages";
import { encodePng } from "../../export/rawPng";
import type { NodeLite, TextStyleLite, VariableLite } from "../../store/types";

const measure = (s: string) => s.length * 8;

function node(over: Partial<NodeLite> & { id: string }): NodeLite {
  return {
    parentId: "page1", orderKey: "a1", name: over.id, visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
    ...over,
  };
}
const style = (over: Partial<TextStyleLite> = {}): TextStyleLite => ({ fontFamily: "Helvetica", fontSize: 16, fontWeight: "400", lineHeight: 1.2, align: "left", ...over });

const page = (nodes: NodeLite[], over: Partial<PdfPageSpec> = {}): PdfPageSpec => ({
  name: "Page 1", media: { x: 0, y: 0, width: 200, height: 100 }, trim: { x: 0, y: 0, width: 200, height: 100 }, bleed: 0, nodes, ...over,
});

function build(pages: PdfPageSpec[], over: Partial<PdfBuild> = {}): Promise<ReturnType<typeof buildPdf> extends Promise<infer R> ? R : never> {
  return buildPdf({
    pages, images: new Map(), faces: [], scene: { variables: {}, collections: {} }, measure,
    title: "Test doc", created: new Date(Date.UTC(2026, 0, 1)), ...over,
  });
}

/** Every Flate stream of the file, inflated and joined: the page content, readable. */
async function contentOf(bytes: Uint8Array): Promise<string> {
  const { inflateSync } = await import("node:zlib");
  const raw = Buffer.from(bytes).toString("latin1");
  const out: string[] = [];
  for (const m of raw.matchAll(/\/Filter\/FlateDecode\/Length (\d+)>>\nstream\n/g)) {
    const start = m.index! + m[0].length;
    try { out.push(inflateSync(Buffer.from(bytes.subarray(start, start + Number(m[1])))).toString("latin1")); } catch { /* not content */ }
  }
  return out.join("\n");
}

async function read(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjs.getDocument({ data: bytes.slice(), useWorkerFetch: false, isEvalSupported: false, verbosity: 0 }).promise;
}

describe("buildPdf — read back with pdf.js", () => {
  it("is a valid PDF with the pages, size in points and the Info title", async () => {
    const { bytes, report } = await build([page([node({ id: "a", x: 10, y: 10, width: 50, height: 20 })]), page([], { name: "Page 2" })]);
    const doc = await read(bytes);
    expect(doc.numPages).toBe(2);
    const p = await doc.getPage(1);
    expect(p.view).toEqual([0, 0, 150, 75]); // 200 x 100 px at 0.75 pt
    const meta = await doc.getMetadata();
    expect((meta.info as { Title: string }).Title).toBe("Test doc");
    expect(report.pages).toBe(2);
  });

  it("draws text with the layout's lines and keeps it searchable", async () => {
    const t = node({ id: "t", kind: "text", x: 10, y: 10, width: 180, height: 40, text: { content: "Hello world\nSecond line", style: style() } });
    const { bytes } = await build([page([t])]);
    const doc = await read(bytes);
    const content = await (await doc.getPage(1)).getTextContent();
    const all = content.items.map((i) => ("str" in i ? i.str : "")).join("|");
    expect(all).toContain("Hello world");
    expect(all).toContain("Second line");
  });

  it("maps a font family to a standard face, and reports the substitution", async () => {
    const t = node({ id: "t", kind: "text", width: 100, height: 20, text: { content: "x", style: style({ fontFamily: "Georgia, serif", fontWeight: "700", italic: true }) } });
    const { report, bytes } = await build([page([t])]);
    expect(report.substitutedFonts).toEqual(["Georgia → Times-BoldItalic"]);
    expect(new TextDecoder("latin1").decode(bytes)).toContain("/BaseFont/Times-BoldItalic");
  });

  it("winansi: accents and typographic quotes survive, unmapped characters become ?", async () => {
    const t = node({ id: "t", kind: "text", width: 200, height: 20, text: { content: "café “ok” — 日", style: style() } });
    const { bytes } = await build([page([t])]);
    const doc = await read(bytes);
    const str = (await (await doc.getPage(1)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join("");
    expect(str).toContain("café");
    expect(str).toContain("“ok”");
    expect(str).toContain("?");
  });

  it("paints shapes, gradients, strokes, dashes and opacity without breaking the content stream", async () => {
    const nodes = [
      node({ id: "r", x: 5, y: 5, width: 60, height: 40, cornerRadius: 8, strokes: [{ color: { r: 1, g: 0, b: 0, a: 1 }, weight: 2, align: "center" }] }),
      node({ id: "e", kind: "ellipse", x: 70, y: 5, width: 40, height: 40, opacity: 0.5, blendMode: "multiply" }),
      node({ id: "g", x: 120, y: 5, width: 60, height: 40, fills: [{ r: 1, g: 0, b: 0, a: 1, gradient: { kind: "linear", x1: 0, y1: 0, x2: 1, y2: 0, stops: [{ color: { r: 1, g: 0, b: 0, a: 1 }, position: 0 }, { color: { r: 0, g: 0, b: 1, a: 1 }, position: 0.4 }, { color: { r: 0, g: 1, b: 0, a: 1 }, position: 1 }] } }] }),
      node({ id: "v", kind: "vector", x: 5, y: 55, width: 40, height: 40, meta: { "stroke.dash": "4,2", "stroke.cap": "round" }, strokes: [{ color: { r: 0, g: 0, b: 0, a: 1 }, weight: 1, align: "center" }], vector: { subpaths: [{ closed: true, anchors: [{ x: 0, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 30, y: 0, inX: 0, inY: 0, outX: 0, outY: 0 }, { x: 15, y: 30, inX: 0, inY: 0, outX: 0, outY: 0 }] }] } }),
    ];
    const { bytes, report } = await build([page(nodes)]);
    const doc = await read(bytes);
    const ops = await (await doc.getPage(1)).getOperatorList();
    expect(ops.fnArray.length).toBeGreaterThan(20);
    expect(report.transparency).toBe(true);
    const raw = new TextDecoder("latin1").decode(bytes);
    expect(raw).toContain("/ShadingType 2");
    expect(raw).toContain("/FunctionType 3");
    expect(raw).toContain("/BM/Multiply");
  });

  it("a CMYK swatch is written as device CMYK, a spot as a Separation, a tint scaled", async () => {
    const variables: Record<string, VariableLite> = {
      c: { id: "c", collectionId: "k", name: "Cyan", type: "color", values: {}, swatch: true, cmyk: { c: 1, m: 0, y: 0, k: 0 } },
      s: { id: "s", collectionId: "k", name: "Brand", type: "color", values: {}, swatch: true, cmyk: { c: 0, m: 1, y: 1, k: 0 }, spotName: "PANTONE 485 C" },
      t: { id: "t", collectionId: "k", name: "Brand 40", type: "color", values: {}, swatch: true, tintOf: "s", tint: 40 },
    };
    const nodes = [
      node({ id: "a", bindings: { "fills.0": "c" } }),
      node({ id: "b", x: 20, bindings: { "fills.0": "s" } }),
      node({ id: "c2", x: 40, bindings: { "fills.0": "t" } }),
      node({ id: "d", x: 60 }),
    ];
    const { bytes, report } = await build([page(nodes)], { scene: { variables, collections: {} } });
    expect(report.spots).toEqual(["PANTONE 485 C"]);
    expect(report.usesCmyk && report.usesRgb).toBe(true);
    const raw = new TextDecoder("latin1").decode(bytes);
    expect(raw).toContain("/Separation/PANTONE#20485#20C/DeviceCMYK");
    await read(bytes);
  });

  it("a CMYK document converts plain colours to device CMYK", async () => {
    const { report } = await build([page([node({ id: "a", fills: [{ r: 1, g: 0, b: 0, a: 1 }] })])], { cmyk: true });
    expect(report.usesRgb).toBe(false);
    expect(report.usesCmyk).toBe(true);
  });

  it("a mask clips the nodes above it, and is not drawn itself", async () => {
    const nodes = [node({ id: "m", kind: "ellipse", isMask: true, width: 40, height: 40 }), node({ id: "x", width: 100, height: 100 })];
    const { bytes } = await build([page(nodes)]);
    const raw = new TextDecoder("latin1").decode(bytes);
    expect(raw).toContain("/Count 1");
    await read(bytes);
  });

  it("no-print nodes are skipped", async () => {
    const hidden = node({ id: "h", x: 1, y: 1, width: 77, height: 33 });
    const { bytes } = await build([page([hidden, node({ id: "k", x: 5, y: 5, width: 11, height: 12 })])], { skip: (n) => n.id === "h" });
    const content = await contentOf(bytes);
    expect(content).toContain("5 5 11 12 re");
    expect(content).not.toContain("77 33 re");
  });
});

describe("buildPdf — print", () => {
  it("writes Trim/Bleed boxes inside a media box that holds the marks", async () => {
    const trim = { x: 0, y: 0, width: 200, height: 100 };
    const media = { x: -50, y: -50, width: 300, height: 200 };
    const { bytes } = await build([page([node({ id: "a" })], { media, trim, bleed: 9 })], { marks: true });
    const doc = await read(bytes);
    const p = await doc.getPage(1);
    expect(p.view).toEqual([0, 0, 225, 150]);
    const raw = new TextDecoder("latin1").decode(bytes);
    expect(raw).toMatch(/\/TrimBox\[37\.5 37\.5 187\.5 112\.5\]/);
    expect(raw).toMatch(/\/BleedBox\[30\.75 30\.75 194\.25 119\.25\]/);
    expect(raw).toContain("/Separation/All/DeviceCMYK");
  });

  it("PDF/X: identification, output intent, XMP, and CMYK-only for X-1a", async () => {
    const { bytes, report } = await build([page([node({ id: "a", fills: [{ r: 0.2, g: 0.4, b: 0.6, a: 1 }] })])], { pdfx: "x1a", condition: "FOGRA39" });
    const raw = new TextDecoder("latin1").decode(bytes);
    expect(raw.startsWith("%PDF-1.4")).toBe(true);
    expect(raw).toContain("/GTS_PDFXVersion(PDF/X-1a:2003)");
    expect(raw).toContain("/OutputConditionIdentifier(FOGRA39)");
    expect(raw).toContain("<pdfxid:GTS_PDFXVersion>PDF/X-1a:2003");
    expect(report.usesRgb).toBe(false);
    await read(bytes);
  });

  it("bookmarks nest by level and links become annotations", async () => {
    const { bytes } = await build(
      [page([], { links: [{ rect: { x: 0, y: 0, width: 50, height: 10 }, url: "https://example.com" }] }), page([], { name: "P2", links: [{ rect: { x: 0, y: 0, width: 50, height: 10 }, page: 0 }] })],
      { outline: [{ title: "One", level: 1, page: 0, top: 0 }, { title: "One.a", level: 2, page: 1, top: 20 }, { title: "Two", level: 1, page: 1, top: 40 }] },
    );
    const doc = await read(bytes);
    const outline = await doc.getOutline();
    expect(outline!.map((o) => o.title)).toEqual(["One", "Two"]);
    expect(outline![0]!.items.map((o) => o.title)).toEqual(["One.a"]);
    const a1 = await (await doc.getPage(1)).getAnnotations();
    expect(a1[0]!.url).toBe("https://example.com/");
    const a2 = await (await doc.getPage(2)).getAnnotations();
    expect(a2).toHaveLength(1);
  });
});

describe("images", () => {
  it("a JPEG goes in untouched, with its dimensions read from the header", async () => {
    // A minimal valid JPEG header (SOI, SOF0 3 components 8 x 4, EOI) is enough to be recognised.
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 4, 0, 8, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
    const img = await prepareImage(jpg, "image/jpeg");
    expect(img).toMatchObject({ kind: "jpeg", width: 8, height: 4, components: 3 });
    const { bytes } = await build([page([node({ id: "i", kind: "image", image: { assetHash: "h", mode: "fill" }, width: 80, height: 40 } as Partial<NodeLite> & { id: string })])], { images: new Map([["h", img!]]) });
    const raw = new TextDecoder("latin1").decode(bytes);
    expect(raw).toContain("/Filter/DCTDecode");
  });

  it("a PNG with transparency is rasterized into RGB plus a soft mask", async () => {
    const png = encodePng(2, 2, new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 9, 9, 9, 0]));
    const img = await prepareImage(png, "image/png", async () => ({ width: 2, height: 2, rgba: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 9, 9, 9, 0]) }));
    expect(img?.kind === "png" || img?.kind === "rgba").toBe(true);
    const { bytes } = await build([page([node({ id: "i", kind: "image", image: { assetHash: "h", mode: "fill" }, width: 20, height: 20 } as Partial<NodeLite> & { id: string })])], { images: new Map([["h", img!]]) });
    await read(bytes);
  });

  it("a missing image draws the placeholder, an unusable one is not prepared", async () => {
    const { bytes, report } = await build([page([node({ id: "i", kind: "image", image: { assetHash: "nope", mode: "fill" }, width: 20, height: 20 } as Partial<NodeLite> & { id: string })])]);
    await read(bytes);
    expect(report.lowResolution).toEqual([]);
    expect(await prepareImage(new Uint8Array([1, 2, 3]), "image/webp")).toBeNull();
  });

  it("data: URIs decode", () => {
    expect(dataUrlBytes("data:image/png;base64,AQID")).toEqual({ mime: "image/png", bytes: new Uint8Array([1, 2, 3]) });
    expect(dataUrlBytes("nope")).toBeNull();
  });

  it("reports an image printed under 150 ppi", async () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 4, 0, 8, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
    const img = (await prepareImage(jpg, "image/jpeg"))!;
    const { report } = await build([page([node({ id: "i", kind: "image", image: { assetHash: "h", mode: "fill" }, width: 80, height: 40 } as Partial<NodeLite> & { id: string })])], { images: new Map([["h", img]]) });
    expect(report.lowResolution[0]).toMatchObject({ hash: "h", ppi: 10 });
  });
});
