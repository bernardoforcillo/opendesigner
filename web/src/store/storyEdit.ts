import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { makeSetTextOp } from "@/tools/ops";
import { headOf } from "@/store/threads";
import type { SceneState } from "@/store/types";

// STORY EDITOR: the whole story of a text frame (the first frame's content, however many frames it flows through)
// as plain text, edited in one field. The character-style runs and paragraph styles stay with the text around the
// edit: what comes before the first changed character keeps its place, what comes after the last one moves with
// it, and a run that overlaps the change is cut to what is left of it.

/** The op that makes the story of the chain `id` belongs to read `content`; null when it already does. */
export function storyEditOp(scene: SceneState, id: string, content: string): Op | null {
  const head = scene.nodes.at(headOf(scene, id));
  if (!head || head.kind !== "text" || !head.text) return null;
  const old = head.text.content, next = content.replace(/\r\n?/g, "\n");
  if (old === next) return null;
  if (!head.text.paragraphStyles && !head.text.runs) return makeSetTextOp(head.id, next);

  let pre = 0;
  while (pre < old.length && pre < next.length && old[pre] === next[pre]) pre++;
  let suf = 0;
  while (suf < old.length - pre && suf < next.length - pre && old[old.length - 1 - suf] === next[next.length - 1 - suf]) suf++;
  const oldEnd = old.length - suf, delta = next.length - old.length;

  const runs: { start: number; end: number; styleId: string }[] = [];
  for (const r of head.text.runs ?? []) {
    // The parts of the run before and after the changed stretch survive; the stretch itself is the new text.
    if (r.start < pre) { const e = Math.min(r.end, pre); if (e > r.start) runs.push({ start: r.start, end: e, styleId: r.styleId }); }
    if (r.end > oldEnd) { const s = Math.max(r.start, oldEnd); if (r.end > s) runs.push({ start: s + delta, end: r.end + delta, styleId: r.styleId }); }
  }
  runs.sort((a, b) => a.start - b.start);
  // Paragraph styles belong to paragraphs: the ones before the first changed newline stay, the ones after the last follow.
  const oldParas = head.text.paragraphStyles ?? [];
  const before = old.slice(0, pre).split("\n").length - 1, after = old.slice(oldEnd).split("\n").length - 1;
  const total = next.split("\n").length;
  const paras: string[] = new Array(total).fill("");
  const oldTotal = old.split("\n").length;
  // A paragraph the edit starts inside keeps its style; one it starts at the very beginning of is pushed on by the new text.
  const inside = pre > old.lastIndexOf("\n", pre - 1) + 1;
  for (let i = 0; i <= before && i < total; i++) if (i < before || inside) paras[i] = oldParas[i] ?? "";
  for (let k = 0; k <= after; k++) {
    const ni = total - 1 - k, oi = oldTotal - 1 - k;
    if (ni >= 0 && !(oi === before && inside)) paras[ni] = oldParas[oi] ?? "";
  }
  return makeSetTextOp(head.id, next, undefined, { paragraphStyles: paras, runs });
}
