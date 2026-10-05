package core

import (
	"errors"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// childOf builds a rectangle inside a specific parent. The rest of the fields
// does not matter for the tree invariants: what matters is parent_id.
func childOf(id, parentID, orderKey string) *opendesignerv1.Node {
	return &opendesignerv1.Node{
		Id: id, ParentId: parentID, OrderKey: orderKey, Name: id, Visible: true, Opacity: 1,
		Width: 10, Height: 10,
		Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}},
	}
}

func createOp(n *opendesignerv1.Node) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}}
}

func deleteOp(id string) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteNode{DeleteNode: &opendesignerv1.DeleteNode{Id: id}}}
}

func reparentOp(id, newParent, orderKey string) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_ReparentNode{ReparentNode: &opendesignerv1.ReparentNode{
		Id: id, NewParentId: newParent, OrderKey: orderKey,
	}}}
}

// mustApply applies a sequence of ops that MUST pass: it is the setup of the
// tree tests, not the thing they are testing.
func mustApply(t *testing.T, doc *opendesignerv1.Document, ops ...*opendesignerv1.Op) {
	t.Helper()
	for i, op := range ops {
		if err := Apply(doc, op); err != nil {
			t.Fatalf("setup op %d: %v", i, err)
		}
	}
}

// The test tree, three levels:
//
//	page1
//	├── g1
//	│   ├── c1
//	│   │   └── d1
//	│   └── c2
//	└── other
func treeDoc(t *testing.T) *opendesignerv1.Document {
	t.Helper()
	doc := NewDocument("doc1", "Untitled")
	mustApply(t, doc,
		createOp(childOf("g1", "page1", "a1")),
		createOp(childOf("c1", "g1", "a1")),
		createOp(childOf("d1", "c1", "a1")),
		createOp(childOf("c2", "g1", "a2")),
		createOp(childOf("other", "page1", "a2")),
	)
	return doc
}

// --- CreateNode: the parent must exist --------------------------------------

func TestApplyCreateRejectsUnknownParent(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	err := Apply(doc, createOp(childOf("n1", "ghost", "a1")))
	if !errors.Is(err, ErrParentNotFound) {
		t.Fatalf("expected ErrParentNotFound, got %v", err)
	}
	if len(doc.Nodes) != 0 {
		t.Fatalf("orphan node landed anyway: %v", doc.Nodes)
	}
}

func TestApplyCreateRejectsEmptyParent(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	// "" is neither a page nor a node: a node without a parent is not
	// reachable from any page, so it is neither drawable nor
	// selectable -- it exists only in the map.
	if err := Apply(doc, createOp(childOf("n1", "", "a1"))); !errors.Is(err, ErrParentNotFound) {
		t.Fatalf("expected ErrParentNotFound, got %v", err)
	}
}

func TestApplyCreateAcceptsPageAndNodeParents(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	mustApply(t, doc, createOp(childOf("g1", "page1", "a1")))
	// An existing node is as valid a parent as a page: that is the whole point
	// of nesting.
	mustApply(t, doc, createOp(childOf("c1", "g1", "a1")))
	if doc.Nodes["c1"].GetParentId() != "g1" {
		t.Fatalf("wrong parent: %q", doc.Nodes["c1"].GetParentId())
	}
}

// --- DeleteNode: cascade ----------------------------------------------------

func TestApplyDeleteCascadesToDescendants(t *testing.T) {
	doc := treeDoc(t)
	if err := Apply(doc, deleteOp("g1")); err != nil {
		t.Fatalf("delete: %v", err)
	}
	for _, id := range []string{"g1", "c1", "c2", "d1"} {
		if _, ok := doc.Nodes[id]; ok {
			t.Fatalf("%s survived a cascading delete", id)
		}
	}
	// The rest of the document is left alone.
	if _, ok := doc.Nodes["other"]; !ok {
		t.Fatal("cascade ate a node outside the subtree")
	}
}

func TestApplyDeleteLeafLeavesSiblings(t *testing.T) {
	doc := treeDoc(t)
	if err := Apply(doc, deleteOp("c2")); err != nil {
		t.Fatalf("delete: %v", err)
	}
	for _, id := range []string{"g1", "c1", "d1", "other"} {
		if _, ok := doc.Nodes[id]; !ok {
			t.Fatalf("%s disappeared deleting a leaf", id)
		}
	}
}

func TestApplyDeleteMissingNodeStillFails(t *testing.T) {
	doc := treeDoc(t)
	if err := Apply(doc, deleteOp("ghost")); !errors.Is(err, ErrNodeNotFound) {
		t.Fatalf("expected ErrNodeNotFound, got %v", err)
	}
	if len(doc.Nodes) != 5 {
		t.Fatalf("rejected delete touched the document: %d nodes left", len(doc.Nodes))
	}
}

// --- ReparentNode -----------------------------------------------------------

func TestApplyReparentMovesUnderNewParent(t *testing.T) {
	doc := treeDoc(t)
	if err := Apply(doc, reparentOp("c1", "other", "a9")); err != nil {
		t.Fatalf("reparent: %v", err)
	}
	if got := doc.Nodes["c1"].GetParentId(); got != "other" {
		t.Fatalf("parent not changed: %q", got)
	}
	if got := doc.Nodes["c1"].GetOrderKey(); got != "a9" {
		t.Fatalf("order key not written: %q", got)
	}
	// The subtree follows the node without anyone rewriting it: the children
	// point to the node, not to the grandparent.
	if got := doc.Nodes["d1"].GetParentId(); got != "c1" {
		t.Fatalf("descendant re-pointed: %q", got)
	}
}

