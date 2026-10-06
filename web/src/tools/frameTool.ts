import { makeShapeTool } from "./shapeTool";
import type { Tool } from "./types";

export const DEFAULT_FRAME_WIDTH = 300;
export const DEFAULT_FRAME_HEIGHT = 200;

// The frame tool: the same gesture as the rectangle (makeShapeTool), with a
// container in place of the shape. It starts white and clips its children, which
// is what you expect from an "artboard"; auto layout is enabled from the panel or
// by wrapping a selection (Shift+A).
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
