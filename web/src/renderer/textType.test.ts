import { describe, it, expect } from "vitest";
import {
  BULLET, caseText, fontFeaturesOf, isSmallCaps, layoutText, ligaturesOff, placeTextLines, runsOf, piecesOfLine, styledMeasure, textPaintBounds,
} from "./text";
import { isValidFontFeatures } from "../store/typography";
import { toPbTextStyle, toTextStyleLite } from "../store/types";
import type { NodeLite, TextStyleLite } from "../store/types";

// 10px per character, like text.test.ts.
const measure = (s: string) => s.length * 10;

function style(over: Partial<TextStyleLite> = {}): TextStyleLite {
  return { fontFamily: "Inter, sans-serif", fontSize: 10, fontWeight: "400", lineHeight: 1.2, align: "left", ...over };
}

function node(content: string, st: TextStyleLite, over: Partial<NodeLite> = {}): NodeLite {
  return {
    id: "t", parentId: "page1", orderKey: "a0", name: "Text", visible: true, opacity: 1,
    x: 100, y: 50, width: 200, height: 40, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false,
    text: { content, style: st },
    ...over,
  };
}

describe("text case", () => {
  it("transforms upper, lower and title; leaves the rest and small caps alone", () => {
    expect(caseText("Hello wORLD", style({ textCase: "upper" }))).toBe("HELLO WORLD");
    expect(caseText("Hello wORLD", style({ textCase: "lower" }))).toBe("hello world");
    expect(caseText("hello wORLD-x it's", style({ textCase: "title" }))).toBe("Hello World-X It's");
    expect(caseText("Hello", style({ textCase: "smallCaps" }))).toBe("Hello");
    expect(caseText("Hello", style())).toBe("Hello");
  });

  it("lays out the cased glyphs, content untouched", () => {
    const l = layoutText(measure, "ab cd", style({ textCase: "upper" }), 1000);
    expect(l.lines).toEqual(["AB CD"]);
  });

  it("splits small caps into capitals at 0.8 and measures them", () => {
    const st = style({ textCase: "smallCaps" });
    expect(isSmallCaps(st)).toBe(true);
    expect(runsOf("Ab c", st)).toEqual([
      { text: "A", scale: 1 }, { text: "B", scale: 0.8 }, { text: " ", scale: 1 }, { text: "C", scale: 0.8 },
    ]);
    // 2 full-size glyphs + 2 small ones.
    expect(styledMeasure(measure, st)("Ab c")).toBeCloseTo(10 + 8 + 10 + 8);
  });

  it("treats the smcp feature as small caps unless it is switched off", () => {
    expect(isSmallCaps(style({ fontFeatures: '"smcp"' }))).toBe(true);
    expect(isSmallCaps(style({ fontFeatures: '"smcp" 0' }))).toBe(false);
  });
});

describe("super and subscript", () => {
  it("draws every run at 0.65 and shifts the baseline", () => {
    const up = placeTextLines(measure, node("ab", style({ textScript: "super" })))[0];
    const down = placeTextLines(measure, node("ab", style({ textScript: "sub" })))[0];
    const plain = placeTextLines(measure, node("ab", style()))[0];
    expect(up.width).toBeCloseTo(13);
    const [seg] = piecesOfLine(up);
    expect(seg.scale).toBe(0.65);
    expect(seg.y).toBeLessThan(plain.y);
    expect(piecesOfLine(down)[0].y).toBeGreaterThan(plain.y);
  });

  it("keeps a plain line free of segments", () => {
    expect(placeTextLines(measure, node("ab", style()))[0].pieces).toBeUndefined();
  });
});

