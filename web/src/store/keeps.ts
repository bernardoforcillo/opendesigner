import type { ResolvedParagraph } from "@/store/types";

// KEEPS: where a threaded story breaks from one frame to the next, the paragraph styles may ask for
// the break to be moved so that
//   - a paragraph is not split at all (keep lines together),
//   - at least N lines stay at the bottom of the frame (orphans / keep first lines),
//   - at least N lines go to the top of the next (widows / keep last lines),
//   - a paragraph is never left alone at the bottom away from the one it introduces (keep with next).
// Only the break moves, never the text: a break pushed up leaves white space at the bottom of the frame.
// When honouring the keeps would empty the frame (a paragraph that starts at its top and cannot fit), the
// original break stands: nothing is ever dropped or looped.

export interface KeepLine { para: number }

/**
 * Where to break: `fit` is how many of `lines` fit in the frame; the result is how many go in it
 * (0 <= result <= fit, or `fit` itself when the keeps cannot be honoured).
 */
export function keepBreak(lines: readonly KeepLine[], fit: number, paras: readonly ResolvedParagraph[]): number {
  if (fit <= 0 || fit >= lines.length) return fit;
  const firstOf = (para: number) => lines.findIndex((l) => l.para === para);
  const lastOf = (para: number) => { for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.para === para) return i; return -1; };
  let k = fit;
  for (let guard = 0; guard < 64 && k > 0 && k < lines.length; guard++) {
    const p = lines[k - 1]!.para, q = lines[k]!.para;
    const rule = paras[p];
    if (p === q) {
      const first = firstOf(p), last = lastOf(p);
      const before = k - first, after = last - k + 1;
      if (rule?.keepLinesTogether) { k = first; continue; }
      if (rule?.keepFirstLines && before < rule.keepFirstLines) { k = first; continue; }
      if (rule?.keepLastLines && after < rule.keepLastLines) {
        const next = last + 1 - rule.keepLastLines;
        k = next - first >= (rule.keepFirstLines ?? 0) && next > first ? next : first;
        continue;
      }
      break;
    }
    if (rule?.keepWithNext) { k = firstOf(p); continue; }
    break;
  }
  return k > 0 ? k : fit;
}
