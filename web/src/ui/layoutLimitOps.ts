import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { LayoutPositioning } from "../gen/opendesigner/v1/opendesigner_pb";
import { makeSetPropsOp } from "../tools/ops";
import type { NodeLite, SceneState } from "../store/types";

// The ops of the SIZE LIMITS (min/max width and height, clamped by the auto layout engine)
// and of ABSOLUTE positioning (a child that leaves its auto layout parent's flow). Pure: they
// read a scene and build ops, the panel submits them as one gesture.

export type LimitField = "minWidth" | "maxWidth" | "minHeight" | "maxHeight";
const LIMIT_PATH = { minWidth: "min_width", maxWidth: "max_width", minHeight: "min_height", maxHeight: "max_height" } as const;

/** The limit of every node, 0 for none, or undefined when they differ. */
export function limitOf(nodes: readonly NodeLite[], field: LimitField): number | undefined {
  const values = nodes.map((n) => n[field] ?? 0);
  return values.every((v) => v === values[0]) ? values[0] : undefined;
}

/** Sets a size limit (0 clears it) on the nodes whose limit differs. */
export function limitOps(scene: SceneState, ids: readonly string[], field: LimitField, value: number): Op[] {
  const v = Number.isFinite(value) && value > 0 ? value : 0;
  return ids.flatMap((id) => {
    const n = scene.nodes.at(id);
    if (!n || (n[field] ?? 0) === v) return [];
    return [makeSetPropsOp(id, { [field]: v }, [LIMIT_PATH[field]])];
  });
}

export function positioningOf(nodes: readonly NodeLite[]): "auto" | "absolute" | undefined {
  const values = nodes.map((n) => (n.layoutPositioning === "absolute" ? "absolute" : "auto") as "auto" | "absolute");
  return values.every((v) => v === values[0]) ? values[0] : undefined;
}

/** Takes the nodes out of the auto layout flow (absolute) or puts them back (auto). */
export function positioningOps(scene: SceneState, ids: readonly string[], value: "auto" | "absolute"): Op[] {
  const pb = value === "absolute" ? LayoutPositioning.ABSOLUTE : LayoutPositioning.AUTO;
  return ids.flatMap((id) => {
    const n = scene.nodes.at(id);
    if (!n || positioningOf([n]) === value) return [];
    return [makeSetPropsOp(id, { layoutPositioning: pb }, ["layout_positioning"])];
  });
}
