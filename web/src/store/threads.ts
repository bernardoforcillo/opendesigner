import { withMeta } from "../flow/meta";
import { fontString, insetOf, layoutRich, layoutText, lineHeightOf, fontSizeOf, trackedMeasure, trackedMeasureFor } from "../renderer/text";
import { worldTransformOf } from "../canvas/transform";
import { paragraphCount, resolveRich } from "./richText";
import { keepBreak } from "./keeps";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { makeSetPropsOp, makeSetTextOp } from "../tools/ops";
import { recordDelta } from "./sceneDelta";
import { wrapRectsOf } from "./wrap";
import type { NodeLite, SceneState, TextLite, TextRunLite, TextStyleLite } from "./types";

// THREADED TEXT FRAMES. Text frames can be chained: the text of the chain's FIRST frame (its "story")
// flows from one frame into the next as each one fills up, across pages if they are on different
// pages. The link is `meta["text.next"] = <id of the next frame>` on each frame but the last; nothing
// else is stored. Like live booleans and master pages the flowed text is DERIVED (resolveScene):
// each frame is drawn with the slice of the story that fits in it, in the first frame's style, and the
// last frame is flagged `overset` when text is left over. Editing any frame of a chain edits the
// story (the first frame's content); the later frames' own content is ignored while linked.
//
// Rules: a frame links to a text node other than itself that has no frame pointing at it, and a link
// never closes a cycle. A dangling link (the target was deleted) is ignored.

export const META_NEXT = "text.next";

const isText = (n: NodeLite | undefined): n is NodeLite => !!n && n.kind === "text" && !!n.text;

/** The frame `n` flows into, or null (no link, a dangling one, or a target that is not text). */
export function nextOf(scene: SceneState, n: NodeLite): NodeLite | null {
  const id = n.meta?.[META_NEXT];
  if (!id || id === n.id) return null;
  const t = scene.nodes.get(id);
  return isText(t) ? t : null;
}

/** Ids of frames that some other frame flows into. */
function linkedTargets(scene: SceneState): Set<string> {
  const out = new Set<string>();
  for (const n of scene.nodes.values()) {
    if (n.meta?.[META_NEXT] === undefined) continue;
    const t = nextOf(scene, n);
    if (t) out.add(t.id);
  }
  return out;
}

/** The chain starting at `head`, in order (cycle-safe). */
export function chainFrom(scene: SceneState, head: NodeLite): NodeLite[] {
  const out: NodeLite[] = [];
  const seen = new Set<string>();
  for (let cur: NodeLite | null = head; cur && !seen.has(cur.id); cur = nextOf(scene, cur)) {
    out.push(cur);
    seen.add(cur.id);
  }
  return out;
}

/** The first frame of the chain `id` belongs to (`id` itself when it is not threaded). */
export function headOf(scene: SceneState | null, id: string): string {
  if (!scene) return id;
  const prev = new Map<string, string>();
  for (const n of scene.nodes.values()) {
    const t = n.meta?.[META_NEXT] !== undefined ? nextOf(scene, n) : null;
    if (t) prev.set(t.id, n.id);
  }
  let cur = id;
  for (let i = 0; i < 100000 && prev.has(cur) && prev.get(cur) !== id; i++) cur = prev.get(cur)!;
  return cur;
}

/** Is the frame part of a chain (it flows into another, or another flows into it)? */
export function isThreaded(scene: SceneState, id: string): boolean {
  const n = scene.nodes.get(id);
  if (!n) return false;
  if (nextOf(scene, n)) return true;
  return headOf(scene, id) !== id;
}

/** Every chain of two or more frames, each starting at its head. */
export function chainsOf(scene: SceneState): NodeLite[][] {
  const targets = linkedTargets(scene);
  const out: NodeLite[][] = [];
  for (const n of scene.nodes.values()) {
    if (n.meta?.[META_NEXT] === undefined || targets.has(n.id) || !nextOf(scene, n)) continue;
    out.push(chainFrom(scene, n));
  }
  return out;
}

// --- flow -----------------------------------------------------------------------------

type MeasureFor = (style: TextStyleLite) => (s: string) => number;

let injected: MeasureFor | null = null;
/** The measure the derived passes use (the injected one in tests, else the canvas). */
export const derivedMeasureFor = (): MeasureFor => injected ?? defaultMeasureFor;
/** Tests (and anything with a better measure) can replace how lines are measured; null restores the default. */
export function setThreadMeasure(m: MeasureFor | null): void { injected = m; }

let canvasCtx: CanvasRenderingContext2D | null | undefined;
export function defaultMeasureFor(style: TextStyleLite): (s: string) => number {
  if (canvasCtx === undefined) {
    canvasCtx = null;
    // jsdom has no 2D context (and logs when asked): do not even try there.
    if (typeof document !== "undefined" && typeof CanvasRenderingContext2D !== "undefined") {
      try { canvasCtx = document.createElement("canvas").getContext("2d"); } catch { canvasCtx = null; }
    }
  }
  const ctx = canvasCtx;
  if (!ctx) return (s) => s.length * fontSizeOf(style) * 0.55;
  return (s) => { ctx.font = fontString(style); return ctx.measureText(s).width; };
}

