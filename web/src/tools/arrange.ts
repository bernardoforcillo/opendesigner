import type { Op } from "@/gen/opendesigner/v1/opendesigner_pb";
import { orderKeyBetween } from "@/store/orderKey";
import { useScene } from "@/store/store";
import { childrenOf, topmostOf } from "@/store/tree";
import type { SceneState } from "@/store/types";
import { makeSetPropsOp } from "@/tools/ops";

// ARRANGE: bring the selection forward / backward one step, or to the front / back, among its
// siblings. The draw order IS the order key (ascending = background to foreground), so every move
// is a `order_key` write on the nodes that moved -- the same path the layers panel's drag uses.
// Selected nodes in different parents are each arranged in their own parent.

export type ArrangeMode = "front" | "forward" | "backward" | "back";

interface Slot { id: string; key: string }

const tryBetween = (a: string | null, b: string | null): string | null => {
  try { return orderKeyBetween(a, b); } catch { return null; }
};

/** The ops that arrange `ids` in their parents; nothing when they cannot move any further. */
export function arrangeOps(scene: SceneState, ids: readonly string[], mode: ArrangeMode): Op[] {
  const byParent = new Map<string, string[]>();
  for (const id of topmostOf(scene, ids)) {
    const n = scene.nodes.at(id);
    if (!n) continue;
    byParent.set(n.parentId, [...(byParent.get(n.parentId) ?? []), id]);
  }
  const ops: Op[] = [];
  for (const [parentId, picked] of byParent) {
    const sel = new Set(picked);
    const list: Slot[] = childrenOf(scene, parentId).map((c) => ({ id: c.id, key: c.orderKey }));
    const moved = new Set<string>();
    const set = (s: Slot, key: string | null): boolean => {
      if (key === null) return false;
      s.key = key;
      moved.add(s.id);
      return true;
    };
    if (mode === "front" || mode === "back") {
      // Already a block at that end: nothing to do.
      const flags = list.map((s) => sel.has(s.id));
      const count = picked.length;
      if (mode === "front" ? flags.slice(list.length - count).every(Boolean) : flags.slice(0, count).every(Boolean)) continue;
      const mine = list.filter((s) => sel.has(s.id));
      if (mode === "front") {
        let top = list[list.length - 1]?.key ?? null;
        for (const s of mine) { if (set(s, tryBetween(top, null))) top = s.key; }
      } else {
        let bottom = list[0]?.key ?? null;
        for (const s of [...mine].reverse()) { if (set(s, tryBetween(null, bottom))) bottom = s.key; }
      }
    } else if (mode === "forward") {
      for (let i = list.length - 2; i >= 0; i--) {
        if (!sel.has(list[i].id) || sel.has(list[i + 1].id)) continue;
        // Jump over the next sibling: land between it and the one after it.
        const over = list[i + 1];
        const key = tryBetween(over.key, list[i + 2]?.key ?? null);
        if (key === null) continue;
        const me = list[i];
        list[i] = over;
        list[i + 1] = me;
        set(me, key);
      }
    } else {
      for (let i = 1; i < list.length; i++) {
        if (!sel.has(list[i].id) || sel.has(list[i - 1].id)) continue;
        const over = list[i - 1];
        const key = tryBetween(list[i - 2]?.key ?? null, over.key);
        if (key === null) continue;
        const me = list[i];
        list[i] = over;
        list[i - 1] = me;
        set(me, key);
      }
    }
    for (const id of picked) {
      const slot = list.find((s) => s.id === id);
      if (slot && moved.has(id)) ops.push(makeSetPropsOp(id, { orderKey: slot.key }, ["order_key"]));
    }
  }
  return ops;
}

/** Arranges the current selection as ONE gesture (one undo step). False when nothing moved. */
export function arrangeSelection(mode: ArrangeMode): boolean {
  const store = useScene.getState();
  if (!store.scene) return false;
  const ops = arrangeOps(store.scene, store.selection, mode);
  if (ops.length === 0) return false;
  store.beginGesture();
  store.endGesture(ops);
  return true;
}
