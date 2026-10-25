import { worldTransformOf } from "../canvas/transform";
import { flattenStyle } from "./richText";
import { pageNumbers } from "./pageNumbers";
import { recordDelta } from "./sceneDelta";
import type { NodeLite, PageLite, SceneState, TextLite, TextRunLite } from "./types";

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
// Headings are the paragraphs whose paragraph style has an outline level (Styles… → Heading level).

const TOKEN_RE = /\[\^([^\]\n]*)\]|\[#([^\]\n]*)\]|\[@([0-9A-Za-z_-]{4,64})\]/g;
const SUPER = "⁰¹²³⁴⁵⁶⁷⁸⁹";

/** 12 -> "¹²". */
export const superscript = (n: number) => String(n).replace(/\d/g, (d) => SUPER[Number(d)]);

export const hasTokens = (content: string) => content.includes("[^") || content.includes("[#") || content.includes("[@");

export interface Token { kind: "footnote" | "index" | "anchor"; text: string; at: number; end: number }

/** The footnote and index markers of `content`, in order. */
export function tokensOf(content: string): Token[] {
  const out: Token[] = [];
  for (const m of content.matchAll(TOKEN_RE)) {
    const at = m.index!, end = at + m[0].length;
    out.push(m[1] !== undefined ? { kind: "footnote", text: m[1], at, end } : m[2] !== undefined ? { kind: "index", text: m[2], at, end } : { kind: "anchor", text: m[3], at, end });
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
    const ids = node.text!.paragraphStyles;
    if (!ids || ids.every((id) => !levelOf.has(id))) continue;
    // A paragraph's text without the markers it carries.
    const paragraphs = node.text!.content.replace(/\r\n?/g, "\n").split("\n");
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
  let counter = 0;
  for (const { node, pageId } of textNodesInReadingOrder(scene)) {
    if (!hasTokens(node.text!.content)) continue;
    const inline: { at: number; id: string }[] = [];
    const text = rewriteTokens(node.text!, (tok, _i, offset) => {
      if (tok.kind === "index") return "";
      if (tok.kind === "anchor") {
        const target = anchorTarget(scene, tok.text, node.id);
        if (!target) return "";
        inline.push({ at: offset, id: target.id });
        return OBJECT_CHAR;
      }
      counter++;
      notes.set(pageId, [...(notes.get(pageId) ?? []), { n: counter, text: tok.text, node }]);
      return superscript(counter);
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

// --- index entries ------------------------------------------------------------------------------

export interface IndexEntry { term: string; pages: string[] }

/** The index terms of the document with the labels of the pages they are on, alphabetically. */
export function indexEntries(scene: SceneState): IndexEntry[] {
  const labels = pageNumbers(scene.pages);
  const terms = new Map<string, Set<string>>();
  for (const { node, pageId } of textNodesInReadingOrder(scene)) {
    for (const tok of tokensOf(node.text!.content)) {
      const term = tok.text.trim();
      if (tok.kind !== "index" || term === "") continue;
      const set = terms.get(term) ?? new Set<string>();
      set.add(labels.get(pageId)?.label ?? "");
      terms.set(term, set);
    }
  }
  return [...terms.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map(([term, set]) => ({ term, pages: [...set] }));
}
