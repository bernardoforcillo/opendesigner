import { describe, it, expect } from "vitest";
import { coversText, sfntKind, unicodeCmap } from "./sfnt";
import { loadFixtureFonts } from "./testFonts";

describe("sfnt", () => {
  it("recognises sfnt files by magic bytes only", () => {
    expect(sfntKind(new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("ttf");
    expect(sfntKind(new TextEncoder().encode("OTTO0000000000"))).toBe("otf");
    expect(sfntKind(new TextEncoder().encode("%PDF-1.7 not a font"))).toBeNull();
    expect(unicodeCmap(new Uint8Array(4))).toBeNull();
  });

  it("answers coverage from the real cmap of an extracted subset", async () => {
    const fonts = await loadFixtureFonts();
    const bold = fonts.find((f) => /DejaVuSans-Bold/.test(f.name))!;
    expect(coversText(bold.data, bold.text)).toBe(true);
    expect(coversText(bold.data, "Title è ü")).toBe(true);
    expect(coversText(bold.data, "日本")).toBe(false);
    // Spaces never need a glyph check.
    expect(coversText(bold.data, "   ")).toBe(true);
  });
});