/**
 * Flows `story` through frames of the given sizes, all laid out with `style`. Returns the text each frame
 * shows and whether text is left over after the last one.
 */
export function flowStory(
  story: string,
  frames: readonly { width: number; height: number }[],
  style: TextStyleLite,
  measure: (s: string) => number,
): { slices: string[]; overset: boolean } {
  let rest = story.replace(/\r\n?/g, "\n");
  const lh = lineHeightOf(style);
  const slices: string[] = [];
  for (const f of frames) {
    if (rest === "" || !(f.width > 0)) { slices.push(""); continue; }
    const lay = layoutText(measure, rest, style, f.width);
    const cap = Math.max(0, Math.floor(f.height / lh + 1e-6));
    if (lay.lines.length <= cap) { slices.push(lay.lines.join("\n")); rest = ""; continue; }
    const take = lay.lines.slice(0, cap);
    // Where the taken lines end in the source: each line is a slice of it, and a soft break swallowed
    // one space (a hard break the newline) between lines.
    let cursor = 0;
    for (const line of take) {
      if (!rest.startsWith(line, cursor)) { cursor = rest.length; break; }
      cursor += line.length;
      if (rest[cursor] === " " || rest[cursor] === "\n") cursor++;
    }
    slices.push(take.join("\n"));
    rest = rest.slice(cursor);
  }
  return { slices, overset: rest.trim() !== "" };
}

/**
 * The text of each frame of a chain whose story is FORMATTED (paragraph styles, character styles, a
 * baseline grid): every frame is laid out with its own width and the paragraph settings, as many lines as
 * its height holds go in, and the rest of the story -- text, and the formatting that goes with it --
 * moves on to the next frame. A paragraph that breaks across frames keeps its style on the continuation
 * (its first-line indent is applied again there). Returns null when the story has no formatting that
 * resolves, or uses carriage returns: the caller then flows it as plain text.
 */
function flowRich(scene: SceneState, chain: NodeLite[]): { texts: TextLite[]; overset: boolean } | null {
  const head = chain[0].text!;
  const wrapRects = chain.map((f) => wrapRectsOf(scene, f));
  if ((!head.rich && wrapRects.every((r) => r.length === 0)) || head.content.includes("\r")) return null;
  const base = head.style;
  const mf = trackedMeasureFor((injected ?? defaultMeasureFor) as (style: TextStyleLite) => (s: string) => number);
  let content = head.content;
  let paras = head.paragraphStyles ?? [];
  let runs: TextRunLite[] = head.runs ?? [];
  let inl = head.inlineObjects ?? [];
  const texts: TextLite[] = [];
  for (const [fi, frame] of chain.entries()) {
    if (content === "") { texts.push({ content: "", style: base }); continue; }
    const boxY = frame.y + worldTransformOf(scene, frame.parentId).f;
    const whole: TextLite = { content, style: base, paragraphStyles: paras, runs, ...(inl.length > 0 ? { inlineObjects: inl } : {}) };
    const rich = resolveRich(scene, whole, base, boxY, wrapRects[fi]);
    let end = 0;
    if (rich && frame.width > 0) {
      const inset = insetOf(base);
      const lay = layoutRich(mf, content, base, rich, Math.max(0, frame.width - 2 * inset));
      const fit = lay.lines.filter((l) => l.top + l.height <= frame.height - 2 * inset + 1e-6).length;
      // Keep rules (widows, orphans, keep with next) may move the break up.
      const k = fit === lay.lines.length ? fit : keepBreak(lay.lines, fit, rich.paragraphs);
      end = k === lay.lines.length ? content.length : k > 0 ? lay.lines[k - 1].end : 0;
    }
    const slice = content.slice(0, end);
    const sliceParas = paras.slice(0, paragraphCount(slice));
    const sliceRuns = runs.filter((r) => r.start < end).map((r) => ({ ...r, end: Math.min(r.end, end) }));
    const sliceInl = inl.filter((o) => o.at < end);
    const sliceRich = resolveRich(scene, { content: slice, style: base, paragraphStyles: sliceParas, runs: sliceRuns, ...(sliceInl.length > 0 ? { inlineObjects: sliceInl } : {}) }, base, boxY, wrapRects[fi]);
    texts.push({
      content: slice, style: base,
      ...(sliceParas.some((p) => p !== "") ? { paragraphStyles: sliceParas } : {}),
      ...(sliceRuns.length > 0 ? { runs: sliceRuns } : {}),
      ...(sliceInl.length > 0 ? { inlineObjects: sliceInl } : {}),
      ...(sliceRich ? { rich: sliceRich } : {}),
    });
    // The rest: past the line break (one space, or the newline that ended the paragraph).
    let cursor = end;
    if (end > 0 && end < content.length && (content[cursor] === " " || content[cursor] === "\n")) cursor++;
    const breaks = content.slice(0, cursor).split("\n").length - 1;
    paras = paras.slice(breaks);
    runs = runs.filter((r) => r.end > cursor).map((r) => ({ ...r, start: Math.max(r.start, cursor) - cursor, end: r.end - cursor }));
    inl = inl.filter((o) => o.at >= cursor).map((o) => ({ ...o, at: o.at - cursor }));
    content = content.slice(cursor);
  }
  return { texts, overset: content.trim() !== "" };
}

