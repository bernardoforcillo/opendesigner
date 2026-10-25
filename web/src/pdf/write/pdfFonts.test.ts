import { describe, it, expect } from "vitest";
import { loadFixtureFonts } from "../testFonts";
import { sfntKind } from "../sfnt";
import { PdfFonts, readFontMetrics, standardFontName, toUnicodeCMap } from "./pdfFonts";
import { buildPdf } from "./pdfDocument";
import type { NodeLite, TextStyleLite } from "../../store/types";

const style = (over: Partial<TextStyleLite> = {}): TextStyleLite => ({ fontFamily: "Helvetica", fontSize: 16, fontWeight: "400", lineHeight: 1.2, align: "left", ...over });

describe("standard faces", () => {
  it("map generic families to Helvetica, Times or Courier with weight and slant", () => {
    expect(standardFontName(style({ fontFamily: "Inter, sans-serif" }))).toBe("Helvetica");
    expect(standardFontName(style({ fontFamily: "Inter", fontWeight: "700" }))).toBe("Helvetica-Bold");
    expect(standardFontName(style({ fontFamily: "Menlo", italic: true }))).toBe("Courier-Oblique");
    expect(standardFontName(style({ fontFamily: "Georgia", fontWeight: "700", italic: true }))).toBe("Times-BoldItalic");
    expect(standardFontName(style({ fontFamily: "Garamond" }))).toBe("Times-Roman");
  });
});

describe("toUnicode", () => {
  it("lists glyph -> code point pairs, astral ones as surrogates", () => {
    const cmap = toUnicodeCMap(new Map([[5, 0x41], [9, 0x1f600], [0, 0x20]]));
    expect(cmap).toContain("<0005> <0041>");
    expect(cmap).toContain("<0009> <d83dde00>");
    expect(cmap).not.toContain("<0000> <0020>");
    expect(cmap).toContain("begincodespacerange");
  });
});

describe("an uploaded font", () => {
  it("is embedded with widths and a ToUnicode map, and its text reads back", async () => {
    const fixtures = await loadFixtureFonts();
    const usable = fixtures.map((f) => ({ f, m: sfntKind(f.data) ? readFontMetrics(f.data) : null })).find((x) => x.m);
    expect(usable).toBeTruthy();
    const { f, m } = usable!;
    const word = [...f.text].find((c) => m!.glyph(c.codePointAt(0)!) !== 0 && c.trim() !== "") ?? "";
    expect(word).not.toBe("");
    const face = { id: "f1", family: "Fixture", weight: "400", style: "normal" as const, assetHash: "x" };
    const fonts = new PdfFonts([{ face, data: f.data }]);
    const ref = fonts.fontFor(style({ fontFamily: "Fixture, sans-serif" }));
    expect(ref.embedded).toBe(true);
    expect(ref.encode(word)).toMatch(/^<[0-9a-f]{4}>$/);
    expect(fonts.missingGlyphs.size).toBe(0);
    ref.encode("\u{1F600}");
    expect(fonts.missingGlyphs.size).toBe(1);

    const n = { id: "t", parentId: "p", orderKey: "a", name: "t", visible: true, opacity: 1, x: 0, y: 0, width: 100, height: 30, rotation: 0, fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false, text: { content: word, style: style({ fontFamily: "Fixture" }) } } as NodeLite;
    const { bytes, report } = await buildPdf({
      pages: [{ name: "p", media: { x: 0, y: 0, width: 100, height: 30 }, trim: { x: 0, y: 0, width: 100, height: 30 }, bleed: 0, nodes: [n] }],
      images: new Map(), faces: [{ face, data: f.data }], scene: { variables: {}, collections: {} }, measure: (s) => s.length * 8, title: "t", created: new Date(0),
    });
    const raw = Buffer.from(bytes).toString("latin1");
    expect(raw).toMatch(/\/FontFile[23] \d+ 0 R/);
    expect(raw).toContain("/Encoding/Identity-H");
    expect(raw).toContain("/ToUnicode");
    expect(report.substitutedFonts).toEqual([]);
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: bytes.slice(), useWorkerFetch: false, isEvalSupported: false, verbosity: 0 }).promise;
    const items = (await (await doc.getPage(1)).getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join("");
    expect(items).toContain(word);
  });

  it("garbage is not a font", () => {
    expect(readFontMetrics(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
  });
});
