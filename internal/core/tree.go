package core

import (
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Traversal of the document as a TREE. `Node.parent_id` has existed since M0
// but nobody read it: the scene was flat and every node a child of "page1". From
// here on it is the load-bearing structure -- groups, frames and components are
// all subtrees -- and core.Apply enforces its invariants:
//
//	1. a node's parent EXISTS (another node, or a Page);
//	2. deleting a node deletes its whole subtree;
//	3. no cycles: a node cannot end up under one of its own descendants.
//
// The functions here are the Go HALF of web/src/store/tree.ts: same rules,
// same order, same tolerance for a malformed document. A document with a
// cycle cannot be produced by Apply, but may arrive from an op-log written
// before these invariants: the traversal must not loop forever, so every
// descent keeps the set of nodes already seen.

// ChildrenOf returns the DIRECT children of parentID (a node id or a Page id),
// sorted by ascending order_key -- i.e. from the bottom to the top in drawing
// order.
//
// The ordering is total even for equal keys: the id is the tiebreaker.
// Iteration of a Go map is deliberately randomized, so without the tiebreaker
// two calls on the same document could give different orders -- and the delete
// cascade, which depends on it, would produce different inverses on every
// run.
func ChildrenOf(doc *opendesignerv1.Document, parentID string) []*opendesignerv1.Node {
	var out []*opendesignerv1.Node
	for _, n := range doc.GetNodes() {
		if n.GetParentId() == parentID {
			out = append(out, n)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].GetOrderKey() != out[j].GetOrderKey() {
			return out[i].GetOrderKey() < out[j].GetOrderKey()
		}
		return out[i].GetId() < out[j].GetId()
	})
	return out
}

// SubtreeOf returns the node and ALL its descendants in pre-order: every node
// always appears AFTER its own parent, and siblings in order_key order.
//
// The order is not an aesthetic detail: it is what makes the list reusable
// as a recreation sequence (the inverse of a cascading delete, see
// web/src/store/history.ts). Recreating the nodes in this order satisfies
// the "the parent exists" invariant at every step; in reverse order every
// child would be rejected.
//
// Empty list if the node does not exist.
func SubtreeOf(doc *opendesignerv1.Document, id string) []*opendesignerv1.Node {
	root := doc.GetNodes()[id]
	if root == nil {
		return nil
	}
	var out []*opendesignerv1.Node
	seen := map[string]bool{}
	// Explicit STACK and not recursion: the tree's depth is decided by the
	// user (groups inside groups inside frames), and a malformed document
	// could make it unbounded. On the stack the children go in REVERSE order,
	// so they come out in order_key order.
	stack := []*opendesignerv1.Node{root}
	for len(stack) > 0 {
		n := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[n.GetId()] {
			// Cycle in a malformed document: the node was already visited,
			// visiting it again would never end.
			continue
		}
		seen[n.GetId()] = true
		out = append(out, n)
		children := ChildrenOf(doc, n.GetId())
		for i := len(children) - 1; i >= 0; i-- {
			stack = append(stack, children[i])
		}
	}
	return out
}

// IsAncestorOf reports whether ancestorID is a STRICT ancestor of id (a node is not
// its own ancestor). It climbs the parent chain instead of descending the
// tree: the depth is typically much smaller than the number of descendants,
// and it is the direction in which the cycle check must be done (see applyReparent).
func IsAncestorOf(doc *opendesignerv1.Document, ancestorID, id string) bool {
	seen := map[string]bool{}
	cur := doc.GetNodes()[id]
	for cur != nil && !seen[cur.GetId()] {
		seen[cur.GetId()] = true
		if cur.GetParentId() == ancestorID {
			return true
		}
		cur = doc.GetNodes()[cur.GetParentId()]
	}
	return false
}

// parentExists reports whether parentID is a valid container: an existing node
// or a Page of the document. An empty string is neither -- a node without
// a parent is not reachable from any page, so it is neither drawable nor
// selectable: it would exist only inside the map.
func parentExists(doc *opendesignerv1.Document, parentID string) bool {
	if _, ok := doc.GetNodes()[parentID]; ok {
		return true
	}
	for _, p := range doc.GetPages() {
		if p.GetId() == parentID {
			return true
		}
	}
	return false
}
