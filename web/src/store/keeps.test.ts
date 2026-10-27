import { describe, it, expect } from "vitest";
import { keepBreak } from "@/store/keeps";
import type { ResolvedParagraph } from "@/store/types";

const base: ResolvedParagraph = { style: { fontFamily: "", fontSize: 16, fontWeight: "", lineHeight: 0, align: "left" }, spaceBefore: 0, spaceAfter: 0, indentFirst: 0, indentLeft: 0 };
const para = (over: Partial<ResolvedParagraph> = {}): ResolvedParagraph => ({ ...base, ...over });
// Lines of paragraphs with the given sizes: [3, 5] -> para 0 x3, para 1 x5.
const linesOf = (...sizes: number[]) => sizes.flatMap((n, p) => Array.from({ length: n }, () => ({ para: p })));

describe("keepBreak", () => {
  it("leaves the break alone when nothing is asked", () => {
    expect(keepBreak(linesOf(4, 4), 6, [para(), para()])).toBe(6);
    expect(keepBreak(linesOf(4), 4, [para()])).toBe(4);
  });
  it("keep lines together moves a split paragraph to the next frame", () => {
    expect(keepBreak(linesOf(2, 6), 5, [para(), para({ keepLinesTogether: true })])).toBe(2);
  });
  it("orphans: fewer than N lines at the bottom moves the whole paragraph", () => {
    expect(keepBreak(linesOf(2, 6), 3, [para(), para({ keepFirstLines: 2 })])).toBe(2);
    expect(keepBreak(linesOf(2, 6), 4, [para(), para({ keepFirstLines: 2 })])).toBe(4);
  });
  it("widows: fewer than N lines at the top of the next frame pulls the break up", () => {
    // 6 lines, 5 fit -> 1 left over; keep 2 -> break after 4.
    expect(keepBreak(linesOf(6), 5, [para({ keepLastLines: 2 })])).toBe(4);
  });
  it("widows that would break the orphan rule move the whole paragraph", () => {
    // 4 lines, 3 fit, keep last 2 -> would leave 2 at the bottom, but orphans want 3 -> all to next frame.
    expect(keepBreak(linesOf(1, 4), 4, [para(), para({ keepLastLines: 2, keepFirstLines: 3 })])).toBe(1);
  });
  it("keep with next moves a heading that would end the frame, chaining upward", () => {
    // para0 body x3, para1 heading x1 (keep with next), para2 heading x1 (keep with next), para3 body x3; 5 lines fit.
    const lines = linesOf(3, 1, 1, 3);
    expect(keepBreak(lines, 5, [para(), para({ keepWithNext: true }), para({ keepWithNext: true }), para()])).toBe(3);
  });
  it("never empties the frame: if the first paragraph cannot be kept, the original break stands", () => {
    expect(keepBreak(linesOf(6), 3, [para({ keepLinesTogether: true })])).toBe(3);
    expect(keepBreak(linesOf(1, 3), 1, [para({ keepWithNext: true }), para()])).toBe(1);
  });
});
