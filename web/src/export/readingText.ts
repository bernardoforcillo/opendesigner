import { flattenStyle } from "../store/richText";
import { textNodesInReadingOrder } from "../store/textTokens";
import type { SceneState } from "../store/types";

// The TEXT of a page in reading order, as structure: what a screen reader gets in an accessible EPUB (fixed layout) next to the page's
// picture. Pass the RESOLVED scene (cross-references and page numbers already written into the text).

export interface ReadingItem { level: number; text: string }

export function pageReadingText(scene: SceneState, pageId: string): ReadingItem[] {
  const out: ReadingItem[] = [];
  for (const { node, pageId: pid } of textNodesInReadingOrder(scene)) {
    if (pid !== pageId || !node.text) continue;
    const paras = node.text.content.replace(/\r\n?/g, "\n").split("\n");
    paras.forEach((text, i) => {
      if (text.trim() === "") return;
      const id = node.text!.paragraphStyles?.[i];
      const level = id ? flattenStyle(scene.textStyles, id)?.outlineLevel ?? 0 : 0;
      out.push({ level, text: text.trim() });
    });
  }
  return out;
}

/** The alternative text of every image on the page: the node's `alt` meta, else its layer name when it is not a bare file name. */
export function pageImageAlts(scene: SceneState, pageId: string): string[] {
  const out: string[] = [];
  for (const n of scene.nodes.values()) {
    if (n.kind !== "image" || n.fromMaster) continue;
    let cur = n, onPage = false;
    for (let g = 0; g < 64 && cur; g++) { if (cur.parentId === pageId) { onPage = true; break; } const up = scene.nodes.get(cur.parentId); if (!up) break; cur = up; }
    if (!onPage) continue;
    const alt = n.meta?.["alt"];
    out.push(alt !== undefined ? alt : /\.(png|jpe?g|gif|webp|svg)$/i.test(n.name) ? "" : n.name);
  }
  return out;
}
