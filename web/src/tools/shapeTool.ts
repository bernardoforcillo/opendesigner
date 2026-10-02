import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
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
  // Il colore del riempimento di partenza. Assente = il grigio delle forme.
  // Un frame parte invece trasparente-bianco: è un contenitore, non una forma.
  fill?: { r: number; g: number; b: number; a: number } | null;
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

      // `box` è in coordinate MONDO e finisce nel nodo così com'è. Le
      // coordinate del modello sono relative al PARENT (canvas/transform.ts) e
      // qui il parent è una PAGINA, che contribuisce l'identità: le due cose
      // coincidono. Il giorno in cui si potrà disegnare DENTRO un container,
      // il box va prima portato nello spazio locale di quel container
      // (transform.ts::worldToLocal).
      //
      // Il parent è la PAGINA CORRENTE (stato di vista dello store), non un
      // "page1" fisso: disegnare mentre si è su un'altra pagina crea il nodo lì.
      // Il ripiego a "page1" copre solo il caso -- irraggiungibile con una scena
      // installata -- in cui currentPageId non è ancora stato risolto.
      const node = create(NodeSchema, {
        id: uuid(),
        parentId: useScene.getState().currentPageId ?? "page1",
        orderKey: nextOrderKey(ctx.getScene()),
        name: config.name,
        visible: true,
        opacity: 1,
        x: box.x,
        y: box.y,
        width,
        height,
        fills: config.fill === null
          ? []
          : [{ kind: { case: "solid", value: { color: config.fill ?? { r: 0.6, g: 0.6, b: 0.65, a: 1 } } } }],
        shape: config.shape(),
      });
      // La creazione passa dal ciclo di gesto come QUALUNQUE altra modifica
      // (sposta, resize, cancella): beginGesture + endGesture con l'unico op
      // finale. Non è una formalità -- la voce di undo viene costruita SOLO
      // dentro endGesture (store.ts), quindi un submit diretto qui renderebbe
      // il disegno l'unica azione dell'editor non annullabile. Il gesto a un
      // solo op resta comunque UN solo op sul filo: endGesture submitta
      // esattamente finalOps.
      const store = useScene.getState();
      store.beginGesture();
      store.endGesture([makeCreateNodeOp(node)]);
    },

    // Gesto abbandonato (cambio tool, pointercancel, smontaggio): nessun op.
    onDeactivate(_ctx: ToolContext) {
      if (!anchor) return;
      anchor = null;
      preview(null);
    },
  };
}
