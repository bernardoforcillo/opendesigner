import type { EffectStyleDef as PbEffectStyleDef, PaintStyleDef as PbPaintStyleDef } from "@/gen/opendesigner/v1/opendesigner_pb";
import { arePaintsValid } from "@/store/paints";
import type { NodeLite, SceneState } from "@/store/types";

// The TS half of internal/core/styles.go: shared PAINT styles and EFFECT styles. A node names one with
// fillStyleId / strokeStyleId / effectStyleId and draws with the style's values (resolved at read time,
// like text styles); its own fills / strokes / effects stay as the fallback. Docs: docs/shapes.md.

/** Parity with core.validatePaintStyleDef. */
export function isValidPaintStyleDef(d: PbPaintStyleDef | undefined): d is PbPaintStyleDef {
  return !!d && d.id !== "" && d.name !== "" && d.paints.length > 0 && arePaintsValid(d.paints, []);
}

/** Parity with core.validateEffectStyleDef. */
export function isValidEffectStyleDef(d: PbEffectStyleDef | undefined): d is PbEffectStyleDef {
  return !!d && d.id !== "" && d.name !== "";
}

/** Parity with core.checkStyleId: empty detaches, otherwise the style must exist in the right map. */
export function isValidStyleId(state: SceneState, path: string, id: string): boolean {
  if (id === "") return true;
  return path === "effect_style_id" ? !!state.effectStyles[id] : !!state.paintStyles[id];
}

/** The mask paths that name a shared style. */
export const STYLE_PATHS: ReadonlySet<string> = new Set(["fill_style_id", "stroke_style_id", "effect_style_id"]);

/** True when the node names a shared paint or effect style. */
export const usesPaintStyle = (n: NodeLite): boolean => !!n.fillStyleId || !!n.strokeStyleId || !!n.effectStyleId;

/** `n` with its shared paint / effect styles applied (parity with core.resolvePaintStyles). */
export function resolvePaintStylesNode(state: SceneState, n: NodeLite): NodeLite {
  if (!usesPaintStyle(n)) return n;
  const fill = n.fillStyleId ? state.paintStyles[n.fillStyleId] : undefined;
  const stroke = n.strokeStyleId ? state.paintStyles[n.strokeStyleId] : undefined;
  const eff = n.effectStyleId ? state.effectStyles[n.effectStyleId] : undefined;
  if (!fill && !stroke && !eff) return n;
  const out: NodeLite = { ...n };
  if (fill) out.fills = fill.paints;
  if (stroke && stroke.paints.length > 0) {
    out.strokes = n.strokes.map((s, i) => ({ ...s, color: stroke.paints[Math.min(i, stroke.paints.length - 1)] }));
  }
  if (eff) {
    if (eff.effects.length > 0) out.effects = eff.effects; else delete out.effects;
  }
  return out;
}

/** The nodes that name style `id` (a paint style on a fill or a stroke, or an effect style), with the id cleared. */
export function unstyleNodesByPaint(state: SceneState, id: string, kind: "paint" | "effect"): SceneState["nodes"] {
  let edit: ReturnType<SceneState["nodes"]["edit"]> | null = null;
  for (const n of state.nodes.values()) {
    const hit = kind === "effect" ? n.effectStyleId === id : n.fillStyleId === id || n.strokeStyleId === id;
    if (!hit) continue;
    const next: NodeLite = { ...n };
    if (kind === "effect") delete next.effectStyleId;
    else {
      if (next.fillStyleId === id) delete next.fillStyleId;
      if (next.strokeStyleId === id) delete next.strokeStyleId;
    }
    (edit ??= state.nodes.edit()).set(n.id, next);
  }
  return edit ? edit.done() : state.nodes;
}
