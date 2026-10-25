import type { NumberStyle, PageLite } from "./types";

// PAGE NUMBERS. The regular pages (not masters) are numbered in document order, 1, 2, 3...; a page that
// starts a SECTION restarts the count at `numberStart` (default 1) in `numberStyle` (arabic when absent,
// else i, I, a, A). The first regular page always starts a section, whether it says so or not.
// The number is what the "<#>" token of a master shows, and on facing pages its parity decides the side
// of the spread: odd numbers are right-hand pages.

export interface PageNumber { value: number; label: string }

const ROMAN: readonly [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];

/** `n` (>= 1) written in `style`: 1, i, I, a (a..z, aa..), A. */
export function formatPageNumber(n: number, style: NumberStyle | undefined): string {
  if (!(n >= 1)) return String(n);
  switch (style) {
    case "i": case "I": {
      let out = "", rest = n;
      for (const [v, s] of ROMAN) while (rest >= v) { out += s; rest -= v; }
      return style === "I" ? out.toUpperCase() : out;
    }
    case "a": case "A": {
      let out = "", rest = n;
      while (rest > 0) { rest -= 1; out = String.fromCharCode(97 + (rest % 26)) + out; rest = Math.floor(rest / 26); }
      return style === "A" ? out.toUpperCase() : out;
    }
    default: return String(n);
  }
}

/** The number of every regular page, by page id. */
export function pageNumbers(pages: readonly PageLite[]): Map<string, PageNumber> {
  const out = new Map<string, PageNumber>();
  let value = 0, style: NumberStyle | undefined;
  let first = true;
  for (const p of pages) {
    if (p.isMaster) continue;
    if (first || p.sectionStart) {
      value = p.numberStart && p.numberStart > 0 ? p.numberStart : 1;
      style = p.numberStyle;
      first = false;
    } else value += 1;
    out.set(p.id, { value, label: formatPageNumber(value, style) });
  }
  return out;
}

/** Is the page a right-hand page of a spread? (Only meaningful with facing pages: odd numbers are right.) */
export const isRightPage = (n: PageNumber | undefined) => (n?.value ?? 1) % 2 === 1;
