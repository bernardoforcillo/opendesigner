import type { Bounds } from "../canvas/geometry";

// GEOMETRY OF THE FLOW ARROWS. Pure: bounds in, numbers out,
// no DOM and no canvas -- so it can be tested without a browser and the renderer
// (renderer/flowRenderer.ts) and the hit-test (tools/flowSelect.ts) read the
// SAME curve. Everything is in WORLD coordinates: whoever draws applies the camera.
//
// The arrow is a cubic bézier that leaves from the midpoint of the closest side
// of the starting screen and enters at the midpoint of the closest side of
// the destination one, with tangents PERPENDICULAR to the sides (the curve "leaves"
// straight from the edge, like Figma/FigJam connectors).

export interface Pt { x: number; y: number }

/** A cubic bézier: p0 -> p3 with control points c1, c2. */
export interface Bezier { p0: Pt; c1: Pt; c2: Pt; p3: Pt }

/** The side of a rectangle the arrow leaves from/enters at. */
export type Side = "left" | "right" | "top" | "bottom";

export const NORMAL: Record<Side, Pt> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

// How far the tangents extend: a fraction of the distance between the ends, with a
// minimum (two touching screens must still give a readable curve) and a
// maximum (at huge distances the curve must not balloon out).
const HANDLE_RATIO = 0.4;
const HANDLE_MIN = 40;
const HANDLE_MAX = 400;
// Distance between two PARALLEL arrows (same pair of screens), along the side.
export const LANE_GAP = 26;
// How far a self-loop sticks out of the screen.
const LOOP_OUT = 70;

