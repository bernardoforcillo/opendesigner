import { type Bounds, boundsOfNode, inflateBounds, intersectBounds, unionBounds, worldVisualAabbOfNode } from "../canvas/geometry";
import { IDENTITY, type Transform, compose, localTransformOf, mapBounds, worldTransformOf } from "../canvas/transform";
import { contentWorldBounds } from "../store/groups";
import { bySiblingOrder, childIndexOf } from "../store/tree";
import { PEditor, PMap } from "../store/nodeMap";
import { deltaOf } from "../store/sceneDelta";
import type { NodeLite, SceneState } from "../store/types";

// THE SCENE INDEX: what the renderer knows about the document and that does not change
// as long as the document does not change.
//
// Before, every frame rebuilt the children index (a scan of the whole
// map and a sort per container) and drew EVERY node, visible or not. With
// 20,000 nodes that was ~140 ms per frame even with a single screen in view.
// The index moves that work to once per scene (scenes are immutable and
// rebuilt on every op, so the scene's identity is the cache key) and
// gives drawing and hit-test what they need to skip whole subtrees:
//
//   - `children`: the children by parent, already sorted (like childIndexOf);
//   - `extent`: for each visible node, the WORLD rectangle that covers EVERYTHING
//     the node draws together with its subtree. If it does not meet the view,
//     no pixel of that subtree can appear.
//
// `extent` is CONSERVATIVE: erring on the high side (drawing one node more) costs a
// little time, erring on the low side (skipping one that is seen) is a visible bug.
// For this reason it includes the overhangs of stroke, shadow and blur, and for text
// -- which overflows its own box and does not need a ctx to say so -- a
// generous estimate.
export interface SceneIndex {
  children: Map<string, NodeLite[]>;
  extent: PMap<Bounds>;
  // An identity token that changes ONLY when the STRUCTURE of the tree as
  // seen by whoever lists it changes: who sits where, in what order, and what a row
  // shows (name, type, visibility, text). A geometry-only or
  // paint-only change leaves the same token. The Layers panel recomputes its
  // rows -- 20,000 objects, for a large document -- only when needed,
  // instead of at every step of a drag.
  structure: object;
}

// Does a change to this node change what the Layers panel shows or how it
// sorts?
function structurallyDifferent(a: NodeLite | undefined, b: NodeLite | undefined): boolean {
  if (!a || !b) return true;
  return (
    a.parentId !== b.parentId || a.orderKey !== b.orderKey || a.visible !== b.visible ||
    a.name !== b.name || a.kind !== b.kind || a.text?.content !== b.text?.content
  );
}

const cache = new WeakMap<SceneState, SceneIndex>();
// The last indexed scene: the base on which the incremental update is tried.
// A single one, because the case that matters is the chain of scenes of a
// gesture (every op produces a new one from the previous one).
let last: { scene: SceneState; index: SceneIndex } | null = null;

export function sceneIndexOf(scene: SceneState): SceneIndex {
  let idx = cache.get(scene);
  if (idx) return idx;
  // The provenance recorded by applyOp says which nodes were touched: if
  // the starting scene has an index, comparing all nodes is avoided.
  const delta = deltaOf(scene);
  const base = delta ? cache.get(delta.prev) : undefined;
  if (delta && base) idx = updateIndex(delta.prev, base, scene, delta.changed) ?? undefined;
  if (!idx && last) idx = updateIndex(last.scene, last.index, scene) ?? undefined;
  if (!idx) idx = buildIndex(scene);
  cache.set(scene, idx);
  last = { scene, index: idx };
  return idx;
}

// The maximum deviation, beyond the box, with which a node paints: stroke (already in
// worldVisualAabbOfNode), shadow (offset + half the blur as deviation, ~3
// tail deviations) and layer blur (~3 deviations).
export function effectsOutset(n: NodeLite): number {
  if (!n.effects) return 0;
  let out = 0;
  let shadow = 0;
  let blurSeen = false;
  // Every drop shadow counts (the widest wins); inner shadows and background
  // blur stay inside the outline.
  for (const e of n.effects) {
    if (e.kind === "dropShadow") {
      shadow = Math.max(shadow, Math.max(Math.abs(e.offsetX), Math.abs(e.offsetY)) + e.blur * 1.5);
    } else if (e.kind === "layerBlur" && !blurSeen && e.radius > 0) {
      blurSeen = true;
      out += e.radius * 3;
    }
  }
  return out + shadow;
}

