package mcp_test

import (
	"context"
	"sort"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// childNames lists the names of the children of parent from bottom to top (order key, then id).
func childNames(t *testing.T, s *odmcp.Session, parent string) []string {
	t.Helper()
	doc, err := s.GetDocument(context.Background(), struct{}{})
	if err != nil {
		t.Fatal(err)
	}
	var kids []odmcp.NodeView
	for _, n := range doc.Nodes {
		if n.ParentId == parent {
			kids = append(kids, n)
		}
	}
	sort.Slice(kids, func(i, j int) bool {
		if kids[i].OrderKey != kids[j].OrderKey {
			return kids[i].OrderKey < kids[j].OrderKey
		}
		return kids[i].Id < kids[j].Id
	})
	var out []string
	for _, k := range kids {
		out = append(out, k.Name)
	}
	return out
}

func sameNames(a, b []string) bool {
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

// TestArrangeNodesIsTheContextMenu: front / forward / backward / back change only order keys, and
// a node that cannot move further is left alone.
func TestArrangeNodesIsTheContextMenu(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	f := frame(t, s, "Screen")
	a, b, c, d := rect(t, s, f, "A"), rect(t, s, f, "B"), rect(t, s, f, "C"), rect(t, s, f, "D")
	want := func(label string, names ...string) {
		t.Helper()
		if got := childNames(t, s, f); !sameNames(got, names) {
			t.Fatalf("%s: order = %v, want %v", label, got, names)
		}
	}
	want("start", "A", "B", "C", "D")

	if out, err := s.ArrangeNodes(ctx, odmcp.ArrangeNodesInput{Ids: []string{a}, Mode: "front"}); err != nil || out.Changed != 1 {
		t.Fatalf("front: %+v %v", out, err)
	}
	want("A to front", "B", "C", "D", "A")
	if out, _ := s.ArrangeNodes(ctx, odmcp.ArrangeNodesInput{Ids: []string{a}, Mode: "front"}); out.Changed != 0 {
		t.Errorf("front on the top node changed %d ops", out.Changed)
	}
	if _, err := s.ArrangeNodes(ctx, odmcp.ArrangeNodesInput{Ids: []string{d}, Mode: "backward"}); err != nil {
		t.Fatal(err)
	}
	want("D backward", "B", "D", "C", "A")
	if _, err := s.ArrangeNodes(ctx, odmcp.ArrangeNodesInput{Ids: []string{b}, Mode: "forward"}); err != nil {
		t.Fatal(err)
	}
	want("B forward", "D", "B", "C", "A")
	if _, err := s.ArrangeNodes(ctx, odmcp.ArrangeNodesInput{Ids: []string{c, a}, Mode: "back"}); err != nil {
		t.Fatal(err)
	}
	want("C and A to back, keeping their relative order", "C", "A", "D", "B")
	// A group of selected siblings steps over the unselected one as a block.
	if _, err := s.ArrangeNodes(ctx, odmcp.ArrangeNodesInput{Ids: []string{c, a}, Mode: "forward"}); err != nil {
		t.Fatal(err)
	}
	want("C and A forward", "D", "C", "A", "B")

	if _, err := s.ArrangeNodes(ctx, odmcp.ArrangeNodesInput{Ids: []string{a}, Mode: "sideways"}); err == nil {
		t.Error("an unknown mode was accepted")
	}
	if _, err := s.ArrangeNodes(ctx, odmcp.ArrangeNodesInput{Ids: []string{"nope"}, Mode: "front"}); err == nil {
		t.Error("an unknown node was accepted")
	}
	if _, err := s.ArrangeNodes(ctx, odmcp.ArrangeNodesInput{Mode: "front"}); err == nil {
		t.Error("an empty selection was accepted")
	}
}

// TestGroupUngroupKeepNodesWhereTheyAre: the group lands right above the topmost grouped node,
// nothing moves in the world, and ungrouping a moved group bakes its translation into the children.
func TestGroupUngroupKeepNodesWhereTheyAre(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	f := frame(t, s, "Screen")
	a, b, c := rect(t, s, f, "A"), rect(t, s, f, "B"), rect(t, s, f, "C")
	pos := func(id string) (float64, float64) {
		doc, _ := s.GetDocument(ctx, struct{}{})
		n, ok := nodeByID(doc, id)
		if !ok {
			t.Fatalf("node %s missing", id)
		}
		return n.X, n.Y
	}

	g, err := s.GroupNodes(ctx, odmcp.GroupNodesInput{Ids: []string{c, a}})
	if err != nil || len(g.NodeIds) != 1 {
		t.Fatalf("GroupNodes: %+v %v", g, err)
	}
	gid := g.NodeIds[0]
	// Topmost grouped node is C: the group sits right above it, B stays under.
	if got := childNames(t, s, f); !sameNames(got, []string{"B", "Group"}) {
		t.Fatalf("frame children = %v, want [B Group]", got)
	}
	if got := childNames(t, s, gid); !sameNames(got, []string{"A", "C"}) {
		t.Fatalf("group children = %v, want [A C] (draw order kept)", got)
	}
	if x, y := pos(a); x != 10 || y != 20 {
		t.Errorf("A moved to (%v, %v) by grouping", x, y)
	}

	// Move the group, then ungroup: the children take the translation with them.
	if _, err := s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: gid, X: ptr(50.0), Y: ptr(60.0)}); err != nil {
		t.Fatal(err)
	}
	u, err := s.UngroupNodes(ctx, odmcp.UngroupNodesInput{Ids: []string{gid}})
	if err != nil || len(u.NodeIds) != 2 {
		t.Fatalf("UngroupNodes: %+v %v", u, err)
	}
	if x, y := pos(a); x != 60 || y != 80 {
		t.Errorf("A after ungrouping a moved group is at (%v, %v), want (60, 80)", x, y)
	}
	if got := childNames(t, s, f); !sameNames(got, []string{"B", "A", "C"}) {
		t.Errorf("frame children = %v, want [B A C] (the group's slot)", got)
	}
	doc, _ := s.GetDocument(ctx, struct{}{})
	if _, ok := nodeByID(doc, gid); ok {
		t.Error("the emptied group is still there")
	}
	if _, err := s.UngroupNodes(ctx, odmcp.UngroupNodesInput{Ids: []string{b}}); err == nil {
		t.Error("ungrouping a rectangle was accepted")
	}
}

