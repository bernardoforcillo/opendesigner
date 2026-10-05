import type { NodeLite } from "../store/types";

// THE EXTRA STYLE OF VECTOR NODES (SVG import).
//
// The model (Stroke) knows color, weight and alignment, but not the caps
// (`stroke-linecap`), the joins (`stroke-linejoin`), the miter limit, the
// dashing and the fill rule: things that an imported SVG carries with it
// and without which a stroke icon (round caps) or an illustration with holes
// (nonzero vs even-odd) looks DIFFERENT from the original.
//
// The proto is not touched (it belongs to the model, not to whoever imports): those values
// travel in `Node.meta`, the free key -> value map that exists for
// this -- metadata the model preserves (op, undo, snapshot, clipboard) and
// that only whoever can read them interprets. This file is the ONLY place that
// knows the keys: the importer writes them, the renderers (canvas 2D, CanvasKit) and
// the SVG export read them from here.
//
// All keys are optional and have a default: a node created by the pen
// tool has none and is drawn as it always has been.

export const META_FILL_RULE = "vector.fillRule"; // "nonzero" | "evenodd"
export const META_NO_HAIRLINE = "vector.hairline"; // "0" = do not draw the 1.5px hairline
export const META_CAP = "stroke.cap"; // "butt" | "round" | "square"
export const META_JOIN = "stroke.join"; // "miter" | "round" | "bevel"
export const META_MITER = "stroke.miter"; // number
export const META_DASH = "stroke.dash"; // "4,2" in world units
export const META_DASH_OFFSET = "stroke.dashOffset"; // number

export interface VectorStyle {
  /** null = the renderer's historical default (even-odd). */
  fillRule: CanvasFillRule | null;
  /** The 1.5px hairline that makes an outline without a stroke visible. */
  hairline: boolean;
  cap: CanvasLineCap;
  join: CanvasLineJoin;
  miter: number;
  dash: number[];
  dashOffset: number;
}

function numberOf(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Reads a node's extra style. An unknown value means the default. */
export function vectorStyleOf(n: Pick<NodeLite, "meta">): VectorStyle {
  const m = n.meta;
  if (!m) return { fillRule: null, hairline: true, cap: "butt", join: "miter", miter: 10, dash: [], dashOffset: 0 };
  const rule = m[META_FILL_RULE];
  const cap = m[META_CAP];
  const join = m[META_JOIN];
  const dash = (m[META_DASH] ?? "")
    .split(",")
    .map((s) => Number(s))
    .filter((v) => Number.isFinite(v) && v >= 0);
  return {
    fillRule: rule === "nonzero" || rule === "evenodd" ? rule : null,
    hairline: m[META_NO_HAIRLINE] !== "0",
    cap: cap === "round" || cap === "square" ? cap : "butt",
    join: join === "round" || join === "bevel" ? join : "miter",
    miter: numberOf(m[META_MITER], 10),
    // A dash with a null sum (or odd is fine: it repeats) does not exist.
    dash: dash.some((v) => v > 0) ? dash : [],
    dashOffset: numberOf(m[META_DASH_OFFSET], 0),
  };
}

/**
 * A vector node has a "real" stroke when at least one of its `strokes`
 * has positive weight. Until the SVG import the panel could write strokes on
 * a path without the renderer drawing them: now it draws them, and the 1.5px
 * hairline (which existed only to make a path with no other
 * ink visible) gives way to the real stroke.
 */
export function hasRealStroke(n: Pick<NodeLite, "strokes">): boolean {
  return n.strokes.some((s) => s.weight > 0);
}
