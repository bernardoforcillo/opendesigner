// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CanvasKit, Font, Typeface } from "canvaskit-wasm";
import CanvasKitInit from "canvaskit-wasm";
import { TextShaper } from "@/renderer/ck/shaping";

const root = new URL("../../../", import.meta.url).pathname;

async function setup() {
  const CK: CanvasKit = await CanvasKitInit({ locateFile: (f) => `${root}node_modules/canvaskit-wasm/bin/${f}` });
  const data = readFileSync(`${root}public/fonts/Inter-400.ttf`);
  const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const face = CK.Typeface.MakeFreeTypeFaceFromData(bytes) as Typeface;
  const font = new CK.Font(face, 48);
  font.setSubpixel(true); // as FontBook does, so the plain sum is not rounded to whole pixels
  const shaper = new TextShaper(CK, () => bytes);
  return { CK, font, shaper };
}

const glyphSum = (font: Font, s: string) => font.getGlyphWidths(font.getGlyphIDs(s)).reduce((a, b) => a + b, 0);

describe("TextShaper (real CanvasKit)", () => {
  it("kerns pairs the glyph-by-glyph sum leaves apart", async () => {
    const { font, shaper } = await setup();
    expect(shaper.available).toBe(true);
    // "AV", "To" and "WA" are classic kerning pairs: shaped is narrower than the plain sum.
    for (const pair of ["AV", "To", "WA"]) {
      expect(shaper.measure(font, pair)).toBeLessThan(glyphSum(font, pair) - 0.5);
    }
  });

  it("adds up where nothing kerns, and handles empty text", async () => {
    const { font, shaper } = await setup();
    expect(shaper.measure(font, "")).toBe(0);
    expect(shaper.measure(font, "ll")).toBeCloseTo(2 * shaper.measure(font, "l"), 1);
  });
});

describe("TextShaper without Paragraph", () => {
  it("falls back to glyph widths and refuses to draw", () => {
    const CK = {} as unknown as CanvasKit;
    const shaper = new TextShaper(CK, () => undefined);
    const font = { getGlyphIDs: (s: string) => [...s].map(() => 1), getGlyphWidths: (ids: number[]) => ids.map(() => 10) } as unknown as Font;
    expect(shaper.available).toBe(false);
    expect(shaper.measure(font, "abc")).toBe(30);
    expect(shaper.draw({} as never, font, "abc", 0, 0, {} as never)).toBe(false);
  });
});
