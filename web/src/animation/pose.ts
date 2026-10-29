import type { AnimInfo, ClipLite, NodeLite, SceneState } from "@/store/types";
import { recordDelta } from "@/store/sceneDelta";
import { contentWorldBounds } from "@/store/groups";
import { applyTransform, invertTransform, worldTransformOf } from "@/canvas/transform";
import { sampleClip, type NodeAnim } from "@/animation/engine";
import type { NodeFx, NodeFxText } from "@/animation/fx/props";
import { fxDef, resolveFx } from "@/animation/fx/library";

// THE POSED SCENE.
//
// While a clip runs (or the playhead is scrubbed, or recording) the canvas does not
// show the document but a VARIANT of it: the same nodes with the sampled
// values in place of the base ones. It is derived, never written: the document
// does not change, no op goes out, and stopping the animation brings back the real scene
// with nothing to undo.
//
// The derived scene is a scene like any other, so the renderer, hit-test,
// overlay and tools read it without knowing:
//   - x, y, rotation, opacity are the node's real fields;
//   - `scale` and `draw` have no field in the model: they go in the
//     TRANSIENT fields animScale/animPivot/animDraw of NodeLite, which only the renderer
//     knows (canvas/transform.ts::localTransformOf, renderer/animDraw.ts).
//
// The cost is proportional to the ANIMATED nodes, not to the document: the node map is
// persistent (a few entries are replaced) and the provenance (sceneDelta) tells
// the scene index that only those changed, so it does not rebuild it.

/** The node types on which `draw` makes sense (they have a path): parity with core.validTrack. */
export function canDraw(n: Pick<NodeLite, "kind">): boolean {
  return n.kind === "vector" || n.kind === "rect" || n.kind === "ellipse" || n.kind === "frame" || n.kind === "polygon" || n.kind === "star";
}

function mergeText(dst: NodeFxText | undefined, src: NodeFxText): NodeFxText {
  const out: NodeFxText = {};
  for (const [id, v] of Object.entries(dst ?? {})) out[id] = { ...v };
  for (const [id, v] of Object.entries(src)) out[id] = { ...out[id], ...v };
  return out;
}

function mergeFx(dst: NodeFx | undefined, src: NodeFx): NodeFx {
  const out: NodeFx = {};
  for (const [id, v] of Object.entries(dst ?? {})) out[id] = { ...v };
  for (const [id, v] of Object.entries(src)) out[id] = { ...out[id], ...v };
  return out;
}

/** Merges `src` into `dst`: the properties of `src` win (later clips overwrite). */
export function mergeAnim(dst: Map<string, NodeAnim>, src: ReadonlyMap<string, NodeAnim>): Map<string, NodeAnim> {
  for (const [id, a] of src) {
    const cur = dst.get(id);
    if (cur) {
      const { fx, fxRefs, fxText, ...rest } = a;
      Object.assign(cur, rest);
      if (fx) cur.fx = mergeFx(cur.fx, fx);
      if (fxRefs) cur.fxRefs = { ...cur.fxRefs, ...fxRefs };
      if (fxText) cur.fxText = mergeText(cur.fxText, fxText);
    }
    else dst.set(id, { ...a });
  }
  return dst;
}

/** The sampled values of a clip at `t` ms, with a draft (record, drag) on top. */
export function sampleWithDraft(clip: Pick<ClipLite, "tracks">, t: number, draft?: ReadonlyMap<string, NodeAnim> | null): Map<string, NodeAnim> {
  const out = sampleClip(clip, t);
  return draft && draft.size > 0 ? mergeAnim(out, draft) : out;
}

// The center (parent space) a GROUP scales around: a group has no
// box, its "center" is that of the contents. Computed on the BASE scene
// (the children's geometry is not animated by this track) and shifted by as much as
// the track shifts the group itself.
function groupPivot(base: SceneState, n: NodeLite, a: NodeAnim): { x: number; y: number } | undefined {
  const b = contentWorldBounds(base, n);
  if (!b) return undefined;
  const inv = invertTransform(worldTransformOf(base, n.parentId));
  const c = applyTransform(inv, b.x + b.width / 2, b.y + b.height / 2);
  return { x: c.x + ((a.x ?? n.x) - n.x), y: c.y + ((a.y ?? n.y) - n.y) };
}

/**
 * The `base` scene with the `anim` values applied to the nodes. Returns `base` itself
 * (same identity: no extra redraw, no index to rebuild) if nothing
 * changes -- an empty clip, values equal to the base ones, vanished nodes.
 */
