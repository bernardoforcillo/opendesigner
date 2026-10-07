package board_test

import (
	"errors"
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/board"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

// insert applies the nodes of a result to a fresh document like the editor does, so a node the
// core would refuse fails the test.
func insert(t *testing.T, kind string, p board.Params) (*opendesignerv1.Document, []*opendesignerv1.Node) {
	t.Helper()
	res, err := board.Render(kind, p)
	if err != nil {
		t.Fatalf("%s: %v", kind, err)
	}
	doc := core.NewDocument("d", "D")
	root := res.Nodes[0]
	root.ParentId, root.OrderKey = "page1", "a0"
	for _, n := range res.Nodes {
		if err := core.Apply(doc, &opendesignerv1.Op{OpId: n.GetId(), Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}}); err != nil {
			t.Fatalf("%s: node %q (%s): %v", kind, n.GetName(), n.GetId(), err)
		}
	}
	if root.GetMeta()[board.MetaKind] != kind {
		t.Errorf("%s: root meta = %v", kind, root.GetMeta())
	}
	if res.Width <= 0 || res.Height <= 0 {
		t.Errorf("%s: size %gx%g", kind, res.Width, res.Height)
	}
	return doc, res.Nodes
}

func TestEveryKindIsValidAndInsideItsRoot(t *testing.T) {
	for _, kind := range board.Kinds {
		_, nodes := insert(t, kind, board.Params{})
		root := nodes[0]
		if root.GetGroup() == nil || len(nodes) < 2 {
			t.Errorf("%s: want a group with children, got %d nodes", kind, len(nodes))
		}
		for _, n := range nodes[1:] {
			if n.GetX() < -0.01 || n.GetY() < -0.01 || n.GetX()+n.GetWidth() > root.GetWidth()+0.01 || n.GetY()+n.GetHeight() > root.GetHeight()+0.01 {
				t.Errorf("%s: %q at (%g,%g) %gx%g sticks out of %gx%g", kind, n.GetName(), n.GetX(), n.GetY(), n.GetWidth(), n.GetHeight(), root.GetWidth(), root.GetHeight())
			}
		}
	}
}

func texts(nodes []*opendesignerv1.Node) []string {
	var out []string
	for _, n := range nodes {
		if t := n.GetText(); t != nil {
			out = append(out, t.GetContent())
		}
	}
	return out
}

func TestParameters(t *testing.T) {
	_, st := insert(t, board.KindSticky, board.Params{Items: []string{"Ship it"}, Color: "Pink"})
	if got := texts(st); len(got) != 1 || got[0] != "Ship it" {
		t.Errorf("sticky texts = %v", got)
	}
	if st[1].GetFills()[0].GetSolid().GetColor().GetR() != 1 || st[1].GetFills()[0].GetSolid().GetColor().GetG() > 0.8 {
		t.Errorf("pink sticky fill = %v", st[1].GetFills())
	}

	_, tb := insert(t, board.KindTable, board.Params{Rows: 2, Columns: 3, Items: []string{"Name", "Role"}})
	if got := texts(tb); strings.Join(got, "|") != "Name|Role|Column 3|||" {
		t.Errorf("table texts = %q", got)
	}

	_, kb := insert(t, board.KindKanban, board.Params{Items: []string{"Backlog", "Review"}})
	if got := texts(kb); strings.Join(got, "|") != "Backlog|Task|Task|Review|Task|Task" {
		t.Errorf("kanban texts = %q", got)
	}
	if kb[0].GetWidth() != 2*240+16 {
		t.Errorf("kanban width = %g", kb[0].GetWidth())
	}

	_, mm := insert(t, board.KindMindMap, board.Params{Items: []string{"Launch", "Design", "Build", "Test"}})
	got := texts(mm)
	if len(got) != 4 || got[len(got)-1] != "Launch" {
		t.Errorf("mind map texts = %q (center comes last: it is on top)", got)
	}
}

func TestRejectsBadRequests(t *testing.T) {
	for name, tc := range map[string]struct {
		kind string
		p    board.Params
	}{
		"unknown kind":  {"whiteboard", board.Params{}},
		"unknown color": {board.KindSticky, board.Params{Color: "teal"}},
		"huge table":    {board.KindTable, board.Params{Rows: 30, Columns: 30}},
		"negative rows": {board.KindTable, board.Params{Rows: -1}},
		"long item":     {board.KindSticky, board.Params{Items: []string{strings.Repeat("x", 401)}}},
		"many items":    {board.KindKanban, board.Params{Items: make([]string, 61)}},
	} {
		_, err := board.Render(tc.kind, tc.p)
		var be *board.Error
		if !errors.As(err, &be) {
			t.Errorf("%s: err = %v, want a *board.Error", name, err)
		}
	}
}