describe("lists and indent", () => {
  it("puts a bullet before each paragraph and hangs the text after the marker column", () => {
    const lines = placeTextLines(measure, node("a\nb", style({ listKind: "bullet" })));
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      const [marker, text] = piecesOfLine(l);
      expect(marker.text).toBe(BULLET);
      expect(marker.x).toBe(100);
      // marker column: max(0.9em, marker width 10) + 0.4em gap
      expect(text.x).toBeCloseTo(100 + 10 + 4);
    }
  });

  it("numbers the non-empty paragraphs in order", () => {
    const l = layoutText(measure, "a\n\nb\nc", style({ listKind: "numbered" }), 1000);
    expect(l.markers).toEqual(["1.", "", "2.", "3."]);
  });

  it("narrows the wrap by the lead and moves the text by the indent", () => {
    const st = style({ indent: 20 });
    const l = layoutText(measure, "aaa bbb", st, 70);
    expect(l.lines).toEqual(["aaa", "bbb"]); // 50px left: "aaa bbb" (70) no longer fits
    expect(l.leads).toEqual([20, 20]);
    expect(placeTextLines(measure, node("aaa bbb", st, { width: 70 }))[0].x).toBe(120);
  });

  it("includes the marker in the paint bounds", () => {
    const b = textPaintBounds((s) => s.length * 10, node("a", style({ listKind: "bullet", indent: 0 }), { x: 0, width: 100 }));
    expect(b.x).toBe(0);
  });
});

describe("inset and vertical alignment", () => {
  it("insets the text and wraps inside the padded box", () => {
    const line = placeTextLines(measure, node("a", style({ inset: 8 })))[0];
    expect(line.x).toBe(108);
    const wrapped = layoutText(measure, "aaa bbb", style(), 70 - 2 * 8);
    expect(wrapped.lines).toEqual(["aaa", "bbb"]);
  });

  it("centres and bottom-aligns in a taller box", () => {
    const top = placeTextLines(measure, node("a", style()))[0].y;
    const mid = placeTextLines(measure, node("a", style({ verticalAlign: "middle" })))[0].y;
    const bot = placeTextLines(measure, node("a", style({ verticalAlign: "bottom" })))[0].y;
    expect(mid - top).toBeCloseTo((40 - 12) / 2);
    expect(bot - top).toBeCloseTo(40 - 12);
    // A text taller than its box stays at the top.
    const tall = placeTextLines(measure, node("a\nb\nc\nd", style({ verticalAlign: "bottom" }), { height: 10 }))[0].y;
    expect(tall).toBe(placeTextLines(measure, node("a\nb\nc\nd", style(), { height: 10 }))[0].y);
  });
});

describe("OpenType features", () => {
  it("validates the feature string and ignores a malformed one", () => {
    for (const ok of ["", '"liga" 0', '"liga" 0, "tnum", "ss01" 1']) expect(isValidFontFeatures(ok)).toBe(true);
    for (const bad of ['"liga";color:red', '"ligature"', '"liga" x', '"a","", "b"']) expect(isValidFontFeatures(bad)).toBe(false);
    expect(fontFeaturesOf(style({ fontFeatures: '"tnum"' }))).toBe('"tnum"');
    expect(fontFeaturesOf(style({ fontFeatures: "a;b" }))).toBe("");
    expect(ligaturesOff(style({ fontFeatures: '"liga" 0' }))).toBe(true);
    expect(ligaturesOff(style({ fontFeatures: '"liga"' }))).toBe(false);
  });
});

describe("model round trip", () => {
  it("carries every extra through the protobuf shape and back", () => {
    const full = style({
      textCase: "smallCaps", textScript: "sub", listKind: "numbered", indent: 12, fontFeatures: '"tnum"', verticalAlign: "bottom", inset: 3,
    });
    expect(toTextStyleLite(toPbTextStyle(full) as never)).toEqual(full);
    // An unextended style stays free of the extras (key-for-key identical to before).
    const plain = toTextStyleLite(toPbTextStyle(style()) as never);
    expect(Object.keys(plain).sort()).toEqual(["align", "fontFamily", "fontSize", "fontWeight", "lineHeight"]);
  });
});