/** Where the time effects find the other moments: `t` is the current time (ms), `at(dt)` the sampled state at t + dt. */
export interface TimeSource {
  t: number;
  at: (dt: number) => ReadonlyMap<string, NodeAnim>;
}

// The node with the animated values applied, or null if nothing changes. `scaled`/`draw` report what the scene needs to know.
function patchNode(base: SceneState, n: NodeLite, a: NodeAnim, timeMs?: number): { next: NodeLite | null; scaled: boolean; drawing: boolean } {
  let next: NodeLite | null = null;
  let scaled = false, drawing = false;
  const patch = () => (next ??= { ...n });
  if (a.opacity !== undefined && a.opacity !== n.opacity) patch().opacity = a.opacity;
  if (a.x !== undefined && a.x !== n.x) patch().x = a.x;
  if (a.y !== undefined && a.y !== n.y) patch().y = a.y;
  if (a.rotation !== undefined && a.rotation !== n.rotation) patch().rotation = a.rotation;
  if (a.scale !== undefined && a.scale !== 1) {
    const p = patch();
    p.animScale = a.scale;
    if (n.kind === "group") p.animPivot = groupPivot(base, n, a);
    scaled = true;
  }
  if (a.fx) patch().animFx = mergeFx(n.animFx, a.fx);
  if (a.fxRefs) patch().animFxRefs = { ...n.animFxRefs, ...a.fxRefs };
  if (a.fxText) patch().animFxText = mergeText(n.animFxText, a.fxText);
  // effects that read the clip time (the audio visualisers) get it
  if (timeMs !== undefined && a.fx && Object.keys(a.fx).some((id) => fxDef(id)?.needsTime)) patch().animTime = timeMs;
  if (a.draw !== undefined && canDraw(n)) {
    patch().animDraw = a.draw;
    // at 1 the path is whole: the GPU renderer draws it normally, no CPU fallback
    if (a.draw < 1) drawing = true;
  }
  return { next, scaled, drawing };
}

// The node's time effect (the first one in the track order), resolved at the current values.
function timeEffectOf(a: NodeAnim, t: number) {
  if (!a.fx) return null;
  for (const [id, given] of Object.entries(a.fx)) {
    const def = fxDef(id);
    if (def?.time) return def.time(resolveFx(def, given), t);
  }
  return null;
}

export function poseScene(base: SceneState, anim: ReadonlyMap<string, NodeAnim>, time?: TimeSource): SceneState {
  if (anim.size === 0) return base;
  let edit: ReturnType<SceneState["nodes"]["edit"]> | null = null;
  const changed: string[] = [];
  const scaled = new Set<string>();
  let hasDraw = false;
  const sampled = new Map<number, ReadonlyMap<string, NodeAnim>>();
  for (const [id, a] of anim) {
    const n = base.nodes.get(id);
    if (!n) continue;
    const r = patchNode(base, n, a, time?.t);
    let next = r.next;
    if (r.scaled) scaled.add(id);
    if (r.drawing) hasDraw = true;
    // Time effects: the node posed at the other moments (never for a group, which draws nothing itself).
    const te = time && n.kind !== "group" ? timeEffectOf(a, time.t) : null;
    if (te && time) {
      const nowNode = next ?? n;
      const samples = te.samples.map(({ dt, weight }) => {
        if (dt === 0) return { node: nowNode, weight };
        let m = sampled.get(dt);
        if (!m) sampled.set(dt, (m = time.at(dt)));
        const sa = m.get(id);
        const posed = sa ? patchNode(base, n, sa).next : null;
        return { node: posed ?? n, weight };
      });
      next = { ...nowNode, animEcho: { mode: te.mode, samples, ...(te.uniforms ? { uniforms: te.uniforms } : {}) } };
    }
    if (next) {
      edit ??= base.nodes.edit();
      edit.set(id, next);
      changed.push(id);
    }
  }
  if (!edit) return base;
  // The ancestors of the scaled nodes: their extent is the union of the children.
  const ancestors = new Set<string>();
  for (const id of scaled) {
    for (let cur = base.nodes.get(id), g = 0; cur && g < 1000; cur = base.nodes.get(cur.parentId), g++) {
      if (cur.id !== id) ancestors.add(cur.id);
    }
  }
  const info: AnimInfo = { scaled, ancestors, hasDraw };
  const scene: SceneState = { ...base, nodes: edit.done(), anim: info };
  recordDelta(scene, base, changed);
  return scene;
}
