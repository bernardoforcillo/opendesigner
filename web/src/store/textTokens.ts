import { worldTransformOf } from "@/canvas/transform";
import { flattenStyle } from "@/store/richText";
import { pageNumbers } from "@/store/pageNumbers";
import { recordDelta } from "@/store/sceneDelta";
import type { NodeLite, PageLite, SceneState, TextLite, TextRunLite } from "@/store/types";

// TOKENS IN TEXT. Four kinds of markers live in the content of a text and are turned into something
// else when it is drawn -- the document keeps the markers:
//
//   [^note text]   a FOOTNOTE: drawn as a superscript number, with the note itself set at the bottom of
//                  the page (a derived text under a thin rule). Numbered 1, 2, 3 ... through the document
//                  in reading order (top to bottom, then left to right) -- a threaded story counts where
//                  its first frame is.
//   [#term]        an INDEX ENTRY: not drawn. The index generator (tools/contents.ts) lists the terms
//                  with the pages they are on.
//   [@a1b2c3d4]   an ANCHORED OBJECT: the object whose id starts with that (a shape, picture, group ...) sits in the
//                  text like a character -- it takes a box in its line and moves with the text (store/anchored.ts).
//   <h1> <h2> <h3> <pages> <doc>   VARIABLES, in the text of a master page (together with <#>, see
//                  store/masters.ts): the running header (the first heading of that level on the page,
//                  else the last one before it), the page count and the document name.
//
//   [*note text]   an ENDNOTE: a superscript number in its own sequence; the notes are listed together by the
//                  endnotes generator (tools/contents.ts), usually on the last page.
//   [=name]        a TEXT ANCHOR: a named place in the text, not drawn; the target of cross-references.
//   [>name]        a CROSS-REFERENCE to an anchor, drawn as its page number; [>name:text] draws the text of the
//                  paragraph the anchor is in instead. Always current -- it is resolved when drawn; "??" when the
//                  anchor does not exist.
//   [!comment]     an EDITORIAL NOTE: never drawn, exported or printed; listed by editorialNotes().
//   [?name] ... [/?]   CONDITIONAL TEXT: the span between is hidden everywhere (canvas, exports, contents, index)
//                  while the document's condition `name` is hidden (DocSettings.conditions); the markers are
//                  never drawn. A condition nobody defined is visible.
//
// Headings are the paragraphs whose paragraph style has an outline level (Styles… → Heading level).

