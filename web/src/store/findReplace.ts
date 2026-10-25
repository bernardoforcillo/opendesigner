import { worldTransformOf } from "../canvas/transform";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { makeSetTextOp } from "../tools/ops";
import { nextOf } from "./threads";
import { reconcileRich } from "./richText";
import type { NodeLite, SceneState, TextLite } from "./types";

// FIND AND CHANGE over the text of the whole document: every text node of every page (master pages too),
// in reading order. Plain text, whole word and regular expressions, with or without case. A change is made
// match by match from the end of each text backwards through the same reconciliation the editor uses, so
// the formatting (paragraph styles, character styles) stays on its characters. Linked frames other than the
// first of a chain are skipped: their text is the first frame's story.

export interface FindOptions { query: string; matchCase?: boolean; wholeWord?: boolean; regex?: boolean }
export interface Match { nodeId: string; pageId: string; start: number; end: number; text: string; context: string }

export const MAX_MATCHES = 5000;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The regular expression of the options, or an error message (an invalid pattern); null for an empty query. */
export function compile(opts: FindOptions): RegExp | { error: string } | null {
  if (opts.query === "") return null;
  let source = opts.regex ? opts.query : escape(opts.query);
  if (opts.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(source, "gu" + (opts.matchCase ? "" : "i"));
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Invalid pattern" };
  }
}

function pageIdOf(scene: SceneState, n: NodeLite, ids: ReadonlySet<string>): string | null {
  let cur: NodeLite | undefined = n;
  for (let i = 0; cur && i < 1000; i++) {
    if (ids.has(cur.parentId)) return cur.parentId;
    cur = scene.nodes.get(cur.parentId);
  }
  return null;
}

/** Every match in the document, in reading order (pages in order, then top to bottom, then left to right). */
export function findAll(scene: SceneState, opts: FindOptions): Match[] | { error: string } {
  const re = compile(opts);
  if (re === null) return [];
  if ("error" in re) return re;
  const pageIds = new Set(scene.pages.map((p) => p.id));
  const pageIndex = new Map(scene.pages.map((p, i) => [p.id, i] as const));
  const followers = new Set<string>();
  for (const n of scene.nodes.values()) {
    if (n.kind !== "text") continue;
    const t = nextOf(scene, n);
    if (t) followers.add(t.id);
  }
  const nodes: { n: NodeLite; pageId: string; y: number; x: number }[] = [];
  for (const n of scene.nodes.values()) {
    if (n.kind !== "text" || !n.text || n.text.content === "" || followers.has(n.id)) continue;
    const pageId = pageIdOf(scene, n, pageIds);
    if (!pageId) continue;
    const w = worldTransformOf(scene, n.parentId);
    nodes.push({ n, pageId, y: n.y + w.f, x: n.x + w.e });
  }
  nodes.sort((a, b) => (pageIndex.get(a.pageId)! - pageIndex.get(b.pageId)!) || a.y - b.y || a.x - b.x || (a.n.id < b.n.id ? -1 : 1));
  const out: Match[] = [];
  for (const { n, pageId } of nodes) {
    const content = n.text!.content;
    re.lastIndex = 0;
    for (let m = re.exec(content); m; m = re.exec(content)) {
      if (m[0] === "") { re.lastIndex++; continue; }
      const from = Math.max(0, m.index - 20), to = Math.min(content.length, m.index + m[0].length + 20);
      out.push({ nodeId: n.id, pageId, start: m.index, end: m.index + m[0].length, text: m[0], context: content.slice(from, to).replace(/\s+/g, " ") });
      if (out.length >= MAX_MATCHES) return out;
    }
  }
  return out;
}

/** What a match becomes: `replacement` as is, or -- for a regular expression -- with $1, $& ... expanded. */
export function replacementFor(m: Match, opts: FindOptions, replacement: string): string {
  const re = compile(opts);
  if (!opts.regex || !re || "error" in re) return replacement;
  return m.text.replace(new RegExp(re.source, re.flags.replace("g", "")), replacement);
}

/** SetText ops that replace `matches` (all in the current document) with `replacement`; formatting stays attached. */
export function replaceOps(scene: SceneState, matches: readonly Match[], opts: FindOptions, replacement: string): Op[] {
  const byNode = new Map<string, Match[]>();
  for (const m of matches) byNode.set(m.nodeId, [...(byNode.get(m.nodeId) ?? []), m]);
  const ops: Op[] = [];
  for (const [id, list] of byNode) {
    const node = scene.nodes.get(id);
    if (!node || node.kind !== "text" || !node.text) continue;
    let cur: TextLite = node.text;
    // From the end backwards, so the offsets of the earlier matches stay valid.
    for (const m of [...list].sort((a, b) => b.start - a.start)) {
      const next = cur.content.slice(0, m.start) + replacementFor(m, opts, replacement) + cur.content.slice(m.end);
      cur = { content: next, style: cur.style, ...reconcileRich(scene, cur, next) };
    }
    ops.push(makeSetTextOp(id, cur.content, undefined, { paragraphStyles: cur.paragraphStyles ?? [], runs: cur.runs ?? [] }));
  }
  return ops;
}
