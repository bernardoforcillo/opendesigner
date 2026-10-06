import { pinAt, pinsOf, placement } from "../comments/pins";
import { hitTest } from "../renderer/canvasRenderer";
import { useCommentsUi } from "../store/commentsUi";
import { useScene } from "../store/store";
import type { Tool } from "./types";

// COMMENT TOOL: a click on a pin opens its thread; a click anywhere else drops a new pin
// (attached to the node under the pointer, or free on the page) and asks for its text in
// the Comments panel. It never writes the document: the comment is created when the text
// is sent (ui/CommentsPanel.tsx).
export function createCommentTool(): Tool {
  return {
    id: "comment",
    cursor: "crosshair",
    onPointerDown(e, ctx) {
      const scene = ctx.getScene();
      if (!scene) return;
      const w = ctx.toWorld(e);
      const zoom = ctx.getCamera().zoom;
      const pageId = useScene.getState().currentPageId ?? scene.pages[0]?.id ?? "";
      const ui = useCommentsUi.getState();
      const hit = pinAt(pinsOf(scene, pageId, ui.showResolved), w.x, w.y, zoom);
      if (hit) {
        ui.setActive(hit.threadId);
        ui.requestReveal();
        return;
      }
      const nodeId = hitTest(scene, w.x, w.y, zoom, pageId);
      ui.setDraft(placement(scene, nodeId, pageId, w.x, w.y));
      ui.requestReveal();
    },
    onKeyDown(e) {
      if (e.key === "Escape") useCommentsUi.getState().setDraft(null);
    },
    onDeactivate() {
      useCommentsUi.getState().setDraft(null);
    },
  };
}

export const commentTool = createCommentTool();
