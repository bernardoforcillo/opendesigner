import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { detachInstance, pageOf, resetInstance, swapInstance, swapSize } from "../store/instanceOps";
import { effectiveComponentId } from "../store/components";
import { useScene } from "../store/store";
import { topmostOf } from "../store/tree";
import { toPbNode, type SceneState } from "../store/types";
import { makeCreateNodeOp, makeDeleteOp, makeSetInstanceOp, makeSetInstanceOverrideOp, makeSetPropsOp, uuid } from "./ops";

// The editor's instance commands: swap the component an instance points to, reset its
// overrides (all, or one master node), detach it into plain nodes and go to its main
// component. The ops are built by the pure functions (tested); the actions below submit
// them as ONE gesture each, so every command is one undo step.

const instanceIds = (scene: SceneState, ids: readonly string[]) =>
  topmostOf(scene, ids).filter((id) => scene.nodes.at(id)?.kind === "instance");

/** Swaps the instances among `ids` to `componentId`, keeping the overrides that still fit, and resizes them to the new master. */
export function swapInstanceOps(scene: SceneState, ids: readonly string[], componentId: string): Op[] {
  return instanceIds(scene, ids).flatMap((id) => {
    const n = scene.nodes.at(id)!;
    const next = swapInstance(scene, id, componentId);
    if (!next || (n.instance?.componentId === componentId)) return [];
    const ops = [makeSetInstanceOp(id, next)];
    const size = swapSize(scene, next);
    if (size && (size.width !== n.width || size.height !== n.height)) ops.push(makeSetPropsOp(id, size, ["width", "height"]));
    return ops;
  });
}

/** Clears every override, property value and variant choice of the instances, or just the override on `masterNodeId`. */
export function resetInstanceOps(scene: SceneState, ids: readonly string[], masterNodeId?: string): Op[] {
  return instanceIds(scene, ids).flatMap((id) => {
    const inst = scene.nodes.at(id)!.instance!;
    if (masterNodeId !== undefined) {
      return inst.overrides.some((o) => o.masterNodeId === masterNodeId) ? [makeSetInstanceOverrideOp(id, { masterNodeId })] : [];
    }
    const empty = inst.overrides.length === 0 && !Object.keys(inst.propertyValues ?? {}).length && !Object.keys(inst.variantProps ?? {}).length;
    const next = resetInstance(scene, id);
    return empty || !next ? [] : [makeSetInstanceOp(id, next)];
  });
}

/** Detaches the instances among `ids`: each is deleted and the master it renders is copied in its place under the same id. */
export function detachInstanceOps(scene: SceneState, ids: readonly string[]): Op[] {
  return instanceIds(scene, ids).flatMap((id) => {
    const nodes = detachInstance(scene, id, uuid);
    return nodes ? [makeDeleteOp(id), ...nodes.map((n) => makeCreateNodeOp(toPbNode(n)))] : [];
  });
}

/** Where "go to main component" lands: the master's root and its page, or null. */
export function mainComponentOf(scene: SceneState, id: string): { rootId: string; pageId: string } | null {
  const inst = scene.nodes.at(id)?.instance;
  const root = inst ? scene.components[effectiveComponentId(scene, inst)]?.rootNodeId : undefined;
  return root && scene.nodes.at(root) ? { rootId: root, pageId: pageOf(scene, root) } : null;
}

function run(ops: Op[]): boolean {
  if (ops.length === 0) return false;
  const store = useScene.getState();
  store.beginGesture();
  store.endGesture(ops);
  return true;
}

export const swapSelectedInstances = (componentId: string): boolean => {
  const { scene, selection } = useScene.getState();
  return !!scene && run(swapInstanceOps(scene, selection, componentId));
};
export const resetSelectedInstances = (masterNodeId?: string): boolean => {
  const { scene, selection } = useScene.getState();
  return !!scene && run(resetInstanceOps(scene, selection, masterNodeId));
};
export const detachSelectedInstances = (): boolean => {
  const { scene, selection } = useScene.getState();
  return !!scene && run(detachInstanceOps(scene, selection));
};

/** Selects the master of the selected instance, switching to its page. */
export function goToMainComponent(): boolean {
  const store = useScene.getState();
  const scene = store.scene;
  const id = store.selection.length === 1 ? store.selection[0] : undefined;
  const main = scene && id ? mainComponentOf(scene, id) : null;
  if (!main) return false;
  if (main.pageId && main.pageId !== store.currentPageId) store.setCurrentPage(main.pageId);
  store.setSelection([main.rootId]);
  return true;
}
