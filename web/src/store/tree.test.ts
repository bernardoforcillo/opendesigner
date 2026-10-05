import { describe, it, expect } from "vitest";
import { emptyScene, type NodeLite, type SceneState } from "./types";
import { childrenOf, documentOrder, subtreeOf, descendantsOf, ancestorsOf, isAncestorOf, isReachableFrom, topmostOf } from "./tree";

function node(id: string, parentId: string, orderKey: string): NodeLite {
  return {
    id, parentId, orderKey, name: id, visible: true, opacity: 1,
    x: 0, y: 0, width: 10, height: 10, rotation: 0,
    fills: [], strokes: [], kind: "rect", cornerRadius: 0, clipsContent: false,
  };
}

// The same tree as internal/core/tree_test.go::treeDoc, so the two implementations can be compared
// by eye as well as with the golden fixtures:
//
//   page1
//   ├── g1
//   │   ├── c1
//   │   │   └── d1
//   │   └── c2
//   └── other
function tree(): SceneState {
  const s = emptyScene("doc1", "Untitled");
  for (const n of [
    node("g1", "page1", "a1"),
    node("c1", "g1", "a1"),
    node("d1", "c1", "a1"),
    node("c2", "g1", "a2"),
    node("other", "page1", "a2"),
  ]) s.nodes = s.nodes.set(n.id, n);
  return s;
}

const ids = (nodes: readonly NodeLite[]) => nodes.map((n) => n.id);

describe("childrenOf", () => {
  it("returns the DIRECT children sorted by orderKey", () => {
    const s = emptyScene("doc1", "Untitled");
    for (const n of [
      node("g1", "page1", "a1"),
      node("z", "g1", "a3"),
      node("a", "g1", "a1"),
      node("m", "g1", "a2"),
    ]) s.nodes = s.nodes.set(n.id, n);
    expect(ids(childrenOf(s, "g1"))).toEqual(["a", "m", "z"]);
    // Only the DIRECT ones: g1 is a child of the page, its children are not.
    expect(ids(childrenOf(s, "page1"))).toEqual(["g1"]);
  });

  it("with equal orderKey it sorts by id (the order of Object.values is not defined)", () => {
    const s = emptyScene("doc1", "Untitled");
    for (const n of [node("b", "page1", "a1"), node("a", "page1", "a1")]) s.nodes = s.nodes.set(n.id, n);
    expect(ids(childrenOf(s, "page1"))).toEqual(["a", "b"]);
  });

  it("empty list for a parent without children or nonexistent", () => {
    expect(childrenOf(tree(), "d1")).toEqual([]);
    expect(childrenOf(tree(), "ghost")).toEqual([]);
  });
});

describe("documentOrder", () => {
  it("returns the WHOLE document in draw order: containers before children", () => {
    expect(ids(documentOrder(tree()))).toEqual(["g1", "c1", "d1", "c2", "other"]);
  });

  it("skips nodes not reachable from a page", () => {
    const s = tree();
    s.nodes = s.nodes.set("orphan", node("orphan", "vanished", "a0"));
    expect(ids(documentOrder(s))).not.toContain("orphan");
  });

  it("terminates on a document with a cycle", () => {
    const s = emptyScene("doc1", "Untitled");
    s.nodes = s.nodes.set("a", node("a", "b", "a1"));
    s.nodes = s.nodes.set("b", node("b", "a", "a1"));
    // Neither of the two hangs from a page: the cycle is not even reachable.
    expect(documentOrder(s)).toEqual([]);
  });

  // It is the reason it exists: between two different parents order keys are not
  // comparable, and grouping must know which is the topmost node.
  it("the tree dominates a flat comparison of order keys", () => {
    const s = emptyScene("doc1", "Untitled");
    for (const n of [
      node("below", "page1", "a1"),
      node("childBelow", "below", "z9"), // very high order key, but inside "below"
      node("above", "page1", "a2"),
    ]) s.nodes = s.nodes.set(n.id, n);
    expect(ids(documentOrder(s))).toEqual(["below", "childBelow", "above"]);
  });
});

describe("subtreeOf / descendantsOf", () => {
  it("visits in depth, parent BEFORE children", () => {
    expect(ids(subtreeOf(tree(), "g1"))).toEqual(["g1", "c1", "d1", "c2"]);
    expect(ids(descendantsOf(tree(), "g1"))).toEqual(["c1", "d1", "c2"]);
  });

  it("a leaf node is its only subtree", () => {
    expect(ids(subtreeOf(tree(), "d1"))).toEqual(["d1"]);
    expect(descendantsOf(tree(), "d1")).toEqual([]);
  });

  it("empty for a nonexistent id", () => {
    expect(subtreeOf(tree(), "ghost")).toEqual([]);
  });

  // THE property needed by the undo of a cascading delete: re-creating nodes in
  // this order satisfies "the parent exists" at every step.
  it("every node appears after its own parent", () => {
    const seen = new Set<string>(["page1"]);
    const sub = subtreeOf(tree(), "g1");
    seen.add(sub[0].parentId);
    for (const n of sub) {
      expect(seen.has(n.parentId)).toBe(true);
      seen.add(n.id);
    }
  });
});

