import { hitTest } from "../renderer/canvasRenderer";
import { worldBoundsOfNode } from "../canvas/transform";
import { connectOps, submit } from "../flow/commands";
import { connectSource } from "../flow/screens";
import { useFlowUi } from "../store/flowUi";
import { useScene } from "../store/store";
import type { SceneState } from "../store/types";
import type { Tool, ToolContext } from "./types";

// "COLLEGA" (tasto K). Si trascina da una schermata (un frame di primo livello)
// a un'altra: al rilascio nasce una transizione `click` nel flusso corrente.
// Partire da un ELEMENTO dentro la schermata (un bottone) lo fa diventare
// l'hotspot (`elementId`) della transizione; `fromId` è sempre la sua schermata.
//
// Tutto ciò che si vede durante il drag (il rubber band) è stato di vista in
// useFlowUi.connectPreview, come la marquee di shapeTool: non è documento. L'unico
// op arriva al rilascio, in UN gesto -- compresa l'eventuale creazione del primo
// flusso ("Flusso 1") e dell'ingresso -- così un solo Ctrl+Z annulla tutto.

// Sotto questa distanza (px SCHERMO) un drag è un click: nessuna transizione.
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
      // Il primo frame del rubber band: nasce dal punto di partenza.
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
      // Una schermata verso se stessa ha senso solo da un elemento ("ricarica",
      // "apri il menu"): senza hotspot sarebbe un anello inutile.
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

    // Cambio tool, pointercancel, smontaggio: il gesto a metà si abbandona.
    onDeactivate() {
      if (drag) clear();
    },
  };
}

export const connectTool = createConnectTool();