const derived = new WeakMap<SceneState, SceneState>();

/** `scene` with each chain's story flowed through its frames; `scene` itself when there are no chains. */
export function deriveThreads(scene: SceneState): SceneState {
  const hit = derived.get(scene);
  if (hit) return hit;
  const chains = chainsOf(scene);
  if (chains.length === 0) { derived.set(scene, scene); return scene; }
  let edit: ReturnType<SceneState["nodes"]["edit"]> | null = null;
  const changed: string[] = [];
  for (const chain of chains) {
    // A formatted story keeps its paragraph and character styles as it flows.
    const rich = flowRich(scene, chain);
    if (rich) {
      for (const [i, n] of chain.entries()) {
        (edit ??= scene.nodes.edit()).set(n.id, {
          ...n, text: rich.texts[i], ...(i === chain.length - 1 && rich.overset ? { overset: true } : {}),
        });
        changed.push(n.id);
      }
      continue;
    }
    const style = chain[0].text!.style;
    const m = trackedMeasure((injected ?? defaultMeasureFor)(style), style);
    const { slices, overset } = flowStory(chain[0].text!.content, chain, style, m);
    for (const [i, n] of chain.entries()) {
      const last = i === chain.length - 1;
      const content = slices[i];
      if (content === n.text!.content && n.text!.style === style && !(last && overset)) continue;
      (edit ??= scene.nodes.edit()).set(n.id, {
        ...n,
        text: { content, style },
        ...(last && overset ? { overset: true } : {}),
      });
      changed.push(n.id);
    }
  }
  if (!edit) { derived.set(scene, scene); return scene; }
  const out: SceneState = { ...scene, nodes: edit.done() };
  recordDelta(out, scene, changed);
  derived.set(scene, out);
  return out;
}

// --- editing --------------------------------------------------------------------------

/** Could `fromId` flow into `toId`? (Both text, different, `from` has no next, `to` is no one's next, no cycle.) */
export function canLink(scene: SceneState, fromId: string, toId: string): boolean {
  const from = scene.nodes.get(fromId), to = scene.nodes.get(toId);
  if (!isText(from) || !isText(to) || fromId === toId) return false;
  if (nextOf(scene, from)) return false;
  if (linkedTargets(scene).has(toId)) return false;
  return !chainFrom(scene, to).some((n) => n.id === fromId);
}

/**
 * Ops that chain `ids` in order: frame 1 flows into frame 2, and so on. The stories of the frames that
 * become followers are appended to the first frame's story (so no text is lost) and cleared on them.
 * Pairs that cannot be linked are skipped; null when nothing links.
 */
export function threadOps(scene: SceneState, ids: readonly string[]): Op[] | null {
  const frames = ids.filter((id, i) => ids.indexOf(id) === i && isText(scene.nodes.get(id)));
  const ops: Op[] = [];
  // Links are decided on a private view of `next` so that each pair sees the previous ones.
  const nextMap = new Map<string, string>();
  const targets = linkedTargets(scene);
  const nextNow = (id: string) => nextMap.get(id) ?? (nextOf(scene, scene.nodes.get(id)!)?.id ?? "");
  const stories: string[] = [];
  let first: NodeLite | null = null;
  for (let i = 0; i + 1 < frames.length; i++) {
    const a = frames[i], b = frames[i + 1];
    if (nextNow(a) || targets.has(b)) continue;
    let cyc = false;
    for (let cur = b, guard = 0; cur && guard < 100000; cur = nextNow(cur), guard++) if (cur === a) { cyc = true; break; }
    if (cyc) continue;
    nextMap.set(a, b);
    targets.add(b);
    const na = scene.nodes.get(a)!, nb = scene.nodes.get(b)!;
    ops.push(makeSetPropsOp(a, { meta: withMeta(na, META_NEXT, b) }, ["meta"]));
    if (first === null) { first = headNode(scene, a); stories.push(first.text!.content); }
    if (nb.text!.content.trim() !== "") {
      stories.push(nb.text!.content);
      ops.push(makeSetTextOp(b, ""));
    }
  }
  if (ops.length === 0 || first === null) return null;
  if (stories.length > 1) ops.push(makeSetTextOp(first.id, stories.join("\n")));
  return ops;
}

function headNode(scene: SceneState, id: string): NodeLite {
  return scene.nodes.get(headOf(scene, id))!;
}

/** Ops that cut the chain after frame `id` (the text stays with the first part). null when it has no next. */
export function unlinkOps(scene: SceneState, id: string): Op[] | null {
  const n = scene.nodes.get(id);
  if (!n || n.meta?.[META_NEXT] === undefined) return null;
  return [makeSetPropsOp(id, { meta: withMeta(n, META_NEXT, "") }, ["meta"])];
}