// Text is not clipped by its own box (renderer/text.ts::textPaintBounds),
// but measuring it needs a ctx. Here an upper bound is enough: lines estimated with a
// glyph 0.8 em wide, generous line spacing, and horizontal margin for
// words that are broken or right-aligned.
function textBox(n: NodeLite): Bounds {
  const t = n.text;
  const box = boundsOfNode(n);
  if (!t || t.content === "") return box;
  const size = Math.max(1, t.style.fontSize || 16);
  const chars = t.content.length;
  const newlines = (t.content.match(/\n/g) ?? []).length;
  const wrapWidth = Math.max(n.width, size);
  const lines = newlines + Math.ceil((chars * size * 0.8) / wrapWidth) + 1;
  const lineHeight = Math.max(size * 1.6, t.style.lineHeight > 0 ? t.style.lineHeight * 1.2 : 0);
  const xSlack = n.width < size * 2 ? chars * size * 0.8 : size * 2;
  return { x: box.x - xSlack, y: box.y, width: box.width + 2 * xSlack, height: Math.max(box.height, lines * lineHeight) };
}

// The rectangle, in the PARENT's space, that the node paints by itself.
function ownLocalBox(n: NodeLite): Bounds {
  const base = n.kind === "text" ? textBox(n) : null;
  const visual = worldVisualAabbOfNode(base ? { ...n, x: base.x, y: base.y, width: base.width, height: base.height } : n);
  return inflateBounds(visual, effectsOutset(n));
}

// The rectangle `n` covers given that of its children (already brought to the world):
// its own, plus the children. A group has nothing of its own, and a clipping
// FRAME counts the children only for the part inside it. null if it
// paints nothing.
function combine(n: NodeLite, parentWorld: Transform, kidExtents: Bounds[]): Bounds | null {
  const parts: Bounds[] = [];
  if (n.kind !== "group") parts.push(mapBounds(parentWorld, ownLocalBox(n)));
  if (n.kind === "frame" && n.clipsContent) {
    const own = parts[0];
    for (const kb of kidExtents) {
      const inside = intersectBounds(kb, own);
      if (inside) parts.push(inside);
    }
  } else {
    parts.push(...kidExtents);
  }
  return unionBounds(parts);
}

// Walks a subtree and writes its extents, zeroing those that
// no longer hold (a node made invisible, or now empty, must not leave an old
// extent: drawing would still draw it).
function makeVisitor(scene: SceneState, children: Map<string, NodeLite[]>, extent: PEditor<Bounds>) {
  const clear = (id: string) => {
    extent.delete(id);
    for (const k of children.get(id) ?? []) clear(k.id);
  };
  const seen = new Set<string>();
  const visit = (n: NodeLite, parentWorld: Transform): Bounds | null => {
    if (!n.visible || seen.has(n.id)) {
      clear(n.id);
      return null;
    }
    seen.add(n.id);

    // An INSTANCE has no children in `children`: its subtree is virtual, and
    // its extent is that of the master's content already brought to the world.
    if (n.kind === "instance") {
      const b = contentWorldBounds(scene, n);
      if (!b) {
        extent.delete(n.id);
        return null;
      }
      const padded = inflateBounds(b, effectsOutset(n));
      extent.set(n.id, padded);
      return padded;
    }

    const kids = children.get(n.id);
    const kidExtents: Bounds[] = [];
    if (kids && kids.length > 0) {
      const childWorld = compose(parentWorld, localTransformOf(n));
      for (const k of kids) {
        const kb = visit(k, childWorld);
        if (kb) kidExtents.push(kb);
      }
    }
    const u = combine(n, parentWorld, kidExtents);
    if (u) extent.set(n.id, u);
    else extent.delete(n.id);
    return u;
  };
  return visit;
}

export function buildIndex(scene: SceneState): SceneIndex {
  const children = childIndexOf(scene);
  const extent = PMap.emptyOf<Bounds>().edit();
  const visit = makeVisitor(scene, children, extent);
  for (const page of scene.pages) {
    for (const r of children.get(page.id) ?? []) visit(r, IDENTITY);
  }
  return { children, extent: extent.done(), structure: {} };
}

