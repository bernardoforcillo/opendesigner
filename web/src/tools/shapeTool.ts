import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/brawt/v1/brawt_pb";
import { normalizeRect } from "../canvas/geometry";
import { nextOrderKey } from "../store/orderKey";
import { useScene } from "../store/store";
import { makeCreateNodeOp, uuid } from "./ops";
import type { Tool, ToolContext, ToolId } from "./types";

// Sotto questa soglia (px SCHERMO, quindi indipendente dallo zoom) un drag è
// considerato un click: senza soglia, a zoom alto un tremolio di mezzo pixel
// creerebbe una forma larga 0.008 unità mondo, invisibile e inafferrabile.
const CLICK_SLOP_PX = 3;

export interface ShapeToolConfig {
  id: ToolId;
  name: string;
  defaultWidth: number;
  defaultHeight: number;
  // Funzione, non un oggetto condiviso: ogni gesto deve ricevere un init
  // fresco, così create() non riceve mai lo stesso riferimento due volte.
  shape: () => MessageInitShape<typeof NodeSchema>["shape"];
}

// rectTool ed ellipseTool sono lo stesso gesto di creazione (down/move/up,
// soglia click, anteprima via marquee dello store, abbandono su deactivate):
// l'unica differenza reale fra le due è la forma emessa, isolata qui in
// ShapeToolConfig. Se un terzo tool-forma smettesse di starci dentro con
// >80% di codice letteralmente identico, andrebbe scritto a mano.
export function makeShapeTool(config: ShapeToolConfig): Tool {
  let anchor: { x: number; y: number } | null = null;

  // L'anteprima riusa il rettangolo di marquee dello store: è già in
  // coordinate mondo ed è già disegnato dall'overlay, quindi non serve un
  // secondo canale solo per il feedback di creazione.
  const preview = (b: { x: number; y: number; width: number; height: number } | null) =>
    useScene.getState().setMarquee(b);

  return {
    id: config.id,
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
      const width = box.width < slop ? config.defaultWidth : box.width;
      const height = box.height < slop ? config.defaultHeight : box.height;

      const node = create(NodeSchema, {
        id: uuid(),
        parentId: "page1",
        orderKey: nextOrderKey(ctx.getScene()),
        name: config.name,
        visible: true,
        opacity: 1,
        x: box.x,
        y: box.y,
        width,
        height,
        fills: [{ kind: { case: "solid", value: { color: { r: 0.6, g: 0.6, b: 0.65, a: 1 } } } }],
        shape: config.shape(),
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
