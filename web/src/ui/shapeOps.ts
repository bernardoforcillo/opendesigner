import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { makeSetPropsOp } from "../tools/ops";
import { toPbStrokes } from "../store/types";
import type { ArrowHeadLite, CornerRadiiLite, NodeLite, StrokeLite, StrokeSidesLite } from "../store/types";
import { MAX_POLYGON_SIDES, MAX_STAR_RATIO, MIN_POLYGON_SIDES, MIN_STAR_RATIO } from "../store/shapes";
import type { NodeLookup } from "./gradientOps";

// The panel's ops for the parametric shapes (docs/shapes.md): polygon sides, star points and depth, ellipse
// arc and ring, rectangle corner smoothing and independent radii, and the stroke's arrowheads and per-side
// weights. Pure functions on the node lookup (they read no store), like gradientOps. Each emits one
// setProps whose mask path is valid only on the shape that owns the field (store/maskPaths.ts), so a
// selection of mixed shapes is simply skipped where a field does not apply.

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Polygon side count (3..60). */
export function polygonSidesOps(ids: readonly string[], lookup: NodeLookup, sides: number): Op[] {
  const v = clamp(Math.round(sides), MIN_POLYGON_SIDES, MAX_POLYGON_SIDES);
  return ids.flatMap((id) => {
    const n = lookup(id);
    if (!n || n.kind !== "polygon" || n.sides === v) return [];
    return [makeSetPropsOp(id, { shape: { case: "polygon", value: { sides: v } } }, ["sides"])];
  });
}

/** Star point count (3..60) and/or inner ratio (0.05..0.95). */
export function starOps(ids: readonly string[], lookup: NodeLookup, patch: { points?: number; innerRatio?: number }): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    if (!n || n.kind !== "star") return [];
    const ops: Op[] = [];
    if (patch.points !== undefined) {
      const points = clamp(Math.round(patch.points), MIN_POLYGON_SIDES, MAX_POLYGON_SIDES);
      if (points !== n.points) ops.push(makeSetPropsOp(id, { shape: { case: "star", value: { points } } }, ["points"]));
    }
    if (patch.innerRatio !== undefined) {
      const innerRatio = clamp(patch.innerRatio, MIN_STAR_RATIO, MAX_STAR_RATIO);
      if (innerRatio !== n.innerRatio) ops.push(makeSetPropsOp(id, { shape: { case: "star", value: { innerRatio } } }, ["inner_ratio"]));
    }
    return ops;
  });
}

/** An ellipse's arc (degrees), sweep (-360..360, 0 = full) and ring hole (0..0.99). */
export function arcOps(ids: readonly string[], lookup: NodeLookup, patch: { start?: number; sweep?: number; innerRatio?: number }): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    if (!n || n.kind !== "ellipse") return [];
    const ops: Op[] = [];
    if (patch.start !== undefined && patch.start !== (n.arcStart ?? 0)) {
      ops.push(makeSetPropsOp(id, { shape: { case: "ellipse", value: { arcStart: patch.start } } }, ["arc_start"]));
    }
    if (patch.sweep !== undefined) {
      const arcSweep = clamp(patch.sweep, -360, 360);
      if (arcSweep !== (n.arcSweep ?? 0)) ops.push(makeSetPropsOp(id, { shape: { case: "ellipse", value: { arcSweep } } }, ["arc_sweep"]));
    }
    if (patch.innerRatio !== undefined) {
      const innerRatio = clamp(patch.innerRatio, 0, 0.99);
      if (innerRatio !== (n.innerRatio ?? 0)) ops.push(makeSetPropsOp(id, { shape: { case: "ellipse", value: { innerRatio } } }, ["inner_ratio"]));
    }
    return ops;
  });
}

/** Rectangle corner smoothing (0..1; 0 removes it). */
export function cornerSmoothingOps(ids: readonly string[], lookup: NodeLookup, smoothing: number): Op[] {
  const v = clamp(smoothing, 0, 1);
  return ids.flatMap((id) => {
    const n = lookup(id);
    if (!n || n.kind !== "rect" || v === (n.cornerSmoothing ?? 0)) return [];
    return [makeSetPropsOp(id, { shape: { case: "rect", value: { cornerSmoothing: v } } }, ["corner_smoothing"])];
  });
}

