import { makeShapeTool } from "@/tools/shapeTool";
import type { Tool } from "@/tools/types";

export const DEFAULT_STAR_SIZE = 100;
export const DEFAULT_STAR_POINTS = 5;
export const DEFAULT_STAR_RATIO = 0.4;

// Twin of polygonTool: a StarNode with five points and a 0.4 inner ratio.
export function createStarTool(): Tool {
  return makeShapeTool({
    id: "star",
    name: "Star",
    defaultWidth: DEFAULT_STAR_SIZE,
    defaultHeight: DEFAULT_STAR_SIZE,
    shape: () => ({ case: "star", value: { points: DEFAULT_STAR_POINTS, innerRatio: DEFAULT_STAR_RATIO } }),
  });
}

export const starTool = createStarTool();
