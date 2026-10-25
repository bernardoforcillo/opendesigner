import { visibleText, textNodesInReadingOrder } from "../store/textTokens";
import type { SceneState } from "../store/types";

// TEXT CHECKS: typographic slips a proofreader would catch, found in the text of the whole document. This is NOT
// a dictionary spell check -- no word list ships with the editor -- the browser's own spell check marks
// misspelt words while you type; these are the mistakes a dictionary does not see.

export type CheckCode = "repeated-word" | "double-space" | "space-before-punctuation" | "straight-quote" | "three-dots" | "spaced-hyphen";
export interface TextIssue { code: CheckCode; nodeId: string; pageId: string; start: number; end: number; text: string; message: string }

export const CHECK_CODES: readonly CheckCode[] = ["repeated-word", "double-space", "space-before-punctuation", "straight-quote", "three-dots", "spaced-hyphen"];

const RULES: { code: CheckCode; re: RegExp; message: string }[] = [
  { code: "repeated-word", re: /\b([\p{L}\p{N}']{2,})(\s+)\1\b/giu, message: "Repeated word." },
  { code: "double-space", re: /[^\S\n]{2,}/g, message: "More than one space in a row." },
  { code: "space-before-punctuation", re: /[^\S\n][,.;:]/g, message: "A space before , . ; or :." },
  { code: "straight-quote", re: /["']/g, message: "Straight quote: use typographic quotes (“ ” ‘ ’)." },
  { code: "three-dots", re: /\.{3}/g, message: "Three dots: use the ellipsis character (…)." },
  { code: "spaced-hyphen", re: /\S - \S/g, message: "A hyphen with spaces around it: use an en dash (–)." },
];

/** Every slip in the document's visible text (hidden conditional text is skipped), in reading order. `only` limits the kinds. */
export function checkText(scene: SceneState, only?: readonly CheckCode[], limit = 1000): TextIssue[] {
  const out: TextIssue[] = [];
  for (const { node, pageId } of textNodesInReadingOrder(scene)) {
    const content = visibleText(scene, node.text!).content;
    const here: TextIssue[] = [];
    for (const rule of RULES) {
      if (only && !only.includes(rule.code)) continue;
      rule.re.lastIndex = 0;
      for (let m = rule.re.exec(content); m; m = rule.re.exec(content)) {
        here.push({ code: rule.code, nodeId: node.id, pageId, start: m.index, end: m.index + m[0].length, text: m[0], message: rule.message });
        if (m[0] === "") rule.re.lastIndex++;
      }
    }
    here.sort((a, b) => a.start - b.start);
    out.push(...here);
    if (out.length >= limit) return out.slice(0, limit);
  }
  return out;
}
