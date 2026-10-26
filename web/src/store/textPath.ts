import { applyTransform, compose, invertTransform, worldTransformOf } from "@/canvas/transform";
import { withMeta } from "@/flow/meta";
import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { makeSetPropsOp } from "@/tools/ops";
import { recordDelta } from "@/store/sceneDelta";
import { flattenSubpath, type PointLite } from "@/store/vectorGeometry";
import type { NodeLite, SceneState } from "@/store/types";

// TEXT ON A PATH. A text node with `meta["text.path"] = <id of a vector>` runs along the first outline of
// that vector: the characters of its first paragraph are set one after another along the curve and turned
// to follow it (renderer/text.ts::placeOnPath). Like threads and wrap it is DERIVED -- the document keeps
// the link only; the node is drawn with the polyline of the path and the box of that polyline, so moving
// or reshaping the vector moves the text. If the vector is deleted the text goes back to its own box.

export const META_TEXT_PATH = "text.path";

/** The vector a text runs along, or null (no link, a dangling one, or a target that is not a vector with an outline). */
export function pathTargetOf(scene: SceneState, text: NodeLite): NodeLite | null {
  const id = text.meta?.[META_TEXT_PATH];
  if (!id || id === text.id) return null;
  const v = scene.nodes.get(id);
  return v && v.kind === "vector" && (v.vector?.subpaths[0]?.anchors.length ?? 0) >= 2 ? v : null;
}

/** The outline of `vector` as a polyline in the space of `text`'s parent. */
export function pathPointsFor(scene: SceneState, vector: NodeLite, text: NodeLite): PointLite[] {
  const toWorld = worldTransformOf(scene, vector.id);
  const toParent = invertTransform(worldTransformOf(scene, text.parentId));
  const m = compose(toParent, toWorld);
  return flattenSubpath(vector.vector!.subpaths[0], 0.25).map((p) => applyTransform(m, p.x, p.y));
}

const derived = new WeakMap<SceneState, SceneState>();

/** `scene` with the texts that run along a path given their polyline; `scene` itself when none does. */
export function deriveTextPaths(scene: SceneState): SceneState {
  const hit = derived.get(scene);
  if (hit) return hit;
  let edit: ReturnType<SceneState["nodes"]["edit"]> | null = null;
  const changed: string[] = [];
  for (const n of scene.nodes.values()) {
    if (n.kind !== "text" || !n.text || n.meta?.[META_TEXT_PATH] === undefined) continue;
    const v = pathTargetOf(scene, n);
    if (!v) continue;
    const pts = pathPointsFor(scene, v, n);
    if (pts.length < 2) continue;
    const size = n.text.style.fontSize || 16;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const x = Math.min(...xs) - size, y = Math.min(...ys) - size;
    (edit ??= scene.nodes.edit()).set(n.id, {
      ...n, x, y, rotation: 0, width: Math.max(...xs) - Math.min(...xs) + 2 * size, height: Math.max(...ys) - Math.min(...ys) + 2 * size,
      text: { ...n.text, onPath: pts },
    });
    changed.push(n.id);
  }
  if (!edit) { derived.set(scene, scene); return scene; }
  const out: SceneState = { ...scene, nodes: edit.done() };
  recordDelta(out, scene, changed);
  derived.set(scene, out);
  return out;
}

/** Ops that make `textId` run along `vectorId` (or, with an empty id, come off it). */
export function textOnPathOps(scene: SceneState, textId: string, vectorId: string): Op[] {
  const t = scene.nodes.get(textId);
  if (!t || t.kind !== "text") return [];
  if (vectorId !== "") {
    const v = scene.nodes.get(vectorId);
    if (!v || v.kind !== "vector" || vectorId === textId) return [];
  }
  return [makeSetPropsOp(textId, { meta: withMeta(t, META_TEXT_PATH, vectorId) }, ["meta"])];
}
