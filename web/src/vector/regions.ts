import polygonClipping from "polygon-clipping";
import type { Geom, MultiPolygon, Pair, Ring } from "polygon-clipping";
import { applyTransform, compose, invertTransform, localTransformOf, worldTransformOf, type Transform } from "../canvas/transform";
import { childrenOf } from "../store/tree";
import { flattenSubpath, subpathFills } from "../store/vectorGeometry";
import type { NodeLite, SceneState, SubPathLite } from "../store/types";

// The PURE geometry of boolean operations: the region a node fills, and the result of an
// operation over regions. No store, no ops -- the derived scene (store/booleans.ts) and the
// flatten command (vector/boolean.ts) both stand on it.

export type BooleanOp = "union" | "subtract" | "intersect" | "exclude";

// How far the flattened curves may stray from the true ones, in world units.
export const BEZIER_TOLERANCE = 0.05;

/** `meta` key of a group that is a LIVE boolean: its value is a BooleanOp. */
export const META_BOOLEAN = "boolean.op";

export function booleanOpOf(n: NodeLite): BooleanOp | null {
  const v = n.kind === "group" ? n.meta?.[META_BOOLEAN] : undefined;
  return v === "union" || v === "subtract" || v === "intersect" || v === "exclude" ? v : null;
}
const CORNER_STEPS = 12;
const ELLIPSE_STEPS = 96;

const KINDS = new Set(["rect", "ellipse", "vector", "frame"]);

/** True if the node is a shape a boolean operation can take (or a group of them). */
export function isBooleanSource(scene: SceneState, n: NodeLite): boolean {
  if (n.kind === "group") return childrenOf(scene, n.id).some((c) => isBooleanSource(scene, c));
  return KINDS.has(n.kind) && n.kind !== "instance";
}

type Pt = { x: number; y: number };

// The outline of a rounded rectangle in the node's local space (0,0)-(w,h).
function rectRing(w: number, h: number, radius: number): Pt[] {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r === 0) return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const out: Pt[] = [];
  const corner = (cx: number, cy: number, from: number) => {
    for (let i = 0; i <= CORNER_STEPS; i++) {
      const a = from + (Math.PI / 2) * (i / CORNER_STEPS);
      out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  };
  corner(w - r, r, -Math.PI / 2);
  corner(w - r, h - r, 0);
  corner(r, h - r, Math.PI / 2);
  corner(r, r, Math.PI);
  return out;
}

function ellipseRing(w: number, h: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < ELLIPSE_STEPS; i++) {
    const a = (2 * Math.PI * i) / ELLIPSE_STEPS;
    out.push({ x: w / 2 + (w / 2) * Math.cos(a), y: h / 2 + (h / 2) * Math.sin(a) });
  }
  return out;
}

/** Every outline of a node (closed or not) as polylines in its LOCAL space. */
export function localOutlines(n: NodeLite, tol: number): { points: Pt[]; closed: boolean }[] {
  switch (n.kind) {
    case "rect": return [{ points: rectRing(n.width, n.height, n.cornerRadius), closed: true }];
    case "frame": return [{ points: rectRing(n.width, n.height, 0), closed: true }];
    case "ellipse": return [{ points: ellipseRing(n.width, n.height), closed: true }];
    case "vector":
      return (n.vector?.subpaths ?? []).filter((sp) => sp.anchors.length > 0).map((sp) => ({ points: flattenSubpath(sp, tol), closed: sp.closed }));
    default: return [];
  }
}

// The closed rings a node fills, in its LOCAL space.
function localRings(n: NodeLite): Pt[][] {
  switch (n.kind) {
    case "rect": return [rectRing(n.width, n.height, n.cornerRadius)];
    case "frame": return [rectRing(n.width, n.height, 0)];
    case "ellipse": return [ellipseRing(n.width, n.height)];
    case "vector":
      return (n.vector?.subpaths ?? []).filter(subpathFills).map((sp) => flattenSubpath(sp, BEZIER_TOLERANCE));
    default: return [];
  }
}

const toRing = (pts: Pt[], t: Transform): Ring => {
  const ring: Pair[] = pts.map((p) => {
    const q = applyTransform(t, p.x, p.y);
    return [q.x, q.y] as Pair;
  });
  // polygon-clipping closes rings itself; an explicit duplicate of the first point is harmless but unneeded.
  const f = ring[0], l = ring[ring.length - 1];
  if (f && l && f[0] === l[0] && f[1] === l[1]) ring.pop();
  return ring;
};

// The region a node fills, in the space of `target` (a container's local space).
export function regionOf(scene: SceneState, n: NodeLite, target: Transform): MultiPolygon {
  if (n.kind === "group") {
    const parts = childrenOf(scene, n.id).filter((c) => c.visible && !c.isMask && isBooleanSource(scene, c)).map((c) => regionOf(scene, c, target));
    // A live boolean group applies ITS operation to its children; a plain group is their union.
    return applyBooleanOp(booleanOpOf(n) ?? "union", parts);
  }
  const t = compose(invertTransform(target), compose(worldTransformOf(scene, n.parentId), localTransformOf(n)));
  const rings = localRings(n).map((r) => toRing(r, t)).filter((r) => r.length >= 3);
  if (rings.length === 0) return [];
  // Even-odd across the node's own rings: XOR them together.
  const polys: Geom[] = rings.map((r) => [r]);
  return polygonClipping.xor(polys[0], ...polys.slice(1));
}

/** The result of an operation as subpaths (every ring closed, corner anchors). */
export function applyBooleanOp(op: BooleanOp, regions: readonly MultiPolygon[]): MultiPolygon {
  if (regions.length === 0) return [];
  const [first, ...rest] = regions;
  return op === "union" ? polygonClipping.union(first, ...rest)
    : op === "intersect" ? polygonClipping.intersection(first, ...rest)
    : op === "subtract" ? polygonClipping.difference(first, ...rest)
    : polygonClipping.xor(first, ...rest);
}

export function booleanRegion(op: BooleanOp, regions: readonly MultiPolygon[]): SubPathLite[] {
  if (regions.length === 0) return [];
  const result = applyBooleanOp(op, regions);
  const out: SubPathLite[] = [];
  for (const polygon of result) {
    for (const ring of polygon) {
      // polygon-clipping repeats the first point at the end of a ring.
      const pts = ring.slice(0, ring.length - 1);
      if (pts.length < 3) continue;
      out.push({ anchors: pts.map(([x, y]) => ({ x, y, inX: 0, inY: 0, outX: 0, outY: 0 })), closed: true });
    }
  }
  return out;
}


export const regionOfNode = regionOf;
