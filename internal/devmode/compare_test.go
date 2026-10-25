package devmode_test

import (
	"errors"
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/bernardoforcillo/opendesigner/internal/devmode"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

func mask(paths ...string) *fieldmaskpb.FieldMask { return &fieldmaskpb.FieldMask{Paths: paths} }

func solid(r, g, b float32) *opendesignerv1.Paint {
	return &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{Color: &opendesignerv1.Color{R: r, G: g, B: b, A: 1}}}}
}

func apply(t *testing.T, doc *opendesignerv1.Document, op *opendesignerv1.Op) {
	t.Helper()
	if err := core.Apply(doc, op); err != nil {
		t.Fatal(err)
	}
}

func create(t *testing.T, doc *opendesignerv1.Document, n *opendesignerv1.Node) {
	t.Helper()
	apply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}})
}

// readyDoc: a frame "f" holding a red button "btn" (with a label "lbl") marked ready for dev.
func readyDoc(t *testing.T) *opendesignerv1.Document {
	doc := core.NewDocument("d", "t")
	create(t, doc, &opendesignerv1.Node{Id: "f", ParentId: "page1", OrderKey: "a", Name: "Checkout", Visible: true, Opacity: 1, Width: 300, Height: 200,
		Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}})
	create(t, doc, &opendesignerv1.Node{Id: "btn", ParentId: "f", OrderKey: "a", Name: "Buy", Visible: true, Opacity: 1, X: 10, Y: 20, Width: 100, Height: 40,
		Fills: []*opendesignerv1.Paint{solid(1, 0, 0)}, Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{CornerRadius: 4}}})
	create(t, doc, &opendesignerv1.Node{Id: "lbl", ParentId: "f", OrderKey: "b", Name: "Label", Visible: true, Opacity: 1, X: 10, Y: 80, Width: 100, Height: 20,
		Shape: &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{Content: "Pay now", Style: &opendesignerv1.TextStyle{FontSize: 14}}}})
	apply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetReadyForDev{SetReadyForDev: &opendesignerv1.SetReadyForDev{
		Ready: &opendesignerv1.ReadyForDev{NodeId: "f", MarkedAt: 100},
	}}})
	return doc
}

func setProps(t *testing.T, doc *opendesignerv1.Document, id string, patch *opendesignerv1.Node, paths ...string) {
	t.Helper()
	apply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: id, Patch: patch, Mask: mask(paths...),
	}}})
}

func find(cs []devmode.Change, node, prop string) *devmode.Change {
	for i := range cs {
		if cs[i].NodeID == node && cs[i].Property == prop {
			return &cs[i]
		}
	}
	return nil
}

func TestUntouchedFrameHasNoChanges(t *testing.T) {
	cmp, err := devmode.Compare(readyDoc(t), "f")
	if err != nil {
		t.Fatal(err)
	}
	if len(cmp.Changes) != 0 || cmp.Name != "Checkout" || cmp.MarkedAt != 100 {
		t.Errorf("comparison = %+v", cmp)
	}
}

func TestChangedPropertiesCarryReadableBeforeAndAfter(t *testing.T) {
	doc := readyDoc(t)
	setProps(t, doc, "btn", &opendesignerv1.Node{Width: 160, Fills: []*opendesignerv1.Paint{solid(0, 0, 1)}}, "width", "fills")
	setProps(t, doc, "btn", &opendesignerv1.Node{Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{CornerRadius: 12}}}, "corner_radius")
	apply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetText{SetText: &opendesignerv1.SetText{Id: "lbl", Content: "Pay"}}})
	cmp, err := devmode.Compare(doc, "f")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []devmode.Change{
		{NodeID: "btn", NodeName: "Buy", Kind: devmode.Changed, Property: "width", Before: "100", After: "160"},
		{NodeID: "btn", NodeName: "Buy", Kind: devmode.Changed, Property: "fills[0]", Before: "solid #ff0000", After: "solid #0000ff"},
		{NodeID: "btn", NodeName: "Buy", Kind: devmode.Changed, Property: "rect.corner_radius", Before: "4", After: "12"},
		{NodeID: "lbl", NodeName: "Label", Kind: devmode.Changed, Property: "text.content", Before: "Pay now", After: "Pay"},
	} {
		got := find(cmp.Changes, want.NodeID, want.Property)
		if got == nil || *got != want {
			t.Errorf("change %s.%s = %+v, want %+v", want.NodeID, want.Property, got, want)
		}
	}
	if len(cmp.Changes) != 4 {
		t.Errorf("exactly the four edits must show, got %+v", cmp.Changes)
	}
	// Geometry reads before paint.
	if cmp.Changes[0].Property != "width" {
		t.Errorf("geometry first, got %s", cmp.Changes[0].Property)
	}
}