export function centerOf(b: Bounds): Pt {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/**
 * The side of `a` facing `b`. The offsets of the centers are compared
 * NORMALIZED on the half-dimensions: two side-by-side screens (same height,
 * one to the right of the other) must give right/left even when the absolute
 * vertical distance is large but small relative to the height of the frames.
 */
export function facingSide(a: Bounds, b: Bounds): Side {
  const ca = centerOf(a);
  const cb = centerOf(b);
  const dx = cb.x - ca.x;
  const dy = cb.y - ca.y;
  const nx = Math.abs(dx) / Math.max(1, a.width / 2 + b.width / 2);
  const ny = Math.abs(dy) / Math.max(1, a.height / 2 + b.height / 2);
  if (nx >= ny) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

export function opposite(s: Side): Side {
  return s === "left" ? "right" : s === "right" ? "left" : s === "top" ? "bottom" : "top";
}

/** The midpoint of a side, shifted along the side by `shift` (parallel lanes). */
export function sidePoint(b: Bounds, side: Side, shift = 0): Pt {
  switch (side) {
    case "left": return { x: b.x, y: b.y + b.height / 2 + shift };
    case "right": return { x: b.x + b.width, y: b.y + b.height / 2 + shift };
    case "top": return { x: b.x + b.width / 2 + shift, y: b.y };
    case "bottom": return { x: b.x + b.width / 2 + shift, y: b.y + b.height };
  }
}

function handleLength(p: Pt, q: Pt): number {
  const d = Math.hypot(q.x - p.x, q.y - p.y);
  return Math.min(HANDLE_MAX, Math.max(HANDLE_MIN, d * HANDLE_RATIO));
}

/** The bézier between two points with the exit and entry normals (towards the OUTSIDE of the sides). */
export function bezierBetween(p0: Pt, n0: Pt, p3: Pt, n3: Pt): Bezier {
  const h = handleLength(p0, p3);
  return {
    p0,
    c1: { x: p0.x + n0.x * h, y: p0.y + n0.y * h },
    c2: { x: p3.x + n3.x * h, y: p3.y + n3.y * h },
    p3,
  };
}

/**
 * The arrow between two rectangles. `shift` moves both ends along the
 * sides (to keep apart the arrows that connect the same pair).
 * With `loop` (from === to) the path leaves from the right side and always re-enters
 * from the right, sticking out: it is the only case where the entry tangent looks
 * in the same direction as the exit one.
 */
export function arrowBetween(from: Bounds, to: Bounds, shift = 0, loop = false): Bezier {
  if (loop) {
    const a = sidePoint(from, "right", -Math.min(from.height / 4, 30) + shift);
    const b = sidePoint(from, "right", Math.min(from.height / 4, 30) + shift);
    return {
      p0: a,
      c1: { x: a.x + LOOP_OUT, y: a.y - LOOP_OUT * 0.6 },
      c2: { x: b.x + LOOP_OUT, y: b.y + LOOP_OUT * 0.6 },
      p3: b,
    };
  }
  const side = facingSide(from, to);
  const other = opposite(side);
  return bezierBetween(sidePoint(from, side, shift), NORMAL[side], sidePoint(to, other, shift), NORMAL[other]);
}

/** The arrow from a POINT (the pointer, during the "Connect" drag) to a rectangle. */
export function arrowFromRectToPoint(from: Bounds, p: Pt): Bezier {
  const side = facingSide(from, { x: p.x, y: p.y, width: 0, height: 0 });
  const p0 = sidePoint(from, side);
  // The arrival point has no side: the entry tangent looks towards whoever arrives.
  const n3 = NORMAL[opposite(side)];
  return bezierBetween(p0, NORMAL[side], p, n3);
}

export function bezierPoint(b: Bezier, t: number): Pt {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * b.p0.x + w1 * b.c1.x + w2 * b.c2.x + w3 * b.p3.x,
    y: w0 * b.p0.y + w1 * b.c1.y + w2 * b.c2.y + w3 * b.p3.y,
  };
}

/** The rectangle that contains the 4 control points: it always contains the curve. */
export function bezierBounds(b: Bezier): Bounds {
  const x = Math.min(b.p0.x, b.c1.x, b.c2.x, b.p3.x);
  const y = Math.min(b.p0.y, b.c1.y, b.c2.y, b.p3.y);
  return {
    x,
    y,
    width: Math.max(b.p0.x, b.c1.x, b.c2.x, b.p3.x) - x,
    height: Math.max(b.p0.y, b.c1.y, b.c2.y, b.p3.y) - y,
  };
}

/**
 * The three vertices of the arrowhead, with the real tip at `b.p3`. `size` is in the same
 * unit as the coordinates of `b`.
 */
export function arrowhead(b: Bezier, size: number): [Pt, Pt, Pt] {
  // Tangent at t=1 (from c2 to p3); if the two coincide it falls back to the chord.
  let tx = b.p3.x - b.c2.x;
  let ty = b.p3.y - b.c2.y;
  if (Math.hypot(tx, ty) < 1e-6) {
    tx = b.p3.x - b.p0.x;
    ty = b.p3.y - b.p0.y;
  }
  const len = Math.hypot(tx, ty) || 1;
  const ux = tx / len;
  const uy = ty / len;
  const half = size * 0.55;
  const bx = b.p3.x - ux * size;
  const by = b.p3.y - uy * size;
  return [b.p3, { x: bx - uy * half, y: by + ux * half }, { x: bx + uy * half, y: by - ux * half }];
}

const SAMPLES = 24;

/** The minimum distance of (x, y) from the curve, by sampling. */
export function distanceToBezier(b: Bezier, x: number, y: number): number {
  let best = Infinity;
  let prev = b.p0;
  for (let i = 1; i <= SAMPLES; i++) {
    const p = bezierPoint(b, i / SAMPLES);
    const d = distanceToSegment(prev, p, x, y);
    if (d < best) best = d;
    prev = p;
  }
  return best;
}

export function distanceToSegment(a: Pt, b: Pt, x: number, y: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}

/** The rectangle enlarged by `pad` per side. */
export function inflate(b: Bounds, pad: number): Bounds {
  return { x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 };
}

export function overlaps(a: Bounds, b: Bounds): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

/**
 * The lane of an arrow among the N that connect the SAME pair of
 * screens (in either direction): the offset along the side, symmetric
 * around zero. A single arrow: 0. Two: ±gap/2. This way A->B and B->A do not
 * overlap and two different clicks A->B remain distinguishable.
 */
export function laneShift(index: number, count: number): number {
  if (count <= 1) return 0;
  return (index - (count - 1) / 2) * LANE_GAP;
}
