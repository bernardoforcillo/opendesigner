import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { makeSetPropsOp } from "../tools/ops";
import { toPbFills, toPbStrokes } from "../store/types";
import type { FillLite, GradientLite, MeshLite, NodeLite } from "../store/types";
import { defaultMesh, meshAverage, resizeMesh } from "../renderer/mesh";
import { MAX_MESH_SIDE, MIN_MESH_SIDE } from "../store/paints";
import type { RgbLite } from "./fields/ColorField";

// The gradient panel's ops. Like fillOps in the panel, they touch ONLY the
// node's first tint: a node with several fills does not lose the others.
//
// Pure functions on the node (they do not read the store): the caller passes the lookup,
// so they can be tested without mounting anything.
export type NodeLookup = (id: string) => NodeLite | undefined;

export type FillKind = "solid" | "linear" | "radial" | "image" | "mesh";

export function fillKindOf(f: FillLite | null): FillKind {
  return f?.mesh ? "mesh" : f?.image ? "image" : (f?.gradient?.kind ?? "solid");
}

// Default axis: linear from top to bottom, radial from center to edge.
function defaultGeometry(kind: "linear" | "radial") {
  return kind === "linear"
    ? { x1: 0.5, y1: 0, x2: 0.5, y2: 1 }
    : { x1: 0.5, y1: 0.5, x2: 1, y2: 0.5 };
}

// From the flat color to a gradient that GOES from the color to itself transparent:
// it is a starting point that visibly looks different right away, without inventing a
// second color the user did not choose.
function toGradient(f: FillLite, kind: "linear" | "radial"): FillLite {
  const from = { r: f.r, g: f.g, b: f.b, a: f.a };
  const gradient: GradientLite = {
    kind,
    stops: [
      { color: from, position: 0 },
      { color: { ...from, a: 0 }, position: 1 },
    ],
    ...defaultGeometry(kind),
  };
  return { ...from, gradient };
}

/** Which paint of the node an op edits: its first fill, or the paint of its first stroke. */
export type PaintTarget = "fill" | "stroke";

const DEFAULT_STROKE_WEIGHT = 1;

/** The paint being edited, or undefined when the node has none there. */
export function paintOf(n: NodeLite, target: PaintTarget): FillLite | undefined {
  return target === "fill" ? n.fills[0] : n.strokes[0]?.color;
}

// A stroke edit never creates a stroke out of nothing here (the panel's stroke color does that);
// it rewrites the first stroke's paint and keeps its weight and alignment.
function withFirst(n: NodeLite, first: FillLite, target: PaintTarget = "fill"): Op {
  if (target === "fill") return makeSetPropsOp(n.id, { fills: toPbFills([first, ...n.fills.slice(1)]) }, ["fills"]);
  const cur = n.strokes[0] ?? { color: first, weight: DEFAULT_STROKE_WEIGHT, align: "center" as const };
  return makeSetPropsOp(n.id, { strokes: toPbStrokes([{ ...cur, color: first }, ...n.strokes.slice(1)]) }, ["strokes"]);
}

const BASE: FillLite = { r: 0.8, g: 0.8, b: 0.8, a: 1 };

/** Changes the fill TYPE. Going back to "solid" keeps the first stop. */
export function fillKindOps(ids: readonly string[], lookup: NodeLookup, kind: FillKind, target: PaintTarget = "fill"): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    if (!n) return [];
    const cur = paintOf(n, target) ?? BASE;
    if (fillKindOf(cur) === kind || kind === "image") return []; // an image needs a file: see imagePaintOps
    if (kind === "solid") return [withFirst(n, { r: cur.r, g: cur.g, b: cur.b, a: cur.a }, target)];
    if (kind === "mesh") return [withFirst(n, withMesh(defaultMesh(cur)), target)];
    // From gradient to gradient only the shape changes: the stops stay, the
    // geometry goes back to the new type's default.
    if (cur.gradient) {
      const gradient: GradientLite = { ...cur.gradient, kind, ...defaultGeometry(kind) };
      return [withFirst(n, { ...cur, gradient }, target)];
    }
    return [withFirst(n, toGradient(cur, kind), target)];
  });
}

// A fill that is this mesh: its own r,g,b,a hold the average, the fallback for whoever cannot draw it.
function withMesh(mesh: MeshLite): FillLite {
  return { ...meshAverage(mesh.colors), mesh };
}

/** Color (without alpha) of one point of the mesh, which keeps its OWN alpha. */
export function meshPointOps(ids: readonly string[], lookup: NodeLookup, index: number, rgb: RgbLite, target: PaintTarget = "fill"): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    const m = n ? paintOf(n, target)?.mesh : undefined;
    if (!n || !m || index < 0 || index >= m.colors.length) return [];
    const colors = m.colors.map((c, i) => (i === index ? { ...rgb, a: c.a } : c));
    return [withFirst(n, withMesh({ ...m, colors }), target)];
  });
}

/** A mesh of another size: the new points take the old mesh's blended colors there. */
export function meshSizeOps(ids: readonly string[], lookup: NodeLookup, rows: number, cols: number, target: PaintTarget = "fill"): Op[] {
  const r = Math.min(MAX_MESH_SIDE, Math.max(MIN_MESH_SIDE, Math.round(rows)));
  const c = Math.min(MAX_MESH_SIDE, Math.max(MIN_MESH_SIDE, Math.round(cols)));
  return ids.flatMap((id) => {
    const n = lookup(id);
    const m = n ? paintOf(n, target)?.mesh : undefined;
    if (!n || !m || (m.rows === r && m.cols === c)) return [];
    return [withFirst(n, withMesh(resizeMesh(m, r, c)), target)];
  });
}

