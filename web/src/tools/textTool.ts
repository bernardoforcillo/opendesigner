import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/brawt/v1/brawt_pb";
import { normalizeRect } from "../canvas/geometry";
import { nextOrderKey } from "../store/orderKey";
import { useScene } from "../store/store";
import { toPbTextStyle } from "../store/types";
import type { TextStyleLite } from "../store/types";
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_FONT_WEIGHT,
  DEFAULT_LINE_HEIGHT,
} from "../renderer/text";
import { makeCreateNodeOp, uuid } from "./ops";
import type { Tool, ToolContext } from "./types";

// Stessa soglia di shapeTool.ts (px SCHERMO, indipendente dallo zoom): sotto,
// un drag è un click.
const CLICK_SLOP_PX = 3;

export const DEFAULT_TEXT_WIDTH = 200;
// Un'unica riga alla dimensione di default, derivata dagli stessi default del
// renderer (renderer/text.ts) invece di un numero magico duplicato qui: se
// quei default cambiano, il box iniziale del tool resta coerente senza dover
// toccare questo file.
export const DEFAULT_TEXT_HEIGHT = DEFAULT_FONT_SIZE * DEFAULT_LINE_HEIGHT;

// Lo stile con cui nasce OGNI nodo testo: esplicito, non gli zeri che
// TextStyleLite tollera altrove (store/types.ts li conserva apposta per
// restare indistinguibile da core.Apply finché nessun SetText li tocca). Un
// nodo appena creato non è mai passato da un SetText con style_present, quindi
// deve già leggersi con il font giusto prima ancora che l'utente scriva una
// lettera.
const DEFAULT_TEXT_STYLE: TextStyleLite = {
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: DEFAULT_FONT_SIZE,
  fontWeight: DEFAULT_FONT_WEIGHT,
  lineHeight: DEFAULT_LINE_HEIGHT,
  align: "left",
};

// Nero pieno: senza un fill esplicito il nodo ricadrebbe sul grigio 0.8
// condiviso con le forme (renderer/canvasRenderer.ts::cssColor) -- illeggibile
// per del testo. Vedi Task 3, divergenza 7.
const DEFAULT_TEXT_FILL = {
  kind: { case: "solid" as const, value: { color: { r: 0, g: 0, b: 0, a: 1 } } },
};

// Il tool testo fa SOLO creazione (come rectTool/ellipseTool), ma non riusa
// makeShapeTool: un nodo testo non è "una forma con uno shape diverso" -- nasce
// con contenuto vuoto, uno stile esplicito, e soprattutto entra SUBITO in
// editing dopo la creazione, cosa che nessun tool-forma fa. Il gesto di
// down/move/up con soglia-click resta lo stesso pattern, scritto per intero
// qui invece di forzarlo dentro l'astrazione condivisa (vedi il commento in
// shapeTool.ts sul >80% di codice letteralmente identico che giustificherebbe
// altrimenti il riuso).
export function createTextTool(): Tool {
  let anchor: { x: number; y: number } | null = null;

  // L'anteprima riusa il rettangolo di marquee dello store, come shapeTool:
  // è già in coordinate mondo ed è già disegnata dall'overlay.
  const preview = (b: { x: number; y: number; width: number; height: number } | null) =>
    useScene.getState().setMarquee(b);

  return {
    id: "text",
    cursor: "text",

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

      // px schermo -> unità mondo (come shapeTool): sotto soglia è un click,
      // non un drag, indipendentemente dallo zoom.
      const slop = CLICK_SLOP_PX / ctx.getCamera().zoom;
      // Un click usa la dimensione di default; un drag usa le dimensioni
      // trascinate -- la larghezza diventa la larghezza di wrap (Task 3:
      // layoutText la usa come maxWidth). Con contenuto vuoto il layout
      // produce comunque altezza 0 finché non si scrive, ma l'altezza del box
      // resta un punto di partenza sensato per le maniglie.
      const width = box.width < slop ? DEFAULT_TEXT_WIDTH : box.width;
      const height = box.height < slop ? DEFAULT_TEXT_HEIGHT : box.height;

      const id = uuid();
      // `box` è MONDO e il modello vuole coordinate relative al PARENT: qui
      // coincidono perché il parent è una pagina (identità). Stessa nota di
      // shapeTool.ts -- creare dentro un container richiederà un worldToLocal.
      const node = create(NodeSchema, {
        id,
        parentId: "page1",
        orderKey: nextOrderKey(ctx.getScene()),
        name: "Text",
        visible: true,
        opacity: 1,
        x: box.x,
        y: box.y,
        width,
        height,
        fills: [DEFAULT_TEXT_FILL],
        shape: { case: "text", value: { content: "", style: toPbTextStyle(DEFAULT_TEXT_STYLE) } },
      });

      const store = useScene.getState();

      // Chiude l'eventuale sessione di editing precedente PRIMA di aprire il
      // gesto di creazione. store.beginTextEditing la chiuderebbe comunque da
      // solo (guardia nello store, per ogni chiamante), ma lo farebbe DOPO --
      // e l'ordine conta, perché ogni chiusura può cancellare un nodo rimasto
      // vuoto, cioè può lasciare una voce di undo. Chiudendo dopo, lo stack
      // diventerebbe [crea t1, crea t2, cancella t1]: il primo Ctrl+Z
      // RESUSCITEREBBE il nodo vuoto t1 invece di annullare la creazione
      // appena fatta. Chiudendo qui l'ordine è quello cronologico dell'utente
      // ([crea t1, cancella t1, crea t2]) e Ctrl+Z disfa sempre l'ultima cosa
      // vista. L'order key resta comunque derivata dalla scena PRIMA della
      // pulizia (node è già costruito): un id cancellato non libera la sua
      // chiave per il nodo successivo.
      store.endTextEditing();

      // Creazione = un gesto (una voce di undo), come ogni altro tool. Il
      // nodo si seleziona SUBITO, a gesto ancora aperto: lo store riconcilia
      // la selezione contro la scena FINALE a endGesture (store.ts), quindi
      // può riferirsi a un id che esiste solo dopo l'op finale (lo stesso
      // meccanismo descritto nel commento di endGesture).
      store.beginGesture();
      store.setSelection([id]);
      store.endGesture([makeCreateNodeOp(node)]);

      // Entra SUBITO in editing (comportamento del brief): diverso da
      // rect/ellipse, che restano strumenti di sola creazione. La sessione di
      // editing vera e propria -- il SUO gesto, il textarea sovrapposto -- è
      // del Task 5: qui si accende solo il flag che gli dice quale nodo.
      store.beginTextEditing(id);
    },

    // Gesto abbandonato (cambio tool, pointercancel, smontaggio): nessun op,
    // nessuna editing.
    onDeactivate(_ctx: ToolContext) {
      if (!anchor) return;
      anchor = null;
      preview(null);
    },
  };
}

export const textTool = createTextTool();
