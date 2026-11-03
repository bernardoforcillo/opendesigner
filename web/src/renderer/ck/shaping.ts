import type { Canvas, CanvasKit, Font, Paint, Paragraph, ParagraphStyle, TypefaceFontProvider } from "canvaskit-wasm";

// SHAPING FOR THE GPU RENDERER.
//
// Skia's `Canvas.drawText` and `Font.getGlyphWidths` place glyphs one by one: no pair
// kerning, no ligatures. CanvasKit also ships Skia's Paragraph module (HarfBuzz), which
// does shape. This file measures and draws a piece of text through it, so the GPU
// renderer breaks lines and places glyphs like the 2D canvas does.
//
// The layout code (renderer/text.ts) is shared by both renderers and only asks for
// "the width of this string", so shaping enters through the measure function alone;
// drawing a piece as a Paragraph then puts the glyphs where that width assumed.
// Where Paragraph is not available (a CanvasKit build without it) every method
// falls back to the glyph-by-glyph behaviour, so nothing breaks, it just does not kern.

const MAX_CACHE = 20000;

export class TextShaper {
  private provider: TypefaceFontProvider | null = null;
  // Font file -> the family name it was registered under in the provider.
  private families = new Map<ArrayBuffer, string>();
  private widths = new Map<Font, Map<string, number>>();
  private next = 0;
  private bg: Paint | null = null;

  /** `bytesOf` returns the file a Font was made from: the provider registers fonts by their bytes. */
  constructor(
    private readonly CK: CanvasKit,
    private readonly bytesOf: (font: Font) => ArrayBuffer | undefined,
  ) {}

  /** Whether this CanvasKit build can shape (Paragraph + font provider). */
  get available(): boolean {
    return typeof this.CK.ParagraphBuilder?.MakeFromFontProvider === "function" && typeof this.CK.TypefaceFontProvider?.Make === "function";
  }

  private familyOf(font: Font): string | null {
    if (!this.available) return null;
    const bytes = this.bytesOf(font);
    if (!bytes) return null;
    let name = this.families.get(bytes);
    if (name) return name;
    this.provider ??= this.CK.TypefaceFontProvider.Make();
    name = `od-face-${this.next++}`;
    this.provider.registerFont(bytes, name);
    this.families.set(bytes, name);
    return name;
  }

  private build(font: Font, text: string, paint: Paint | null): Paragraph | null {
    if (!this.available) return null;
    const family = this.familyOf(font);
    if (!family || !this.provider) return null;
    const CK = this.CK;
    // CanvasKit's constructors fill the fields the embind layer insists on.
    const textStyle = new CK.TextStyle({ fontFamilies: [family], fontSize: font.getSize() });
    // No wrapping and no ellipsis: the caller already broke the lines.
    const style: ParagraphStyle = new CK.ParagraphStyle({ textStyle, maxLines: 1 });
    const builder = CK.ParagraphBuilder.MakeFromFontProvider(style, this.provider);
    if (paint) {
      this.bg ??= new CK.Paint();
      builder.pushPaintStyle(textStyle, paint, this.bg);
    }
    builder.addText(text);
    const p = builder.build();
    builder.delete();
    p.layout(1e6);
    return p;
  }

  /** The shaped advance of `text` in `font`, or the sum of glyph widths when shaping is unavailable. */
  measure(font: Font, text: string): number {
    let cache = this.widths.get(font);
    if (!cache) { cache = new Map(); this.widths.set(font, cache); }
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    let width: number | null = null;
    if (text !== "") {
      const p = this.build(font, text, null);
      if (p) { width = p.getMaxIntrinsicWidth(); p.delete(); }
    }
    if (width === null) {
      width = 0;
      if (text !== "") {
        const ws = font.getGlyphWidths(font.getGlyphIDs(text));
        for (let i = 0; i < ws.length; i++) width += ws[i];
      }
    }
    if (cache.size > MAX_CACHE) cache.clear();
    cache.set(text, width);
    return width;
  }

  /** Draws `text` shaped with its baseline at (x, y). False when it could not: the caller then uses drawText. */
  draw(sk: Canvas, font: Font, text: string, x: number, y: number, paint: Paint): boolean {
    if (text === "") return true;
    const p = this.build(font, text, paint);
    if (!p) return false;
    sk.drawParagraph(p, x, y - p.getAlphabeticBaseline());
    p.delete();
    return true;
  }

  /** Drops the measures cached for the fonts (a face arrived or was replaced). */
  reset(): void {
    this.widths.clear();
  }

  dispose(): void {
    this.bg?.delete();
    this.bg = null;
    this.provider?.delete();
    this.provider = null;
    this.families.clear();
    this.widths.clear();
  }
}
