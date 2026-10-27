import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { isValidObjectStyleId, styleFromNode } from "@/store/graphics";
import { OBJECT_STYLE_PROPS, type NodeLite, type ObjectStyleLite, type ObjectStyleProp, type SceneState } from "@/store/types";
import { makeDeleteObjectStyleDefOp, makeSetObjectStyleDefOp, makeSetPropsOp, uuid } from "@/tools/ops";

// OBJECT STYLES as ops (store/graphics.ts): a named look for shapes that can be applied to many and redefined once.

/** Nodes that can take an object style: every shape (not groups or instances). */
export const stylable = (n: NodeLite | undefined): n is NodeLite => !!n && n.kind !== "group" && n.kind !== "instance";

/** Applies the object style `styleId` (null = detach) to `ids`; the nodes keep their own values as the fallback. */
export function applyObjectStyleOps(scene: SceneState, ids: readonly string[], styleId: string | null): Op[] {
  if (styleId !== null && !scene.objectStyles[styleId]) return [];
  return ids.flatMap((id) => {
    const n = scene.nodes.get(id);
    if (!stylable(n) || !isValidObjectStyleId(scene, n, styleId ?? "") || (n.objectStyleId ?? null) === styleId) return [];
    return [makeSetPropsOp(id, { objectStyleId: styleId ?? "" }, ["object_style_id"])];
  });
}

/** A new object style from the look of `nodeId` (all of `props`), applied to that node. */
export function createObjectStyleOps(scene: SceneState, nodeId: string, name: string, props: readonly ObjectStyleProp[] = OBJECT_STYLE_PROPS): { ops: Op[]; id: string } | null {
  const n = scene.nodes.get(nodeId);
  if (!stylable(n) || props.length === 0) return null;
  const id = uuid();
  const def: ObjectStyleLite = { id, name, ...styleFromNode(n, props) };
  return { id, ops: [makeSetObjectStyleDefOp(def), ...applyObjectStyleOps({ ...scene, objectStyles: { ...scene.objectStyles, [id]: def } }, [nodeId], id)] };
}

/** Redefines style `styleId` from the look of `nodeId` (keeping the set of properties the style already sets). */
export function redefineObjectStyleOps(scene: SceneState, styleId: string, nodeId: string): Op[] {
  const cur = scene.objectStyles[styleId];
  const n = scene.nodes.get(nodeId);
  if (!cur || !stylable(n)) return [];
  const { sets, ...values } = styleFromNode(n, cur.sets);
  void sets;
  return [makeSetObjectStyleDefOp({ id: cur.id, name: cur.name, sets: cur.sets, ...(cur.basedOn ? { basedOn: cur.basedOn } : {}), ...values })];
}

/** One edit of a style: name, which properties it sets, what it is based on. */
export function updateObjectStyleOps(scene: SceneState, styleId: string, patch: Partial<Pick<ObjectStyleLite, "name" | "sets" | "basedOn">>): Op[] {
  const cur = scene.objectStyles[styleId];
  if (!cur) return [];
  const next: ObjectStyleLite = { ...cur, ...patch };
  if (patch.basedOn === "") delete next.basedOn;
  return [makeSetObjectStyleDefOp(next)];
}

export const deleteObjectStyleOps = (scene: SceneState, styleId: string): Op[] => (scene.objectStyles[styleId] ? [makeDeleteObjectStyleDefOp(styleId)] : []);
