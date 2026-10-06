import { type Transform, compose, localTransformOf, translation } from "../canvas/transform";
import { effectiveComponentId, effectiveOverrides } from "./components";
import type { InstanceOverrideLite, NodeLite, SceneState } from "./types";

// INSTANCES: the VIRTUAL subtree of a component, and how to descend into it.
//
// An instance (kind "instance") has no children of its own in `scene.nodes`: it renders the
// MASTER's subtree, which is a normal subtree rooted at
// scene.components[componentId].rootNodeId. It is therefore, for all intents and purposes, "a
// GROUP whose children are the master's subtree, moved to the instance's
// origin, with per-node overrides" -- and the renderer's four descents
// (draw, hit-test, marquee) plus the bounds treat it exactly that way,
// from these two shared building blocks: the MASTER RESOLUTION and the
// DESCENT TRANSFORM. Having them in a single place is what keeps
// see-vs-select aligned: drawing, click and frame descend with the same matrix.

export function isInstance(n: NodeLite | undefined): boolean {
  return n?.kind === "instance";
}

// The resolved master of an instance: the root of its subtree (a LIVE node
// in `scene.nodes`) and the componentId it renders. `null` when the instance has no
// content to show -- component absent from `components`, or master
// absent from `nodes`: in that case nothing is drawn, nothing is hit
// and the bounds are null, exactly like an empty group. A node that
// is not an instance (or has no `instance` payload) also falls back to null.
export interface ResolvedInstance {
  masterRoot: NodeLite;
  componentId: string;
}

export function resolveInstance(scene: SceneState, n: NodeLite): ResolvedInstance | null {
  if (n.kind !== "instance" || !n.instance) return null;
  // The variant the instance has chosen (components.ts::effectiveComponentId): the
  // base component itself when it is not part of a set or nothing matches.
  const componentId = effectiveComponentId(scene, n.instance);
  const comp = scene.components[componentId];
  if (!comp) return null;
  const masterRoot = scene.nodes.at(comp.rootNodeId);
  if (!masterRoot) return null;
  return { masterRoot, componentId };
}

// The instance's overrides indexed by master node (masterNodeId ->
// override). It is the map that drawing THREADS along the master descent: when
// it draws a master node whose id is in here, it uses the override's `fills`/`text`
// in place of those of the node (see renderer/canvasRenderer.ts).
// The bounds do NOT use it: a fill or text override does not move the geometry (a
// longer text might, but this model does not remeasure -- see the comment
// on bounds in store/groups.ts).
export function instanceOverrideMap(scene: SceneState, n: NodeLite): Map<string, InstanceOverrideLite> {
  // The explicit overrides plus what the component's properties derive (a text
  // property sets text, a false boolean property hides): components.ts::effectiveOverrides.
  return effectiveOverrides(scene, n);
}

// The master nodes an instance HIDES (a boolean component property set to false), or
// null when none -- the common case, which costs nothing. Drawing, hit-test and bounds
// all skip them (and their subtrees), like any invisible node.
export function hiddenMasterNodes(scene: SceneState, n: NodeLite): ReadonlySet<string> | null {
  if (!n.instance) return null;
  const comp = scene.components[effectiveComponentId(scene, n.instance)];
  if (!comp?.properties) return null;
  let out: Set<string> | null = null;
  for (const [id, o] of effectiveOverrides(scene, n)) if (o.hidden) (out ??= new Set()).add(id);
  return out;
}

// The transform that PLACES the master's subtree at the instance, in the
// space of the instance's PARENT. Two pieces:
//   - localTransformOf(n): the position (and rotation) of the instance in its
//     parent, IDENTICAL to that of any other node;
//   - translation(-masterRoot.x, -masterRoot.y): inside the instance's
//     local space, moves the master so that the ORIGIN of its root lands
//     on the instance's origin. Without it, the master would appear at its own
//     absolute coordinates instead of where the instance is.
// The renderer applies it to ctx while descending; hit-test applies the INVERSE to the
// point; the bounds compose it with worldTransformOf(parent) and map the boxes
// of the master with it. These are the three directions of the same matrix, and they must remain
// the same matrix -- like localTransformOf for normal containers.
export function instanceDescentLocal(n: NodeLite, masterRoot: NodeLite): Transform {
  return compose(localTransformOf(n), translation(-masterRoot.x, -masterRoot.y));
}
