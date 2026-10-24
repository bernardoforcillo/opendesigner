import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeFont, mul, pdfPageToSvg, type PdfPageInput } from "./pdfToSvg";
import { importSvg } from "../svg/importSvg";

// A tiny operator table with the pdf.js 4.x numbering.
const OPS = {
  save: 10, restore: 11, transform: 12, moveTo: 13, lineTo: 14, curveTo: 15, curveTo2: 16, curveTo3: 17,
  closePath: 18, rectangle: 19, constructPath: 91, endPath: 28, fill: 22, eoFill: 23, stroke: 20, closeStroke: 21,
  fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26, closeEOFillStroke: 27, clip: 29, eoClip: 30,
  setFillRGBColor: 59, setStrokeRGBColor: 58, setLineWidth: 2, setLineCap: 3, setLineJoin: 4, setMiterLimit: 5,
  setDash: 6, setGState: 9, showText: 44, showSpacedText: 45, paintImageXObject: 85, paintInlineImageXObject: 86,
  setFillColorN: 55, paintShading: 89,
} as const;
const V = [1, 0, 0, -1, 0, 200] as const; // 200pt high page, y flipped

function page(ops: [number, unknown[]][], extra: Partial<PdfPageInput> = {}): PdfPageInput {
  return {
    width: 300, height: 200, viewTransform: V, OPS,
    fnArray: ops.map((o) => o[0]), argsArray: ops.map((o) => o[1]), text: [], ...extra,
  };
}

