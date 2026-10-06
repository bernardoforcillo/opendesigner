import type { SceneState } from "./types";

// The PROVENANCE of a scene: which scene it was produced from and which nodes
// were touched. applyOp records it for ops that touch a few known nodes
// (create, write properties, text, path) and for the nodes that auto layout
// then rearranged.
//
// It serves whoever maintains structures derived from the scene (the scene index): without it,
// to know what changed they must compare ALL nodes -- a linear scan
// for every op, even when the op touched only one. With provenance
// the cost is proportional to the touched nodes.
//
// It is only a HINT: whoever uses it must be able to fall back on the full comparison
// (the previous scene may have no derived structure, an op may not
// record it). WeakMap, so it does not retain scenes nobody references anymore.
export interface SceneDelta {
  prev: SceneState;
  // Ids of the nodes whose entry in `nodes` is new or changed. Never removed nodes: ops
  // that remove nodes do not record provenance.
  changed: readonly string[];
}

const deltas = new WeakMap<SceneState, SceneDelta>();

export function recordDelta(next: SceneState, prev: SceneState, changed: readonly string[]): void {
  if (next !== prev) deltas.set(next, { prev, changed });
}

export function deltaOf(scene: SceneState): SceneDelta | undefined {
  return deltas.get(scene);
}
