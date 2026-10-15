import polygonClipping from "polygon-clipping";
import type { MultiPolygon, Pair, Ring } from "polygon-clipping";
import { create } from "@bufbuild/protobuf";
import { NodeSchema } from "../gen/opendesigner/v1/opendesigner_pb";
import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { applyTransform, localTransformOf, worldTransformOf } from "../canvas/transform";
import { orderKeyBetween } from "../store/orderKey";
import { childrenOf } from "../store/tree";
import { normalizeVector } from "../store/vectorGeometry";
import type { NodeLite, SceneState } from "../store/types";
import { toPbFills, toPbSubPaths } from "../store/types";
import { vectorStyleOf } from "../renderer/vectorStyle";
import { makeCreateNodeOp, makeDeleteOp, makeSetPropsOp, uuid } from "../tools/ops";
import { BEZIER_TOLERANCE, booleanRegion, localOutlines, regionOfNode } from "./boolean";

// OUTLINE STROKE: turns the first stroke of a shape into a filled vector -- the
// stroke's own geometry, ready to be edited as a shape.
//
// The stroke is the union of one quad per segment, a join piece per vertex and a cap
// piece per open end, then clipped by the stroke alignment (inside = intersected with
// the shape, outside = shape removed). Curves are flattened (BEZIER_TOLERANCE) and
// dashes are not applied: the outline is of the solid line.

type Pt = { x: number; y: number };

const CIRCLE_STEPS = 24;

const ringOf = (pts: Pt[]): Ring => pts.map((p) => [p.x, p.y] as Pair);
const poly = (pts: Pt[]): MultiPolygon => [[ringOf(pts)]];

function circle(c: Pt, r: number): MultiPolygon {
  const pts: Pt[] = [];
  for (let i = 0; i < CIRCLE_STEPS; i++) {
    const a = (2 * Math.PI * i) / CIRCLE_STEPS;
    pts.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return poly(pts);
}

function dedupe(pts: Pt[], closed: boolean): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const l = out[out.length - 1];
    if (!l || Math.hypot(p.x - l.x, p.y - l.y) > 1e-9) out.push(p);
  }
  if (closed && out.length > 1) {
    const f = out[0], l = out[out.length - 1];
    if (Math.hypot(f.x - l.x, f.y - l.y) <= 1e-9) out.pop();
  }
  return out;
}

export interface StrokeGeometry { cap: "butt" | "round" | "square"; join: "miter" | "round" | "bevel"; miter: number }

/** The solid region of a stroke of `weight` along ONE polyline. */
export function strokePolyline(raw: Pt[], closed: boolean, weight: number, g: StrokeGeometry): MultiPolygon[] {
  const h = weight / 2;
  const pts = dedupe(raw, closed);
  const out: MultiPolygon[] = [];
  if (pts.length === 0 || !(h > 0)) return out;
  if (pts.length === 1) {
    if (g.cap === "round") out.push(circle(pts[0], h));
    else if (g.cap === "square") out.push(poly([{ x: pts[0].x - h, y: pts[0].y - h }, { x: pts[0].x + h, y: pts[0].y - h }, { x: pts[0].x + h, y: pts[0].y + h }, { x: pts[0].x - h, y: pts[0].y + h }]));
    return out;
  }
  const n = pts.length;
  const segs = closed ? n : n - 1;
  const dir = (i: number): Pt => {
    const a = pts[i], b = pts[(i + 1) % n];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
  };
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const d = dir(i);
    const nx = -d.y * h, ny = d.x * h;
    out.push(poly([{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }]));
  }
  // Joins between consecutive segments.
  const joinAt = (i: number, d0: Pt, d1: Pt) => {
    const v = pts[i];
    if (g.join === "round") { out.push(circle(v, h)); return; }
    const cross = d0.x * d1.y - d0.y * d1.x;
    if (Math.abs(cross) < 1e-9) return;
    // The outer side of the turn.
    const side = cross > 0 ? -1 : 1;
    const A = { x: v.x + side * -d0.y * h, y: v.y + side * d0.x * h };
    const B = { x: v.x + side * -d1.y * h, y: v.y + side * d1.x * h };
    const tri = [v, A, B];
    if (g.join === "miter") {
      const dot = d0.x * d1.x + d0.y * d1.y;
      // miter length / stroke width = 1 / cos(phi / 2), phi the turning angle between the segments.
      const turn = Math.sqrt(Math.max(0, (1 + dot) / 2));
      if (turn > 1e-9 && 1 / turn <= g.miter) {
        const m = { x: A.x + B.x - 2 * v.x, y: A.y + B.y - 2 * v.y };
        const ml = Math.hypot(m.x, m.y);
        if (ml > 1e-9) {
          const len = h / turn;
          tri.splice(2, 0, { x: v.x + (m.x / ml) * len, y: v.y + (m.y / ml) * len });
        }
      }
    }
    out.push(poly(tri));
  };
  if (closed) for (let i = 0; i < n; i++) joinAt(i, dir((i + n - 1) % n), dir(i));
  else for (let i = 1; i < n - 1; i++) joinAt(i, dir(i - 1), dir(i));
  // Caps at the two ends of an open polyline.
  if (!closed && g.cap !== "butt") {
    const end = (v: Pt, d: Pt) => {
      if (g.cap === "round") { out.push(circle(v, h)); return; }
      const nx = -d.y * h, ny = d.x * h;
      out.push(poly([{ x: v.x + nx, y: v.y + ny }, { x: v.x + nx + d.x * h, y: v.y + ny + d.y * h }, { x: v.x - nx + d.x * h, y: v.y - ny + d.y * h }, { x: v.x - nx, y: v.y - ny }]));
    };
    const d0 = dir(0), dN = dir(segs - 1);
    end(pts[0], { x: -d0.x, y: -d0.y });
    end(pts[n - 1], dN);
  }
  return out;
}

