import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { makeDeleteEffectStyleDefOp, makeDeletePaintStyleDefOp, makeSetEffectStyleDefOp, makeSetPaintStyleDefOp, makeSetPropsOp, uuid } from "@/tools/ops";
import { toPbEffects, toPbFills, toPbStrokes } from "@/store/types";
import type { NodeLite, SceneState } from "@/store/types";
import type { NodeLookup } from "@/ui/gradientOps";

// The panel's ops for SHARED PAINT AND EFFECT STYLES (docs/shapes.md; the text-style flow's twin). A style is
// a named list of paints (used by fills or strokes) or of effects; a node that names one draws with it and
// keeps its own values as the fallback. Detaching writes the style's values into the node, so what is drawn
// does not change.

export type PaintTarget = "fill" | "stroke";

/** The id of the paint style a node uses for `target`, or undefined. */
export const paintStyleIdOf = (n: NodeLite | undefined, target: PaintTarget): string | undefined =>
  (target === "fill" ? n?.fillStyleId : n?.strokeStyleId) || undefined;

const path = (target: PaintTarget) => (target === "fill" ? "fill_style_id" : "stroke_style_id") as "fill_style_id" | "stroke_style_id";
const field = (target: PaintTarget) => (target === "fill" ? "fillStyleId" : "strokeStyleId") as "fillStyleId" | "strokeStyleId";

/** A new paint style from the node's fills (or strokes' paints), applied to that node. null when it has no paints. */
export function createPaintStyleOps(node: NodeLite, target: PaintTarget, name: string): { id: string; ops: Op[] } | null {
  const paints = target === "fill" ? node.fills : node.strokes.map((s) => s.color);
  if (paints.length === 0) return null;
  const id = uuid();
  return {
    id,
    ops: [
      makeSetPaintStyleDefOp({ id, name, paints: [...paints] }),
      makeSetPropsOp(node.id, { [field(target)]: id }, [path(target)]),
    ],
  };
}

/** Applies the paint style `styleId` ("" detaches, keeping what is drawn) to `ids`. */
export function applyPaintStyleOps(scene: SceneState, ids: readonly string[], target: PaintTarget, styleId: string): Op[] {
  const def = styleId === "" ? undefined : scene.paintStyles[styleId];
  if (styleId !== "" && !def) return [];
  return ids.flatMap((id) => {
    const n = scene.nodes.at(id);
    if (!n) return [];
    const cur = paintStyleIdOf(n, target) ?? "";
    if (cur === styleId) return [];
    if (def) return [makeSetPropsOp(id, { [field(target)]: styleId }, [path(target)])];
    // Detach: copy the style's paints into the node first.
    const old = scene.paintStyles[cur];
    if (!old) return [makeSetPropsOp(id, { [field(target)]: "" }, [path(target)])];
    if (target === "fill") return [makeSetPropsOp(id, { fills: toPbFills(old.paints), fillStyleId: "" }, ["fills", "fill_style_id"])];
    const strokes = n.strokes.map((s, i) => ({ ...s, color: old.paints[Math.min(i, old.paints.length - 1)] }));
    return [makeSetPropsOp(id, { strokes: toPbStrokes(strokes), strokeStyleId: "" }, ["strokes", "stroke_style_id"])];
  });
}

/** Deletes a paint style (the server clears it from the nodes that used it; they keep their own paints). */
export function deletePaintStyleOps(scene: SceneState, styleId: string): Op[] {
  return scene.paintStyles[styleId] ? [makeDeletePaintStyleDefOp(styleId)] : [];
}

// ---------- effect styles ----------

/** A new effect style from the node's effects, applied to that node. */
export function createEffectStyleOps(node: NodeLite, name: string): { id: string; ops: Op[] } | null {
  if (!node.effects || node.effects.length === 0) return null;
  const id = uuid();
  return {
    id,
    ops: [
      makeSetEffectStyleDefOp({ id, name, effects: [...node.effects] }),
      makeSetPropsOp(node.id, { effectStyleId: id }, ["effect_style_id"]),
    ],
  };
}

/** Applies the effect style `styleId` ("" detaches, keeping the effects that were drawn). */
export function applyEffectStyleOps(scene: SceneState, ids: readonly string[], styleId: string): Op[] {
  const def = styleId === "" ? undefined : scene.effectStyles[styleId];
  if (styleId !== "" && !def) return [];
  return ids.flatMap((id) => {
    const n = scene.nodes.at(id);
    if (!n) return [];
    const cur = n.effectStyleId ?? "";
    if (cur === styleId) return [];
    if (def) return [makeSetPropsOp(id, { effectStyleId: styleId }, ["effect_style_id"])];
    const old = scene.effectStyles[cur];
    if (!old) return [makeSetPropsOp(id, { effectStyleId: "" }, ["effect_style_id"])];
    return [makeSetPropsOp(id, { effects: toPbEffects(old.effects), effectStyleId: "" }, ["effects", "effect_style_id"])];
  });
}

/** Deletes an effect style. */
export function deleteEffectStyleOps(scene: SceneState, styleId: string): Op[] {
  return scene.effectStyles[styleId] ? [makeDeleteEffectStyleDefOp(styleId)] : [];
}

export type { NodeLookup };
