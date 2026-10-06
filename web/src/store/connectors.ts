import { invertTransform, mapBounds, worldBoundsOfNode, worldTransformOf } from "../canvas/transform";
import { connectorOf, connectorSubpaths } from "../vector/connector";
import { recordDelta } from "./sceneDelta";
import { normalizeVector } from "./vectorGeometry";
import type { SceneState } from "./types";

// CONNECTORS THAT FOLLOW THEIR SHAPES. A vector node with `connector.from` / `connector.to` meta is
// redrawn between the two nodes wherever they are: like live booleans and variables the result is
// DERIVED (resolveScene) and never written, so a remote move, an agent's setProps or an undo all
// keep the arrow attached. The stored path is only what the connector looked like when it was made.

const derived = new WeakMap<SceneState, SceneState>();

/** `scene` with each connector's path recomputed from its ends; `scene` itself when there are none (or none moved). */
export function deriveConnectors(scene: SceneState): SceneState {
  const hit = derived.get(scene);
  if (hit) return hit;
  let edit: ReturnType<SceneState["nodes"]["edit"]> | null = null;
  const changed: string[] = [];
  for (const n of scene.nodes.values()) {
    const spec = connectorOf(n);
    if (!spec) continue;
    const a = scene.nodes.get(spec.from);
    const b = scene.nodes.get(spec.to);
    if (!a || !b || !a.visible || !b.visible) continue;
    // The ends in the connector's own parent space, where its path lives.
    const into = invertTransform(worldTransformOf(scene, n.parentId));
    const boxA = mapBounds(into, worldBoundsOfNode(scene, a));
    const boxB = mapBounds(into, worldBoundsOfNode(scene, b));
    const weight = n.strokes[0]?.weight ?? 1;
    const subpaths = connectorSubpaths(boxA, boxB, spec, weight);
    if (subpaths.length === 0) continue;
    const norm = normalizeVector({ x: 0, y: 0 }, subpaths);
    (edit ??= scene.nodes.edit()).set(n.id, {
      ...n, rotation: 0, vector: { subpaths: norm.subpaths },
      x: norm.box.x, y: norm.box.y, width: norm.box.width, height: norm.box.height,
    });
    changed.push(n.id);
  }
  if (!edit) { derived.set(scene, scene); return scene; }
  const out: SceneState = { ...scene, nodes: edit.done() };
  recordDelta(out, scene, changed);
  derived.set(scene, out);
  return out;
}
