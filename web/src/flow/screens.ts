import type { NodeLite, SceneState } from "../store/types";
import { sceneIndexOf } from "../renderer/sceneIndex";
import { rootsOf } from "../renderer/canvasRenderer";

// WHAT A SCREEN IS. In the flow model a screen is a node of the
// document (transitions reference it by id); in practice, in the editor, it is
// a TOP-LEVEL FRAME: a direct child of a page. An element inside the
// frame (a button) is not a screen but may be its "hotspot".

/** The node is a direct child of a document page. */
export function isPageRoot(scene: SceneState, n: NodeLite): boolean {
  return scene.pages.some((p) => p.id === n.parentId);
}

/**
 * The screen `id` belongs to: the ancestor-or-self that is a direct child of
 * a page. null if `id` does not exist or does not climb to any page (orphan
 * node). Cycle-proof, like tree.ts::ancestorsOf.
 */
export function screenOf(scene: SceneState, id: string): NodeLite | null {
  const seen = new Set<string>();
  let cur = scene.nodes.at(id);
  while (cur && !seen.has(cur.id)) {
    if (isPageRoot(scene, cur)) return cur;
    seen.add(cur.id);
    cur = scene.nodes.at(cur.parentId);
  }
  return null;
}

/** A top-level frame: what "Connect" accepts as an end of an arrow. */
export function isScreenNode(n: NodeLite | null | undefined): n is NodeLite {
  return !!n && n.kind === "frame";
}

/**
 * The screens of the page (top-level frames), in document order.
 * Goes through the memoized scene index: no scan of the map per
 * call.
 */
export function topLevelScreens(scene: SceneState, pageId: string | null): NodeLite[] {
  const roots = rootsOf(scene, sceneIndexOf(scene).children, pageId);
  return roots.filter(isScreenNode);
}

/**
 * Where a "Connect" drag starts from: the node under the pointer becomes the
 * starting screen (if it is a top-level frame) or the hotspot
 * `elementId` inside its screen. null if there is no screen.
 */
export function connectSource(scene: SceneState, hitId: string): { screenId: string; elementId: string } | null {
  const screen = screenOf(scene, hitId);
  if (!isScreenNode(screen)) return null;
  return { screenId: screen.id, elementId: hitId === screen.id ? "" : hitId };
}

/** The name to show for a screen (never empty). */
export function screenName(scene: SceneState, id: string): string {
  const n = scene.nodes.at(id);
  if (!n) return "(screen deleted)";
  return n.name.trim() !== "" ? n.name : "Untitled";
}
