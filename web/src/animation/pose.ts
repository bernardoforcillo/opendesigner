import type { AnimInfo, ClipLite, NodeLite, SceneState } from "../store/types";
import { recordDelta } from "../store/sceneDelta";
import { contentWorldBounds } from "../store/groups";
import { applyTransform, invertTransform, worldTransformOf } from "../canvas/transform";
import { sampleClip, type NodeAnim } from "./engine";

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
  return n.kind === "vector" || n.kind === "rect" || n.kind === "ellipse" || n.kind === "frame";
}

/** Merges `src` into `dst`: the properties of `src` win (later clips overwrite). */
export function mergeAnim(dst: Map<string, NodeAnim>, src: ReadonlyMap<string, NodeAnim>): Map<string, NodeAnim> {
  for (const [id, a] of src) {
    const cur = dst.get(id);
    if (cur) Object.assign(cur, a);
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
export function poseScene(base: SceneState, anim: ReadonlyMap<string, NodeAnim>): SceneState {
  if (anim.size === 0) return base;
  let edit: ReturnType<SceneState["nodes"]["edit"]> | null = null;
  const changed: string[] = [];
  const scaled = new Set<string>();
  let hasDraw = false;
  for (const [id, a] of anim) {
    const n = base.nodes.get(id);
    if (!n) continue;
    let next: NodeLite | null = null;
    const patch = () => (next ??= { ...n });
    if (a.opacity !== undefined && a.opacity !== n.opacity) patch().opacity = a.opacity;
    if (a.x !== undefined && a.x !== n.x) patch().x = a.x;
    if (a.y !== undefined && a.y !== n.y) patch().y = a.y;
    if (a.rotation !== undefined && a.rotation !== n.rotation) patch().rotation = a.rotation;
    if (a.scale !== undefined && a.scale !== 1) {
      const p = patch();
      p.animScale = a.scale;
      if (n.kind === "group") p.animPivot = groupPivot(base, n, a);
      scaled.add(id);
    }
    if (a.draw !== undefined && canDraw(n)) {
      patch().animDraw = a.draw;
      // at 1 the path is whole: the GPU renderer draws it normally, no CPU fallback
      if (a.draw < 1) hasDraw = true;
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