describe("pdfPageToSvg", () => {
  it("turns a filled rectangle into a <rect> in top-left coordinates", () => {
    const { svg } = pdfPageToSvg(page([
      [OPS.setFillRGBColor, [255, 128, 0]],
      [OPS.constructPath, [[OPS.rectangle], [20, 20, 100, 60], [20, 20, 120, 80]]],
      [OPS.fill, []],
    ]));
    expect(svg).toContain('<rect x="20" y="120" width="100" height="60" fill="#ff8000"/>');
    expect(svg).toContain('id="page-background"');
  });

  it("writes strokes with width, dash, cap and opacity, scaled by the matrix", () => {
    const { svg } = pdfPageToSvg(page([
      [OPS.save, []], [OPS.transform, [2, 0, 0, 2, 0, 0]],
      [OPS.setStrokeRGBColor, [0, 0, 255]], [OPS.setLineWidth, [3]], [OPS.setDash, [[4, 2], 0]], [OPS.setLineCap, [1]],
      [OPS.setGState, [[["CA", 0.5]]]],
      [OPS.constructPath, [[OPS.moveTo, OPS.lineTo], [0, 0, 10, 0], [0, 0, 10, 0]]],
      [OPS.stroke, []], [OPS.restore, []],
    ]));
    expect(svg).toContain('stroke="#0000ff"');
    expect(svg).toContain('stroke-width="6"');
    expect(svg).toContain('stroke-dasharray="8 4"');
    expect(svg).toContain('stroke-linecap="round"');
    expect(svg).toContain('stroke-opacity="0.5"');
    expect(svg).toContain('d="M0 200L20 200"');
  });

  it("keeps curves, closes fills, honours the even-odd rule and restores state", () => {
    const { svg } = pdfPageToSvg(page([
      [OPS.save, []], [OPS.setFillRGBColor, [1, 2, 3]], [OPS.restore, []],
      [OPS.constructPath, [[OPS.moveTo, OPS.curveTo, OPS.curveTo3], [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5], [0, 0, 5, 5]]],
      [OPS.eoFill, []],
    ]));
    expect(svg).toContain("fill-rule=\"evenodd\"");
    expect(svg).toContain('fill="#000000"'); // the restore dropped the colour
    expect(svg).toContain("C");
    expect(svg).toMatch(/Z"/);
  });

  it("places text where its showText was, with colour, size and weight", () => {
    const { svg, warnings } = pdfPageToSvg(page(
      [
        [OPS.setFillRGBColor, [0, 128, 0]], [OPS.showText, []],
        [OPS.constructPath, [[OPS.rectangle], [0, 0, 5, 5], [0, 0, 5, 5]]], [OPS.fill, []],
      ],
      { text: [{ str: "Hello & <you>", transform: [18, 0, 0, 18, 30, 100], width: 80, fontName: "f1" }], fontNames: { f1: "ABCDEF+Arial-BoldItalicMT" } },
    ));
    expect(svg).toContain('x="30" y="100"');
    expect(svg).toContain('font-size="18"');
    expect(svg).toContain('font-weight="700"');
    expect(svg).toContain('font-style="italic"');
    expect(svg).toContain('fill="#008000"');
    expect(svg).toContain("Hello &amp; &lt;you&gt;");
    expect(svg.indexOf("<text")).toBeLessThan(svg.indexOf("<rect x=\"0\" y=\"195\""));
    expect(warnings).toContain("fonts are matched by name, not embedded");
  });

  it("rotates rotated text and drops empty runs", () => {
    const { svg } = pdfPageToSvg(page([], { text: [
      { str: "up", transform: [0, 10, -10, 0, 50, 50], width: 20, fontName: "f" },
      { str: "  ", transform: [10, 0, 0, 10, 0, 0], width: 0, fontName: "f" },
    ] }));
    expect(svg).toContain("rotate(");
    expect(svg.match(/<text/g)).toHaveLength(1);
  });

  it("places images and warns about what it drops", () => {
    const { svg, warnings } = pdfPageToSvg(page(
      [
        [OPS.save, []], [OPS.transform, [100, 0, 0, 50, 10, 20]], [OPS.paintImageXObject, ["img_1", 4, 4]], [OPS.restore, []],
        [OPS.paintImageXObject, ["missing", 1, 1]],
        [OPS.constructPath, [[OPS.rectangle], [0, 0, 1, 1], [0, 0, 1, 1]]], [OPS.clip, []], [OPS.endPath, []],
        [OPS.setFillColorN, ["Pattern"]],
      ],
      { images: { img_1: "data:image/png;base64,AAAA" } },
    ));
    expect(svg).toContain('<image x="10" y="130" width="100" height="50"');
    expect(warnings).toEqual(expect.arrayContaining(["clipping was not carried over", "some images could not be read", "gradients and patterns were replaced by a solid colour"]));
  });
});

describe("helpers", () => {
  it("composes matrices with the new transform applied first", () => {
    expect(mul([1, 0, 0, 1, 10, 0], [2, 0, 0, 2, 0, 0])).toEqual([2, 0, 0, 2, 10, 0]);
  });
  it("reads family, weight and style from a PDF font name", () => {
    expect(describeFont("ABCDEF+TimesNewRomanPS-BoldMT", "serif")).toMatchObject({ bold: true, italic: false });
    expect(describeFont("Courier", "sans-serif").family).toContain("monospace");
    expect(describeFont(undefined, "serif").family).toBe("serif");
  });
});

describe("with real pdf.js on a generated PDF", () => {
  it("produces SVG that the importer turns into rect, vector and text nodes", async () => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const doc = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(join(process.cwd(), "src/pdf/__fixtures__/sample.pdf"))), useWorkerFetch: false, isEvalSupported: false, verbosity: 0 }).promise;
    const p = await doc.getPage(1);
    const vp = p.getViewport({ scale: 1 });
    const ops = await p.getOperatorList();
    const content = await p.getTextContent();
    const { svg } = pdfPageToSvg({
      width: vp.width, height: vp.height, viewTransform: vp.transform as never,
      fnArray: ops.fnArray, argsArray: ops.argsArray, OPS: pdfjs.OPS as never,
      text: content.items.filter((i) => "str" in i) as never,
    });
    expect(svg).toContain("Hello PDF");
    const res = importSvg(svg, { scale: 1, at: { x: 0, y: 0 }, parentId: "pg", docId: "d" });
    const kinds = res.ops.map((o) => (o.kind.case === "createNode" ? o.kind.value.node?.shape.case : ""));
    expect(kinds).toEqual(expect.arrayContaining(["rect", "text"]));
    expect(kinds.filter((k) => k === "vector").length).toBeGreaterThanOrEqual(2);
    expect(res.size).toEqual({ width: 300, height: 200 });
  });
});
