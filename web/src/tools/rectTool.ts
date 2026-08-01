import { makeShapeTool } from "./shapeTool";
import type { Tool } from "./types";

// Dimensione di default quando il gesto è un semplice click invece di un drag.
export const DEFAULT_RECT_WIDTH = 100;
export const DEFAULT_RECT_HEIGHT = 80;

// Il tool rettangolo fa SOLO creazione: selezione e spostamento vivono nel
// select tool. Il gesto vero e proprio è in makeShapeTool, condiviso con
// ellipseTool: l'unica cosa specifica al rettangolo è la forma emessa.
export function createRectTool(): Tool {
  return makeShapeTool({
    id: "rect",
    name: "Rectangle",
    defaultWidth: DEFAULT_RECT_WIDTH,
    defaultHeight: DEFAULT_RECT_HEIGHT,
    shape: () => ({ case: "rect", value: { cornerRadius: 0 } }),
  });
}

export const rectTool = createRectTool();