export interface OutlineResult { ops: Op[]; selection: string[] }

/** True if the node has a stroke that can be outlined. */
export function canOutlineStroke(n: NodeLite): boolean {
  return (n.kind === "rect" || n.kind === "ellipse" || n.kind === "vector" || n.kind === "frame") && n.strokes.some((s) => s.weight > 0);
}

/**
 * Outline stroke of one node: a new vector with the stroke's region, filled with the
 * stroke's paint, right above the node. The node keeps its fill and loses the stroke
 * (a node with no fill is replaced).
 */
export function outlineStrokeOps(scene: SceneState, id: string): OutlineResult | null {
  const n = scene.nodes.at(id);
  if (!n || !canOutlineStroke(n)) return null;
  const stroke = n.strokes.find((s) => s.weight > 0)!;
  const style = vectorStyleOf(n);
  const g: StrokeGeometry = { cap: style.cap, join: style.join, miter: Math.max(1, style.miter) };
  // Work in the node's PARENT space (the space its own x/y live in).
  const t = localTransformOf(n);
  const pieces: MultiPolygon[] = [];
  for (const o of localOutlines(n, BEZIER_TOLERANCE)) {
    const pts = o.points.map((p) => applyTransform(t, p.x, p.y));
    // Inside / outside strokes are the doubled line clipped to one side (as the canvas draws them).
    pieces.push(...strokePolyline(pts, o.closed, stroke.align === "center" ? stroke.weight : stroke.weight * 2, g));
  }
  if (pieces.length === 0) return null;
  let region: MultiPolygon = polygonClipping.union(pieces[0], ...pieces.slice(1));
  // Alignment: the stroke is centred by default; inside / outside clip it by the shape.
  if (stroke.align !== "center") {
    const fillRegion = regionOfNode(scene, n, worldTransformOf(scene, n.parentId));
    if (fillRegion.length > 0) {
      region = stroke.align === "inside" ? polygonClipping.intersection(region, fillRegion) : polygonClipping.difference(region, fillRegion);
    }
  }
  const subpaths = booleanRegion("union", [region]);
  if (subpaths.length === 0) return null;
  const norm = normalizeVector({ x: 0, y: 0 }, subpaths);
  const siblings = childrenOf(scene, n.parentId);
  const at = siblings.findIndex((s) => s.id === n.id);
  const above = at >= 0 ? siblings[at + 1] : undefined;
  const newId = uuid();
  const node = create(NodeSchema, {
    id: newId, parentId: n.parentId,
    orderKey: orderKeyBetween(n.orderKey, above && above.orderKey > n.orderKey ? above.orderKey : null),
    name: `${n.name || "Shape"} outline`,
    visible: true, opacity: n.opacity,
    x: norm.box.x, y: norm.box.y, width: norm.box.width, height: norm.box.height, rotation: 0,
    fills: toPbFills([stroke.color]),
    shape: { case: "vector", value: { subpaths: toPbSubPaths(norm.subpaths) } },
  });
  const ops: Op[] = [makeCreateNodeOp(node)];
  const keepsFill = n.fills.length > 0 && n.kind !== "vector";
  ops.push(keepsFill ? makeSetPropsOp(n.id, { strokes: [] }, ["strokes"]) : makeDeleteOp(n.id));
  return { ops, selection: [newId] };
}
