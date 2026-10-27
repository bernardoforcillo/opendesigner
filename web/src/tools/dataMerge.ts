import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { META_NEXT } from "@/store/threads";
import { childrenOf, subtreeOf } from "@/store/tree";
import { toPbNode, type NodeLite, type SceneState } from "@/store/types";
import { makeCreateNodeOp, makeCreatePageWithMasterOp, makeMovePageOp, uuid } from "@/tools/ops";

// DATA MERGE: a page laid out once with `{{Field}}` placeholders in its text becomes one page per record
// of a CSV/TSV table. The template page stays; the merged pages follow it, each a copy of the template
// with the record's values in place of the placeholders. Works on text content and on a node's
// `link.url`. Images are NOT merged (an image field would need its file uploaded: place the images by
// hand, or merge the text and relink).

export interface Table { headers: string[]; rows: string[][] }

/** RFC-4180 CSV; the delimiter (`,` `;` or tab) is the one that occurs most in the first line. */
export function parseTable(input: string): Table {
  const text = input.replace(/^﻿/, "");
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const delim = [",", ";", "\t"].map((d) => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v !== "")) rows.push(row);
  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return { headers, rows };
}

const PLACEHOLDER = /\{\{\s*([^{}\n]+?)\s*\}\}/g;

/** The field names a piece of text refers to. */
export const fieldsIn = (s: string): string[] => [...s.matchAll(PLACEHOLDER)].map((m) => m[1]!);

/** The placeholders used on a page's text (and link URLs), in order of first use. */
export function placeholdersOnPage(scene: SceneState, pageId: string): string[] {
  const out = new Set<string>();
  for (const root of childrenOf(scene, pageId)) for (const n of subtreeOf(scene, root.id)) {
    if (n.text) for (const f of fieldsIn(n.text.content)) out.add(f);
    const url = n.meta?.["link.url"];
    if (url) for (const f of fieldsIn(url)) out.add(f);
  }
  return [...out];
}

/** `content` with each known placeholder replaced; also maps an old offset to its new one (for style runs). */
export function substitute(content: string, record: Readonly<Record<string, string>>): { text: string; map: (offset: number) => number } {
  const cuts: { at: number; end: number; to: number }[] = [];
  let out = "", last = 0;
  for (const m of content.matchAll(PLACEHOLDER)) {
    const value = record[m[1]!];
    if (value === undefined) continue;
    out += content.slice(last, m.index) ;
    const v = value.replace(/\r?\n/g, " ");
    cuts.push({ at: m.index!, end: m.index! + m[0].length, to: out.length + v.length });
    out += v;
    last = m.index! + m[0].length;
  }
  out += content.slice(last);
  return {
    text: out,
    map: (o) => {
      let delta = 0;
      for (const c of cuts) {
        if (o >= c.end) delta = c.to - c.end;
        else if (o > c.at) return c.to; // inside a placeholder: the end of its value
        else break;
      }
      return o + delta;
    },
  };
}

export interface MergePlan { ops: Op[]; pages: number; missingFields: string[]; unusedFields: string[] }

/**
 * The ops of one gesture that add a merged page per record after `pageId`. A placeholder with no column
 * of that name is left as written and listed in `missingFields`.
 */
export function mergeOps(scene: SceneState, pageId: string, table: Table): MergePlan {
  const at = scene.pages.findIndex((p) => p.id === pageId);
  const src = scene.pages[at];
  const used = placeholdersOnPage(scene, pageId);
  const plan: MergePlan = { ops: [], pages: 0, missingFields: used.filter((f) => !table.headers.includes(f)), unusedFields: table.headers.filter((h) => !used.includes(h)) };
  if (!src || table.rows.length === 0) return plan;
  const roots = childrenOf(scene, pageId);
  table.rows.forEach((row, k) => {
    const record: Record<string, string> = {};
    table.headers.forEach((h, i) => { if (h) record[h] = row[i] ?? ""; });
    const newId = uuid();
    plan.ops.push(makeCreatePageWithMasterOp(newId, `${src.name || "Page"} ${k + 1}`, (({ id: _i, name: _n, ...rest }) => (void _i, void _n, rest))(src)));
    const ids = new Map<string, string>();
    const order: NodeLite[] = [];
    for (const root of roots) for (const n of subtreeOf(scene, root.id)) { ids.set(n.id, uuid()); order.push(n); }
    for (const n of order) {
      let copy: NodeLite = { ...n, id: ids.get(n.id)!, parentId: n.parentId === pageId ? newId : ids.get(n.parentId) ?? newId };
      if (n.text) {
        const s = substitute(n.text.content, record);
        if (s.text !== n.text.content) copy = { ...copy, text: { ...n.text, content: s.text, ...(n.text.runs ? { runs: n.text.runs.map((r) => ({ ...r, start: s.map(r.start), end: s.map(r.end) })) } : {}) } };
      }
      const url = n.meta?.["link.url"];
      if (url) copy = { ...copy, meta: { ...n.meta, "link.url": substitute(url, record).text } };
      const pb = toPbNode(copy);
      const next = n.meta?.[META_NEXT];
      if (next !== undefined) {
        if (ids.has(next)) pb.meta = { ...pb.meta, [META_NEXT]: ids.get(next)! };
        else { const { [META_NEXT]: _x, ...rest } = pb.meta; void _x; pb.meta = rest; }
      }
      plan.ops.push(makeCreateNodeOp(pb));
    }
    plan.ops.push(makeMovePageOp(newId, at + 1 + k));
    plan.pages++;
  });
  return plan;
}
