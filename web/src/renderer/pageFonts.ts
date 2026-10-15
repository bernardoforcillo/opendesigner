import type { SceneState } from "../store/types";
import { sceneIndexOf } from "./sceneIndex";
import { rootsOf } from "./canvasRenderer";
import { firstFamily } from "./ck/canvaskit";

// WHICH UPLOADED FONTS A PAGE NEEDS. A document keeps all its fonts, but only the page on screen
// has to download them: the renderers ask this for the families used by the current page's text and
// fetch only those. `null` means "cannot tell, load them all" -- a page with component instances
// draws its masters' text, which this does not follow.

const memo = new WeakMap<SceneState, Map<string, ReadonlySet<string> | null>>();

export function fontFamiliesOnPage(scene: SceneState, pageId: string | null): ReadonlySet<string> | null {
  const key = pageId ?? scene.pages[0]?.id ?? "";
  let perScene = memo.get(scene);
  if (!perScene) memo.set(scene, (perScene = new Map()));
  if (perScene.has(key)) return perScene.get(key) ?? null;
  const children = sceneIndexOf(scene).children;
  const out = new Set<string>();
  let all = false;
  const stack = [...rootsOf(scene, children, pageId)];
  while (stack.length > 0 && !all) {
    const n = stack.pop()!;
    if (n.kind === "instance") { all = true; break; }
    if (n.kind === "text" && n.text?.style.fontFamily) out.add(firstFamily(n.text.style.fontFamily));
    for (const c of children.get(n.id) ?? []) stack.push(c);
  }
  const result = all ? null : out;
  perScene.set(key, result);
  return result;
}