/**
 * Independent corner radii: `null` goes back to the single radius; a partial patch edits a corner (the first
 * edit starts from the node's single radius on all four).
 */
export function cornerRadiiOps(ids: readonly string[], lookup: NodeLookup, radii: Partial<CornerRadiiLite> | null): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    if (!n || n.kind !== "rect") return [];
    if (radii === null) {
      if (!n.radii) return [];
      // Keep the look: the single radius becomes the largest corner.
      const r = n.radii;
      const ops: Op[] = [makeSetPropsOp(id, { shape: { case: "rect", value: {} } }, ["radii"])];
      ops.push(makeSetPropsOp(id, { shape: { case: "rect", value: { cornerRadius: Math.max(r.topLeft, r.topRight, r.bottomRight, r.bottomLeft) } } }, ["corner_radius"]));
      return ops;
    }
    const base: CornerRadiiLite = n.radii ?? { topLeft: n.cornerRadius, topRight: n.cornerRadius, bottomRight: n.cornerRadius, bottomLeft: n.cornerRadius };
    const next: CornerRadiiLite = { ...base };
    for (const k of Object.keys(radii) as (keyof CornerRadiiLite)[]) next[k] = Math.max(0, radii[k] ?? base[k]);
    if (n.radii && JSON.stringify(next) === JSON.stringify(n.radii)) return [];
    return [makeSetPropsOp(id, { shape: { case: "rect", value: { radii: next } } }, ["radii"])];
  });
}

const DEFAULT_STROKE: StrokeLite = { color: { r: 0, g: 0, b: 0, a: 1 }, weight: 1, align: "center" };

function writeStrokes(n: NodeLite, first: StrokeLite): Op {
  return makeSetPropsOp(n.id, { strokes: toPbStrokes([first, ...n.strokes.slice(1)]) }, ["strokes"]);
}

/**
 * Arrowheads of the first stroke of each vector (`null` removes one end's head; `undefined` leaves it). A vector
 * with no stroke gets a default one so the head has a line to sit on.
 */
export function arrowheadOps(ids: readonly string[], lookup: NodeLookup, patch: { start?: ArrowHeadLite | null; end?: ArrowHeadLite | null }): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    if (!n || n.kind !== "vector") return [];
    const base = n.strokes[0] ?? DEFAULT_STROKE;
    const next: StrokeLite = { ...base };
    for (const [key, value] of [["startCap", patch.start], ["endCap", patch.end]] as const) {
      if (value === undefined) continue;
      if (value === null) delete next[key]; else next[key] = value;
    }
    if (n.strokes[0] && JSON.stringify(next) === JSON.stringify(base)) return [];
    return [writeStrokes(n, next)];
  });
}

/**
 * Per-side weights of the first stroke of each rectangle / frame (`null` goes back to one weight). The stroke's
 * `weight` follows the widest side, so everything that only looks at `weight > 0` still sees the stroke.
 */
export function strokeSidesOps(ids: readonly string[], lookup: NodeLookup, sides: Partial<StrokeSidesLite> | null): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    if (!n || (n.kind !== "rect" && n.kind !== "frame")) return [];
    const base = n.strokes[0] ?? DEFAULT_STROKE;
    const next: StrokeLite = { ...base };
    if (sides === null) {
      if (!base.sides) return [];
      delete next.sides;
      next.weight = Math.max(base.sides.top, base.sides.right, base.sides.bottom, base.sides.left);
    } else {
      const cur: StrokeSidesLite = base.sides ?? { top: base.weight, right: base.weight, bottom: base.weight, left: base.weight };
      const merged: StrokeSidesLite = { ...cur };
      for (const k of Object.keys(sides) as (keyof StrokeSidesLite)[]) merged[k] = Math.max(0, sides[k] ?? cur[k]);
      next.sides = merged;
      next.weight = Math.max(merged.top, merged.right, merged.bottom, merged.left);
    }
    return [writeStrokes(n, next)];
  });
}
