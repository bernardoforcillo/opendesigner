import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import type { BrushLite, NodeLite, StrokeLite } from "@/store/types";
import { toPbStrokes } from "@/store/types";
import { MAX_BRUSH_ANGLE, MAX_BRUSH_SCATTER, MAX_BRUSH_SPACING, MIN_BRUSH_SPACING } from "@/store/shapes";
import { makeSetPropsOp } from "@/tools/ops";

// The EDITING half of brushes: the stroke whose brush the panel edits, and the ops that write it (ui/BrushControls.tsx).

const DEFAULT_STROKE: StrokeLite = { color: { r: 0, g: 0, b: 0, a: 1 }, weight: 4, align: "center" };

/** The stroke whose brush is edited: the first with a positive weight. */
export function brushStrokeOf(n: NodeLite): StrokeLite | undefined {
  return n.strokes.find((s) => s.weight > 0);
}

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/** The brush with every parameter inside the limits of core.validateBrush (a panel field cannot write an invalid one). */
export function clampBrush(b: BrushLite): BrushLite {
  return {
    ...b,
    spacing: clamp(b.spacing, MIN_BRUSH_SPACING, MAX_BRUSH_SPACING),
    scatter: clamp(b.scatter, 0, MAX_BRUSH_SCATTER),
    sizeJitter: clamp(b.sizeJitter, 0, 1),
    angleJitter: clamp(b.angleJitter, 0, MAX_BRUSH_ANGLE),
    seed: Number.isInteger(b.seed) && b.seed >= 0 && b.seed <= 0xffffffff ? b.seed : 0,
  };
}

/**
 * Writes `brush` on the node's first stroke (a node with none gets a 4 unit black one, so there is a line to
 * brush); undefined goes back to the plain stroke. No ops if nothing changes or it is not a vector.
 */
export function setBrushOps(n: NodeLite, brush: BrushLite | undefined): Op[] {
  if (n.kind !== "vector") return [];
  const at = n.strokes.findIndex((s) => s.weight > 0);
  const base = at >= 0 ? n.strokes[at] : DEFAULT_STROKE;
  const next: StrokeLite = { ...base };
  if (brush) next.brush = clampBrush(brush); else delete next.brush;
  if (at >= 0 && JSON.stringify(next) === JSON.stringify(base)) return [];
  const strokes = at >= 0 ? n.strokes.map((s, i) => (i === at ? next : s)) : [next, ...n.strokes];
  return [makeSetPropsOp(n.id, { strokes: toPbStrokes(strokes) }, ["strokes"])];
}
