import { worldTransformOf } from "../canvas/transform";
import type { NodeLite, ResolvedParagraph, ResolvedRun, RichText, SceneState, TextLite, TextRunLite, TextStyleDefLite, TextStyleLite } from "./types";

// RICH TEXT -- paragraph styles per paragraph and character styles over ranges. The TypeScript twin
// of internal/core/richtext.go (Go is the authority) plus what only the editor needs: resolving the
// style ids into drawable values, and keeping formatting attached to the right characters while the
// text is edited. See docs/rich-text.md.

/** How many paragraphs `content` has: pieces between newlines ("\r\n" and "\r" count as one). */
export function paragraphCount(content: string): number {
  return content.replace(/\r\n?/g, "\n").split("\n").length;
}

/** Parity with core.validateRich. Lengths are UTF-16 code units: exactly `string.length`. */
export function isValidRich(state: SceneState, content: string, paras: readonly string[], runs: readonly TextRunLite[]): boolean {
  if (paras.length > paragraphCount(content)) return false;
  for (const id of paras) {
    if (id === "") continue;
    const d = state.textStyles[id];
    if (!d || d.kind === "character") return false;
  }
  let prev = 0;
  for (const r of runs) {
    if (r.start < prev || r.start >= r.end || r.end > content.length) return false;
    const d = state.textStyles[r.styleId];
    if (!d || d.kind !== "character") return false;
    prev = r.end;
  }
  return true;
}

/** The formatting fields as stored: absent (not empty) when there is none. */
export function richFields(paras: readonly string[], runs: readonly TextRunLite[]): Pick<TextLite, "paragraphStyles" | "runs"> {
  return {
    ...(paras.some((p) => p !== "") ? { paragraphStyles: [...paras] } : {}),
    ...(runs.length > 0 ? { runs: runs.map((r) => ({ start: r.start, end: r.end, styleId: r.styleId })) } : {}),
  };
}

/** `t` with the formatting it has adjusted to its (new) content. Parity with core.clampRich. */
export function clampRich(t: TextLite): TextLite {
  let runs = t.runs;
  if (runs && runs.length > 0) {
    const size = t.content.length;
    const kept: TextRunLite[] = [];
    for (const r of runs) {
      if (r.start >= size) break;
      kept.push(r.end > size ? { ...r, end: size } : r);
    }
    runs = kept;
  }
  const n = paragraphCount(t.content);
  const paras = t.paragraphStyles && t.paragraphStyles.length > n ? t.paragraphStyles.slice(0, n) : t.paragraphStyles;
  return { content: t.content, style: t.style, ...richFields(paras ?? [], runs ?? []) };
}

// --- resolution ---------------------------------------------------------------------------------

const EMPTY: TextStyleLite = { fontFamily: "", fontSize: 0, fontWeight: "", lineHeight: 0, align: "left" };

/** `over`'s set fields on top of `base`: "" / 0 / left / false mean "not set". */
export function overlay(base: TextStyleLite, over: TextStyleLite): TextStyleLite {
  const out: TextStyleLite = {
    fontFamily: over.fontFamily !== "" ? over.fontFamily : base.fontFamily,
    fontSize: over.fontSize > 0 ? over.fontSize : base.fontSize,
    fontWeight: over.fontWeight !== "" ? over.fontWeight : base.fontWeight,
    lineHeight: over.lineHeight > 0 ? over.lineHeight : base.lineHeight,
    align: over.align !== "left" ? over.align : base.align,
  };
  if (over.letterSpacing || base.letterSpacing) out.letterSpacing = over.letterSpacing || base.letterSpacing;
  if (over.italic || base.italic) out.italic = true;
  if (over.underline || base.underline) out.underline = true;
  if (over.strikethrough || base.strikethrough) out.strikethrough = true;
  // The type extras (case, script, list, indent, features, vertical alignment, inset, scale): "unset" inherits.
  const extra = {
    textCase: over.textCase ?? base.textCase, textScript: over.textScript ?? base.textScript, listKind: over.listKind ?? base.listKind,
    indent: over.indent || base.indent, fontFeatures: over.fontFeatures || base.fontFeatures,
    verticalAlign: over.verticalAlign ?? base.verticalAlign, inset: over.inset || base.inset, textScale: over.textScale || base.textScale,
  };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== "") (out as unknown as Record<string, unknown>)[k] = v;
  return out;
}

export interface FlatStyle {
  style: TextStyleLite;
  spaceBefore: number; spaceAfter: number; indentFirst: number; indentLeft: number;
  alignToGrid: boolean;
}

