import { panBy } from "../canvas/camera";
import type { Tool } from "./types";

// Pure pan: touches ONLY the camera, never the document. No op is emitted,
// so a pan does not enter undo and does not go over the network.
export function createHandTool(): Tool {
  // Last SCREEN position of the pointer: the pan is incremental (delta between
  // two moves), not absolute with respect to the anchor, so it stays correct even if
  // someone changes the camera mid-drag (e.g. wheel zoom).
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
