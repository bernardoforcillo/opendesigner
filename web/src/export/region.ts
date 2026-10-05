import { NodeMap } from "../store/nodeMap";
import type { NodeLite, SceneState } from "../store/types";
import { type Bounds, boundsOfNode, unionBounds } from "../canvas/geometry";
import { sortedVisible } from "../renderer/canvasRenderer";
import { isPaintable } from "../renderer/shapes";
import { textPaintBounds, type MeasureText } from "../renderer/text";

// WHAT IS EXPORTED, AND WHERE IT SITS.
//
// Export happens CLIENT SIDE (see export/png.ts and export/svg.ts): this
// module is the piece common to both formats, that is the answer to two questions that
// do not depend on the format -- which nodes end up in the file, and what is the
// world rectangle the file represents.
//
// No `Camera` parameter, and it is not an oversight: it is this module's
// invariant. The exported region is a function of the NODES, not of where the user had
// scrolled or how much they had zoomed. An export that depended on the camera
// would give different files from the same document.
//
// There is instead a TEXT MEASURE, which is not the same thing: it does not say where
// the user is looking, it says how big a glyph is -- a property of the
// document and of the font, identical at every zoom. Without it, the bounds would be those
// of the model's boxes, and the text that overflows its own box (see
// renderer/text.ts::textPaintBounds) would be cropped out of the file without a
// warning. The measure stays injected, so this module still touches neither
// the DOM nor a canvas.

export type ExportScope = "selection" | "page";

export interface ExportRegion {
  scope: ExportScope;
  // The nodes to draw, in DRAW ORDER (from bottom to top), already
  // filtered the way the renderer filters them.
  nodes: NodeLite[];
  // The WORLD rectangle occupied exactly by those nodes.
  bounds: Bounds;
  // The scene REDUCED to those nodes. It serves export/png.ts, which reuses drawScene
  // (the only renderer that exists) instead of rewriting a second one: passing it
  // the whole scene would also draw the unselected nodes.
  scene: SceneState;
}

// The rectangle a node occupies IN THE FILE.
//
// For every shape it is the model's box, which is also everything the shape
// paints. Text is the exception, and the only one: it paints the lines the layout
// produces, which may leave the box in all directions. The branch is
// explicit here instead of hidden inside `boundsOfNode` because `boundsOfNode`
// is the MODEL's box -- that of the handles, the selection rectangle and the
// properties panel -- and must stay so: here the question is another,
// "what would be cropped away", and the answer needs a measure.
function exportBounds(n: NodeLite, measure: MeasureText): Bounds {
  return n.kind === "text" ? textPaintBounds(measure, n) : boundsOfNode(n);
}

/**
 * The region to export, or `null` when there is nothing to export (empty
 * page, empty selection or reduced to invisible nodes).
 *
 * Nodes are chosen and ordered by `sortedVisible` + `isPaintable`, that is by the
 * same two functions `drawScene` uses: what is seen on the canvas is what
 * ends up in the file, and -- just as important -- what is NOT seen does not
 * widen the bounds. A 0x0 rectangle forgotten at (5000, 5000) would otherwise produce
 * a huge image with the real drawing in a corner.
 *
 * `measure` is mandatory and not optional on purpose: the fallback value
 * (the model's box) would be wrong for text and wrong silently,
 * that is the signature would invite producing cropped files. Whoever exports a canvas
 * already has it; whoever cannot measure cannot even know what they are exporting.
 */
export function exportRegion(
  scene: SceneState,
  selection: readonly string[],
  scope: ExportScope,
  measure: MeasureText,
): ExportRegion | null {
  const drawn = sortedVisible(scene).filter(isPaintable);
  // The ALREADY sorted list is filtered instead of mapping the selection: the draw
  // order is that of orderKey, not the one in which the user clicked.
  const nodes =
    scope === "selection" ? drawn.filter((n) => selection.includes(n.id)) : drawn;
  const bounds = unionBounds(nodes.map((n) => exportBounds(n, measure)));
  if (bounds === null) return null;
  return {
    scope,
    nodes,
    bounds,
    scene: { ...scene, nodes: NodeMap.from(nodes.map((n) => [n.id, n] as const)) },
  };
}
