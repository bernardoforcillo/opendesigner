import type { NodeLite } from "../store/types";
import { flattenSubpath } from "../store/vectorGeometry";
import { traceSubpath } from "./shapes";

// THE STROKE BEING DRAWN ("draw" of an animation).
//
// The `draw` property (0..1) has the semantics of SVG's `pathLength`: the fraction
// of the path that has already been stroked. Canvas 2D has no pathLength, but it
// has dashing: with the path length L, `setLineDash([L * draw, L])`
// draws exactly the first `draw * L` and then leaves a gap as long as all
// the rest -- no second repetition. This module's job is to provide L.

/** The dash pattern that leaves visible the fraction `draw` of a path of length `length`. */
export function drawDash(length: number, draw: number): number[] {
  const d = Math.min(1, Math.max(0, draw));
  // The gap is L (+1 to not depend on rounding at draw = 1): a single visible
  // stroke per cycle.
  return [length * d, length + 1];
}

/**
 * The perimeter of rect / ellipse / frame, in the same units as the box. The rounded
 * rectangle removes at each corner (2 - π/2) r of what it would have with a sharp corner;
 * the ellipse is Ramanujan's approximation (error below 0.01% for any
 * eccentricity a box can have).
 */
export function perimeterOf(n: Pick<NodeLite, "kind" | "width" | "height" | "cornerRadius">): number {
  const w = Math.max(0, n.width), h = Math.max(0, n.height);
  if (n.kind === "ellipse") {
    const a = w / 2, b = h / 2;
    return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
  }
  // `frame` is drawn with sharp corners even with a cornerRadius (see nodePath).
  const r = n.kind === "rect" ? Math.min(Math.max(0, n.cornerRadius), w / 2, h / 2) : 0;
  return 2 * (w + h) - 8 * r + 2 * Math.PI * r;
}

// Flattening tolerance for MEASURING (world units): the length of a
// polyline at 0.05 from the curve is off by less than a pixel on any
// legible outline, and does not depend on the zoom (the length must not oscillate while
// zooming during playback).
const LENGTH_TOL = 0.05;

/** The length of a polyline. */
function polylineLength(pts: readonly { x: number; y: number }[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
}

export interface DrawSubpath { path: Path2D; length: number }

/**
 * The outlines of a vector, each with ITS Path2D (world coordinates) and its
 * length: each outline is drawn for the same fraction, in parallel --
 * like an SVG icon whose paths start together. Canvas dashing
 * restarts at every sub-path, so a single one with all the outlines would give
 * the same thing, but with the WRONG length (that of the longest, not of
 * each).
 */
export function vectorDrawSubpaths(n: NodeLite): DrawSubpath[] {
  const out: DrawSubpath[] = [];
  for (const sp of n.vector?.subpaths ?? []) {
    if (sp.anchors.length === 0) continue;
    const path = new Path2D();
    traceSubpath(path, n, sp);
    out.push({ path, length: polylineLength(flattenSubpath(sp, LENGTH_TOL)) });
  }
  return out;
}