// --- AGGIORNAMENTO INCREMENTALE ------------------------------------------------
//
// A gesture (a drag, a resize) produces a new scene for every op, and
// almost entirely equal to the previous one: the UNtouched node objects have
// the same identity. Comparing them costs one pass over the map (a few ms even at
// 20,000 nodes), against rebuilding the whole index (tens of ms).
//
// ONLY what may have changed is recomputed: the different nodes with their
// subtree (if a frame is moved its descendants move), and the
// chain of ancestors (their union depends on the children). The children lists
// are copied only for the touched parents; `children` and `extent` are COPIES,
// because the previous scene's index may still be in use (undo, optimistic view
// against confirmed).
//
// Returns null when it is convenient -- or necessary -- to redo everything: too many nodes
// changed, different pages or components, or a change inside a
// component's master (the instances' extents depend on it).
const INCREMENTAL_MAX_FRACTION = 0.05;
const INCREMENTAL_MIN_LIMIT = 64;

function updateIndex(
  prevScene: SceneState,
  prev: SceneIndex,
  scene: SceneState,
  hint?: readonly string[],
): SceneIndex | null {
  if (prevScene.pages !== scene.pages || prevScene.components !== scene.components) return null;
  const prevNodes = prevScene.nodes;
  const nodes = scene.nodes;

  const changed: string[] = [];
  const removed: string[] = [];
  if (hint) {
    // With provenance the map is not scanned: the candidates are the touched
    // nodes (those that stayed identical do not count), and no node is removed.
    const limit = Math.max(INCREMENTAL_MIN_LIMIT, Math.floor(prev.extent.size * INCREMENTAL_MAX_FRACTION));
    if (hint.length > limit) return null;
    // An id may appear MORE THAN ONCE in the provenance: creating a node inside a
    // frame with auto layout records it as "touched by the op" and again as
    // "rearranged by layout". Processing it twice inserted the child twice
    // in the parent's list and lost its extent -- a text inside a button
    // vanished from the drawing until the document was reloaded.
    const seenHint = new Set<string>();
    for (const id of hint) {
      if (seenHint.has(id)) continue;
      seenHint.add(id);
      if (nodes.at(id) && prevNodes.at(id) !== nodes.at(id)) changed.push(id);
    }
  } else {
    // The comparison skips the map's buckets with the same identity: it costs
    // as much as the touched buckets, not as the document.
    const limit = Math.max(INCREMENTAL_MIN_LIMIT, Math.floor(nodes.size * INCREMENTAL_MAX_FRACTION));
    if (!nodes.diff(prevNodes, changed, removed, limit)) return null;
  }
  if (changed.length === 0 && removed.length === 0) return prev;
  const structural = removed.length > 0 || changed.some((id) => structurallyDifferent(prevNodes.at(id), nodes.at(id)));

  // A change inside a component master's subtree moves the instances'
  // extents: redo everything.
  const rootIds = Object.values(scene.components).map((c) => c.rootNodeId);
  if (rootIds.length > 0) {
    const roots = new Set(rootIds);
    for (const id of [...changed, ...removed]) {
      const base = nodes.at(id) ?? prevNodes.at(id);
      for (let cur: NodeLite | undefined = base, g = 0; cur && g < 1000; cur = (nodes.at(cur.parentId) ?? prevNodes.at(cur.parentId)), g++) {
        if (roots.has(cur.id)) return null;
      }
    }
  }

  // The children lists: copies only of the touched parents. A changed node may have
  // changed parent or key (it is repositioned), or only geometry (the
  // object is replaced at the same position).
  const children = new Map(prev.children);
  const touched = new Map<string, NodeLite[]>(); // parentId -> lista copiata (mutabile)
  const listOf = (parentId: string): NodeLite[] => {
    let l = touched.get(parentId);
    if (!l) {
      l = [...(prev.children.get(parentId) ?? [])];
      touched.set(parentId, l);
    }
    return l;
  };
  const dropFrom = (parentId: string, id: string) => {
    const l = listOf(parentId);
    const i = l.findIndex((x) => x.id === id);
    if (i >= 0) l.splice(i, 1);
  };
  const insertInto = (parentId: string, n: NodeLite) => {
    const l = listOf(parentId);
    let lo = 0;
    let hi = l.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bySiblingOrder(l[mid], n) < 0) lo = mid + 1;
      else hi = mid;
    }
    l.splice(lo, 0, n);
  };
  for (const id of removed) dropFrom(prevNodes.at(id).parentId, id);
  for (const id of changed) {
    const before = prevNodes.at(id);
    const after = nodes.at(id);
    if (before) dropFrom(before.parentId, id);
    insertInto(after.parentId, after);
  }
  for (const [pid, list] of touched) {
    if (list.length === 0) children.delete(pid);
    else children.set(pid, list);
  }

  const extent = prev.extent.edit();
  for (const id of removed) extent.delete(id);

  const worldOf = (parentId: string): Transform => worldTransformOf(scene, parentId);
  const visit = makeVisitor(scene, children, extent);
  // Like the full construction, which starts from the pages and does not enter a
  // hidden subtree: a node sitting under a hidden ancestor, or not
  // reachable from any page (a component master), has no extent.
  const pageIds = new Set(scene.pages.map((p) => p.id));
  const drawn = (n: NodeLite): boolean => {
    for (let cur: NodeLite | undefined = n, g = 0; cur && g < 1000; cur = nodes.at(cur.parentId), g++) {
      if (!cur.visible) return false;
      if (pageIds.has(cur.parentId)) return true;
    }
    return false;
  };
  const clearTree = (id: string) => {
    extent.delete(id);
    for (const k of children.get(id) ?? []) clearTree(k.id);
  };
  // 1) Subtrees of the changed nodes (their transform may be new).
  //
  // Shallowest first. A changed node under another changed one is covered by its
  // ancestor's visit, but only if the ancestor is processed FIRST: the other way
  // round the child is visited twice, and the visitor treats the second visit as a
  // cycle (it has already `seen` the node) and clears its extent -- the node stops
  // being drawn. The provenance does not promise any order (a derived scene lists
  // the nodes it replaced as it found them).
  const depthIn = (id: string): number => {
    let d = 0;
    for (let cur: NodeLite | undefined = nodes.at(id); cur && d < 1000; cur = nodes.at(cur.parentId)) d++;
    return d;
  };
  changed.sort((a, b) => depthIn(a) - depthIn(b));
  const redone = new Set<string>();
  for (const id of changed) {
    // Already redone as a descendant of another changed one? A node under a
    // changed one is revisited by it anyway: skip.
    let covered = false;
    for (let cur = nodes.at(nodes.at(id).parentId), g = 0; cur && g < 1000; cur = nodes.at(cur.parentId), g++) {
      if (redone.has(cur.id)) { covered = true; break; }
    }
    if (covered) continue;
    redone.add(id);
    if (drawn(nodes.at(id))) visit(nodes.at(id), worldOf(nodes.at(id).parentId));
    else clearTree(id);
  }
  // The touched ancestors: of the changed ones, of the removed ones and of the OLD parents of whoever
  // moved. From the deepest, with the children's union already in cache.
  const up = new Set<string>();
  const addChain = (startParentId: string) => {
    for (let cur = nodes.at(startParentId), g = 0; cur && g < 1000; cur = nodes.at(cur.parentId), g++) up.add(cur.id);
  };
  for (const id of changed) {
    addChain(nodes.at(id).parentId);
    if (prevNodes.at(id)) addChain(prevNodes.at(id).parentId);
  }
  for (const id of removed) addChain(prevNodes.at(id).parentId);
  for (const id of redone) up.delete(id);
  const depth = (id: string): number => {
    let d = 0;
    for (let cur: NodeLite | undefined = nodes.at(id); cur && d < 1000; cur = nodes.at(cur.parentId)) d++;
    return d;
  };
  const chain = [...up].sort((a, b) => depth(b) - depth(a));
  for (const id of chain) {
    const n = nodes.at(id);
    if (!n || n.kind === "instance") continue;
    if (!drawn(n)) {
      extent.delete(id);
      continue;
    }
    const kidExtents: Bounds[] = [];
    for (const k of children.get(id) ?? []) {
      const e = extent.get(k.id);
      if (e && k.visible) kidExtents.push(e);
    }
    const u = combine(n, worldOf(n.parentId), kidExtents);
    if (u) extent.set(id, u);
    else extent.delete(id);
  }
  return { children, extent: extent.done(), structure: structural ? {} : prev.structure };
}