/** A style with its `basedOn` chain folded in (root first), or null when it does not exist. A loop stops at the loop. */
export function flattenStyle(textStyles: Readonly<Record<string, TextStyleDefLite>>, id: string): FlatStyle | null {
  const chain: TextStyleDefLite[] = [];
  const seen = new Set<string>();
  for (let cur: TextStyleDefLite | undefined = textStyles[id]; cur && !seen.has(cur.id); cur = cur.basedOn ? textStyles[cur.basedOn] : undefined) {
    chain.unshift(cur);
    seen.add(cur.id);
  }
  if (chain.length === 0) return null;
  // A style without a base is returned as it is, so the node-wide path keeps its exact values.
  if (chain.length === 1) {
    const d = chain[0];
    return { style: d.style, spaceBefore: d.spaceBefore ?? 0, spaceAfter: d.spaceAfter ?? 0, indentFirst: d.indentFirst ?? 0, indentLeft: d.indentLeft ?? 0, alignToGrid: d.alignToGrid === true };
  }
  const out: FlatStyle = { style: EMPTY, spaceBefore: 0, spaceAfter: 0, indentFirst: 0, indentLeft: 0, alignToGrid: false };
  for (const d of chain) {
    out.style = overlay(out.style, d.style);
    out.spaceBefore = d.spaceBefore || out.spaceBefore;
    out.spaceAfter = d.spaceAfter || out.spaceAfter;
    out.indentFirst = d.indentFirst || out.indentFirst;
    out.indentLeft = d.indentLeft || out.indentLeft;
    out.alignToGrid = d.alignToGrid === true || out.alignToGrid;
  }
  return out;
}

/**
 * The drawable form of a text's formatting, or null when it has none that resolves (no paragraph style
 * that exists, no run whose style exists): the text is then laid out as plain text, exactly as before.
 */
export function resolveRich(state: SceneState, t: TextLite, base: TextStyleLite, boxY = 0): RichText | null {
  const ids = t.paragraphStyles ?? [];
  const count = paragraphCount(t.content);
  const paragraphs: ResolvedParagraph[] = [];
  let any = false;
  for (let i = 0; i < count; i++) {
    const def = ids[i] ? state.textStyles[ids[i]] : undefined;
    const flat = def && def.kind !== "character" ? flattenStyle(state.textStyles, def.id) : null;
    if (flat) {
      any = true;
      paragraphs.push({
        style: overlay(base, flat.style), spaceBefore: flat.spaceBefore, spaceAfter: flat.spaceAfter, indentFirst: flat.indentFirst, indentLeft: flat.indentLeft,
        ...(flat.alignToGrid ? { alignToGrid: true } : {}),
      });
    } else {
      paragraphs.push({ style: base, spaceBefore: 0, spaceAfter: 0, indentFirst: 0, indentLeft: 0 });
    }
  }
  const runs: ResolvedRun[] = [];
  for (const r of t.runs ?? []) {
    const def = state.textStyles[r.styleId];
    const flat = def && def.kind === "character" ? flattenStyle(state.textStyles, def.id) : null;
    if (flat) runs.push({ start: r.start, end: r.end, style: flat.style });
  }
  if (!any && runs.length === 0) return null;
  // The baseline grid matters only to paragraphs that ask for it, and only when the document has one.
  const inc = state.settings?.baselineIncrement ?? 0;
  const grid = inc > 0 && paragraphs.some((p) => p.alignToGrid) ? { increment: inc, start: state.settings?.baselineStart ?? 0, boxY: boxY + (base.inset ?? 0) } : undefined;
  return { paragraphs, runs, ...(grid ? { grid } : {}) };
}

/** Does the text carry any formatting at all (resolvable or not)? Decides whether the resolve pass looks at it. */
export function hasRich(n: NodeLite): boolean {
  const t = n.text;
  return !!t && ((t.paragraphStyles?.length ?? 0) > 0 || (t.runs?.length ?? 0) > 0);
}

/** `n` with its formatting resolved into `text.rich` (a derived field). */
export function resolveRichNode(state: SceneState, n: NodeLite): NodeLite {
  if (n.kind !== "text" || !n.text || !hasRich(n)) return n;
  // The text box's top in the world: the grid is the page's, not the box's.
  const boxY = n.y + worldTransformOf(state, n.parentId).f;
  const rich = resolveRich(state, n.text, n.text.style, boxY);
  return rich ? { ...n, text: { ...n.text, rich } } : n;
}

// --- editing --------------------------------------------------------------------------------------

/**
 * The formatting a text should have after its content changed from `prev.content` to `next`, found by
 * comparing the two (the common start and end are kept, what is between is the edit):
 *  - runs move with their characters; text typed at the end of a run joins it; a run the edit swallows
 *    disappears;
 *  - paragraph styles follow their paragraphs; a paragraph split at its end by Enter gets the style's
 *    "next style" (or the same style), a paragraph split in the middle keeps the style on both halves,
 *    and merged paragraphs keep the first one's style.
 */
