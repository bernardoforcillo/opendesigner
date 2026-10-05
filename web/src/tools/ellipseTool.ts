import { makeShapeTool } from "./shapeTool";
import type { Tool } from "./types";

// Default size when the gesture is a plain click rather than a drag.
export const DEFAULT_ELLIPSE_WIDTH = 100;
export const DEFAULT_ELLIPSE_HEIGHT = 80;

// Twin of rectTool: same creation gesture (in makeShapeTool), the only
// difference is the emitted shape. EllipseNode has no fields of its own,
// unlike RectNode which has cornerRadius.
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
