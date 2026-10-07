import { hitTest } from "../renderer/canvasRenderer";
import { worldBoundsOfNode } from "../canvas/transform";
import { useScene } from "../store/store";
import type { SceneState } from "../store/types";
import { connectOps } from "../vector/connect";
import type { Tool, ToolContext } from "./types";

// "LINK" (L, in the Board). Drag from one thing to another and an arrow joins them -- an arrow that
// FOLLOWS them (vector/connector.ts). A sticky note, a table cell group or a card is a group of
// nodes: the link attaches to the whole object, not to the piece under the pointer.

const CLICK_SLOP_PX = 4;

/** The thing a pointer at (x, y) means: the outermost plain group around the hit node, else the node itself. */
export function linkableAt(scene: SceneState, ctx: ToolContext, x: number, y: number): string | null {
  const hit = hitTest(scene, x, y, ctx.getCamera().zoom, useScene.getState().currentPageId);
  if (!hit) return null;
  let id = hit;
  for (let guard = 0; guard < 10000; guard++) {
    const parent = scene.nodes.get(scene.nodes.get(id)?.parentId ?? "");
    if (!parent || parent.kind !== "group") break;
    id = parent.id;
  }
  // A connector is not something to attach to.
  return scene.nodes.get(id)?.meta?.["connector.from"] ? null : id;
}

export function createLinkTool(): Tool {
  let drag: { fromId: string; sx: number; sy: number; moved: boolean } | null = null;
  const clear = () => {
    drag = null;
    useScene.getState().setLinkPreview(null);
  };

  return {
    id: "link",
    cursor: "crosshair",

    onPointerDown(e, ctx) {
      const scene = ctx.getScene();
      if (!scene) return;
      const w = ctx.toWorld(e);
      const fromId = linkableAt(scene, ctx, w.x, w.y);
      const node = fromId ? scene.nodes.at(fromId) : undefined;
      if (!fromId || !node) return;
      drag = { fromId, sx: e.clientX, sy: e.clientY, moved: false };
      useScene.getState().setLinkPreview({ from: worldBoundsOfNode(scene, node), x: w.x, y: w.y, targetId: null });
    },

    onPointerMove(e, ctx) {
      if (!drag) return;
      const scene = ctx.getScene();
      const prev = useScene.getState().linkPreview;
      if (!scene || !prev) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) >= CLICK_SLOP_PX) drag.moved = true;
      const w = ctx.toWorld(e);
      useScene.getState().setLinkPreview({ ...prev, x: w.x, y: w.y, targetId: linkableAt(scene, ctx, w.x, w.y) });
    },

    onPointerUp(e, ctx) {
      if (!drag) return;
      const d = drag;
      const scene = ctx.getScene();
      clear();
      if (!scene || !d.moved) return;
      const w = ctx.toWorld(e);
      const target = linkableAt(scene, ctx, w.x, w.y);
      if (!target || target === d.fromId) return;
      const res = connectOps(scene, d.fromId, target);
      if (!res) return;
      const st = useScene.getState();
      st.beginGesture();
      st.setSelection(res.selection);
      st.endGesture(res.ops);
    },

    onKeyDown(e) {
      if (e.key === "Escape" && drag) clear();
    },

    onDeactivate() {
      if (drag) clear();
    },
  };
}

export const linkTool = createLinkTool();
