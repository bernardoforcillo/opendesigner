import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { makeSetPropsOp } from "../tools/ops";
import { toPbFills } from "../store/types";
import type { FillLite, GradientLite, NodeLite } from "../store/types";
import type { RgbLite } from "./fields/ColorField";

// The gradient panel's ops. Like fillOps in the panel, they touch ONLY the
// node's first tint: a node with several fills does not lose the others.
//
// Pure functions on the node (they do not read the store): the caller passes the lookup,
// so they can be tested without mounting anything.
export type NodeLookup = (id: string) => NodeLite | undefined;

export type FillKind = "solid" | "linear" | "radial";

export function fillKindOf(f: FillLite | null): FillKind {
  return f?.gradient?.kind ?? "solid";
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

function withFirst(n: NodeLite, first: FillLite): Op {
  return makeSetPropsOp(n.id, { fills: toPbFills([first, ...n.fills.slice(1)]) }, ["fills"]);
}

const BASE: FillLite = { r: 0.8, g: 0.8, b: 0.8, a: 1 };

/** Changes the fill TYPE. Going back to "solid" keeps the first stop. */
export function fillKindOps(ids: readonly string[], lookup: NodeLookup, kind: FillKind): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    if (!n) return [];
    const cur = n.fills[0] ?? BASE;
    if (fillKindOf(cur) === kind) return [];
    if (kind === "solid") return [withFirst(n, { r: cur.r, g: cur.g, b: cur.b, a: cur.a })];
    // From gradient to gradient only the shape changes: the stops stay, the
    // geometry goes back to the new type's default.
    if (cur.gradient) {
      const gradient: GradientLite = { ...cur.gradient, kind, ...defaultGeometry(kind) };
      return [withFirst(n, { ...cur, gradient })];
    }
    return [withFirst(n, toGradient(cur, kind))];
  });
}

/** Color (without alpha) of a stop, which keeps its OWN alpha. */
export function gradientStopOps(ids: readonly string[], lookup: NodeLookup, index: number, rgb: RgbLite): Op[] {
  return ids.flatMap((id) => {
    const n = lookup(id);
    const cur = n?.fills[0];
    const g = cur?.gradient;
    if (!n || !cur || !g || index < 0 || index >= g.stops.length) return [];
    const stops = g.stops.map((st, i) => (i === index ? { ...st, color: { ...rgb, a: st.color.a } } : st));
    const first = stops[0].color;
    return [withFirst(n, { r: first.r, g: first.g, b: first.b, a: first.a, gradient: { ...g, stops } })];
  });
}

/** Angle (degrees, 0 = left to right, 90 = top to bottom) of a linear gradient. */
export function gradientAngleOf(f: FillLite | null): number {
  const g = f?.gradient;
  if (!g || g.kind !== "linear") return 0;
  const deg = (Math.atan2(g.y2 - g.y1, g.x2 - g.x1) * 180) / Math.PI;
  return Math.round(((deg % 360) + 360) % 360 * 100) / 100;
}

export function gradientAngleOps(ids: readonly string[], lookup: NodeLookup, degrees: number): Op[] {
  const rad = (degrees * Math.PI) / 180;
  const dx = Math.cos(rad) / 2, dy = Math.sin(rad) / 2;
  return ids.flatMap((id) => {
    const n = lookup(id);
    const cur = n?.fills[0];
    const g = cur?.gradient;
    if (!n || !cur || !g || g.kind !== "linear") return [];
    const gradient: GradientLite = { ...g, x1: 0.5 - dx, y1: 0.5 - dy, x2: 0.5 + dx, y2: 0.5 + dy };
    return [withFirst(n, { ...cur, gradient })];
  });
}
