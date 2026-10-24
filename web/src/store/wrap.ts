import { worldAabbOfNode, type Bounds } from "../canvas/geometry";
import { worldTransformOf } from "../canvas/transform";
import { withMeta } from "../flow/meta";
import { makeSetPropsOp } from "../tools/ops";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { resolveRich } from "./richText";
import { recordDelta } from "./sceneDelta";
import type { NodeLite, SceneState } from "./types";

// TEXT WRAP. An object with `meta["wrap.mode"] = "box"` pushes the text of the frames BELOW it out of its way:
// the lines of a text node that sits under the object (same parent, lower in the stacking order) are
// laid out beside it -- on the wider side -- and jump over it when neither side has room. The gap around
// the object is `meta["wrap.offset"]` (default 6). Only the object's bounding box counts, rotation
// included; a rotated text frame is not wrapped. Like threads and masters the result is DERIVED
// (resolveScene): the document only keeps the two meta keys. See docs/text-frames.md.

export const META_WRAP = "wrap.mode";
export const META_WRAP_OFFSET = "wrap.offset";
export const DEFAULT_WRAP_OFFSET = 6;

export const isWrapper = (n: NodeLite) => n.meta?.[META_WRAP] === "box";

export function wrapOffsetOf(n: NodeLite): number {
  const v = Number(n.meta?.[META_WRAP_OFFSET]);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_WRAP_OFFSET;
}

/** The boxes the text of frame `text` must avoid, relative to the frame's top-left corner. */
export function wrapRectsOf(scene: SceneState, text: NodeLite): Bounds[] {
  if (text.kind !== "text" || text.rotation % 360 !== 0) return [];
  const out: Bounds[] = [];
  for (const o of scene.nodes.values()) {
    if (o.id === text.id || o.parentId !== text.parentId || !o.visible || !isWrapper(o)) continue;
    // Above the text in the stacking order only: the text keeps its place under an object that does not wrap it.
    if (!(o.orderKey > text.orderKey || (o.orderKey === text.orderKey && o.id > text.id))) continue;
    const b = worldAabbOfNode(o);
    const g = wrapOffsetOf(o);
    const rect = { x: b.x - g - text.x, y: b.y - g - text.y, width: b.width + 2 * g, height: b.height + 2 * g };
    if (rect.x < text.width && rect.x + rect.width > 0 && rect.y < text.height + 100000 && rect.y + rect.height > 0) out.push(rect);
  }
  return out;
}

const derived = new WeakMap<SceneState, SceneState>();

/** `scene` with the text frames that have objects over them laid out around those; `scene` itself when nothing wraps. */
export function deriveWrap(scene: SceneState): SceneState {
  const hit = derived.get(scene);
  if (hit) return hit;
  let any = false;
  for (const n of scene.nodes.values()) if (n.meta?.[META_WRAP] !== undefined && isWrapper(n)) { any = true; break; }
  if (!any) { derived.set(scene, scene); return scene; }
  let edit: ReturnType<SceneState["nodes"]["edit"]> | null = null;
  const changed: string[] = [];
  for (const n of scene.nodes.values()) {
    // Threaded frames are laid out by the thread itself (store/threads.ts), which asks for the rects too.
    if (n.kind !== "text" || !n.text || n.meta?.["text.next"] !== undefined || n.text.content === "") continue;
    const rects = wrapRectsOf(scene, n);
    if (rects.length === 0) continue;
    const boxY = n.y + worldTransformOf(scene, n.parentId).f;
    const rich = resolveRich(scene, n.text, n.text.style, boxY, rects);
    if (!rich) continue;
    (edit ??= scene.nodes.edit()).set(n.id, { ...n, text: { ...n.text, rich } });
    changed.push(n.id);
  }
  if (!edit) { derived.set(scene, scene); return scene; }
  const out: SceneState = { ...scene, nodes: edit.done() };
  recordDelta(out, scene, changed);
  derived.set(scene, out);
  return out;
}

/** Ops that set (or, with mode "", clear) the wrap of `ids`. */
export function wrapOps(scene: SceneState, ids: readonly string[], mode: "" | "box", offset?: number): Op[] {
  return ids.flatMap((id) => {
    const n = scene.nodes.get(id);
    if (!n) return [];
    let meta = withMeta(n, META_WRAP, mode);
    if (mode === "" ) meta = withMeta({ ...n, meta }, META_WRAP_OFFSET, "");
    else if (offset !== undefined) meta = withMeta({ ...n, meta }, META_WRAP_OFFSET, offset === DEFAULT_WRAP_OFFSET ? "" : String(offset));
    return [makeSetPropsOp(id, { meta }, ["meta"])];
  });
}