// TestDuplicateNodesCopiesTheSubtree: new ids, same parent on top, offset roots only.
func TestDuplicateNodesCopiesTheSubtree(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	card := frame(t, s, "Card")
	rect(t, s, card, "Inner")
	out, err := s.DuplicateNodes(ctx, odmcp.DuplicateNodesInput{Ids: []string{card}})
	if err != nil || len(out.NodeIds) != 1 || out.Changed != 2 {
		t.Fatalf("DuplicateNodes: %+v %v", out, err)
	}
	doc, _ := s.GetDocument(ctx, struct{}{})
	orig, _ := nodeByID(doc, card)
	cp, ok := nodeByID(doc, out.NodeIds[0])
	if !ok || cp.ParentId != orig.ParentId || cp.X != orig.X+16 || cp.Y != orig.Y+16 || cp.OrderKey <= orig.OrderKey {
		t.Fatalf("copy = %+v (original %+v)", cp, orig)
	}
	var inner []odmcp.NodeView
	for _, n := range doc.Nodes {
		if n.ParentId == cp.Id {
			inner = append(inner, n)
		}
	}
	if len(inner) != 1 || inner[0].Name != "Inner" || inner[0].X != 10 {
		t.Errorf("the copy's children = %+v, want the Inner rectangle at its own x (only the root is offset)", inner)
	}
	still, _ := s.DuplicateNodes(ctx, odmcp.DuplicateNodesInput{Ids: []string{card}, Offset: ptr(0.0)})
	doc, _ = s.GetDocument(ctx, struct{}{})
	if n, _ := nodeByID(doc, still.NodeIds[0]); n.X != orig.X {
		t.Errorf("offset 0 moved the copy to x=%v", n.X)
	}
}
