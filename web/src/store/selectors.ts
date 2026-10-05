import { frameOriginOf } from "./groups";
import type { FillLite, NodeLite, SceneState, StrokeLite } from "./types";

// The layers panel shows the FRONT at the top of the list: it is the INVERSE
// of the draw order (which goes from bottom to top, orderKey ascending). A
// new Object.values() on every call: the nodes map is not ordered and
// iteration order is not that of orderKey, so there is a
// sort to do -- nothing to gain from doing it "in place".
export function layersInDrawOrder(scene: SceneState): NodeLite[] {
  return [...scene.nodes.values()].sort((a, b) => (a.orderKey < b.orderKey ? 1 : a.orderKey > b.orderKey ? -1 : 0));
}

// Marker for a "mixed value" for a field that differs among the
// selected nodes. A Symbol and not a sentinel string ("mixed"): a text
// node could legitimately be named "mixed", and a literal string
// would be indistinguishable from that real value. The Symbol does not collide with
// any value a NodeLite could ever contain.
export const MIXED = Symbol("mixed");
export type Mixed = typeof MIXED;
export type OrMixed<T> = T | Mixed;

export interface SelectionSummary {
  count: number;
  name: OrMixed<string>;
  kind: OrMixed<NodeLite["kind"]>;
  visible: OrMixed<boolean>;
  opacity: OrMixed<number>;
  x: OrMixed<number>;
  y: OrMixed<number>;
  width: OrMixed<number>;
  height: OrMixed<number>;
  rotation: OrMixed<number>;
  cornerRadius: OrMixed<number>;
  fills: OrMixed<FillLite[]>;
  strokes: OrMixed<StrokeLite[]>;
}

function sameColor(a: FillLite, b: FillLite): boolean {
  if (!(a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a)) return false;
  // Two gradients are the same value if they have the same shape and the same stops.
  return JSON.stringify(a.gradient ?? null) === JSON.stringify(b.gradient ?? null);
}

function sameFills(a: FillLite[], b: FillLite[]): boolean {
  return a.length === b.length && a.every((f, i) => sameColor(f, b[i]));
}

// Like sameFills: two distinct arrays with the same content are the SAME
// value for the user. Weight and alignment besides color -- two strokes of the
// same color but different thickness are not "the same stroke", and the
// panel must say "Mixed".
function sameStrokes(a: StrokeLite[], b: StrokeLite[]): boolean {
  return a.length === b.length
    && a.every((s, i) => s.weight === b[i].weight && s.align === b[i].align && sameColor(s.color, b[i].color));
}

// Compares a field across all selected nodes against the FIRST: as soon as
// one diverges the field is MIXED, and the rest of the nodes no longer matter (short
// circuit, no need to keep reading them). `eq` defaults to `Object.is`
// (numbers, strings, booleans); fills passes `sameFills` because two distinct
// arrays with the same content are the SAME value for the user.
// Generic over the ELEMENT and not just the field: x/y are not summarized from the raw
// node but from the origin of its frame (see below), which is another type.
function summarize<I, T>(items: readonly I[], get: (n: I) => T, eq: (a: T, b: T) => boolean = Object.is): OrMixed<T> {
  const value = get(items[0]);
  for (let i = 1; i < items.length; i++) {
    if (!eq(get(items[i]), value)) return MIXED;
  }
  return value;
}

// Summarizes the selection for the properties panel: for each field, the value
// common to all selected nodes or MIXED if it differs. null for an empty
// selection (or reduced to nothing because the ids no longer exist in the
// scene): the properties panel, in that case, stays empty/disabled.
export function selectionSummary(scene: SceneState, ids: readonly string[]): SelectionSummary | null {
  const nodes = ids.map((id) => scene.nodes.at(id)).filter((n): n is NodeLite => n !== undefined);
  if (nodes.length === 0) return null;
  // x/y are the origin of the FRAME, not the raw field of the node: for everything
  // that is not a group they are the same thing, for a group they are not (its x/y
  // are the translation it contributes to its children, see groups.ts::
  // frameOriginOf). Computed once here because two fields need them.
  const origins = nodes.map((n) => frameOriginOf(scene, n));
  return {
    count: nodes.length,
    name: summarize(nodes, (n) => n.name),
    kind: summarize(nodes, (n) => n.kind),
    visible: summarize(nodes, (n) => n.visible),
    opacity: summarize(nodes, (n) => n.opacity),
    x: summarize(origins, (o) => o.x),
    y: summarize(origins, (o) => o.y),
    width: summarize(nodes, (n) => n.width),
    height: summarize(nodes, (n) => n.height),
    rotation: summarize(nodes, (n) => n.rotation),
    cornerRadius: summarize(nodes, (n) => n.cornerRadius),
    fills: summarize(nodes, (n) => n.fills, sameFills),
    strokes: summarize(nodes, (n) => n.strokes, sameStrokes),
  };
}