describe("ancestorsOf / isAncestorOf", () => {
  it("climbs the chain, from nearest to farthest", () => {
    expect(ids(ancestorsOf(tree(), "d1"))).toEqual(["c1", "g1"]);
    expect(ancestorsOf(tree(), "g1")).toEqual([]); // the parent is a page, not a node
  });

  it("isAncestorOf is STRICT and handles arbitrary depth", () => {
    const s = tree();
    expect(isAncestorOf(s, "g1", "d1")).toBe(true);
    expect(isAncestorOf(s, "c1", "d1")).toBe(true);
    expect(isAncestorOf(s, "d1", "g1")).toBe(false);
    expect(isAncestorOf(s, "other", "d1")).toBe(false);
    expect(isAncestorOf(s, "g1", "g1")).toBe(false);
  });
});

describe("topmostOf", () => {
  it("removes ids that have an ANCESTOR in the selection, at any depth", () => {
    const s = tree();
    // g1 takes c1, d1 and c2 away with the cascade: a single op remains, plus "other".
    expect(topmostOf(s, ["g1", "c1", "d1", "c2", "other"])).toEqual(["g1", "other"]);
    // Even when the ancestor is selected AFTER the descendant: pruning
    // looks at the set, not at the selection order.
    expect(topmostOf(s, ["d1", "g1"])).toEqual(["g1"]);
    // An intermediate ancestor is enough: c1 covers d1 even without g1.
    expect(topmostOf(s, ["c1", "d1"])).toEqual(["c1"]);
  });

  it("leaves a selection of only siblings or cousins intact, in the given order", () => {
    const s = tree();
    expect(topmostOf(s, ["c2", "c1"])).toEqual(["c2", "c1"]);
    expect(topmostOf(s, ["d1", "other"])).toEqual(["d1", "other"]);
    expect(topmostOf(s, [])).toEqual([]);
  });

  it("removes duplicates and keeps unknown ids (it is not its job to validate them)", () => {
    const s = tree();
    expect(topmostOf(s, ["g1", "g1"])).toEqual(["g1"]);
    expect(topmostOf(s, ["ghost", "g1"])).toEqual(["ghost", "g1"]);
  });

  it("a cycle in a malformed document does not make the pruning loop", () => {
    const s = emptyScene("doc1", "Untitled");
    s.nodes = s.nodes.set("a", node("a", "b", "a1"));
    s.nodes = s.nodes.set("b", node("b", "a", "a1"));
    // Each of the two is an ancestor of the other: the climb stops anyway, and
    // the result is empty instead of an infinite cycle.
    expect(topmostOf(s, ["a", "b"])).toEqual([]);
  });
});

// A document with a cycle cannot be produced by applyOp (nor by core.Apply), but
// can arrive from an op-log written before these invariants: the traversal
// must terminate anyway, not loop forever.
describe("malformed document", () => {
  it("a cycle does not make descent or climb loop", () => {
    const s = emptyScene("doc1", "Untitled");
    s.nodes = s.nodes.set("a", node("a", "b", "a1"));
    s.nodes = s.nodes.set("b", node("b", "a", "a1"));
    expect(ids(subtreeOf(s, "a")).sort()).toEqual(["a", "b"]);
    // The climb stops at the first already-seen node: "a" does not come back to the end of its
    // own ancestor chain.
    expect(ids(ancestorsOf(s, "a"))).toEqual(["b"]);
    expect(isAncestorOf(s, "a", "b")).toBe(true);
  });
});

// Reachability from a page: same criterion rootsOf uses to decide whether to
// draw a node, so what keeps the selection per-page scoped in
// agreement with the canvas (store.ts::pruneSelectionToPage).
describe("isReachableFrom", () => {
  // Like tree() but with a second page and a node hanging under it:
  //   page1 ── g1 ── c1 ── d1 ; g1 ── c2 ; page1 ── other
  //   page2 ── far
  function twoPages(): SceneState {
    const s = tree();
    s.pages.push({ id: "page2", name: "Page 2" });
    s.nodes = s.nodes.set("far", node("far", "page2", "a1"));
    return s;
  }

  it("is true for a DIRECT child of the page", () => {
    expect(isReachableFrom(twoPages(), "g1", "page1")).toBe(true);
    expect(isReachableFrom(twoPages(), "far", "page2")).toBe(true);
  });

  it("is true for a DEEP descendant (climbs g1>c1>d1 up to page1)", () => {
    expect(isReachableFrom(twoPages(), "d1", "page1")).toBe(true);
  });

  it("is false for a node hanging from ANOTHER page", () => {
    expect(isReachableFrom(twoPages(), "d1", "page2")).toBe(false);
    expect(isReachableFrom(twoPages(), "far", "page1")).toBe(false);
  });

  it("is false for an id that does not exist (subsumes existence)", () => {
    expect(isReachableFrom(twoPages(), "ghost", "page1")).toBe(false);
  });

  it("does not loop on a cycle detached from every page", () => {
    const s = emptyScene("doc1", "Untitled");
    s.nodes = s.nodes.set("a", node("a", "b", "a1"));
    s.nodes = s.nodes.set("b", node("b", "a", "a1"));
    expect(isReachableFrom(s, "a", "page1")).toBe(false);
  });
});
