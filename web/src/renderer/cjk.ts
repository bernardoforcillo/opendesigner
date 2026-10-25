// CJK LINE BREAKING. Chinese and Japanese text has no spaces: a line may break between almost any two characters, except that some
// characters must not START a line (closing brackets, 。 、 ！ ？, the prolonged-sound mark ー, small kana, …) and some must not END
// one (opening brackets): the "kinsoku" rules. Hangul is written with spaces and breaks at them like Latin text.

const NO_START = new Set(Array.from("、。，．・：；！？）］｝〕〉》」』】〙〗〟’”‥…ー々〻ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ゛゜ゝゞヽヾ)]}!?,.:;%"));
const NO_END = new Set(Array.from("（［｛〔〈《「『【〘〖〝‘“([{"));
const INSEPARABLE = new Set(["…", "‥", "—", "―"]);

/** Kana, ideographs, CJK symbols and fullwidth forms (not Hangul). */
export function isCjk(cp: number): boolean {
  return (cp >= 0x3000 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x20000 && cp <= 0x2fa1f);
}

export const hasCjk = (s: string): boolean => /[　-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿＀-￯]|[\ud840-\ud87f][\udc00-\udfff]/.test(s);

/** The UTF-16 offsets inside `text` where a line may break (never 0 or the end). */
export function cjkBreaks(text: string): number[] {
  const chars = Array.from(text);
  const out: number[] = [];
  let at = 0;
  for (let i = 0; i < chars.length - 1; i++) {
    const a = chars[i]!, b = chars[i + 1]!;
    at += a.length;
    if (!(isCjk(a.codePointAt(0)!) || isCjk(b.codePointAt(0)!))) continue;
    if (NO_START.has(b) || NO_END.has(a)) continue;
    if (INSEPARABLE.has(a) && a === b) continue;
    out.push(at);
  }
  return out;
}

/** `text` cut at its break opportunities (a Latin-only word comes back whole). */
export function cjkSplit(text: string): string[] {
  if (!hasCjk(text)) return [text];
  const cuts = cjkBreaks(text);
  const out: string[] = [];
  let from = 0;
  for (const c of [...cuts, text.length]) { out.push(text.slice(from, c)); from = c; }
  return out;
}
