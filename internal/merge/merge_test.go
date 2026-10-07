package merge

import (
	"testing"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

func apply(t *testing.T, d *opendesignerv1.Document, ops ...*opendesignerv1.Op) {
	t.Helper()
	for i, op := range ops {
		op.DocId = d.GetId()
		if op.OpId == "" {
			op.OpId = "op"
		}
		if err := core.Apply(d, op); err != nil {
			t.Fatalf("op %d (%T): %v", i, op.GetKind(), err)
		}
	}
}

func create(n *opendesignerv1.Node) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}}
}

func rect(id, parent, key string, x float64) *opendesignerv1.Node {
	return &opendesignerv1.Node{Id: id, ParentId: parent, OrderKey: key, Name: id, Visible: true, Opacity: 1, X: x, Width: 50, Height: 50,
		Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}}}
}

func set(id string, patch *opendesignerv1.Node, paths ...string) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{Id: id, Patch: patch, Mask: &fieldmaskpb.FieldMask{Paths: paths}}}}
}

// world builds a base with page1 and rectangles a, b, c, then forks it into a branch and a source.
func world(t *testing.T) (base, branch, source *opendesignerv1.Document) {
	t.Helper()
	base = core.NewDocument("d", "Doc")
	apply(t, base, create(rect("a", "page1", "a0", 0)), create(rect("b", "page1", "a1", 100)), create(rect("c", "page1", "a2", 200)))
	return base, proto.Clone(base).(*opendesignerv1.Document), proto.Clone(base).(*opendesignerv1.Document)
}

func merged(t *testing.T, base, branch, source *opendesignerv1.Document, prefer bool) (*Plan, *opendesignerv1.Document) {
	t.Helper()
	p := Compute(base, branch, source)
	out := proto.Clone(source).(*opendesignerv1.Document)
	apply(t, out, p.Ops("d", prefer)...)
	return p, out
}

func TestNonOverlappingEditsMergeCleanly(t *testing.T) {
	base, branch, source := world(t)
	apply(t, branch, set("a", &opendesignerv1.Node{X: 30, Name: "A!"}, "x", "name"))
	apply(t, source, set("b", &opendesignerv1.Node{Y: 70}, "y"))
	p, out := merged(t, base, branch, source, false)
	if p.Conflicts() != 0 {
		t.Fatalf("unexpected conflicts: %+v", p.Changes)
	}
	if a := out.Nodes["a"]; a.GetX() != 30 || a.GetName() != "A!" {
		t.Fatalf("branch edit not taken: %v", a)
	}
	if out.Nodes["b"].GetY() != 70 {
		t.Fatal("the source's own edit was lost")
	}
}

func TestSamePropertyChangedOnBothSidesIsAConflict(t *testing.T) {
	base, branch, source := world(t)
	apply(t, branch, set("a", &opendesignerv1.Node{X: 30, Y: 5}, "x", "y"))
	apply(t, source, set("a", &opendesignerv1.Node{X: 99}, "x"))
	p, kept := merged(t, base, branch, source, false)
	if p.Conflicts() != 1 || p.Changes[0].ConflictPaths[0] != "x" {
		t.Fatalf("want one conflict on x, got %+v", p.Changes)
	}
	// The source keeps its x; the non-conflicting y still comes across.
	if kept.Nodes["a"].GetX() != 99 || kept.Nodes["a"].GetY() != 5 {
		t.Fatalf("keeping the source: %v", kept.Nodes["a"])
	}
	_, taken := merged(t, base, branch, source, true)
	if taken.Nodes["a"].GetX() != 30 || taken.Nodes["a"].GetY() != 5 {
		t.Fatalf("taking the branch: %v", taken.Nodes["a"])
	}
}

func TestBothSidesMakingTheSameChangeIsNotAConflict(t *testing.T) {
	base, branch, source := world(t)
	apply(t, branch, set("a", &opendesignerv1.Node{X: 30}, "x"))
	apply(t, source, set("a", &opendesignerv1.Node{X: 30}, "x"))
	if p := Compute(base, branch, source); len(p.Changes) != 0 {
		t.Fatalf("nothing to do, got %+v", p.Changes)
	}
}

func TestAddedAndRemovedNodes(t *testing.T) {
	base, branch, source := world(t)
	apply(t, branch,
		create(rect("n1", "page1", "a5", 10)),
		create(rect("n2", "n1", "a0", 1)), // inside the new node
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteNode{DeleteNode: &opendesignerv1.DeleteNode{Id: "c"}}},
	)
	p, out := merged(t, base, branch, source, false)
	if p.Conflicts() != 0 {
		t.Fatalf("conflicts: %+v", p.Changes)
	}
	if out.Nodes["n1"] == nil || out.Nodes["n2"].GetParentId() != "n1" {
		t.Fatal("new nodes missing or misplaced")
	}
	if out.Nodes["c"] != nil {
		t.Fatal("c should be removed")
	}
}

