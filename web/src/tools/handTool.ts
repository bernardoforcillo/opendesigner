import { panBy } from "../canvas/camera";
import type { Tool } from "./types";

// Pan puro: tocca SOLO la camera, mai il documento. Nessun op viene emesso,
// quindi un pan non entra nell'undo e non passa dalla rete.
export function createHandTool(): Tool {
  // Ultima posizione SCHERMO del puntatore: il pan è incrementale (delta tra
  // due move), non assoluto rispetto all'ancora, così resta corretto anche se
  // qualcuno modifica la camera in mezzo al drag (es. zoom con la rotella).
  let last: { x: number; y: number } | null = null;

  return {
    id: "hand",
    cursor: "grab",
    onPointerDown(e) {
      last = { x: e.clientX, y: e.clientY };
    },
    onPointerMove(e, ctx) {
      if (!last) return;
      ctx.setCamera(panBy(ctx.getCamera(), e.clientX - last.x, e.clientY - last.y));
      last = { x: e.clientX, y: e.clientY };
    },
    onPointerUp() {
      last = null;
    },
    onDeactivate() {
      last = null;
    },
  };
}

export const handTool = createHandTool();