func TestAddedAndRemovedLayers(t *testing.T) {
	doc := readyDoc(t)
	create(t, doc, &opendesignerv1.Node{Id: "new", ParentId: "f", OrderKey: "c", Name: "Badge", Visible: true, Opacity: 1, Width: 10, Height: 10,
		Shape: &opendesignerv1.Node_Ellipse{Ellipse: &opendesignerv1.EllipseNode{}}})
	apply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteNode{DeleteNode: &opendesignerv1.DeleteNode{Id: "lbl"}}})
	cmp, _ := devmode.Compare(doc, "f")
	var kinds []string
	for _, c := range cmp.Changes {
		kinds = append(kinds, c.Kind+":"+c.NodeID)
	}
	if strings.Join(kinds, ",") != "added:new,removed:lbl" {
		t.Errorf("changes = %v", kinds)
	}
}

func TestMovingAChildBetweenParentsAndRenaming(t *testing.T) {
	doc := readyDoc(t)
	setProps(t, doc, "btn", &opendesignerv1.Node{Name: "Pay button"}, "name")
	cmp, _ := devmode.Compare(doc, "f")
	c := find(cmp.Changes, "btn", "name")
	if c == nil || c.Before != "Buy" || c.After != "Pay button" || c.NodeName != "Pay button" {
		t.Errorf("rename = %+v", c)
	}
}

func TestMovedFrameIsNotAChangeOfItsChildren(t *testing.T) {
	doc := readyDoc(t)
	setProps(t, doc, "f", &opendesignerv1.Node{X: 500, Y: 40}, "x", "y")
	cmp, _ := devmode.Compare(doc, "f")
	// Children keep their coordinates relative to the parent: only the frame's own x / y differ.
	for _, c := range cmp.Changes {
		if c.NodeID != "f" {
			t.Errorf("moving the frame must not report its children: %+v", c)
		}
	}
	if len(cmp.Changes) != 2 {
		t.Errorf("changes = %+v", cmp.Changes)
	}
}

func TestNotReadyAndDeletedFrame(t *testing.T) {
	doc := readyDoc(t)
	if _, err := devmode.Compare(doc, "btn"); !errors.Is(err, devmode.ErrNotReady) {
		t.Errorf("an unmarked node: err = %v", err)
	}
	apply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteNode{DeleteNode: &opendesignerv1.DeleteNode{Id: "f"}}})
	cmp, err := devmode.Compare(doc, "f")
	if err != nil || len(cmp.Changes) != 1 || cmp.Changes[0].Kind != devmode.Removed || cmp.Name != "Checkout" {
		t.Errorf("a deleted frame is one removed node: %+v %v", cmp, err)
	}
}

func TestChangeSummary(t *testing.T) {
	if got := (devmode.Change{NodeName: "Buy", Kind: devmode.Changed, Property: "width", Before: "100", After: "160"}).Summary(); got != "Buy: width 100 -> 160" {
		t.Errorf("summary = %q", got)
	}
	if got := (devmode.Change{NodeName: "Buy", Kind: devmode.Changed, Property: "meta.status", After: "done"}).Summary(); got != "Buy: meta.status (unset) -> done" {
		t.Errorf("summary = %q", got)
	}
}
