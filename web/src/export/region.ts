import { NodeMap } from "@/store/nodeMap";
import type { NodeLite, SceneState } from "@/store/types";
import { type Bounds, boundsOfNode, intersectBounds, unionBounds } from "@/canvas/geometry";
import { applyTransform, compose, IDENTITY, localTransformOf, rotatedAabb, type Transform } from "@/canvas/transform";
import { childIndexOf } from "@/store/tree";
import type { ClipBox } from "@/store/types";
import { isPaintable } from "@/renderer/shapes";
import { textPaintBounds, type MeasureText } from "@/renderer/text";

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
  // The sheet of a sized page: exporting the page is exporting THIS rectangle (content outside it is
  // cropped, an empty sheet is still a page), not the bounding box of what is drawn on it.
  sheet: Bounds | null = null,
): ExportRegion | null {
  const walked = walkTree(scene, scope === "selection" ? new Set(selection) : null);
  // A node clipped away entirely by a frame around it paints nothing: it neither widens the bounds nor reaches the file.
  const visible = walked.filter((w) => isPaintable(w.flat) && !clippedAway(w.flat, measure));
  const nodes = visible.map((w) => w.flat);
  const bounds = scope === "page" && sheet ? sheet : unionBounds(nodes.map((n) => visibleBounds(n, measure)).filter((b): b is Bounds => b !== null));
  if (bounds === null) return null;
  return {
    scope,
    nodes,
    bounds,
    scene: { ...scene, nodes: NodeMap.from(visible.map((w) => [w.tree.id, w.tree] as const)) },
  };
}

// NESTED FRAMES. The model keeps a child's box in its PARENT's space, but the file formats that read `nodes` (SVG, PDF) draw
// flat: so every node leaves here already in WORLD space (position, accumulated rotation), in tree draw order (a container, then
// its children, siblings by order key), carrying the clipping frames around it. `tree` is the same node as the canvas draws it
// (relative to its parent) for the PNG, which reuses drawScene; a selected node whose parent is not exported is lifted to the
// world there, so it is not orphaned.
interface Walked { flat: NodeLite; tree: NodeLite }

function walkTree(scene: SceneState, selected: ReadonlySet<string> | null): Walked[] {
  const children = childIndexOf(scene);
  const out: Walked[] = [];
  const seen = new Set<string>();
  const roots = [...scene.nodes.values()].filter((n) => !scene.nodes.has(n.parentId)).sort((a, b) => (a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0));
  const visit = (n: NodeLite, t: Transform, clips: readonly ClipBox[], inSel: boolean, lifted: boolean, pageId: string): void => {
    if (!n.visible || seen.has(n.id)) return;
    seen.add(n.id);
    let nClips = clips, nInSel = inSel, nLifted = lifted;
    // A selection root: what is exported starts here, so the frames around it do not cut it.
    if (selected && !inSel && selected.has(n.id)) { nInSel = true; nClips = []; nLifted = true; }
    const world = placeInWorld(n, t);
    if (nInSel) {
      const flat = nClips.length > 0 ? { ...world, exportClips: nClips } : world;
      const tree = nLifted && !inSel ? { ...world, parentId: pageId } : n;
      out.push({ flat, tree });
    }
    const inner = compose(t, localTransformOf(n));
    if (n.kind === "frame" && n.clipsContent) nClips = [...nClips, { x: world.x, y: world.y, width: n.width, height: n.height, rotation: world.rotation }];
    for (const k of children.get(n.id) ?? []) visit(k, inner, nClips, nInSel, nLifted, pageId);
  };
  for (const r of roots) visit(r, IDENTITY, [], selected === null, false, r.parentId);
  return out;
}

// The node with its box in world space: where the centre of its box lands and the rotation accumulated from the containers.
function placeInWorld(n: NodeLite, parent: Transform): NodeLite {
  if (parent === IDENTITY) return n;
  const c = applyTransform(parent, n.x + n.width / 2, n.y + n.height / 2);
  const turn = (Math.atan2(parent.b, parent.a) * 180) / Math.PI;
  return { ...n, x: c.x - n.width / 2, y: c.y - n.height / 2, rotation: n.rotation + (Math.abs(turn) < 1e-9 ? 0 : turn) };
}

const clipAabb = (c: ClipBox): Bounds => rotatedAabb({ x: c.x, y: c.y, width: c.width, height: c.height }, c.rotation);

// The part of the node inside every clipping frame around it; null when nothing is left.
function visibleBounds(n: NodeLite, measure: MeasureText): Bounds | null {
  let b: Bounds | null = exportBounds(n, measure);
  for (const c of n.exportClips ?? []) b = b && intersectBounds(b, clipAabb(c));
  return b;
}

function clippedAway(n: NodeLite, measure: MeasureText): boolean {
  return n.exportClips !== undefined && visibleBounds(n, measure) === null;
}
