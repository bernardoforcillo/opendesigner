import { describe, it, expect } from "vitest";
import { fontString, layoutText, alignOffsetX, drawText, placeTextLines, textPaintBounds } from "./text";
import type { NodeLite, TextStyleLite } from "../store/types";

// DETERMINISTIC fake measure: 10px per character. It is the reason
// layoutText takes a measure function instead of the ctx -- layout is
// verifiable in Node without real fonts or canvas, and in production it receives
// (s) => ctx.measureText(s).width.
const measure = (s: string) => s.length * 10;

function style(over: Partial<TextStyleLite> = {}): TextStyleLite {
  return { fontFamily: "Inter, sans-serif", fontSize: 16, fontWeight: "400", lineHeight: 1.2, align: "left", ...over };
}

// All-zero style: it is what toTextStyleLite produces from an absent style
// (see store/types.ts), so the renderer really encounters it.
const zeroStyle: TextStyleLite = { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" };

function textNode(over: Partial<NodeLite> = {}, content = "aaa bbb ccc", st: TextStyleLite = style()): NodeLite {
  return {
    id: "t", parentId: "page1", orderKey: "a0", name: "Text", visible: true, opacity: 1,
    x: 100, y: 50, width: 200, height: 40, rotation: 0,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], kind: "text", cornerRadius: 0, clipsContent: false,
    text: { content, style: st },
    ...over,
  };
}

interface FillTextCall { text: string; x: number; y: number }

// jsdom does not implement canvas 2D: the ctx is a duck-type that records
// the calls. It is also the right way to test drawText, which must be asserted on the
// emitted calls, not on pixels.
function fakeCtx() {
  const calls: FillTextCall[] = [];
  const state = {
    font: "", textBaseline: "", textAlign: "", fillStyle: "",
    measureText: (s: string) => ({ width: measure(s) }),
    fillText: (t: string, x: number, y: number) => { calls.push({ text: t, x, y }); },
  };
  return { state, calls, ctx: state as unknown as CanvasRenderingContext2D };
}

describe("fontString", () => {
  it("builds a CSS font shorthand from the style", () => {
    expect(fontString(style({ fontWeight: "700" }))).toBe("700 16px Inter, sans-serif");
  });

  it("fills in the renderer defaults for an all-zero style", () => {
    // The model keeps the zero (see store/types.ts): the defaults belong to the
    // RENDERER, and this is where they get resolved.
    expect(fontString(zeroStyle)).toBe("400 16px Inter, sans-serif");
  });
});