func TestRemovingANodeTheSourceEditedIsAConflict(t *testing.T) {
	base, branch, source := world(t)
	apply(t, branch, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteNode{DeleteNode: &opendesignerv1.DeleteNode{Id: "a"}}})
	apply(t, source, set("a", &opendesignerv1.Node{X: 5}, "x"))
	p, kept := merged(t, base, branch, source, false)
	if p.Conflicts() != 1 || kept.Nodes["a"] == nil {
		t.Fatalf("the edited node must survive by default: %+v", p.Changes)
	}
	if _, gone := merged(t, base, branch, source, true); gone.Nodes["a"] != nil {
		t.Fatal("preferring the branch should delete it")
	}
}

func TestEditsToTextVectorAndShape(t *testing.T) {
	base := core.NewDocument("d", "Doc")
	txt := &opendesignerv1.Node{Id: "t", ParentId: "page1", OrderKey: "a0", Name: "t", Visible: true, Opacity: 1, Width: 100, Height: 20,
		Shape: &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{Content: "hello", Style: &opendesignerv1.TextStyle{FontSize: 14}}}}
	apply(t, base, create(txt), create(rect("r", "page1", "a1", 0)))
	branch, source := proto.Clone(base).(*opendesignerv1.Document), proto.Clone(base).(*opendesignerv1.Document)
	apply(t, branch,
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetText{SetText: &opendesignerv1.SetText{Id: "t", Content: "hello world", Style: &opendesignerv1.TextStyle{FontSize: 14}, StylePresent: true}}},
		set("r", &opendesignerv1.Node{Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{CornerRadius: 8}}}, "corner_radius"),
	)
	p, out := merged(t, base, branch, source, false)
	if p.Conflicts() != 0 {
		t.Fatalf("conflicts: %+v", p.Changes)
	}
	if got := out.Nodes["t"].GetText().GetContent(); got != "hello world" {
		t.Fatalf("text = %q", got)
	}
	if got := out.Nodes["r"].GetRect().GetCornerRadius(); got != 8 {
		t.Fatalf("corner radius = %v", got)
	}
}

func TestMovesAndReordering(t *testing.T) {
	base := core.NewDocument("d", "Doc")
	frame := &opendesignerv1.Node{Id: "f", ParentId: "page1", OrderKey: "a0", Name: "f", Visible: true, Opacity: 1, Width: 400, Height: 400,
		Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}}
	apply(t, base, create(frame), create(rect("a", "page1", "a1", 0)), create(rect("b", "page1", "a2", 0)))
	branch, source := proto.Clone(base).(*opendesignerv1.Document), proto.Clone(base).(*opendesignerv1.Document)
	apply(t, branch,
		create(rect("n", "f", "a0", 0)),
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_ReparentNode{ReparentNode: &opendesignerv1.ReparentNode{Id: "a", NewParentId: "n", OrderKey: "a0"}}},
		set("b", &opendesignerv1.Node{OrderKey: "a0V"}, "order_key"),
	)
	p, out := merged(t, base, branch, source, false)
	if p.Conflicts() != 0 {
		t.Fatalf("conflicts: %+v", p.Changes)
	}
	if out.Nodes["a"].GetParentId() != "n" {
		t.Fatalf("a was not moved into the new node: %v", out.Nodes["a"])
	}
	if out.Nodes["b"].GetOrderKey() != "a0V" {
		t.Fatalf("b's order = %v", out.Nodes["b"].GetOrderKey())
	}
}

func TestPagesAndDefinitions(t *testing.T) {
	base, branch, source := world(t)
	apply(t, branch,
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreatePage{CreatePage: &opendesignerv1.CreatePage{Page: &opendesignerv1.Page{Id: "p2", Name: "Second"}}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_RenamePage{RenamePage: &opendesignerv1.RenamePage{Id: "page1", Name: "Home"}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetCollection{SetCollection: &opendesignerv1.SetCollection{Collection: &opendesignerv1.VariableCollection{Id: "col", Name: "Colors", Modes: []*opendesignerv1.VariableMode{{Id: "m", Name: "Light"}}}}}},
	)
	p, out := merged(t, base, branch, source, false)
	if p.Conflicts() != 0 {
		t.Fatalf("conflicts: %+v", p.Changes)
	}
	if len(out.Pages) != 2 || out.Pages[0].GetName() != "Home" {
		t.Fatalf("pages = %v", out.Pages)
	}
	if out.Collections["col"].GetName() != "Colors" {
		t.Fatal("collection not merged")
	}
}

func TestANewNodeWhoseParentIsGoneIsReportedNotApplied(t *testing.T) {
	base, branch, source := world(t)
	apply(t, branch, create(rect("n", "a", "a0", 0))) // inside a
	apply(t, source, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteNode{DeleteNode: &opendesignerv1.DeleteNode{Id: "a"}}})
	p, out := merged(t, base, branch, source, false)
	if p.Conflicts() != 1 || out.Nodes["n"] != nil {
		t.Fatalf("want a reported conflict and no node: %+v", p.Changes)
	}
}

func TestIdenticalDocumentsPlanNothing(t *testing.T) {
	base, branch, source := world(t)
	p := Compute(base, branch, source)
	if len(p.Changes) != 0 || len(p.Warnings) != 0 {
		t.Fatalf("identical documents must plan nothing: %+v", p)
	}
}
