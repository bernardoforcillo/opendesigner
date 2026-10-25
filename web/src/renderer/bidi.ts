// RIGHT-TO-LEFT TEXT for the PDF writer. The screen (canvas) and the SVG export leave this to the browser, which shapes Arabic and
// orders mixed-direction text itself. A PDF has no such engine: each glyph is placed by us, so the text must reach the writer in
// VISUAL order and with Arabic letters already in their joined forms. This module does both:
//   - `arabicShape`: letters to their isolated / final / initial / medial presentation forms (U+FE70..FEFF), lam-alef ligatures included;
//   - `visualOrder`: a simplified Unicode bidirectional algorithm (UAX #9: strong types, neutrals, European/Arabic numbers, levels,
//     reordering, mirrored brackets). No explicit embeddings or isolates (LRE, RLO, ...).
// A font must contain the presentation forms for shaped text to show; the common Arabic fonts do.

type Joining = "D" | "R"; // dual-joining, right-joining

// base -> [isolated, final, initial?, medial?]  (initial and medial only for dual-joining letters)
const FORMS = new Map<number, number[]>();
const add = (cp: number, first: number, joining: Joining) => FORMS.set(cp, joining === "D" ? [first, first + 1, first + 2, first + 3] : [first, first + 1]);
const R = (cp: number, first: number) => add(cp, first, "R");
const D = (cp: number, first: number) => add(cp, first, "D");
FORMS.set(0x621, [0xfe80]);
R(0x622, 0xfe81); R(0x623, 0xfe83); R(0x624, 0xfe85); R(0x625, 0xfe87); D(0x626, 0xfe89); R(0x627, 0xfe8d); D(0x628, 0xfe8f); R(0x629, 0xfe93);
D(0x62a, 0xfe95); D(0x62b, 0xfe99); D(0x62c, 0xfe9d); D(0x62d, 0xfea1); D(0x62e, 0xfea5); R(0x62f, 0xfea9); R(0x630, 0xfeab); R(0x631, 0xfead); R(0x632, 0xfeaf);
D(0x633, 0xfeb1); D(0x634, 0xfeb5); D(0x635, 0xfeb9); D(0x636, 0xfebd); D(0x637, 0xfec1); D(0x638, 0xfec5); D(0x639, 0xfec9); D(0x63a, 0xfecd);
D(0x641, 0xfed1); D(0x642, 0xfed5); D(0x643, 0xfed9); D(0x644, 0xfedd); D(0x645, 0xfee1); D(0x646, 0xfee5); D(0x647, 0xfee9); R(0x648, 0xfeed);
FORMS.set(0x649, [0xfeef, 0xfef0]); D(0x64a, 0xfef1);
const LAM_ALEF = new Map<number, [number, number]>([[0x622, [0xfef5, 0xfef6]], [0x623, [0xfef7, 0xfef8]], [0x625, [0xfef9, 0xfefa]], [0x627, [0xfefb, 0xfefc]]]);
const isMark = (cp: number) => (cp >= 0x64b && cp <= 0x65f) || cp === 0x670 || (cp >= 0x6d6 && cp <= 0x6dc);
const joinsNext = (cp: number) => (FORMS.get(cp)?.length ?? 0) === 4 || cp === 0x640; // can connect to the letter after it
const joinsPrev = (cp: number) => FORMS.has(cp) && FORMS.get(cp)!.length > 1 || cp === 0x640; // can connect to the letter before it

export const hasArabic = (s: string): boolean => /[؀-ۿݐ-ݿ]/.test(s);

/** The text with Arabic letters replaced by their joined presentation forms (other characters untouched). */
export function arabicShape(text: string): string {
  const cps = Array.from(text, (c) => c.codePointAt(0)!);
  const out: number[] = [];
  const prevJoins = (i: number): boolean => { // the nearest non-mark character before i joins forward
    for (let k = i - 1; k >= 0; k--) { if (isMark(cps[k]!)) continue; return joinsNext(cps[k]!) && prevLinked(k); }
    return false;
  };
  // A letter can only join forward into the next one if that one is Arabic (the chain is checked from its side).
  const prevLinked = (k: number): boolean => FORMS.has(cps[k]!) || cps[k] === 0x640;
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i]!;
    const forms = FORMS.get(cp);
    if (!forms) { out.push(cp); continue; }
    let nextIdx = i + 1;
    while (nextIdx < cps.length && isMark(cps[nextIdx]!)) nextIdx++;
    const next = cps[nextIdx];
    // lam + alef ligature
    if (cp === 0x644 && next !== undefined && LAM_ALEF.has(next) && nextIdx === i + 1) {
      const [iso, fin] = LAM_ALEF.get(next)!;
      out.push(prevJoins(i) ? fin : iso);
      i = nextIdx;
      continue;
    }
    const before = prevJoins(i);
    const after = forms.length === 4 && next !== undefined && joinsPrev(next);
    if (forms.length === 4) out.push(before && after ? forms[3]! : before ? forms[1]! : after ? forms[2]! : forms[0]!);
    else out.push(before ? forms[1] ?? forms[0]! : forms[0]!);
  }
  return String.fromCodePoint(...out);
}

