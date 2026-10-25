import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Pair, Polygon, Ring } from "polygon-clipping";
import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { IDENTITY, applyTransform, invertTransform, worldTransformOf } from "../canvas/transform";
import { orderKeyBetween } from "../store/orderKey";
import { childrenOf, documentOrder, topmostOf } from "../store/tree";
import { normalizeVector } from "../store/vectorGeometry";
import type { NodeLite, SceneState } from "../store/types";
import { toPbEffects, toPbFills, toPbStrokes, toPbSubPaths } from "../store/types";
import { makeCreateNodeOp, makeDeleteOp, uuid } from "../tools/ops";
import { booleanRegion, isBooleanSource, regionOfNode } from "./boolean";

// THE SHAPE BUILDER (docs/vector.md): the regions of overlapping shapes, and what a click or a drag across
// them makes. The selected shapes are cut along each other's outlines into FACES -- the disjoint pieces of
// the plane that the same shapes cover -- and the gesture merges the faces it crosses into one shape
// (Alt: removes them). The geometry is the boolean code's (vector/boolean.ts, polygon-clipping); this file
// is the arrangement and the ops. Pure: no store.

/** One piece of the plane: a polygon with its holes, in WORLD coordinates, and the shapes that cover it (bottom first). */
export interface Face { polygon: Polygon; members: string[] }

export type BuilderMode = "merge" | "remove";

/** Faces smaller than this (world units squared) are slivers of numerical noise and are dropped. */
export const MIN_FACE_AREA = 1e-4;

function ringArea(r: Ring): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
}

/** The area of a polygon (outer ring minus its holes). */
export function polygonArea(p: Polygon): number {
  return p.reduce((t, ring, i) => t + (i === 0 ? 1 : -1) * ringArea(ring), 0);
}

const multiArea = (m: MultiPolygon) => m.reduce((t, p) => t + polygonArea(p), 0);

function inRing(r: Ring, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True if (x, y) is inside the face: in the outer ring and in none of the holes. */
export function faceContains(face: Face, x: number, y: number): boolean {
  const [outer, ...holes] = face.polygon;
  return !!outer && inRing(outer, x, y) && !holes.some((h) => inRing(h, x, y));
}

/** The shapes the builder takes from a selection: top-level fillable shapes of ONE parent, bottom first. */
export function builderSources(scene: SceneState, selection: readonly string[]): NodeLite[] {
  const order = new Map<string, number>();
  documentOrder(scene).forEach((n, i) => order.set(n.id, i));
  const nodes = topmostOf(scene, selection)
    .filter((id) => order.has(id))
    .map((id) => scene.nodes.at(id))
    .filter((n): n is NodeLite => !!n && n.visible && isBooleanSource(scene, n))
    .sort((a, b) => (order.get(a.id) as number) - (order.get(b.id) as number));
  return nodes.length > 0 && nodes.every((n) => n.parentId === nodes[0].parentId) ? nodes : [];
}

/**
 * The faces of the shapes' arrangement: every piece of the plane covered by the same set of shapes, each
 * polygon its own face (a shape cut in two by another makes two). Bottom shape first, so `members` is in
 * draw order.
 */
export function builderFaces(scene: SceneState, sources: readonly NodeLite[]): Face[] {
  let faces: Face[] = [];
  for (const n of sources) {
    const region = regionOfNode(scene, n, IDENTITY);
    if (multiArea(region) < MIN_FACE_AREA) continue;
    const next: Face[] = [];
    const push = (m: MultiPolygon, members: string[]) => {
      for (const polygon of m) if (polygonArea(polygon) >= MIN_FACE_AREA) next.push({ polygon, members });
    };
    let rest: MultiPolygon = region;
    for (const f of faces) {
      const shape: MultiPolygon = [f.polygon];
      push(polygonClipping.intersection(shape, region), [...f.members, n.id]);
      push(polygonClipping.difference(shape, region), f.members);
      rest = polygonClipping.difference(rest, shape);
    }
    push(rest, [n.id]);
    faces = next;
  }
  return faces;
}

/** The indices of the faces a polyline (the drag, in world coordinates) passes through; the end points count. */
export function facesAlong(faces: readonly Face[], path: readonly { x: number; y: number }[], step = 1): number[] {
  const hit = new Set<number>();
  const probe = (x: number, y: number) => {
    // The topmost face wins where faces touch on an edge: the last match.
    for (let i = faces.length - 1; i >= 0; i--) if (faceContains(faces[i], x, y)) { hit.add(i); return; }
  };
  for (let i = 0; i < path.length; i++) {
    probe(path[i].x, path[i].y);
    if (i === 0) continue;
    const a = path[i - 1], b = path[i];
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step);
    for (let k = 1; k < n; k++) probe(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n);
  }
  return [...hit].sort((x, y) => x - y);
}

