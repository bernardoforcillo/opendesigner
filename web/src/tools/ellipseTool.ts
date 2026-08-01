import { makeShapeTool } from "./shapeTool";
import type { Tool } from "./types";

// Dimensione di default quando il gesto è un semplice click invece di un drag.
export const DEFAULT_ELLIPSE_WIDTH = 100;
export const DEFAULT_ELLIPSE_HEIGHT = 80;

// Gemello di rectTool: stesso gesto di creazione (in makeShapeTool), unica
// differenza è la forma emessa. EllipseNode non ha campi propri, a
// differenza di RectNode che ha cornerRadius.
export function createEllipseTool(): Tool {
  return makeShapeTool({
    id: "ellipse",
    name: "Ellipse",
    defaultWidth: DEFAULT_ELLIPSE_WIDTH,
    defaultHeight: DEFAULT_ELLIPSE_HEIGHT,
    shape: () => ({ case: "ellipse", value: {} }),
  });
}

export const ellipseTool = createEllipseTool();