func TestApplyReparentToPageIsValid(t *testing.T) {
	doc := treeDoc(t)
	if err := Apply(doc, reparentOp("d1", "page1", "a3")); err != nil {
		t.Fatalf("reparent to page: %v", err)
	}
	if got := doc.Nodes["d1"].GetParentId(); got != "page1" {
		t.Fatalf("parent not changed: %q", got)
	}
}

func TestApplyReparentRejectsCycle(t *testing.T) {
	for _, tc := range []struct{ name, id, parent string }{
		{"self", "g1", "g1"},
		{"direct child", "g1", "c1"},
		{"deep descendant", "g1", "d1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			doc := treeDoc(t)
			err := Apply(doc, reparentOp(tc.id, tc.parent, "a9"))
			if !errors.Is(err, ErrCycle) {
				t.Fatalf("expected ErrCycle, got %v", err)
			}
			// ALL-OR-NOTHING rejection: not even the order key moves.
			if got := doc.Nodes[tc.id].GetParentId(); got != "page1" {
				t.Fatalf("parent mutated by a rejected reparent: %q", got)
			}
			if got := doc.Nodes[tc.id].GetOrderKey(); got != "a1" {
				t.Fatalf("order key mutated by a rejected reparent: %q", got)
			}
		})
	}
}

func TestApplyReparentRejectsUnknownParent(t *testing.T) {
	doc := treeDoc(t)
	if err := Apply(doc, reparentOp("c1", "ghost", "a9")); !errors.Is(err, ErrParentNotFound) {
		t.Fatalf("expected ErrParentNotFound, got %v", err)
	}
	if got := doc.Nodes["c1"].GetParentId(); got != "g1" {
		t.Fatalf("parent mutated by a rejected reparent: %q", got)
	}
}

func TestApplyReparentRejectsUnknownNode(t *testing.T) {
	doc := treeDoc(t)
	if err := Apply(doc, reparentOp("ghost", "page1", "a9")); !errors.Is(err, ErrNodeNotFound) {
		t.Fatalf("expected ErrNodeNotFound, got %v", err)
	}
}

// Reordering among siblings WITHOUT changing parent is a legitimate reparent (same
// parent, new key): the layers panel uses it for the reorder drag.
func TestApplyReparentSameParentReorders(t *testing.T) {
	doc := treeDoc(t)
	if err := Apply(doc, reparentOp("c1", "g1", "a3")); err != nil {
		t.Fatalf("reparent: %v", err)
	}
	if got := doc.Nodes["c1"].GetOrderKey(); got != "a3" {
		t.Fatalf("order key not written: %q", got)
	}
}

// --- traversal --------------------------------------------------------------

func ids(nodes []*opendesignerv1.Node) []string {
	out := make([]string, len(nodes))
	for i, n := range nodes {
		out[i] = n.GetId()
	}
	return out
}

func equalIDs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestChildrenOfIsOrderedByOrderKey(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	mustApply(t, doc,
		createOp(childOf("g1", "page1", "a1")),
		createOp(childOf("z", "g1", "a3")),
		createOp(childOf("a", "g1", "a1")),
		createOp(childOf("m", "g1", "a2")),
	)
	if got := ids(ChildrenOf(doc, "g1")); !equalIDs(got, []string{"a", "m", "z"}) {
		t.Fatalf("children out of order: %v", got)
	}
	// With equal keys the order must remain DETERMINISTIC (iteration of a
	// Go map is not): the id is the tiebreaker.
	mustApply(t, doc, createOp(childOf("b", "g1", "a1")))
	if got := ids(ChildrenOf(doc, "g1")); !equalIDs(got, []string{"a", "b", "m", "z"}) {
		t.Fatalf("tie not broken by id: %v", got)
	}
}

func TestSubtreeOfIsParentsBeforeChildren(t *testing.T) {
	doc := treeDoc(t)
	got := ids(SubtreeOf(doc, "g1"))
	if !equalIDs(got, []string{"g1", "c1", "d1", "c2"}) {
		t.Fatalf("wrong subtree order: %v", got)
	}
	// The property needed by undo: every node appears AFTER its parent,
	// so recreating them in this order satisfies the parent-exists invariant.
	seen := map[string]bool{"page1": true}
	for _, n := range SubtreeOf(doc, "g1") {
		if !seen[n.GetParentId()] && n.GetId() != "g1" {
			t.Fatalf("%s comes before its parent %s", n.GetId(), n.GetParentId())
		}
		seen[n.GetId()] = true
	}
}

func TestIsAncestorOf(t *testing.T) {
	doc := treeDoc(t)
	if !IsAncestorOf(doc, "g1", "d1") {
		t.Fatal("g1 should be an ancestor of d1")
	}
	if IsAncestorOf(doc, "d1", "g1") {
		t.Fatal("d1 is not an ancestor of g1")
	}
	if IsAncestorOf(doc, "other", "c1") {
		t.Fatal("a sibling subtree is not an ancestor")
	}
	// A node is not its own ancestor (the relation is strict); the rejection
	// of reparenting onto itself handles that separately.
	if IsAncestorOf(doc, "g1", "g1") {
		t.Fatal("IsAncestorOf must be strict")
	}
}

// A MALFORMED document (cycle already present, e.g. from an op-log written by a
// version without these invariants) must not send the traversal into a loop:
// this holds for both the cascade and the cycle check.
func TestTraversalSurvivesACorruptedCycle(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	doc.Nodes["a"] = childOf("a", "b", "a1")
	doc.Nodes["b"] = childOf("b", "a", "a1")
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = SubtreeOf(doc, "a")
		_ = IsAncestorOf(doc, "a", "b")
		_ = Apply(doc, deleteOp("a"))
	}()
	<-done
}
