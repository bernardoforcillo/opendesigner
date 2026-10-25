import type { Op } from "../gen/opendesigner/v1/opendesigner_pb";
import { hitTestNode } from "../renderer/shapes";
import { META_NEXT } from "../store/threads";
import { subtreeOf, childrenOf } from "../store/tree";
import { toPbNode, type PageLite, type SceneState } from "../store/types";
import { makeCreateNodeOp, makeCreatePageWithMasterOp, makeMovePageOp, makeUpdatePageOp, uuid } from "./ops";

// PAGE STRUCTURE GESTURES: each returns the ops of ONE gesture (one undo step).

/** `p` without any link to the master `id` (its master, its left-hand master). */
const unlinked = (p: PageLite, id: string): PageLite => {
  const { masterId, leftMasterId, ...rest } = p;
  return { ...rest, ...(masterId && masterId !== id ? { masterId } : {}), ...(leftMasterId && leftMasterId !== id ? { leftMasterId } : {}) };
};

/** Updates that detach every page (and master based on it) from the master `id`, so it can go or stop being a master. */
export function detachMasterOps(pages: readonly PageLite[], id: string): Op[] {
  return pages.filter((p) => p.masterId === id || p.leftMasterId === id).map((p) => makeUpdatePageOp(unlinked(p, id)));
}

/**
 * A copy of page `pageId` right after it: the same sheet, master and guides, a copy of every node under
 * it (new ids; a text thread inside the page stays linked in the copy), named "<name> copy". `newId` is
 * the id of the new page.
 */
export function duplicatePageOps(scene: SceneState, pageId: string, newId = uuid()): Op[] {
  const i = scene.pages.findIndex((p) => p.id === pageId);
  if (i < 0) return [];
  const src = scene.pages[i];
  const ops: Op[] = [makeCreatePageWithMasterOp(newId, `${src.name || "Page"} copy`, (({ id: _i, name: _n, ...rest }) => (void _i, void _n, rest))(src))];
  const ids = new Map<string, string>();
  const order: string[] = [];
  for (const root of childrenOf(scene, pageId)) for (const n of subtreeOf(scene, root.id)) { ids.set(n.id, uuid()); order.push(n.id); }
  for (const id of order) {
    const n = scene.nodes.get(id)!;
    const pb = toPbNode({ ...n, id: ids.get(id)!, parentId: n.parentId === pageId ? newId : ids.get(n.parentId) ?? newId });
    // A thread link to a frame inside the page follows the copy; one to a frame elsewhere is dropped.
    const next = n.meta?.[META_NEXT];
    if (next !== undefined) {
      if (ids.has(next)) pb.meta = { ...pb.meta, [META_NEXT]: ids.get(next)! };
      else { const { [META_NEXT]: _x, ...rest } = pb.meta; void _x; pb.meta = rest; }
    }
    ops.push(makeCreateNodeOp(pb));
  }
  ops.push(makeMovePageOp(newId, i + 1));
  return ops;
}

/** Moves page `pageId` by `delta` positions (-1 earlier, +1 later); [] when it cannot move. */
export function movePageBy(pages: readonly PageLite[], pageId: string, delta: number): Op[] {
  const i = pages.findIndex((p) => p.id === pageId);
  const to = i + delta;
  if (i < 0 || to < 0 || to >= pages.length) return [];
  return [makeMovePageOp(pageId, to)];
}

/**
 * Overrides master item `itemId` on `page`: the page gets its own, editable copy of the item (and of
 * its children) and the master's one stops being drawn there. `itemId` is the id of the item on the
 * MASTER, not of the derived copy.
 */
export function overrideMasterItemOps(scene: SceneState, page: PageLite, masterNodeId: string): Op[] {
  const root = scene.nodes.get(masterNodeId);
  if (!root || page.isMaster) return [];
  const ids = new Map<string, string>();
  const subtree = subtreeOf(scene, masterNodeId);
  for (const n of subtree) ids.set(n.id, uuid());
  const ops: Op[] = [makeUpdatePageOp({ ...page, hiddenMasterItems: [...(page.hiddenMasterItems ?? []), masterNodeId] })];
  for (const n of subtree) {
    ops.push(makeCreateNodeOp(toPbNode({ ...n, id: ids.get(n.id)!, parentId: n.id === masterNodeId ? page.id : ids.get(n.parentId)!, fromMaster: undefined })));
  }
  return ops;
}

/** The id on the master of the top-level master item drawn at the world point (x, y) of page `pageId`, front-most first. */
export function masterItemAt(scene: SceneState, pageId: string, x: number, y: number, zoom: number): string | null {
  const copies = childrenOf(scene, pageId).filter((n) => n.fromMaster && n.visible);
  for (let i = copies.length - 1; i >= 0; i--) {
    if (hitTestNode(copies[i], x, y, zoom)) return copies[i].id.slice(pageId.length + 1);
  }
  return null;
}

/** The id of the node a createNode op creates ("" for any other op). */
export function creatingId(op: Op): string {
  return op.kind.case === "createNode" ? op.kind.value.node?.id ?? "" : "";
}
