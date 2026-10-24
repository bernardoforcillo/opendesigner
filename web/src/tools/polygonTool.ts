import { makeShapeTool } from "./shapeTool";
import type { Tool } from "./types";

// Default size when the gesture is a plain click rather than a drag, and the number of sides a new polygon gets
// (the panel changes it afterwards).
export const DEFAULT_POLYGON_SIZE = 100;
export const DEFAULT_POLYGON_SIDES = 6;

// Twin of ellipseTool: same creation gesture, a PolygonNode instead.
export function createPolygonTool(): Tool {
  return makeShapeTool({
    id: "polygon",
    name: "Polygon",
    defaultWidth: DEFAULT_POLYGON_SIZE,
    defaultHeight: DEFAULT_POLYGON_SIZE,
    shape: () => ({ case: "polygon", value: { sides: DEFAULT_POLYGON_SIDES } }),
  });
}

export const polygonTool = createPolygonTool();