export function reconcileRich(
  state: SceneState,
  prev: TextLite,
  next: string,
): Pick<TextLite, "paragraphStyles" | "runs"> {
  const old = prev.content;
  let p = 0;
  const max = Math.min(old.length, next.length);
  while (p < max && old[p] === next[p]) p++;
  let q = 0;
  while (q < max - p && old[old.length - 1 - q] === next[next.length - 1 - q]) q++;
  const removedEnd = old.length - q; // end of the removed zone in `old`
  const inserted = next.length - p - q;
  const delta = next.length - old.length;

  // Runs.
  const pure = removedEnd === p; // a pure insertion removes nothing
  // A line break typed at the end of a run does not join it (the new paragraph starts unstyled).
  const extendable = !/^[\r\n]+$/.test(next.slice(p, p + inserted));
  const move = (pos: number, isEnd: boolean): number => {
    if (pos < p) return pos;
    if (pos === p) {
      // Typing at the end of a run extends it; typing at its start does not; text typed over a
      // replaced zone that begins here is not part of the run on its left.
      if (isEnd) return pure && extendable ? p + inserted : p;
      return pure ? p + inserted : p;
    }
    if (pos >= removedEnd) return pos + delta;
    return p + inserted; // inside what was replaced
  };
  const runs: TextRunLite[] = [];
  for (const r of prev.runs ?? []) {
    const s = move(r.start, false), e = move(r.end, true);
    if (e <= s) continue;
    const last = runs[runs.length - 1];
    if (last && last.styleId === r.styleId && last.end === s) last.end = e;
    else runs.push({ start: s, end: e, styleId: r.styleId });
  }

  // Paragraph styles.
  const norm = (s: string) => s.replace(/\r\n?/g, "\n");
  const oldN = norm(old);
  const paras = prev.paragraphStyles ?? [];
  let styles: string[] = paras.length === 0 ? [] : [...paras];
  if (styles.length > 0 && old !== next) {
    const nOld = paragraphCount(old);
    while (styles.length < nOld) styles.push("");
    const pn = Math.min(p, oldN.length); // offsets agree unless \r\n is in play; clamp is enough then
    const before = oldN.slice(0, pn);
    const idx = before.split("\n").length - 1;
    const removedZone = norm(old.slice(p, removedEnd));
    const insertedZone = norm(next.slice(p, p + inserted));
    const removedBreaks = removedZone.split("\n").length - 1;
    const insertedBreaks = insertedZone.split("\n").length - 1;
    const atEnd = pn >= oldN.length || oldN[pn] === "\n";
    const cur = styles[idx] ?? "";
    const nextStyle = (cur && state.textStyles[cur]?.nextStyleId) || cur;
    const fresh = Array.from({ length: insertedBreaks }, () => (atEnd && removedBreaks === 0 ? nextStyle : cur));
    styles = [...styles.slice(0, idx + 1), ...fresh, ...styles.slice(idx + 1 + removedBreaks)];
    const n = paragraphCount(next);
    if (styles.length > n) styles = styles.slice(0, n);
  }
  return richFields(styles, runs);
}

// --- applying styles ------------------------------------------------------------------------------

/** `runs` with the character style `styleId` (or none, when "") over [start, end): what it overlaps is replaced. */
export function applyRun(runs: readonly TextRunLite[], start: number, end: number, styleId: string): TextRunLite[] {
  if (end <= start) return runs.map((r) => ({ ...r }));
  const out: TextRunLite[] = [];
  for (const r of runs) {
    if (r.end <= start || r.start >= end) { out.push({ ...r }); continue; }
    if (r.start < start) out.push({ start: r.start, end: start, styleId: r.styleId });
    if (r.end > end) out.push({ start: end, end: r.end, styleId: r.styleId });
  }
  if (styleId !== "") out.push({ start, end, styleId });
  out.sort((a, b) => a.start - b.start);
  const merged: TextRunLite[] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && last.styleId === r.styleId && last.end === r.start) last.end = r.end;
    else merged.push(r);
  }
  return merged;
}

/** The paragraph styles with `styleId` on paragraphs `from..to` (inclusive); the list is padded with "" as needed. */
export function applyParagraphRange(paras: readonly string[], count: number, from: number, to: number, styleId: string): string[] {
  const out = Array.from({ length: count }, (_, i) => paras[i] ?? "");
  for (let i = Math.max(0, from); i <= Math.min(count - 1, to); i++) out[i] = styleId;
  return out;
}

/** Which paragraphs does [start, end] touch in `content`? (A caret touches the one it is in.) */
export function paragraphsTouched(content: string, start: number, end: number): { from: number; to: number } {
  const norm = content.replace(/\r\n?/g, "\n");
  const idx = (pos: number) => norm.slice(0, Math.min(pos, norm.length)).split("\n").length - 1;
  const from = idx(start);
  // A selection that ends right after a newline does not touch the next paragraph.
  const last = end > start && norm[end - 1] === "\n" ? end - 1 : end;
  return { from, to: Math.max(from, idx(last)) };
}
