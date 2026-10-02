import { deleteTransitionOp, submit } from "../flow/commands";
import { flowLayout, hitArrow, LABEL_HIT, type Arrow } from "../flow/layout";
import { resolveFlow, useFlowUi } from "../store/flowUi";
import { useScene } from "../store/store";
import type { Tool, ToolContext } from "./types";

// SELEZIONE DELLE FRECCE. In modalità Flussi il click sul canvas cerca PRIMA una
// freccia (o la sua pillola) sotto il puntatore: se c'è, la seleziona; altrimenti
// il gesto è quello del tool di selezione di sempre (schermate, marquee). In
// modalità Design non cambia nulla: il wrapper delega senza guardare.
//
// Sta come wrapper e non dentro selectTool per non gonfiarlo: selectTool non sa
// nulla dei flussi e continua a non saperlo.

// Presa attorno al tratto, in px SCHERMO (costante a ogni zoom).
const ARROW_HIT_PX = 6;

/** La freccia sotto il punto MONDO (x, y), fra quelle visibili del flusso corrente. */
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
  // Il pointerdown è andato a una freccia: il resto del gesto (move/up) non
  // deve arrivare al tool di selezione, che non ha mai visto il down.
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
        // Una freccia scelta e dei nodi selezionati insieme confonderebbero il
        // pannello e il Canc: la scelta è una sola.
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
          // Un id sparito nel frattempo (cancellato da un peer) non è un errore: niente op.
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