type Type = "L" | "R" | "AL" | "EN" | "AN" | "WS" | "ON";
function typeOf(cp: number): Type {
  if ((cp >= 0x590 && cp <= 0x5ff) || (cp >= 0x7c0 && cp <= 0x85f) || (cp >= 0xfb1d && cp <= 0xfb4f)) return "R";
  if ((cp >= 0x600 && cp <= 0x7bf && !(cp >= 0x660 && cp <= 0x669) && !isMark(cp)) || (cp >= 0x8a0 && cp <= 0x8ff) || (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff)) return "AL";
  if (cp >= 0x660 && cp <= 0x669) return "AN";
  if ((cp >= 0x30 && cp <= 0x39) || (cp >= 0x6f0 && cp <= 0x6f9)) return "EN";
  if (cp === 0x20 || cp === 0x09 || cp === 0xa0) return "WS";
  if (isMark(cp) || (cp >= 0x300 && cp <= 0x36f)) return "ON"; // inherits (handled as neutral that follows its base below)
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || cp > 0xff) return "L";
  if (cp >= 0xc0) return "L";
  return "ON";
}

const MIRROR = new Map<string, string>([["(", ")"], [")", "("], ["[", "]"], ["]", "["], ["{", "}"], ["}", "{"], ["<", ">"], [">", "<"], ["«", "»"], ["»", "«"]]);

/** `true` when the first strong character is right-to-left. */
export function isRtl(text: string): boolean {
  for (const ch of text) { const t = typeOf(ch.codePointAt(0)!); if (t === "R" || t === "AL") return true; if (t === "L") return false; }
  return false;
}

/** The characters of `text` in the order they are drawn left to right (base direction from `rtl`, default: the first strong character). */
export function visualOrder(text: string, rtl: boolean = isRtl(text)): string {
  const chars = Array.from(text);
  if (chars.length === 0) return text;
  const base = rtl ? 1 : 0;
  const types: Type[] = chars.map((c) => typeOf(c.codePointAt(0)!));
  // W2/W3: European numbers after an Arabic letter become Arabic numbers; AL counts as R from here on.
  let lastStrong: Type = rtl ? "R" : "L";
  for (let i = 0; i < types.length; i++) {
    const t = types[i]!;
    if (t === "L" || t === "R" || t === "AL") lastStrong = t;
    else if (t === "EN" && lastStrong === "AL") types[i] = "AN";
  }
  for (let i = 0; i < types.length; i++) if (types[i] === "AL") types[i] = "R";
  // N1/N2: runs of neutrals take the direction of the strong types on both sides if they agree (numbers count as R), else the base.
  const dir = (t: Type): "L" | "R" | null => (t === "L" ? "L" : t === "R" || t === "EN" || t === "AN" ? "R" : null);
  const resolved: ("L" | "R" | "N" | "EN" | "AN")[] = types.map((t) => (t === "L" ? "L" : t === "R" ? "R" : t === "EN" ? "EN" : t === "AN" ? "AN" : "N"));
  for (let i = 0; i < resolved.length;) {
    if (resolved[i] !== "N") { i++; continue; }
    let j = i;
    while (j < resolved.length && resolved[j] === "N") j++;
    const before = i > 0 ? dir(types[i - 1]!) : rtl ? "R" : "L";
    const after = j < types.length ? dir(types[j]!) : rtl ? "R" : "L";
    const d = before && before === after ? before : rtl ? "R" : "L";
    for (let k = i; k < j; k++) resolved[k] = d;
    i = j;
  }
  // Levels: L and R as the base requires; numbers inside right-to-left text sit two levels up (they read left to right).
  const levels = resolved.map((t) => {
    if (base === 0) return t === "L" ? 0 : t === "R" ? 1 : 2;
    return t === "R" ? 1 : t === "L" ? 2 : 2;
  });
  // Mirror brackets in right-to-left runs.
  const glyphs = chars.map((c, i) => (levels[i]! % 2 === 1 ? MIRROR.get(c) ?? c : c));
  // L2: from the highest level down to the lowest odd one, reverse every run at that level or above.
  const idx = glyphs.map((_, i) => i);
  const max = Math.max(...levels), minOdd = Math.min(...levels.filter((l) => l % 2 === 1), Infinity);
  for (let lv = max; lv >= minOdd && Number.isFinite(minOdd); lv--) {
    for (let i = 0; i < idx.length;) {
      if (levels[idx[i]!]! < lv) { i++; continue; }
      let j = i;
      while (j < idx.length && levels[idx[j]!]! >= lv) j++;
      const seg = idx.slice(i, j).reverse();
      idx.splice(i, j - i, ...seg);
      i = j;
    }
  }
  return idx.map((i) => glyphs[i]!).join("");
}

/** What the PDF writer shows for a run: shaped, then reordered. Text with no right-to-left characters comes back unchanged. */
export function forPdf(text: string, rtlBase?: boolean): string {
  if (!/[֐-ࣿיִ-﷿ﹰ-﻿]/.test(text)) return text;
  return visualOrder(arabicShape(text), rtlBase);
}
