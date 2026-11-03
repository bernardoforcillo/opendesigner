import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { swatchColor } from "@/store/graphics";
import type { FillLite, GradientLite, NodeLite, PaintStyleDefLite, SceneState } from "@/store/types";
import { makeSetPaintStyleDefOp, uuid } from "@/tools/ops";
import { applyPaintStyleOps, deletePaintStyleOps } from "@/ui/styleOps";

// GRADIENT SWATCHES. A gradient swatch is a shared PAINT STYLE (proto PaintStyleDef) whose paint is a gradient: it
// is listed with the swatches, applied to a fill or a stroke by the same style mechanism, and editing the style changes
// everything that uses it. Stops made from colour swatches take the swatch's colour AT THE TIME: they do not follow
// later edits of the swatch (the model keeps no swatch reference on a gradient stop). See docs/color-management.md.

const MAX_NAME = 80;

/** True for a paint style whose first paint is a gradient. */
export const isGradientSwatch = (d: PaintStyleDefLite): boolean => !!d.paints[0]?.gradient;

/** The document's gradient swatches, by name. */
export function gradientSwatchesOf(scene: Pick<SceneState, "paintStyles">): PaintStyleDefLite[] {
  return Object.values(scene.paintStyles).filter(isGradientSwatch).sort((a, b) => a.name.localeCompare(b.name));
}

export interface GradientSwatchSpec {
  name: string;
  /** "linear" runs along `angle` (degrees, 0 = left to right, 90 = top to bottom); "radial" spreads from the middle. */
  kind?: "linear" | "radial";
  angle?: number;
  /** Two or more stops, in order. A stop is a colour swatch (its colour is copied) or a plain RGB colour. */
  stops: { swatchId?: string; rgb?: { r: number; g: number; b: number }; position?: number }[];
}

function geometry(kind: "linear" | "radial", angle: number): Pick<GradientLite, "x1" | "y1" | "x2" | "y2"> {
  if (kind === "radial") return { x1: 0.5, y1: 0.5, x2: 1, y2: 0.5 };
  const a = (angle * Math.PI) / 180, dx = Math.cos(a) / 2, dy = Math.sin(a) / 2;
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return { x1: r(0.5 - dx), y1: r(0.5 - dy), x2: r(0.5 + dx), y2: r(0.5 + dy) };
}

/** The ops that add a gradient swatch; null when the spec has fewer than two usable stops or a bad name. */
export function createGradientSwatchOps(scene: Pick<SceneState, "variables" | "collections">, spec: GradientSwatchSpec): { ops: Op[]; id: string } | null {
  const name = spec.name.trim();
  if (name === "" || name.length > MAX_NAME || spec.stops.length < 2) return null;
  const colors: { r: number; g: number; b: number }[] = [];
  for (const s of spec.stops) {
    const c = s.swatchId ? swatchColor(scene, s.swatchId) : s.rgb;
    if (!c) return null;
    colors.push({ r: c.r, g: c.g, b: c.b });
  }
  const last = colors.length - 1;
  const stops = colors.map((c, i) => ({
    color: { ...c, a: 1 },
    position: Math.min(1, Math.max(0, spec.stops[i]?.position ?? i / last)),
  }));
  const kind = spec.kind ?? "linear";
  const gradient: GradientLite = { kind, stops, ...geometry(kind, spec.angle ?? 0) };
  const first = stops[0]!.color;
  const paint: FillLite = { r: first.r, g: first.g, b: first.b, a: 1, gradient };
  const id = uuid();
  return { id, ops: [makeSetPaintStyleDefOp({ id, name, paints: [paint] })] };
}

/** A gradient swatch from the first fill of a node (null when that fill is not a gradient). It is not applied to the node. */
export function gradientSwatchFromNodeOps(node: NodeLite, name: string): { ops: Op[]; id: string } | null {
  const paint = node.fills[0];
  const n = name.trim();
  if (!paint?.gradient || n === "" || n.length > MAX_NAME) return null;
  const id = uuid();
  return { id, ops: [makeSetPaintStyleDefOp({ id, name: n, paints: [paint] })] };
}

export function renameGradientSwatchOps(scene: Pick<SceneState, "paintStyles">, id: string, name: string): Op[] {
  const d = scene.paintStyles[id];
  const n = name.trim();
  if (!d || !isGradientSwatch(d) || n === "" || n.length > MAX_NAME || n === d.name) return [];
  return [makeSetPaintStyleDefOp({ ...d, name: n })];
}

export function applyGradientSwatchOps(scene: SceneState, ids: readonly string[], target: "fill" | "stroke", id: string): Op[] {
  return scene.paintStyles[id] && isGradientSwatch(scene.paintStyles[id]) ? applyPaintStyleOps(scene, ids, target, id) : [];
}

export function deleteGradientSwatchOps(scene: SceneState, id: string): Op[] {
  const d = scene.paintStyles[id];
  return d && isGradientSwatch(d) ? deletePaintStyleOps(scene, id) : [];
}

/** The CSS for a swatch's preview chip. */
export function gradientCss(d: PaintStyleDefLite): string {
  const g = d.paints[0]?.gradient;
  if (!g) return "transparent";
  const hex = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");
  const list = g.stops.map((s) => `#${hex(s.color.r)}${hex(s.color.g)}${hex(s.color.b)} ${Math.round(s.position * 100)}%`).join(", ");
  if (g.kind === "radial") return `radial-gradient(circle, ${list})`;
  const deg = Math.round((Math.atan2(g.y2 - g.y1, g.x2 - g.x1) * 180) / Math.PI + 90);
  return `linear-gradient(${deg}deg, ${list})`;
}
