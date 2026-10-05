import { deleteTransitionOp, submit } from "../flow/commands";
import { flowLayout, hitArrow, LABEL_HIT, type Arrow } from "../flow/layout";
import { resolveFlow, useFlowUi } from "../store/flowUi";
import { useScene } from "../store/store";
import type { Tool, ToolContext } from "./types";

// ARROW SELECTION. In Flows mode a click on the canvas FIRST looks for an
// arrow (or its pill) under the pointer: if there is one, it selects it; otherwise
// the gesture is the usual select tool one (screens, marquee). In
// Design mode nothing changes: the wrapper delegates without looking.
//
// It is a wrapper and not inside selectTool so as not to bloat it: selectTool knows
// nothing about flows and continues not to.

// Grab margin around the stroke, in SCREEN px (constant at every zoom).
const ARROW_HIT_PX = 6;

/** The arrow under the WORLD point (x, y), among the visible ones of the current flow. */
export function pickArrow(ctx: ToolContext, x: number, y: number): Arrow | null {
  const scene = ctx.getScene();
  if (!scene || Object.keys(scene.transitions).length === 0) return null;
  const ui = useFlowUi.getState();
  const flow = resolveFlow(scene, ui.currentFlowId);
  const z = ctx.getCamera().zoom || 1;
  return hitArrow(
    flowLayout(scene), x, y, ARROW_HIT_PX / z, { w: LABEL_HIT.w / z, h: LABEL_HIT.h / z },
    (a) => ui.showAllFlows || a.flowId === flow?.id,
  );
}

export function withFlowArrows(base: Tool): Tool {
  // The pointerdown went to an arrow: the rest of the gesture (move/up) must
  // not reach the select tool, which never saw the down.
  let armed = false;

  return {
    ...base,

    onPointerDown(e, ctx) {
      if (useFlowUi.getState().mode !== "flows") return base.onPointerDown?.(e, ctx);
      const w = ctx.toWorld(e);
      const hit = pickArrow(ctx, w.x, w.y);
      if (hit) {
        armed = true;
        useFlowUi.getState().selectTransition(hit.id);
        // A selected arrow and selected nodes together would confuse the
        // panel and Delete: the selection is just one.
        useScene.getState().clearSelection();
        return;
      }
      useFlowUi.getState().selectTransition(null);
      base.onPointerDown?.(e, ctx);
    },

    onPointerMove(e, ctx) {
      if (armed) return;
      if (useFlowUi.getState().mode === "flows" && !useScene.getState().gesture) {
        const w = ctx.toWorld(e);
        useFlowUi.getState().setHoverTransition(pickArrow(ctx, w.x, w.y)?.id ?? null);
      }
      base.onPointerMove?.(e, ctx);
    },

    onPointerUp(e, ctx) {
      if (armed) {
        armed = false;
        return;
      }
      base.onPointerUp?.(e, ctx);
    },

    onKeyDown(e, ctx) {
      const ui = useFlowUi.getState();
      if (ui.mode === "flows" && ui.selectedTransitionId !== null) {
        if (e.key === "Delete" || e.key === "Backspace") {
          const id = ui.selectedTransitionId;
          ui.selectTransition(null);
          // An id that vanished in the meantime (deleted by a peer) is not an error: no op.
          if (useScene.getState().scene?.transitions[id]) submit([deleteTransitionOp(id)]);
          return;
        }
        if (e.key === "Escape") {
          ui.selectTransition(null);
          return;
        }
      }
      base.onKeyDown?.(e, ctx);
    },

    onDeactivate(ctx) {
      armed = false;
      base.onDeactivate?.(ctx);
    },
  };
}
