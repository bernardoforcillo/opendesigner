import { hitTest } from "../renderer/canvasRenderer";
import { useScene } from "../store/store";
import type { Tool } from "./types";

// Versione minima: click = seleziona il nodo più in alto, shift+click = toggle,
// click sul vuoto = deseleziona. Marquee, spostamento della selezione e
// maniglie di resize arrivano con i task successivi (8 e 9), che estendono
// questo file: qui serve solo perché la selezione (e il suo overlay) sia
// raggiungibile dall'interfaccia.
export function createSelectTool(): Tool {
  return {
    id: "select",
    cursor: "default",

    onPointerDown(e, ctx) {
      const scene = ctx.getScene();
      if (!scene) return;
      const { x, y } = ctx.toWorld(e);
      const id = hitTest(scene, x, y);
      const store = useScene.getState();

      if (!id) {
        // shift+click sul vuoto non azzera: è l'inizio di un'aggiunta.
        if (!e.shiftKey) store.clearSelection();
        return;
      }
      if (e.shiftKey) store.toggleSelection(id);
      else store.setSelection([id]);
    },
  };
}

export const selectTool = createSelectTool();