/** Color (without alpha) of a stop, which keeps its OWN alpha. */
export function gradientStopOps(ids: readonly string[], lookup: NodeLookup, index: number, rgb: RgbLite, target: PaintTarget = "fill"): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    const cur = n ? paintOf(n, target) : undefined;
    const g = cur?.gradient;
    if (!n || !cur || !g || index < 0 || index >= g.stops.length) return [];
    const stops = g.stops.map((st, i) => (i === index ? { ...st, color: { ...rgb, a: st.color.a } } : st));
    const first = stops[0].color;
    return [withFirst(n, { r: first.r, g: first.g, b: first.b, a: first.a, gradient: { ...g, stops } }, target)];
  });
}

/** Angle (degrees, 0 = left to right, 90 = top to bottom) of a linear gradient. */
export function gradientAngleOf(f: FillLite | null): number {
  const g = f?.gradient;
  if (!g || g.kind !== "linear") return 0;
  const deg = (Math.atan2(g.y2 - g.y1, g.x2 - g.x1) * 180) / Math.PI;
  return Math.round(((deg % 360) + 360) % 360 * 100) / 100;
}

export function gradientAngleOps(ids: readonly string[], lookup: NodeLookup, degrees: number, target: PaintTarget = "fill"): Op[] {
  const rad = (degrees * Math.PI) / 180;
  const dx = Math.cos(rad) / 2, dy = Math.sin(rad) / 2;
  return ids.flatMap((id) => {
    const n = lookup(id);
    const cur = n ? paintOf(n, target) : undefined;
    const g = cur?.gradient;
    if (!n || !cur || !g || g.kind !== "linear") return [];
    const gradient: GradientLite = { ...g, x1: 0.5 - dx, y1: 0.5 - dy, x2: 0.5 + dx, y2: 0.5 + dy };
    return [withFirst(n, { ...cur, gradient }, target)];
  });
}

// ---------- several stops ----------

type Stop = GradientLite["stops"][number];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const byPosition = (a: Stop, b: Stop) => a.position - b.position;

// Rewrites the stops of each node's first gradient. The result is always
// sorted by position (the renderers draw them in order) and the fill's own
// color follows the first stop, as in gradientStopOps.
function editStops(ids: readonly string[], lookup: NodeLookup, edit: (stops: Stop[]) => Stop[] | null, target: PaintTarget = "fill"): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    const cur = n ? paintOf(n, target) : undefined;
    const g = cur?.gradient;
    if (!n || !cur || !g) return [];
    const next = edit(g.stops.map((s) => ({ ...s })));
    if (!next || next.length < 2) return [];
    const stops = [...next].sort(byPosition);
    const first = stops[0].color;
    return [withFirst(n, { r: first.r, g: first.g, b: first.b, a: first.a, gradient: { ...g, stops } }, target)];
  });
}

/** Adds a stop halfway through the widest gap, with the color the gradient has there. */
export function addGradientStopOps(ids: readonly string[], lookup: NodeLookup, target: PaintTarget = "fill"): Op[] {
  return editStops(ids, lookup, (stops) => {
    const s = [...stops].sort(byPosition);
    let at = 0, gap = -1;
    for (let i = 0; i + 1 < s.length; i++) {
      const d = s[i + 1].position - s[i].position;
      if (d > gap) { gap = d; at = i; }
    }
    const a = s[at], b = s[at + 1];
    const mix = (x: number, y: number) => x + (y - x) / 2;
    const color = { r: mix(a.color.r, b.color.r), g: mix(a.color.g, b.color.g), b: mix(a.color.b, b.color.b), a: mix(a.color.a, b.color.a) };
    return [...s, { color, position: mix(a.position, b.position) }];
  }, target);
}

/** Removes the stop at `index` (a gradient keeps at least two). */
export function removeGradientStopOps(ids: readonly string[], lookup: NodeLookup, index: number, target: PaintTarget = "fill"): Op[] {
  return editStops(ids, lookup, (stops) => (index < 0 || index >= stops.length || stops.length <= 2 ? null : stops.filter((_, i) => i !== index)), target);
}

/** Moves the stop at `index` to `position` (0..1). */
export function gradientStopPositionOps(ids: readonly string[], lookup: NodeLookup, index: number, position: number, target: PaintTarget = "fill"): Op[] {
  return editStops(ids, lookup, (stops) => {
    if (index < 0 || index >= stops.length || !Number.isFinite(position)) return null;
    stops[index].position = clamp01(position);
    return stops;
  }, target);
}

// ---------- image paints ----------

/** Makes the paint an image of `assetHash` (keeping the mode when it already is one), or changes the mode. */
export function imagePaintOps(
  ids: readonly string[], lookup: NodeLookup, patch: { assetHash?: string; mode?: "fill" | "fit" | "tile" }, target: PaintTarget = "fill",
): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    if (!n) return [];
    const cur = paintOf(n, target) ?? BASE;
    const hash = patch.assetHash ?? cur.image?.assetHash;
    if (!hash) return [];
    const image = { assetHash: hash, mode: patch.mode ?? cur.image?.mode ?? "fill" };
    if (cur.image && cur.image.assetHash === image.assetHash && cur.image.mode === image.mode) return [];
    return [withFirst(n, { r: cur.r, g: cur.g, b: cur.b, a: cur.a, image }, target)];
  });
}
