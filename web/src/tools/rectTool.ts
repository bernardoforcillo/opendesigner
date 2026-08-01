import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/brawt/v1/brawt_pb";
import { normalizeRect } from "../canvas/geometry";
import { nextOrderKey } from "../store/orderKey";
import { useScene } from "../store/store";
import { makeCreateNodeOp, uuid } from "./ops";
import type { Tool, ToolContext } from "./types";

// Dimensione di default quando il gesto è un semplice click invece di un drag.
export const DEFAULT_RECT_WIDTH = 100;
export const DEFAULT_RECT_HEIGHT = 80;

// Sotto questa soglia (px SCHERMO, quindi indipendente dallo zoom) un drag è
// considerato un click: senza soglia, a zoom alto un tremolio di mezzo pixel
// creerebbe un rettangolo largo 0.008 unità mondo, invisibile e inafferrabile.
const CLICK_SLOP_PX = 3;

// Il tool rettangolo fa SOLO creazione: selezione e spostamento vivono nel
// select tool. In M0 questo file era un monolite che faceva tutto e tre.
export function createRectTool(): Tool {
  let anchor: { x: number; y: number } | null = null;

  // L'anteprima riusa il rettangolo di marquee dello store: è già in
  // coordinate mondo ed è già disegnato dall'overlay, quindi non serve un
  // secondo canale solo per il feedback di creazione.
  const preview = (b: { x: number; y: number; width: number; height: number } | null) =>
    useScene.getState().setMarquee(b);

  return {
    id: "rect",
    cursor: "crosshair",

    onPointerDown(e, ctx) {
      anchor = ctx.toWorld(e);
      preview({ ...anchor, width: 0, height: 0 });
    },

    onPointerMove(e, ctx) {
      if (!anchor) return;
      const p = ctx.toWorld(e);
      preview(normalizeRect(anchor.x, anchor.y, p.x, p.y));
    },

    onPointerUp(e, ctx) {
      if (!anchor) return;
      const p = ctx.toWorld(e);
      const box = normalizeRect(anchor.x, anchor.y, p.x, p.y);
      anchor = null;
      preview(null);

      const slop = CLICK_SLOP_PX / ctx.getCamera().zoom; // px schermo -> unità mondo
      const width = box.width < slop ? DEFAULT_RECT_WIDTH : box.width;
      const height = box.height < slop ? DEFAULT_RECT_HEIGHT : box.height;

      const node = create(NodeSchema, {
        id: uuid(),
        parentId: "page1",
        orderKey: nextOrderKey(ctx.getScene()),
        name: "Rectangle",
        visible: true,
        opacity: 1,
        x: box.x,
        y: box.y,
        width,
        height,
        fills: [{ kind: { case: "solid", value: { color: { r: 0.6, g: 0.6, b: 0.65, a: 1 } } } }],
        shape: { case: "rect", value: { cornerRadius: 0 } },
      });
      ctx.sync.submit(makeCreateNodeOp(node));
    },

    // Gesto abbandonato (cambio tool, pointercancel, smontaggio): nessun op.
    onDeactivate(_ctx: ToolContext) {
      if (!anchor) return;
      anchor = null;
      preview(null);
    },
  };
}

export const rectTool = createRectTool();
