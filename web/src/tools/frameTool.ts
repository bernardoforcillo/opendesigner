import { makeShapeTool } from "./shapeTool";
import type { Tool } from "./types";

export const DEFAULT_FRAME_WIDTH = 300;
export const DEFAULT_FRAME_HEIGHT = 200;

// Il tool frame: lo stesso gesto del rettangolo (makeShapeTool), con un
// contenitore al posto della forma. Parte bianco e ritaglia i figli, che è ciò
// che ci si aspetta da una "tavola"; l'auto layout si attiva dal pannello o
// avvolgendo una selezione (Shift+A).
export function createFrameTool(): Tool {
  return makeShapeTool({
    id: "frame",
    name: "Frame",
    defaultWidth: DEFAULT_FRAME_WIDTH,
    defaultHeight: DEFAULT_FRAME_HEIGHT,
    shape: () => ({ case: "frame", value: { clipsContent: true } }),
    fill: { r: 1, g: 1, b: 1, a: 1 },
  });
}

export const frameTool = createFrameTool();
