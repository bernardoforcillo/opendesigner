import { ArrowHead } from "../gen/opendesigner/v1/opendesigner_pb";
import type { EllipseNode, Node as PbNode, RectNode, Stroke } from "../gen/opendesigner/v1/opendesigner_pb";
import type { NodeLite } from "./types";

// The TS half of internal/core/shapes.go: the ranges of the parametric shapes (polygon, star, ellipse arc /
// ring, rectangle corner smoothing and independent radii) and the stroke extras (arrowheads, per-side
// weights). Go is the authority; applyOp mirrors it so a rejected op leaves the scene unchanged here too.
// Docs: docs/shapes.md.

export const MIN_POLYGON_SIDES = 3;
export const MAX_POLYGON_SIDES = 60;
export const MIN_STAR_RATIO = 0.05;
export const MAX_STAR_RATIO = 0.95;

const finite = (v: number) => Number.isFinite(v);
const finiteNonNeg = (v: number) => Number.isFinite(v) && v >= 0;

export function isValidRect(r: RectNode | undefined): boolean {
  if (!r) return true;
  if (!finite(r.cornerSmoothing) || r.cornerSmoothing < 0 || r.cornerSmoothing > 1) return false;
  const c = r.radii;
  return !c || [c.topLeft, c.topRight, c.bottomRight, c.bottomLeft].every(finiteNonNeg);
}

export function isValidArc(e: EllipseNode | undefined): boolean {
  if (!e) return true;
  return finite(e.arcStart) && finite(e.arcSweep) && e.arcSweep >= -360 && e.arcSweep <= 360
    && finite(e.innerRatio) && e.innerRatio >= 0 && e.innerRatio < 1;
}

const isValidPoints = (n: number) => n >= MIN_POLYGON_SIDES && n <= MAX_POLYGON_SIDES;
const isValidStarRatio = (r: number) => finite(r) && r >= MIN_STAR_RATIO && r <= MAX_STAR_RATIO;

/** The shape parameters of a node being created (core.validateShape). */
export function isValidShape(pb: PbNode): boolean {
  switch (pb.shape.case) {
    case "rect": return isValidRect(pb.shape.value);
    case "ellipse": return isValidArc(pb.shape.value);
    case "polygon": return isValidPoints(pb.shape.value.sides);
    case "star": return isValidPoints(pb.shape.value.points) && isValidStarRatio(pb.shape.value.innerRatio);
    default: return true;
  }
}

/**
 * A shape-parameter mask path written on `cur`: only on the shape that owns the field, with an in-range
 * value (core.checkShapePath). Paths that are not shape parameters are not its business (true).
 */
export function isValidShapePath(cur: NodeLite, p: PbNode, path: string): boolean {
  switch (path) {
    case "corner_smoothing":
    case "radii": {
      if (cur.kind !== "rect") return false;
      const r = p.shape.case === "rect" ? p.shape.value : undefined;
      return path === "radii" ? isValidRect({ cornerSmoothing: 0, radii: r?.radii } as RectNode) : isValidRect({ cornerSmoothing: r?.cornerSmoothing ?? 0 } as RectNode);
    }
    case "arc_start":
    case "arc_sweep":
      return cur.kind === "ellipse" && isValidArc(p.shape.case === "ellipse" ? p.shape.value : undefined);
    case "inner_ratio":
      if (cur.kind === "ellipse") return isValidArc(p.shape.case === "ellipse" ? p.shape.value : undefined);
      if (cur.kind === "star") return isValidStarRatio(p.shape.case === "star" ? p.shape.value.innerRatio : 0);
      return false;
    case "sides":
      return cur.kind === "polygon" && isValidPoints(p.shape.case === "polygon" ? p.shape.value.sides : 0);
    case "points":
      return cur.kind === "star" && isValidPoints(p.shape.case === "star" ? p.shape.value.points : 0);
    default:
      return true;
  }
}

/** Arrowhead enums are closed and side weights finite and non-negative (core.validateStrokeExtras). */
export function areStrokeExtrasValid(strokes: readonly Stroke[]): boolean {
  return strokes.every((s) =>
    s.startCap >= ArrowHead.NONE && s.startCap <= ArrowHead.DIAMOND
    && s.endCap >= ArrowHead.NONE && s.endCap <= ArrowHead.DIAMOND
    && (!s.sides || [s.sides.top, s.sides.right, s.sides.bottom, s.sides.left].every(finiteNonNeg)));
}

/** The mask paths that address a shape parameter inside the `shape` oneof. */
export const SHAPE_PATHS: ReadonlySet<string> = new Set(["corner_smoothing", "radii", "arc_start", "arc_sweep", "inner_ratio", "sides", "points"]);

/** Writes one shape-parameter mask path of `p` onto `next` (the field absent when it is the default). */
export function writeShapePath(next: NodeLite, p: PbNode, path: string): void {
  const rect = p.shape.case === "rect" ? p.shape.value : undefined;
  const ellipse = p.shape.case === "ellipse" ? p.shape.value : undefined;
  const star = p.shape.case === "star" ? p.shape.value : undefined;
  const polygon = p.shape.case === "polygon" ? p.shape.value : undefined;
  switch (path) {
    case "corner_smoothing":
      if (rect && rect.cornerSmoothing > 0) next.cornerSmoothing = rect.cornerSmoothing; else delete next.cornerSmoothing;
      break;
    case "radii":
      if (rect?.radii) next.radii = { topLeft: rect.radii.topLeft, topRight: rect.radii.topRight, bottomRight: rect.radii.bottomRight, bottomLeft: rect.radii.bottomLeft };
      else delete next.radii;
      break;
    case "arc_start":
      if (ellipse && ellipse.arcStart !== 0) next.arcStart = ellipse.arcStart; else delete next.arcStart;
      break;
    case "arc_sweep":
      if (ellipse && ellipse.arcSweep !== 0) next.arcSweep = ellipse.arcSweep; else delete next.arcSweep;
      break;
    case "inner_ratio":
      if (next.kind === "star") next.innerRatio = star?.innerRatio ?? 0;
      else if (ellipse && ellipse.innerRatio > 0) next.innerRatio = ellipse.innerRatio;
      else delete next.innerRatio;
      break;
    case "sides": next.sides = polygon?.sides ?? 0; break;
    case "points": next.points = star?.points ?? 0; break;
  }
}
