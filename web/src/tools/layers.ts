import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import type { LayerLite, SceneState } from "@/store/types";
import { makeDeleteLayerOp, makeSetLayerOp, makeSetPropsOp, uuid } from "@/tools/ops";

// LAYERS as ops (store/graphics.ts). Layers span all pages: put nodes on one, then hide or lock it for everything at once.

export const MAX_LAYERS = 200;

export function createLayerOps(scene: SceneState, name?: string): { ops: Op[]; id: string } | null {
  if (scene.layers.length >= MAX_LAYERS) return null;
  const id = uuid();
  return { id, ops: [makeSetLayerOp({ id, name: name ?? `Layer ${scene.layers.length + 1}` })] };
}

/** One edit of a layer: name, hidden, locked, no_print. */
export function updateLayerOps(scene: SceneState, id: string, patch: Partial<Omit<LayerLite, "id">>): Op[] {
  const cur = scene.layers.find((l) => l.id === id);
  if (!cur) return [];
  const next: LayerLite = { ...cur, ...patch };
  for (const k of ["hidden", "locked", "noPrint"] as const) if (!next[k]) delete next[k];
  return [makeSetLayerOp(next)];
}

export const deleteLayerOps = (scene: SceneState, id: string): Op[] => (scene.layers.some((l) => l.id === id) ? [makeDeleteLayerOp(id)] : []);

/** Puts nodes on a layer (null = on none). */
export function moveToLayerOps(scene: SceneState, ids: readonly string[], layerId: string | null): Op[] {
  if (layerId !== null && !scene.layers.some((l) => l.id === layerId)) return [];
  return ids.flatMap((id) => {
    const n = scene.nodes.get(id);
    return n && (n.layerId ?? null) !== layerId ? [makeSetPropsOp(id, { layerId: layerId ?? "" }, ["layer_id"])] : [];
  });
}

/** The layer every node of `ids` is on: its id, null when none is on one, undefined when they differ. */
export function layerOf(scene: SceneState, ids: readonly string[]): string | null | undefined {
  let seen: string | null | undefined;
  for (const id of ids) {
    const v = scene.nodes.get(id)?.layerId ?? null;
    if (seen === undefined) seen = v; else if (seen !== v) return undefined;
  }
  return seen ?? null;
}
