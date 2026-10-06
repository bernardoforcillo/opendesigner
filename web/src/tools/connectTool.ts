import { hitTest } from "../renderer/canvasRenderer";
import { worldBoundsOfNode } from "../canvas/transform";
import { connectOps, submit } from "../flow/commands";
import { connectSource } from "../flow/screens";
import { useFlowUi } from "../store/flowUi";
import { useScene } from "../store/store";
import type { SceneState } from "../store/types";
import type { Tool, ToolContext } from "./types";

// "CONNECT" (K key). Drag from one screen (a top-level frame)
// to another: on release a `click` transition is born in the current flow.
// Starting from an ELEMENT inside the screen (a button) makes it the
// hotspot (`elementId`) of the transition; `fromId` is always its screen.
//
// Everything shown during the drag (the rubber band) is view state in
// useFlowUi.connectPreview, like the marquee of shapeTool: it is not document. The only
// op arrives on release, in ONE gesture -- including the possible creation of the first
// flow ("Flow 1") and of the entry -- so a single Ctrl+Z undoes everything.

// Under this distance (SCREEN px) a drag is a click: no transition.
const CLICK_SLOP_PX = 4;

function screenAt(scene: SceneState, ctx: ToolContext, x: number, y: number): string | null {
  const hit = hitTest(scene, x, y, ctx.getCamera().zoom, useScene.getState().currentPageId);
  if (!hit) return null;
  return connectSource(scene, hit)?.screenId ?? null;
}

export function createConnectTool(): Tool {
  let drag: { screenId: string; elementId: string; sx: number; sy: number; moved: boolean } | null = null;

  const clear = () => {
    drag = null;
    useFlowUi.getState().setConnectPreview(null);
  };

  return {
    id: "connect",
    cursor: "crosshair",

    onPointerDown(e, ctx) {
      const scene = ctx.getScene();
      if (!scene) return;
      const w = ctx.toWorld(e);
      const hit = hitTest(scene, w.x, w.y, ctx.getCamera().zoom, useScene.getState().currentPageId);
      if (!hit) return;
      const src = connectSource(scene, hit);
      if (!src) return;
      const fromNode = scene.nodes.at(src.elementId || src.screenId);
      if (!fromNode) return;
      drag = { ...src, sx: e.clientX, sy: e.clientY, moved: false };
      // The first frame of the rubber band: it starts at the starting point.
      useFlowUi.getState().setConnectPreview({
        fromScreenId: src.screenId,
        elementId: src.elementId,
        fromBounds: worldBoundsOfNode(scene, fromNode),
        x: w.x,
        y: w.y,
        targetId: null,
      });
    },

    onPointerMove(e, ctx) {
      if (!drag) return;
      const scene = ctx.getScene();
      const prev = useFlowUi.getState().connectPreview;
      if (!scene || !prev) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) >= CLICK_SLOP_PX) drag.moved = true;
      const w = ctx.toWorld(e);
      useFlowUi.getState().setConnectPreview({ ...prev, x: w.x, y: w.y, targetId: screenAt(scene, ctx, w.x, w.y) });
    },

    onPointerUp(e, ctx) {
      if (!drag) return;
      const d = drag;
      const scene = ctx.getScene();
      clear();
      if (!scene || !d.moved) return;
      const w = ctx.toWorld(e);
      const target = screenAt(scene, ctx, w.x, w.y);
      if (!target) return;
      // A screen towards itself only makes sense from an element ("reload",
      // "open the menu"): without a hotspot it would be a useless loop.
      if (target === d.screenId && d.elementId === "") return;
      const ui = useFlowUi.getState();
      const r = connectOps(scene, ui.currentFlowId, d.screenId, target, d.elementId);
      submit(r.ops);
      ui.setCurrentFlow(r.flowId);
      useFlowUi.getState().selectTransition(r.transitionId);
    },

    onKeyDown(e) {
      if (e.key === "Escape" && drag) clear();
    },

    // Tool change, pointercancel, unmount: the half-done gesture is abandoned.
    onDeactivate() {
      if (drag) clear();
    },
  };
}

export const connectTool = createConnectTool();