export interface BuilderResult { ops: Op[]; selection: string[] }

/**
 * The ops of one gesture: `picked` faces are merged into one shape (merge) or dropped (remove); every other
 * face becomes a shape of its own, and the source shapes are deleted. Each new vector takes the style of the
 * TOPMOST shape that covers it. Null when nothing is picked or there is nothing to build.
 */
export function shapeBuilderOps(scene: SceneState, sources: readonly NodeLite[], faces: readonly Face[], picked: readonly number[], mode: BuilderMode): BuilderResult | null {
  const pick = new Set(picked.filter((i) => i >= 0 && i < faces.length));
  if (pick.size === 0 || sources.length === 0 || faces.length === 0) return null;
  if (mode === "merge" && pick.size < 2 && faces.length === 1) return null; // a lone face: nothing to build
  const byId = new Map(sources.map((n) => [n.id, n]));
  const topOf = (members: readonly string[]) => byId.get(members[members.length - 1]) as NodeLite;
  type Piece = { region: MultiPolygon; members: string[] };
  const pieces: Piece[] = [];
  const merged: Piece = { region: [], members: [] };
  faces.forEach((f, i) => {
    if (pick.has(i)) {
      if (mode === "remove") return;
      merged.region = merged.region.length === 0 ? [f.polygon] : polygonClipping.union(merged.region, [f.polygon]);
      merged.members.push(...f.members);
    } else {
      pieces.push({ region: [f.polygon], members: f.members });
    }
  });
  if (merged.members.length > 0) {
    // The merged shape takes the style of the topmost of ALL the shapes under the faces it swallowed.
    const order = new Map(sources.map((n, i) => [n.id, i]));
    merged.members = [...new Set(merged.members)].sort((a, b) => (order.get(a) as number) - (order.get(b) as number));
    pieces.push(merged);
  }
  const top = sources[sources.length - 1];
  const parentId = top.parentId;
  const toParent = invertTransform(worldTransformOf(scene, parentId));
  const siblings = childrenOf(scene, parentId);
  const above = siblings[siblings.findIndex((s) => s.id === top.id) + 1];
  let key = top.orderKey;
  const ceiling = above && above.orderKey > top.orderKey ? above.orderKey : null;
  const ops: Op[] = [];
  const selection: string[] = [];
  for (const piece of pieces) {
    const local: MultiPolygon = piece.region.map((poly) => poly.map((ring) => ring.map(([x, y]) => {
      const p = applyTransform(toParent, x, y);
      return [p.x, p.y] as Pair;
    })));
    const subpaths = booleanRegion("union", [local]);
    if (subpaths.length === 0) continue;
    const style = topOf(piece.members);
    const norm = normalizeVector({ x: 0, y: 0 }, subpaths);
    key = orderKeyBetween(key, ceiling);
    const id = uuid();
    ops.push(makeCreateNodeOp(create(NodeSchema, {
      id, parentId, orderKey: key,
      name: `${style.name || "Shape"} piece`, visible: true, opacity: style.opacity,
      x: norm.box.x, y: norm.box.y, width: norm.box.width, height: norm.box.height, rotation: 0,
      fills: toPbFills(style.fills), strokes: toPbStrokes(style.strokes), effects: toPbEffects(style.effects ?? []),
      shape: { case: "vector", value: { subpaths: toPbSubPaths(norm.subpaths) } },
    })));
    selection.push(id);
  }
  for (const n of sources) ops.push(makeDeleteOp(n.id));
  return { ops, selection };
}
