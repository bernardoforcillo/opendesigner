import type { SceneState } from "../store/types";

// THE PROTOTYPE SCENE: the document seen as if it contained a SINGLE page
// with a SINGLE screen. This way the usual renderer (drawScene) draws the
// current screen -- same rules for clip, effects, images, instances --
// without knowing a prototype exists, and without the other screens.
//
// Nothing is copied: the screen is RE-PARENTED under a fake page,
// and the node map is persistent (store/nodeMap.ts), so the cost is
// a single new entry. The other screens remain children of the real pages, which
// in the derived scene do not exist: they are not reachable, they are not drawn.
// The components stay in place, and the instances keep resolving.

export const PROTO_PAGE_ID = "__prototype__";

let memo: { scene: SceneState; screenId: string; derived: SceneState } | null = null;

/**
 * The scene that shows only `screenId`, or null if the node does not exist. Memoized
 * on the last pair (scene, screen): at every frame the SAME
 * object is returned, and the renderer's scene index is not rebuilt.
 */
export function sceneForScreen(scene: SceneState, screenId: string): SceneState | null {
  if (memo && memo.scene === scene && memo.screenId === screenId) return memo.derived;
  const root = scene.nodes.at(screenId);
  if (!root) return null;
  const derived: SceneState = {
    ...scene,
    pages: [{ id: PROTO_PAGE_ID, name: "Prototype" }],
    nodes: scene.nodes.set(screenId, { ...root, parentId: PROTO_PAGE_ID, visible: true }),
  };
  memo = { scene, screenId, derived };
  return derived;
}