describe("layoutText", () => {
  it("wraps greedily at maxWidth", () => {
    const l = layoutText(measure, "aaa bbb ccc", style(), 70);
    expect(l.lines).toEqual(["aaa bbb", "ccc"]);
    expect(l.width).toBe(70);
    expect(l.height).toBeCloseTo(2 * 19.2);
  });

  it("breaks a word wider than the box instead of looping forever", () => {
    const l = layoutText(measure, "aaaaaaaaaa", style(), 35);
    expect(l.lines).toEqual(["aaa", "aaa", "aaa", "a"]);
    expect(l.lines.join("")).toBe("aaaaaaaaaa");
  });

  it("terminates even when a single character does not fit", () => {
    // The infinite loop edge case: maxWidth narrower than a character.
    // At least one character per line, always -- overflowing is acceptable,
    // not terminating is not.
    const l = layoutText(measure, "abcde", style(), 5);
    expect(l.lines).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("keeps explicit newlines as lines, however short", () => {
    const l = layoutText(measure, "a\n\nb", style(), 1000);
    expect(l.lines).toEqual(["a", "", "b"]);
    expect(l.height).toBeCloseTo(3 * 19.2);
  });

  it("returns zero lines and zero height for empty content", () => {
    const l = layoutText(measure, "", style(), 200);
    expect(l.lines).toEqual([]);
    expect(l.height).toBe(0);
    expect(l.width).toBe(0);
    // The line height stays resolved: it serves the caret of an empty text.
    expect(l.lineHeight).toBeCloseTo(19.2);
  });

  it("resolves the line-height multiplier and the baseline inside the line box", () => {
    const def = layoutText(measure, "a", style(), 100);
    expect(def.lineHeight).toBeCloseTo(19.2);          // 0 => 1.2 (default del proto)
    expect(def.ascent).toBeCloseTo(14.4);              // half-leading 1.6 + 0.8em
    const wide = layoutText(measure, "a", style({ lineHeight: 2 }), 100);
    expect(wide.lineHeight).toBeCloseTo(32);
    expect(wide.ascent).toBeCloseTo(20.8);             // half-leading 8 + 0.8em
    expect(wide.ascent).toBeLessThan(wide.lineHeight); // the baseline sits inside the line
  });

  it("does not wrap when maxWidth is zero or negative", () => {
    // A just-created text node can have width 0: better one long line
    // than one line per character.
    expect(layoutText(measure, "aaa bbb ccc", style(), 0).lines).toEqual(["aaa bbb ccc"]);
    expect(layoutText(measure, "aaa bbb ccc", style(), -5).lines).toEqual(["aaa bbb ccc"]);
  });

  it("lets a trailing space hang past the wrap width", () => {
    // Typing "aaa bbb " the trailing space would take the line to 80 > 70 and
    // make an empty line appear below the text on every word. As in
    // browsers, the trailing space does not count for the wrap (and does not inflate the
    // measured width).
    const l = layoutText(measure, "aaa bbb ", style(), 70);
    expect(l.lines).toEqual(["aaa bbb "]);
    expect(l.width).toBe(70);
  });

  it("keeps the whitespace that opens a line", () => {
    // An "empty" line and a line "on which nothing has been placed yet"
    // are not the same thing: confusing them made the leading spaces vanish,
    // that is the indentation the user had just typed.
    expect(layoutText(measure, "  aaa", style(), 1000).lines).toEqual(["  aaa"]);
    expect(layoutText(measure, "aaa\n  bbb", style(), 1000).lines).toEqual(["aaa", "  bbb"]);
    expect(layoutText(measure, "aaa  bbb", style(), 1000).lines).toEqual(["aaa  bbb"]);
  });

  it("keeps a line made only of spaces", () => {
    const l = layoutText(measure, "  ", style(), 1000);
    expect(l.lines).toEqual(["  "]);
    expect(l.width).toBe(0); // spaces are not drawn: width 0
    expect(l.height).toBeCloseTo(19.2);
  });

  it("still terminates when a line opens with spaces", () => {
    // The preserved leading spaces must not send the breaker into a loop.
    // Of the two leading spaces one remains: the one at which the
    // wrap happens is consumed by the wrap itself, as in browsers.
    const l = layoutText(measure, "  aaaaaaaaaa", style(), 35);
    expect(l.lines).toEqual([" ", "aaa", "aaa", "aaa", "a"]);
  });

  it("wraps each paragraph independently", () => {
    const l = layoutText(measure, "aaa bbb\nccc ddd eee", style(), 70);
    expect(l.lines).toEqual(["aaa bbb", "ccc ddd", "eee"]);
  });
});

describe("alignOffsetX", () => {
  it("computes the per-line x offset for each alignment", () => {
    expect(alignOffsetX("left", 70, 200)).toBe(0);
    expect(alignOffsetX("center", 70, 200)).toBe(65);
    expect(alignOffsetX("right", 70, 200)).toBe(130);
  });

  it("falls back to left when the box has no width", () => {
    expect(alignOffsetX("right", 70, 0)).toBe(0);
    expect(alignOffsetX("center", 70, -10)).toBe(0);
  });
});

describe("drawText", () => {
  it("draws one fillText per line with an explicit baseline", () => {
    const f = fakeCtx();
    drawText(f.ctx, textNode({ width: 70 }));
    expect(f.state.font).toBe("400 16px Inter, sans-serif");
    // Never the default: `textBaseline` changes between browsers, and the lines' y
    // is computed by the layout assuming the alphabetic baseline.
    expect(f.state.textBaseline).toBe("alphabetic");
    expect(f.calls.map((c) => c.text)).toEqual(["aaa bbb", "ccc"]);
    expect(f.calls[0].x).toBe(100);
    expect(f.calls[0].y).toBeCloseTo(50 + 14.4);
    expect(f.calls[1].y).toBeCloseTo(50 + 14.4 + 19.2);
  });

  it("offsets each line for center alignment", () => {
    const f = fakeCtx();
    drawText(f.ctx, textNode({ width: 200 }, "aaa bbb\nc", style({ align: "center" })));
    expect(f.calls[0].x).toBe(100 + (200 - 70) / 2);
    expect(f.calls[1].x).toBe(100 + (200 - 10) / 2);
  });

  it("draws nothing for a non-text node or empty content", () => {
    const rect = fakeCtx();
    drawText(rect.ctx, { ...textNode(), kind: "rect", text: undefined });
    expect(rect.calls).toEqual([]);

    const empty = fakeCtx();
    drawText(empty.ctx, textNode({}, ""));
    expect(empty.calls).toEqual([]);
  });

  it("does not paint a line of only spaces but keeps its slot", () => {
    // Spaces are kept in the layout (they are content) but are not drawn.
    const f = fakeCtx();
    drawText(f.ctx, textNode({ width: 1000 }, "a\n  \nb"));
    expect(f.calls.map((c) => c.text)).toEqual(["a", "b"]);
    expect(f.calls[1].y - f.calls[0].y).toBeCloseTo(2 * 19.2);
  });

  it("skips empty lines but keeps their vertical slot", () => {
    const f = fakeCtx();
    drawText(f.ctx, textNode({ width: 1000 }, "a\n\nb"));
    expect(f.calls.map((c) => c.text)).toEqual(["a", "b"]);
    expect(f.calls[1].y - f.calls[0].y).toBeCloseTo(2 * 19.2);
  });
});

describe("placeTextLines", () => {
  it("reports the painted width of each line", () => {
    // The width serves whoever needs to know how much space the text occupies
    // (textPaintBounds): without it, they would measure a second time.
    const lines = placeTextLines(measure, textNode({ width: 70 }));
    expect(lines.map((l) => l.text)).toEqual(["aaa bbb", "ccc"]);
    expect(lines.map((l) => l.width)).toEqual([70, 30]);
  });

  it("measures the PAINTED text, without the trailing spaces", () => {
    const lines = placeTextLines(measure, textNode({ width: 1000 }, "aaa   "));
    expect(lines[0].width).toBe(30);
  });
});

// The model's box does not limit text drawing: drawText places line i
// at y = n.y + ascent + i * lineHeight without looking at n.height, drawScene does not
// clip, and nobody rewrites the measured height into the node. Whoever draws
// notices it right away (the canvas is as large as the window); whoever CROPS --
// the export, which sizes the file on the bounds -- would silently throw away the text
// below.
describe("textPaintBounds", () => {
  it("unites the model box with the lines the layout actually paints", () => {
    // Box of ONE line (19.2) and two lines of content: the everyday case,
    // because a node created with a click is born one line tall.
    const b = textPaintBounds(measure, textNode({ x: 0, y: 0, width: 70, height: 19.2 }));
    expect(b).toEqual({ x: 0, y: 0, width: 70, height: 38.4 });
  });

  it("keeps a box that is larger than the text", () => {
    // Union, not replacement: a box dragged by the user stays part of
    // what is seen, therefore of what is exported.
    const b = textPaintBounds(measure, textNode({ x: 0, y: 0, width: 200, height: 100 }, "a"));
    expect(b).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });

  it("follows a line that overflows to the right when there is no wrap width", () => {
    // Width 0 = no wrap (layoutText): the line is as long as it is.
    const b = textPaintBounds(measure, textNode({ x: 0, y: 0, width: 0, height: 0 }, "ciao"));
    expect(b).toEqual({ x: 0, y: 0, width: 40, height: 19.2 });
  });

  it("follows a right-aligned overflow to the LEFT of the box", () => {
    // breakWord never rejects a single character (or it would not terminate): a
    // glyph wider than the box overflows, and with align=right it overflows to the left.
    const b = textPaintBounds(
      measure,
      textNode({ x: 0, y: 0, width: 5, height: 0 }, "ab", style({ align: "right" })),
    );
    expect(b).toEqual({ x: -5, y: 0, width: 10, height: 38.4 });
  });

  it("is the plain box for an empty text and for a shape", () => {
    const box = { x: 1, y: 2, width: 3, height: 4 };
    expect(textPaintBounds(measure, textNode({ ...box }, ""))).toEqual(box);
    expect(textPaintBounds(measure, { ...textNode({ ...box }), kind: "rect", text: undefined }))
      .toEqual(box);
  });
});
