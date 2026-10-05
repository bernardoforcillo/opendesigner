import type { NodeLite, SceneState } from "./types";

// TRAVERSAL OF THE DOCUMENT AS A TREE.
//
// `parentId` has existed since M0 but nobody read it: the scene was flat and every
// node a child of "page1". From here on it is the load-bearing structure -- groups,
// frames and components are all subtrees -- and these are the only
// traversals the rest of the code must use: renderer, layers
// panel, hit-test and the other tracks.
//
// TS half of internal/core/tree.go: same rules, same ORDER, same
// tolerance of a malformed document. The two implementations must remain
// indistinguishable like applyOp and core.Apply -- the order of children decides
// the draw order, and the order of the subtree decides the sequence in which
// a cascading delete is undone.
//
// Nodes live in a flat MAP (`scene.nodes`) and children are not
// indexed: every call scans the map. It is the same choice as
// selectors.ts::layersInDrawOrder (a sort on every call) and for the same
// reason: `scene` is immutable and rebuilt on every op, so any
// index would have to be invalidated continuously. If one day the cost shows up, the
// place to put it is THIS module, not the callers.

// Sibling order: ascending order key (from bottom to top in draw
// order), id as tiebreaker. The tiebreaker is not pedantry: the order of
// Object.values on a map is not defined by the language, so without
// it two identical calls could give different lists -- and the restore
// sequence of a cascading delete would change on every run.
// Comparison by code unit as in Go (byte-wise), not localeCompare: order
// keys are ASCII fractional indices, and a locale collation would sort them
// differently from the server.
export function bySiblingOrder(a: NodeLite, b: NodeLite): number {
  if (a.orderKey !== b.orderKey) return a.orderKey < b.orderKey ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// The DIRECT children of a container, sorted. `parentId` can be the id of a
// node or that of a Page (the roots of that page).
export function childrenOf(scene: SceneState, parentId: string): NodeLite[] {
  return [...scene.nodes.values()].filter((n) => n.parentId === parentId).sort(bySiblingOrder);
}

// ALL children of ALL containers in a single pass: the same list that
// childrenOf would produce (same filter, same order), indexed by
// parentId. A key exists only if it has at least one child.
//
// It is the index that the comment at the top of this module anticipated: whoever has to
// descend the WHOLE tree (the renderer, on every frame, and hit-test) would
// otherwise do a childrenOf -- that is, a map scan -- for every node
// visited, which on a scene of N nodes is N scans, N^2 comparisons per frame.
// Building it once and passing it to the descent brings it back to one pass plus a
// sort per container. It remains a THROWAWAY index, rebuilt on every
// call: `scene` is immutable and rebuilt on every op, so a
// stored index would have to be invalidated continuously.
//
// It has no counterpart in Go: the server does not draw and does not hit-test, it never
// descends the whole tree repeatedly. The RULES (who is a child of whom, in
// what order) remain those of childrenOf, which does have a counterpart.
export function childIndexOf(scene: SceneState): Map<string, NodeLite[]> {
  const index = new Map<string, NodeLite[]>();
  for (const n of [...scene.nodes.values()]) {
    const siblings = index.get(n.parentId);
    if (siblings) siblings.push(n);
    else index.set(n.parentId, [n]);
  }
  for (const siblings of index.values()) siblings.sort(bySiblingOrder);
  return index;
}

// The WHOLE document in DRAW order: start from the children of the pages
// (in page order) and descend in pre-order -- a container before
// its children, siblings by order key. It is the same walk as
// renderer/canvasRenderer.ts::drawScene, so the last element is the node
// drawn HIGHEST in the whole document.
//
// It serves whoever has to compare the position of two nodes that are NOT siblings
// -- grouping, which must know which is the topmost node of the
// selection to know where the group is born: between two different parents order
// keys are not comparable, the tree decides.
//
// Nodes NOT reachable from a page do not appear: they have no place in the world,
// exactly as for the renderer.
//
// Like childIndexOf, it has no counterpart in Go (the server does not draw); the
// RULES are those of childrenOf, which does have a counterpart.
export function documentOrder(scene: SceneState): NodeLite[] {
  const children = childIndexOf(scene);
  const out: NodeLite[] = [];
  const seen = new Set<string>();
  const roots = scene.pages.flatMap((p) => children.get(p.id) ?? []);
  // Explicit stack and children in REVERSE order, like subtreeOf: same reason
  // (depth decided by the user) and same exit order.
  const stack: NodeLite[] = [];
  for (let i = roots.length - 1; i >= 0; i--) stack.push(roots[i]);
  while (stack.length > 0) {
    const n = stack.pop() as NodeLite;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
    const kids = children.get(n.id) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

// The node AND all its descendants, in PRE-ORDER: every node always appears
// after its own parent, siblings in order key order.
//
// The order is not aesthetic: it is what makes the list reusable as a
// RE-CREATION sequence (the inverse of a cascading delete, see history.ts::invertOp).
// Re-creating them in this order satisfies the "the parent exists" invariant at every
// step; in reverse order every child would be rejected.
//
// Empty list if the node does not exist.
export function subtreeOf(scene: SceneState, id: string): NodeLite[] {
  const root = scene.nodes.at(id);
  if (!root) return [];
  const out: NodeLite[] = [];
  const seen = new Set<string>();
  // Explicit stack and not recursion: depth is decided by the user (groups
  // inside groups inside frames) and a malformed document could make it
  // unbounded. On the stack children go in REVERSE order, so they come out in order
  // of order key.
  const stack: NodeLite[] = [root];
  while (stack.length > 0) {
    const n = stack.pop() as NodeLite;
    // Cycle in a malformed document: already visited, revisiting it would
    // never end.
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
    const children = childrenOf(scene, n.id);
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return out;
}

// The subtree WITHOUT the root, same order.
export function descendantsOf(scene: SceneState, id: string): NodeLite[] {
  return subtreeOf(scene, id).slice(1);
}

// The ancestors of a node, from the NEAREST to the farthest. It stops at the page:
// a Page is not a NodeLite, so a page root has no ancestors.
export function ancestorsOf(scene: SceneState, id: string): NodeLite[] {
  const out: NodeLite[] = [];
  const seen = new Set<string>([id]);
  let cur = scene.nodes.at(id);
  while (cur) {
    const parent = scene.nodes.at(cur.parentId);
    // seen: a cycle in a malformed document must not make it climb forever.
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    out.push(parent);
    cur = parent;
  }
  return out;
}

// STRICT relation: nobody is an ancestor of themselves. It climbs the chain instead
// of descending the tree -- depth is typically much smaller than the number
// of descendants, and it is the direction in which the cycle check of a
// reparent must be done.
export function isAncestorOf(scene: SceneState, ancestorId: string, id: string): boolean {
  const seen = new Set<string>();
  let cur = scene.nodes.at(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.parentId === ancestorId) return true;
    cur = scene.nodes.at(cur.parentId);
  }
  return false;
}

// The TOPMOST nodes of a set: removes every id that has an ANCESTOR
// in the set itself, keeping the order of those that remain (and without
// duplicates).
//
// It serves whoever builds ops that act on a SUBTREE -- today the
// deletion (cascading deleteNode, see applyOp and core.applyDelete). With the
// flat scene "one op per selected id" was correct; with the tree it no longer is:
// if the selection contains a group AND one of its children, the second op
// names a node that the first's cascade has already removed. The server
// rejects it (ErrNodeNotFound -> rollback and red banner) and, much worse,
// invertOp on that second op returns null, so invertChain drops the
// undo entry of the ENTIRE gesture: a group deleted forever, with
// no Ctrl+Z possible. Pruning here is what makes the gesture ONE and
// undoable.
//
// Ids that are not in the scene stay (no ancestor to find): it is
// not this function's job to decide whether an id is valid.
export function topmostOf(scene: SceneState, ids: readonly string[]): string[] {
  const set = new Set(ids);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (ancestorsOf(scene, id).some((a) => set.has(a.id))) continue;
    out.push(id);
  }
  return out;
}

// A node is REACHABLE from a page when, climbing the parent chain,
// that page is met as the container of an ancestor (or of the node itself).
// It is exactly the criterion with which the renderer decides whether to draw it:
// canvasRenderer.ts::rootsOf takes the direct children of the page and drawSiblings
// descends the subtree, so a node is seen on currentPageId iff
// one of its ancestors-or-self has parentId === pageId. Keeping this function
// aligned with rootsOf is what prevents the see-vs-select divergence
// when the selection must be pruned by page (store.ts).
//
// false for an absent id (scene.nodes.at(id) undefined): a node that does not exist
// is not reachable from any page, so this function also subsumes the
// existence check. `seen` as in ancestorsOf: a cycle in a malformed document
// must not make it climb forever.
export function isReachableFrom(scene: SceneState, id: string, pageId: string): boolean {
  const seen = new Set<string>();
  let cur = scene.nodes.at(id);
  while (cur && !seen.has(cur.id)) {
    if (cur.parentId === pageId) return true;
    seen.add(cur.id);
    cur = scene.nodes.at(cur.parentId);
  }
  return false;
}

// A VALID parent: an existing node or a Page of the document. The empty
// string is neither -- a node without a parent is not reachable from any
// page, so it is neither drawable nor selectable: it would exist only
// inside the map. Parity with core.parentExists (Go).
export function parentExists(scene: SceneState, parentId: string): boolean {
  return scene.nodes.has(parentId) || scene.pages.some((p) => p.id === parentId);
}
