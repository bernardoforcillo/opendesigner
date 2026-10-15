import { useFacilitation } from "../store/facilitation";
import { linkableAt } from "./linkTool";
import type { Tool } from "./types";

// "VOTE" (Y, in the Board). A click puts one of your dots on the thing under the pointer; Alt-click
// takes one back. Dots are ephemeral and public (store/facilitation.ts), not part of the document.

export const voteTool: Tool = {
  id: "vote",
  cursor: "pointer",

  onPointerUp(e, ctx) {
    const scene = ctx.getScene();
    if (!scene) return;
    const w = ctx.toWorld(e);
    const id = linkableAt(scene, ctx, w.x, w.y);
    if (!id) return;
    const f = useFacilitation.getState();
    if (e.altKey) f.unvote(id);
    else f.vote(id);
  },
};
