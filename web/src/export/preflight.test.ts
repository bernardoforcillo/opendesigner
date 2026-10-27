import { describe, it, expect } from "vitest";
import { hasErrors, preflightReport, preflightScene } from "@/export/preflight";
import { emptyScene } from "@/store/types";
import type { NodeLite, SceneState } from "@/store/types";
import type { PdfReport } from "@/pdf/write/pdfDocument";

const text = (id: string, family: string, content = "x", over: Partial<NodeLite> = {}): NodeLite => ({
  id, parentId: "page1", orderKey: "a", name: id, visible: true, opacity: 1, x: 0, y: 0, width: 100, height: 20, rotation: 0,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false,
  text: { content, style: { fontFamily: family, fontSize: 16, fontWeight: "400", lineHeight: 1.2, align: "left" } }, ...over,
});
const sceneWith = (...nodes: NodeLite[]): SceneState => { const s = emptyScene("d", "Doc"); for (const n of nodes) s.nodes = s.nodes.set(n.id, n); return s; };
const codes = (l: { code: string }[]) => l.map((i) => i.code);

describe("preflightScene", () => {
  it("flags a font that is not uploaded, once per family, and makes it an error under PDF/X", () => {
    const s = sceneWith(text("a", "Garamond"), text("b", "Garamond"), text("c", "sans-serif"));
    const plain = preflightScene(s);
    expect(plain.filter((i) => i.code === "font-not-embedded")).toHaveLength(1);
    expect(plain[0]!.severity).toBe("warning");
    expect(preflightScene(s, { pdfx: "x4" }).find((i) => i.code === "font-not-embedded")!.severity).toBe("error");
  });
  it("accepts an uploaded family", () => {
    const s = sceneWith(text("a", "Garamond, serif"));
    s.fonts = { f: { id: "f", family: "garamond", weight: "400", style: "normal", assetHash: "h" } };
    expect(codes(preflightScene(s))).not.toContain("font-not-embedded");
  });
  it("finds overset text with a measure", () => {
    const s = sceneWith(text("a", "x", "aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd", { width: 100, height: 20 }));
    expect(codes(preflightScene(s, {}, (t) => t.length * 10))).toContain("overset");
    expect(codes(preflightScene(s))).not.toContain("overset");
  });
  it("wants a bleed when printing with bleed or marks, and sizes on pages", () => {
    const s = sceneWith();
    s.pages = [{ id: "page1", name: "One", width: 100, height: 100 }, { id: "p2", name: "Free" }];
    expect(codes(preflightScene(s))).toEqual(["page-unsized"]);
    expect(codes(preflightScene(s, { marks: true }))).toEqual(["no-bleed", "page-unsized"]);
  });
  it("mentions layers that do not print and spot colours", () => {
    const s = sceneWith();
    s.layers = [{ id: "l", name: "Notes", noPrint: true }];
    s.variables = { v: { id: "v", collectionId: "c", name: "Brand", type: "color", values: {}, swatch: true, spotName: "PANTONE 485 C" } };
    const c = codes(preflightScene(s));
    expect(c).toContain("no-print-layer");
    expect(c).toContain("spot-colours");
  });
});

describe("preflightReport", () => {
  const base: PdfReport = { pages: 1, pdfx: "none", substitutedFonts: [], missingGlyphs: [], embeddedFonts: 0, spots: [], usesRgb: false, usesCmyk: false, transparency: false, flattened: [], lowResolution: [] };
  it("reports resolution, transparency and RGB against the chosen mode", () => {
    const r = { ...base, transparency: true, usesRgb: true, lowResolution: [{ page: "One", hash: "h", ppi: 72 }], flattened: ["n"] };
    const x1a = preflightReport(r, { pdfx: "x1a" });
    expect(codes(x1a)).toEqual(["low-resolution", "transparency", "rgb", "effects"]);
    expect(hasErrors(x1a)).toBe(true);
    const x4 = preflightReport(r, { pdfx: "x4" });
    expect(codes(x4)).not.toContain("transparency");
    expect(hasErrors(preflightReport({ ...base, lowResolution: [{ page: "One", hash: "h", ppi: 72 }] }))).toBe(false);
  });
  it("reports unreadable assets", () => {
    expect(codes(preflightReport(base, {}, 2, 1))).toEqual(["missing-image", "font-unreadable"]);
  });
});