const TOKEN_RE = /\[\^([^\]\n]*)\]|\[#([^\]\n]*)\]|\[@([0-9A-Za-z_-]{4,64})\]|\[\*([^\]\n]*)\]|\[=([A-Za-z0-9_-]{1,40})\]|\[>([A-Za-z0-9_-]{1,40})(?::(page|text))?\]|\[!([^\]\n]*)\]|\[\?([A-Za-z0-9_ -]{1,40})\]|(\[\/\?\])/g;
const SUPER = "⁰¹²³⁴⁵⁶⁷⁸⁹";

/** 12 -> "¹²". */
export const superscript = (n: number) => String(n).replace(/\d/g, (d) => SUPER[Number(d)]);

export const hasTokens = (content: string) => /\[[\^#@*=>!?\/]/.test(content);

export type TokenKind = "footnote" | "index" | "anchor" | "endnote" | "dest" | "xref" | "note" | "cond" | "endcond";
export interface Token { kind: TokenKind; text: string; at: number; end: number; /** xref only */ format?: "page" | "text" }

/** The footnote and index markers of `content`, in order. */
export function tokensOf(content: string): Token[] {
  const out: Token[] = [];
  for (const m of content.matchAll(TOKEN_RE)) {
    const at = m.index!, end = at + m[0].length;
    if (m[1] !== undefined) out.push({ kind: "footnote", text: m[1], at, end });
    else if (m[2] !== undefined) out.push({ kind: "index", text: m[2], at, end });
    else if (m[3] !== undefined) out.push({ kind: "anchor", text: m[3], at, end });
    else if (m[4] !== undefined) out.push({ kind: "endnote", text: m[4], at, end });
    else if (m[5] !== undefined) out.push({ kind: "dest", text: m[5], at, end });
    else if (m[6] !== undefined) out.push({ kind: "xref", text: m[6], at, end, format: m[7] === "text" ? "text" : "page" });
    else if (m[8] !== undefined) out.push({ kind: "note", text: m[8], at, end });
    else if (m[9] !== undefined) out.push({ kind: "cond", text: m[9], at, end });
    else out.push({ kind: "endcond", text: "", at, end });
  }
  return out;
}

/**
 * `t` with each token replaced by `replace(token)` and its runs moved with the characters (a run that
 * began or ended inside a token is cut at the replacement). Paragraph styles are untouched: a token
 * never contains a line break.
 */
export function rewriteTokens(t: TextLite, replace: (token: Token, index: number, offset: number) => string): TextLite {
  const tokens = tokensOf(t.content);
  if (tokens.length === 0) return t;
  let content = "";
  let cursor = 0;
  // Breakpoints: for each token the old [at, end) and the new [at', end') it became.
  const spans: { at: number; end: number; nat: number; nend: number }[] = [];
  tokens.forEach((tok, i) => {
    content += t.content.slice(cursor, tok.at);
    const nat = content.length;
    content += replace(tok, i, content.length);
    spans.push({ at: tok.at, end: tok.end, nat, nend: content.length });
    cursor = tok.end;
  });
  content += t.content.slice(cursor);
  // Old position -> new; `isEnd` picks the side of a replacement a position inside a token falls on.
  const move = (pos: number, isEnd: boolean) => {
    let shift = 0;
    for (const s of spans) {
      if (pos <= s.at) break;
      if (pos >= s.end) { shift = s.nend - s.end; continue; }
      return isEnd ? s.nat : s.nend;
    }
    return pos + shift;
  };
  const runs: TextRunLite[] = [];
  for (const r of t.runs ?? []) {
    const start = move(r.start, false), end = move(r.end, true);
    if (end > start) runs.push({ start, end, styleId: r.styleId });
  }
  const { runs: _r, ...rest } = t;
  void _r;
  return { ...rest, content, ...(runs.length > 0 ? { runs } : {}) };
}

// --- conditional text ---------------------------------------------------------------------------

/** Names of the conditions the document hides. */
export const hiddenConditions = (scene: Pick<SceneState, "settings">): Set<string> =>
  new Set((scene.settings?.conditions ?? []).filter((c) => !c.visible).map((c) => c.name));

/** `t` without the characters in `ranges` ([start, end) of its content, sorted, disjoint): runs and paragraph styles follow. */
function cutRanges(t: TextLite, ranges: readonly [number, number][]): TextLite {
  if (ranges.length === 0) return t;
  let content = "";
  let cursor = 0;
  for (const [a, b] of ranges) { content += t.content.slice(cursor, a); cursor = b; }
  content += t.content.slice(cursor);
  const move = (pos: number) => {
    let removed = 0;
    for (const [a, b] of ranges) {
      if (pos <= a) break;
      removed += Math.min(pos, b) - a;
    }
    return pos - removed;
  };
  const runs: TextRunLite[] = [];
  for (const r of t.runs ?? []) {
    const start = move(r.start), end = move(r.end);
    if (end > start) runs.push({ start, end, styleId: r.styleId });
  }
  // A removed line break merges two paragraphs: the first keeps its style, the swallowed ones lose theirs.
  let paragraphStyles = t.paragraphStyles;
  if (paragraphStyles && paragraphStyles.length > 0) {
    const drop = new Set<number>();
    for (const [a, b] of ranges) {
      const before = t.content.slice(0, a).split("\n").length - 1;
      const inside = t.content.slice(a, b).split("\n").length - 1;
      for (let k = 1; k <= inside; k++) drop.add(before + k);
    }
    if (drop.size > 0) paragraphStyles = paragraphStyles.filter((_, i) => !drop.has(i));
  }
  const { runs: _r, paragraphStyles: _p, ...rest } = t;
  void _r; void _p;
  return { ...rest, content, ...(runs.length > 0 ? { runs } : {}), ...(paragraphStyles && paragraphStyles.some((x) => x !== "") ? { paragraphStyles } : {}) };
}

/**
 * `t` with the spans of the `hidden` conditions removed. Nested spans work; an unclosed [?name] hides to the
 * end of the text. The markers of visible conditions stay (they are never drawn: see deriveTextTokens).
 */
export function hideConditions(t: TextLite, hidden: ReadonlySet<string>): TextLite {
  if (hidden.size === 0 || !t.content.includes("[?")) return t;
  const ranges: [number, number][] = [];
  const stack: { name: string; at: number }[] = [];
  const last = () => ranges[ranges.length - 1];
  const addRange = (a: number, b: number) => {
    // Merge with the previous range when they touch or overlap (the ranges come out sorted).
    const prev = last();
    if (prev && a <= prev[1]) prev[1] = Math.max(prev[1], b);
    else ranges.push([a, b]);
  };
  for (const tok of tokensOf(t.content)) {
    if (tok.kind === "cond") stack.push({ name: tok.text, at: tok.at });
    else if (tok.kind === "endcond") {
      const open = stack.pop();
      if (open && hidden.has(open.name) && stack.every((s) => !hidden.has(s.name))) addRange(open.at, tok.end);
    }
  }
  for (const open of stack) if (hidden.has(open.name)) addRange(open.at, t.content.length);
  ranges.sort((a, b) => a[0] - b[0]);
  // Re-merge after sorting (inner spans of an already hidden outer one).
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && r[0] <= prev[1]) prev[1] = Math.max(prev[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return cutRanges(t, merged);
}

/** The text of `t` as it is drawn as far as conditions go: hidden spans out. */
export const visibleText = (scene: Pick<SceneState, "settings">, t: TextLite): TextLite => hideConditions(t, hiddenConditions(scene));

// --- reading order and pages --------------------------------------------------------------------

function pageIdOf(scene: SceneState, n: NodeLite, pageIds: ReadonlySet<string>): string | null {
  let cur: NodeLite | undefined = n;
  for (let i = 0; cur && i < 1000; i++) {
    if (pageIds.has(cur.parentId)) return cur.parentId;
    cur = scene.nodes.get(cur.parentId);
  }
  return null;
}

/** Text nodes of the regular pages in reading order: page by page, then top to bottom, then left to right. */
export function textNodesInReadingOrder(scene: SceneState, includeDerived = false): { node: NodeLite; pageId: string }[] {
  const pageIds = new Set(scene.pages.filter((p) => !p.isMaster).map((p) => p.id));
  const pageIndex = new Map(scene.pages.map((p, i) => [p.id, i] as const));
  const out: { node: NodeLite; pageId: string; y: number; x: number }[] = [];
  for (const n of scene.nodes.values()) {
    if (n.kind !== "text" || !n.text || (n.fromMaster && !includeDerived)) continue;
    const pageId = pageIdOf(scene, n, pageIds);
    if (!pageId) continue;
    const w = worldTransformOf(scene, n.parentId);
    out.push({ node: n, pageId, y: n.y + w.f, x: n.x + w.e });
  }
  out.sort((a, b) => (pageIndex.get(a.pageId)! - pageIndex.get(b.pageId)!) || a.y - b.y || a.x - b.x || (a.node.id < b.node.id ? -1 : 1));
  return out.map(({ node, pageId }) => ({ node, pageId }));
}

// --- headings -----------------------------------------------------------------------------------

export interface Heading { level: number; text: string; pageId: string; nodeId: string }

/** The headings of the document in reading order: paragraphs in a paragraph style with an outline level. */
export function headingsOf(scene: SceneState): Heading[] {
  const levelOf = new Map<string, number>();
  for (const id of Object.keys(scene.textStyles)) {
    const level = flattenStyle(scene.textStyles, id)?.outlineLevel ?? 0;
    if (level > 0) levelOf.set(id, level);
  }
  if (levelOf.size === 0) return [];
  const out: Heading[] = [];
  for (const { node, pageId } of textNodesInReadingOrder(scene)) {
    // Conditional text first: a hidden span (or paragraph) is not a heading.
    const vt = visibleText(scene, node.text!);
    const ids = vt.paragraphStyles;
    if (!ids || ids.every((id) => !levelOf.has(id))) continue;
    // A paragraph's text without the markers it carries.
    const paragraphs = vt.content.replace(/\r\n?/g, "\n").split("\n");
    ids.forEach((id, i) => {
      const level = levelOf.get(id);
      const text = paragraphs[i]?.replace(TOKEN_RE, "").trim();
      if (level && text) out.push({ level, text, pageId, nodeId: node.id });
    });
  }
  return out;
}

const heads = new WeakMap<SceneState, Map<string, Record<number, string>>>();

/** For each regular page: the running header of levels 1..3 (the first heading on the page, else the last before it). */
export function runningHeads(scene: SceneState): Map<string, Record<number, string>> {
  const hit = heads.get(scene);
  if (hit) return hit;
  const byPage = new Map<string, Heading[]>();
  for (const h of headingsOf(scene)) byPage.set(h.pageId, [...(byPage.get(h.pageId) ?? []), h]);
  const out = new Map<string, Record<number, string>>();
  const current: Record<number, string> = {};
  for (const page of scene.pages) {
    if (page.isMaster) continue;
    const first: Record<number, string> = {};
    for (const h of byPage.get(page.id) ?? []) if (h.level <= 3 && first[h.level] === undefined) first[h.level] = h.text;
    // A new heading of a level resets the deeper levels, as a chapter title ends the section running head.
    for (const level of [1, 2, 3]) {
      if (first[level] !== undefined) { current[level] = first[level]; for (const deeper of [1, 2, 3].filter((l) => l > level)) if (first[deeper] === undefined) delete current[deeper]; }
    }
    out.set(page.id, { ...current });
  }
  heads.set(scene, out);
  return out;
}

const VARIABLE_RE = /<(#|pages|doc|h1|h2|h3)>/g;

/** Replaces the variables of a master's text for one page. */
export function substituteVariables(content: string, scene: Pick<SceneState, "name">, number: string, total: number, heads: Record<number, string> | undefined): string {
  if (!content.includes("<")) return content;
  return content.replace(VARIABLE_RE, (_m, name: string) => {
    switch (name) {
      case "#": return number;
      case "pages": return String(total);
      case "doc": return scene.name;
      default: return heads?.[Number(name.slice(1))] ?? "";
    }
  });
}

// --- derive: footnotes and index markers ---------------------------------------------------------

const derived = new WeakMap<SceneState, SceneState>();
/** What an anchored object leaves in the drawn text: the Unicode object replacement character. */
export const OBJECT_CHAR = "\uFFFC";

/** The node an anchor marker names: the one whose id is `ref` or the only one that starts with it (never the text itself). */
export function anchorTarget(scene: SceneState, ref: string, exceptId: string): NodeLite | null {
  const exact = scene.nodes.get(ref);
  if (exact) return exact.id === exceptId ? null : exact;
  let found: NodeLite | null = null;
  for (const n of scene.nodes.values()) {
    if (n.id === exceptId || !n.id.startsWith(ref)) continue;
    if (found) return null; // ambiguous
    found = n;
  }
  return found;
}

const NOTE_SIZE = 0.8;
const RULE_GAP = 6;

const blankNode = (over: Partial<NodeLite> & Pick<NodeLite, "id" | "parentId" | "kind" | "x" | "y" | "width" | "height">): NodeLite => ({
  orderKey: "￿", name: over.id, visible: true, opacity: 1, rotation: 0, fills: [{ r: 0, g: 0, b: 0, a: 1 }], strokes: [], cornerRadius: 0, clipsContent: false, fromMaster: true, ...over,
});

/**
 * `scene` with footnote markers drawn as superscript numbers (and their notes set at the foot of the page)
 * and index markers removed; `scene` itself when no text has a marker.
 */
export function deriveTextTokens(scene: SceneState): SceneState {
  const hit = derived.get(scene);
  if (hit) return hit;
  let any = false;
  for (const n of scene.nodes.values()) if (n.kind === "text" && n.text && hasTokens(n.text.content)) { any = true; break; }
  if (!any) { derived.set(scene, scene); return scene; }

  const edit = scene.nodes.edit();
  const changed: string[] = [];
  const notes = new Map<string, { n: number; text: string; node: NodeLite }[]>();
  const hidden = hiddenConditions(scene);
  const dests = destinationsOf(scene, hidden);
  const labels = pageNumbers(scene.pages);
  let counter = 0, endCounter = 0;
  for (const { node, pageId } of textNodesInReadingOrder(scene)) {
    if (!hasTokens(node.text!.content)) continue;
    const inline: { at: number; id: string }[] = [];
    const text = rewriteTokens(hideConditions(node.text!, hidden), (tok, _i, offset) => {
      switch (tok.kind) {
        case "index": case "dest": case "note": case "cond": case "endcond": return "";
        case "anchor": {
          const target = anchorTarget(scene, tok.text, node.id);
          if (!target) return "";
          inline.push({ at: offset, id: target.id });
          return OBJECT_CHAR;
        }
        case "xref": {
          const d = dests.get(tok.text);
          if (!d) return "??";
          return tok.format === "text" ? d.paragraph : labels.get(d.pageId)?.label ?? "??";
        }
        case "endnote":
          endCounter++;
          return superscript(endCounter);
        default:
          counter++;
          notes.set(pageId, [...(notes.get(pageId) ?? []), { n: counter, text: tok.text, node }]);
          return superscript(counter);
      }
    });
    edit.set(node.id, { ...node, text: inline.length > 0 ? { ...text, inlineObjects: inline } : text });
    changed.push(node.id);
  }
  const pagesById = new Map(scene.pages.map((p) => [p.id, p] as const));
  for (const [pageId, list] of notes) {
    const page = pagesById.get(pageId)!;
    const anchor = list[0].node;
    const size = Math.max(6, (anchor.text!.style.fontSize || 16) * NOTE_SIZE);
    const lh = size * 1.25;
    // Where the notes go: the foot of the text area of a sheet; for an unbounded page, under the text that holds the first one.
    const area = footArea(scene, page, anchor);
    const lines = list.reduce((n, f) => n + Math.max(1, Math.ceil((`${superscript(f.n)} ${f.text}`.length * size * 0.5) / Math.max(1, area.width))), 0);
    const height = lines * lh;
    const y = area.bottom !== null ? area.bottom - height : area.y;
    const style = { ...anchor.text!.style, fontSize: size, lineHeight: 1.25, align: "left" as const, italic: false };
    const rule = blankNode({ id: `${pageId}~fn-rule`, parentId: pageId, kind: "rect", x: area.x, y: y - RULE_GAP / 2, width: area.width / 3, height: 0.5 });
    const body = blankNode({
      id: `${pageId}~fn`, parentId: pageId, kind: "text", x: area.x, y, width: area.width, height,
      text: { content: list.map((f) => `${superscript(f.n)} ${f.text}`).join("\n"), style },
      fills: anchor.fills.length > 0 ? anchor.fills : [{ r: 0, g: 0, b: 0, a: 1 }],
    });
    edit.set(rule.id, rule);
    edit.set(body.id, body);
    changed.push(rule.id, body.id);
  }
  const out: SceneState = { ...scene, nodes: edit.done() };
  recordDelta(out, scene, changed);
  derived.set(scene, out);
  return out;
}

function footArea(scene: SceneState, page: PageLite, anchor: NodeLite): { x: number; y: number; width: number; bottom: number | null } {
  const h = page.height ?? 0, w = page.width ?? 0;
  if (h > 0 && w > 0) {
    const left = page.marginLeft ?? 0, right = page.marginRight ?? 0;
    return { x: left, y: 0, width: Math.max(10, w - left - right), bottom: h - (page.marginBottom ?? 0) };
  }
  const wt = worldTransformOf(scene, anchor.parentId);
  return { x: anchor.x + wt.e - 0, y: anchor.y + anchor.height + wt.f + 12, width: Math.max(10, anchor.width), bottom: null };
}

// --- cross-references, editorial notes, endnotes -------------------------------------------------

export interface Destination { pageId: string; paragraph: string }

/** The text anchors of the document ([=name]) with the page and the paragraph they are in; the first of a name wins. */
export function destinationsOf(scene: SceneState, hidden: ReadonlySet<string> = hiddenConditions(scene)): Map<string, Destination> {
  const out = new Map<string, Destination>();
  for (const { node, pageId } of textNodesInReadingOrder(scene)) {
    const t = hideConditions(node.text!, hidden);
    if (!t.content.includes("[=")) continue;
    for (const tok of tokensOf(t.content)) {
      if (tok.kind !== "dest" || out.has(tok.text)) continue;
      const from = t.content.lastIndexOf("\n", tok.at - 1) + 1;
      const to = t.content.indexOf("\n", tok.end);
      const paragraph = t.content.slice(from, to < 0 ? undefined : to).replace(TOKEN_RE, "").replace(/\s+/g, " ").trim().slice(0, 80);
      out.set(tok.text, { pageId, paragraph });
    }
  }
  return out;
}

export interface EditorialNote { nodeId: string; pageId: string; at: number; text: string; context: string }

/** The editorial notes ([!comment]) of the document in reading order; they are never drawn, exported or printed. */
export function editorialNotes(scene: SceneState): EditorialNote[] {
  const out: EditorialNote[] = [];
  for (const { node, pageId } of textNodesInReadingOrder(scene)) {
    const c = node.text!.content;
    for (const tok of tokensOf(c)) {
      if (tok.kind !== "note") continue;
      const from = Math.max(0, tok.at - 25);
      out.push({ nodeId: node.id, pageId, at: tok.at, text: tok.text.trim(), context: c.slice(from, tok.at).replace(TOKEN_RE, "").replace(/\s+/g, " ").trim() });
    }
  }
  return out;
}

/** The endnotes ([*text]) of the document, numbered in reading order (the numbers the references show). */
export function endnoteEntries(scene: SceneState): { n: number; text: string }[] {
  const hidden = hiddenConditions(scene);
  const out: { n: number; text: string }[] = [];
  for (const { node } of textNodesInReadingOrder(scene)) {
    for (const tok of tokensOf(hideConditions(node.text!, hidden).content)) if (tok.kind === "endnote") out.push({ n: out.length + 1, text: tok.text.trim() });
  }
  return out;
}

// --- index entries ------------------------------------------------------------------------------

export interface IndexEntry {
  /** The whole path, "Fruit:Apple". */
  term: string;
  /** 1 for a main entry, 2 for a sub-entry ("Fruit:Apple")... */
  level: number;
  /** The last part of the path, what is printed on the line. */
  label: string;
  pages: string[];
}

/**
 * The index terms of the document with the labels of the pages they are on, alphabetically; a term with colons
 * ([#Fruit:Apple]) is a sub-entry of "Fruit", which is listed too (with no pages of its own if none marks it).
 */
export function indexEntries(scene: SceneState): IndexEntry[] {
  const labels = pageNumbers(scene.pages);
  const hidden = hiddenConditions(scene);
  const terms = new Map<string, Set<string>>();
  const add = (path: string, page: string | null) => {
    const set = terms.get(path) ?? new Set<string>();
    if (page !== null) set.add(page);
    terms.set(path, set);
  };
  for (const { node, pageId } of textNodesInReadingOrder(scene)) {
    for (const tok of tokensOf(hideConditions(node.text!, hidden).content)) {
      if (tok.kind !== "index") continue;
      const parts = tok.text.split(":").map((p) => p.trim()).filter((p) => p !== "").slice(0, 4);
      if (parts.length === 0) continue;
      for (let k = 1; k < parts.length; k++) add(parts.slice(0, k).join(":"), null);
      add(parts.join(":"), labels.get(pageId)?.label ?? "");
    }
  }
  const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });
  return [...terms.entries()]
    .sort(([a], [b]) => {
      const pa = a.split(":"), pb = b.split(":");
      for (let i = 0; i < Math.min(pa.length, pb.length); i++) { const c = cmp(pa[i]!, pb[i]!); if (c !== 0) return c; }
      return pa.length - pb.length;
    })
    .map(([term, set]) => {
      const parts = term.split(":");
      return { term, level: parts.length, label: parts[parts.length - 1]!, pages: [...set] };
    });
}
