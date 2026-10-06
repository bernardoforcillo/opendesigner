import { worldTransformOf } from "../canvas/transform";
import { booleanOpOf, booleanRegion, regionOf } from "../vector/regions";
import { recordDelta } from "./sceneDelta";
import { subtreeOf } from "./tree";
import { normalizeVector } from "./vectorGeometry";
import type { NodeLite, SceneState } from "./types";

// LIVE BOOLEAN GROUPS. A group whose meta has `boolean.op` keeps its shapes as children and DRAWS as
// the result of the operation over them, styled by the group's own fills, strokes and effects.
// Nothing is written to the document: like variables, the result is DERIVED (resolveScene) -- the
// canvas, the exports and the prototype draw a scene where the group is a vector node and its
// children are hidden. Editing a child, or moving it, changes the result at once; the tools and the
// layers panel keep working on the real group.

/** The live boolean groups of a scene that are not themselves inside another one. */
export function liveBooleanRoots(scene: SceneState): NodeLite[] {
  const live = new Set<string>();
  for (const n of scene.nodes.values()) if (booleanOpOf(n)) live.add(n.id);
  if (live.size === 0) return [];
  const inside = (n: NodeLite): boolean => {
    for (let cur = scene.nodes.get(n.parentId), guard = 0; cur && guard < 10000; cur = scene.nodes.get(cur.parentId), guard++) {
      if (live.has(cur.id)) return true;
    }
    return false;
  };
  return [...live].map((id) => scene.nodes.at(id)).filter((n) => !inside(n));
}

const derived = new WeakMap<SceneState, SceneState>();

/** `scene` with every live boolean group turned into a vector and its children hidden; `scene` itself when there are none. */
export function deriveBooleans(scene: SceneState): SceneState {
  const hit = derived.get(scene);
  if (hit) return hit;
  const roots = liveBooleanRoots(scene);
  if (roots.length === 0) { derived.set(scene, scene); return scene; }
  let edit = scene.nodes.edit();
  const changed: string[] = [];
  for (const g of roots) {
    for (const d of subtreeOf(scene, g.id)) {
      if (d.id === g.id) continue;
      edit.set(d.id, { ...d, visible: false });
      changed.push(d.id);
    }
    const region = regionOf(scene, g, worldTransformOf(scene, g.parentId));
    const subpaths = booleanRegion("union", [region]);
    const base: NodeLite = { ...g, kind: "vector", rotation: 0 };
    if (subpaths.length === 0) {
      edit.set(g.id, { ...base, vector: { subpaths: [] }, width: 0, height: 0, visible: false });
    } else {
      const norm = normalizeVector({ x: 0, y: 0 }, subpaths);
      edit.set(g.id, { ...base, vector: { subpaths: norm.subpaths }, x: norm.box.x, y: norm.box.y, width: norm.box.width, height: norm.box.height });
    }
    changed.push(g.id);
  }
  const out: SceneState = { ...scene, nodes: edit.done() };
  recordDelta(out, scene, changed);
  derived.set(scene, out);
  return out;
}
