import { insertDiagram } from "../diagram/insert";
import { renderBoard, type BoardClient } from "../board/board";
import type { Tool } from "./types";

// "STICKY" (N, in the Board). A click drops a sticky note centered on the pointer. The note is drawn
// by the server (the same function as the Whiteboard dialog and the MCP tool), so it is the same
// object whichever way it was made; one gesture, one undo step, the note is selected.

export function createStickyTool(client?: BoardClient): Tool {
  return {
    id: "sticky",
    cursor: "crosshair",

    onPointerUp(e, ctx) {
      const at = ctx.toWorld(e);
      void renderBoard({ kind: "sticky" }, client)
        .then((res) => { insertDiagram(res, at); })
        .catch(() => { /* the server did not answer: nothing was drawn, nothing to undo */ });
    },
  };
}

export const stickyTool = createStickyTool();
