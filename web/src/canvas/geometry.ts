import type { NodeLite, StrokeLite } from "../store/types";
import { type Camera, worldToScreen } from "./camera";
import { rotatedAabb } from "./transform";

export interface Bounds { x: number; y: number; width: number; height: number }

// The node's LOCAL bounds: the axis-aligned rectangle the model keeps
// in x/y/width/height, BEFORE rotation. It is the space in which resize
// and handles work (see selection/handles.ts).
export function boundsOfNode(n: NodeLite): Bounds {
  return { x: n.x, y: n.y, width: n.width, height: n.height };
}

// The axis-aligned rectangle that the MODEL'S BOX occupies in the world,
// rotation included. It is the GEOMETRY -- the stroke is not involved, on purpose:
// this is the space in which resize writes (selection frame and group
// resize, see renderer/overlayRenderer.ts::selectionFrame). Including the
// stroke overhang would mean writing an inflated box into x/y/width/height,
// and the node would grow by half an overhang on every handle drag.
// For what the node PAINTS there is worldVisualAabbOfNode.
// For a still node it is identical (numbers included) to boundsOfNode.
export function worldAabbOfNode(n: NodeLite): Bounds {
  return rotatedAabb(boundsOfNode(n), n.rotation);
}

// --- THE STROKE IN THE BOUNDS ------------------------------------------------
//
// A stroke is drawn ON the perimeter, so depending on alignment it
// overhangs the model's box: half the weight for CENTER, the whole weight for
// OUTSIDE, nothing for INSIDE. That overhang is painted pixels like the others:
// whoever reasons about "what space does this node occupy" -- the marquee, hit-test,
// the export -- must count it, or it cuts the border exactly where it is most visible.
//
// It lives HERE and not in the renderer because it is geometry, not drawing: the renderer
// uses it to decide lineWidth and clip, but the MEASURE is only one and is read by
// both (renderer/canvasRenderer.ts, renderer/shapes.ts).

// How much ONE stroke overhangs beyond the perimeter. A non-positive weight is not a
// very thin stroke: it is not a stroke, and it does not overhang (the canvas draws
// nothing with lineWidth 0, and a negative weight would be an error from which a
// box SMALLER than the node must not come out).
export function strokeOutset(s: StrokeLite): number {
  if (!(s.weight > 0)) return 0;
  if (s.align === "inside") return 0;
  return s.align === "outside" ? s.weight : s.weight / 2;
}

// The node's overhang: the MAXIMUM among its strokes, not the sum. Strokes
// are drawn one ABOVE the other on the same perimeter (like fills), so
// the one that overhangs the most contains all the others.
//
// TEXT is the exception, and not for convenience: its stroke is drawn with
// ctx.strokeText, which is ALWAYS centered on the glyph's outline -- a glyph has no
// Path2D, so there is nothing to clip (see
// renderer/text.ts::strokeText). Alignment is not representable, and the
// measure must say what the drawing REALLY does: counting the whole `weight`
// for an OUTSIDE on a text would give bounds larger than the painted result, and counting 0
// for an INSIDE would give smaller ones -- that is, it would crop.
export function strokeOutsetOfNode(n: NodeLite): number {
  let max = 0;
  for (const s of n.strokes) {
    max = Math.max(max, strokeOutset(n.kind === "text" ? { ...s, align: "center" } : s));
  }
  return max;
}

// The LOCAL bounds of what the node paints: the model's box widened
// by the stroke overhang. A node without strokes (the normal case) returns
// IDENTICAL numbers to boundsOfNode -- inflateBounds with pad 0 is the arithmetic
// identity, not a rounding.
export function visualBoundsOfNode(n: NodeLite): Bounds {
  return inflateBounds(boundsOfNode(n), strokeOutsetOfNode(n));
}

// The axis-aligned rectangle that the node PAINTS in the world: stroke included and
// rotation included. It widens BEFORE and rotates AFTER, because the stroke lives
// in the node's LOCAL space (it is the perimeter of the unrotated box that carries it);
// rotating and then widening would put the overhang on the screen's axes
// instead of the node's.
export function worldVisualAabbOfNode(n: NodeLite): Bounds {
  return rotatedAabb(visualBoundsOfNode(n), n.rotation);
}

export function unionBounds(list: Bounds[]): Bounds | null {
  if (list.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of list) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// handles backward drags (in any direction): (x0,y0) and (x1,y1) are the two
// corners of the drag rectangle, in any order.
export function normalizeRect(x0: number, y0: number, x1: number, y1: number): Bounds {
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  return { x, y, width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

// The part IN COMMON between two rectangles, or null if they have none.
//
// It serves whoever needs to know how much of a node is SEEN inside a clip: a
// frame with clips_content hides what leaves its own box, and the rubber
// band must not be able to select what the clip has taken away
// (renderer/canvasRenderer.ts::collectIn).
//
// A DEGENERATE intersection (null width or height: two rectangles that
// touch on an edge) is null and not a flat rectangle, for consistency with
// boundsIntersect above, which compares opposite edges with < / >: a
// strip of zero area is not visible area.
export function intersectBounds(a: Bounds, b: Bounds): Bounds | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export function pointInBounds(b: Bounds, x: number, y: number): boolean {
  return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
}

// Converts WORLD bounds into SCREEN bounds (CSS px) ALWAYS going through
// canvas/camera.ts, never recomputing the transform by hand. It lives here (and not
// in the renderer) because it serves both the overlay and selection/handles.ts, and
// keeping it in the renderer would force the handles to import from it -- a cycle.
export function worldBoundsToScreen(b: Bounds, cam: Camera): Bounds {
  const p0 = worldToScreen(cam, b.x, b.y);
  const p1 = worldToScreen(cam, b.x + b.width, b.y + b.height);
  return { x: p0.x, y: p0.y, width: p1.x - p0.x, height: p1.y - p0.y };
}

// Widens (or narrows, with negative pad) a rectangle by pad px on every side.
export function inflateBounds(b: Bounds, pad: number): Bounds {
  return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
}
