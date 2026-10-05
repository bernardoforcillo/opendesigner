import { makeShapeTool } from "./shapeTool";
import type { Tool } from "./types";

// Default size when the gesture is a plain click rather than a drag.
export const DEFAULT_RECT_WIDTH = 100;
export const DEFAULT_RECT_HEIGHT = 80;

// The rectangle tool ONLY creates: selection and moving live in the select
// tool. The gesture itself is in makeShapeTool, shared with ellipseTool: the
// only rectangle-specific thing is the emitted shape.
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
