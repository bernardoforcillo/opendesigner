package core

import (
	"errors"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

func mask(paths ...string) *fieldmaskpb.FieldMask { return &fieldmaskpb.FieldMask{Paths: paths} }

func colorVal(r, g, b float32) *opendesignerv1.VariableValue {
	return &opendesignerv1.VariableValue{Kind: &opendesignerv1.VariableValue_Color{Color: &opendesignerv1.Color{R: r, G: g, B: b, A: 1}}}
}

func numVal(n float64) *opendesignerv1.VariableValue {
	return &opendesignerv1.VariableValue{Kind: &opendesignerv1.VariableValue_Number{Number: n}}
}

// themed builds: frame f > frame inner > rect r (red fill, opacity 1), a "Theme"
// collection (light, dark) and bg (color) / op (number) variables bound on r.
func themed(t *testing.T) *opendesignerv1.Document {
	t.Helper()
	doc := NewDocument("d", "d")
	node := func(id, parent string, shape *opendesignerv1.Node) *opendesignerv1.Op {
		shape.Id, shape.ParentId, shape.OrderKey, shape.Visible, shape.Opacity = id, parent, "a1", true, 1
		return &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: shape}}}
	}
	red := &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{Color: &opendesignerv1.Color{R: 1, A: 1}}}}
	mustApply(t, doc,
		node("f", "page1", &opendesignerv1.Node{Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}}),
		node("inner", "f", &opendesignerv1.Node{Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}}),
		node("r", "inner", &opendesignerv1.Node{Fills: []*opendesignerv1.Paint{red}, Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}}}),
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetCollection{SetCollection: &opendesignerv1.SetCollection{Collection: &opendesignerv1.VariableCollection{
			Id: "theme", Name: "Theme", Modes: []*opendesignerv1.VariableMode{{Id: "light"}, {Id: "dark"}}}}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetVariable{SetVariable: &opendesignerv1.SetVariable{Variable: &opendesignerv1.Variable{
			Id: "bg", CollectionId: "theme", Type: opendesignerv1.VariableType_VARIABLE_TYPE_COLOR,
			Values: map[string]*opendesignerv1.VariableValue{"light": colorVal(1, 1, 1), "dark": colorVal(0, 0, 0)}}}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetVariable{SetVariable: &opendesignerv1.SetVariable{Variable: &opendesignerv1.Variable{
			Id: "dim", CollectionId: "theme", Type: opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER,
			Values: map[string]*opendesignerv1.VariableValue{"light": numVal(1), "dark": numVal(0.4)}}}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
			Id: "r", Patch: &opendesignerv1.Node{Bindings: map[string]string{"fills.0": "bg", "opacity": "dim"}},
			Mask: mask("bindings")}}},
	)
	return doc
}

func TestResolveFollowsNearestModeOverride(t *testing.T) {
	doc := themed(t)
	r := ResolveNode(doc, doc.Nodes["r"])
	if got := r.GetFills()[0].GetSolid().GetColor().GetR(); got != 1 || r.GetOpacity() != 1 {
		t.Fatalf("default mode: r=%v opacity=%v, want light values", got, r.GetOpacity())
	}
	// Pin the OUTER frame to dark: the whole subtree follows.
	mustApply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: "f", Patch: &opendesignerv1.Node{Modes: map[string]string{"theme": "dark"}}, Mask: mask("modes")}}})
	r = ResolveNode(doc, doc.Nodes["r"])
	if c := r.GetFills()[0].GetSolid().GetColor(); c.GetR() != 0 || r.GetOpacity() != 0.4 {
		t.Fatalf("dark: color=%v opacity=%v", c, r.GetOpacity())
	}
	// ...and the NEAREST override wins over the outer one.
	mustApply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: "inner", Patch: &opendesignerv1.Node{Modes: map[string]string{"theme": "light"}}, Mask: mask("modes")}}})
	if got := ActiveMode(doc, "r", "theme"); got != "light" {
		t.Fatalf("nearest override: mode=%q, want light", got)
	}
	// The document itself is never touched by resolution.
	if doc.Nodes["r"].GetFills()[0].GetSolid().GetColor().GetR() != 1 || doc.Nodes["r"].GetOpacity() != 1 {
		t.Fatal("ResolveNode mutated the document")
	}
}

func TestResolveFallsBackToDefaultModeValue(t *testing.T) {
	doc := themed(t)
	// "spacing" only has a light value; in dark it falls back to the default mode.
	mustApply(t, doc,
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetVariable{SetVariable: &opendesignerv1.SetVariable{Variable: &opendesignerv1.Variable{
			Id: "rot", CollectionId: "theme", Type: opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER,
			Values: map[string]*opendesignerv1.VariableValue{"light": numVal(15)}}}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
			Id: "r", Patch: &opendesignerv1.Node{Bindings: map[string]string{"rotation": "rot"}}, Mask: mask("bindings")}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
			Id: "f", Patch: &opendesignerv1.Node{Modes: map[string]string{"theme": "dark"}}, Mask: mask("modes")}}},
	)
	if got := ResolveNode(doc, doc.Nodes["r"]).GetRotation(); got != 15 {
		t.Fatalf("rotation=%v, want the default-mode value 15", got)
	}
}

func TestResolveWithoutBindingsReturnsTheSameNode(t *testing.T) {
	doc := themed(t)
	if n := doc.Nodes["f"]; ResolveNode(doc, n) != n {
		t.Fatal("a node without bindings must be returned as is, not cloned")
	}
}

func TestResolveIgnoresBindingsThatNoLongerApply(t *testing.T) {
	doc := themed(t)
	// fills.3 does not exist: the binding is kept in the model but draws nothing.
	mustApply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: "r", Patch: &opendesignerv1.Node{Bindings: map[string]string{"fills.3": "bg", "corner_radius": "dim", "strokes.0.weight": "dim"}},
		Mask: mask("bindings")}}})
	r := ResolveNode(doc, doc.Nodes["r"])
	if len(r.GetFills()) != 1 || r.GetFills()[0].GetSolid().GetColor().GetR() != 1 {
		t.Fatalf("fills changed: %v", r.GetFills())
	}
	if r.GetRect().GetCornerRadius() != 1 {
		t.Fatalf("corner radius=%v, want the bound 1", r.GetRect().GetCornerRadius())
	}
}

func TestDeleteVariableAndCollectionKeepSharedNodesIntact(t *testing.T) {
	doc := themed(t)
	// A shallow copy sharing the nodes, as the hub does: the cascade must clone
	// the nodes it rewrites and leave the other document untouched.
	snap := &opendesignerv1.Document{Nodes: make(map[string]*opendesignerv1.Node, len(doc.Nodes))}
	for k, n := range doc.Nodes {
		snap.Nodes[k] = n
	}
	snap.Collections, snap.Variables = doc.Collections, doc.Variables
	before := proto.Clone(doc.Nodes["r"])
	cow := NewShared()
	if err := ApplyShared(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteCollection{DeleteCollection: &opendesignerv1.DeleteCollection{Id: "theme"}}}, cow); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(snap.Nodes["r"], before) {
		t.Fatal("cascade wrote through a shared node")
	}
	if len(doc.Nodes["r"].GetBindings()) != 0 || len(doc.Variables) != 0 || len(doc.Collections) != 0 {
		t.Fatalf("cascade incomplete: bindings=%v vars=%d cols=%d", doc.Nodes["r"].GetBindings(), len(doc.Variables), len(doc.Collections))
	}
}

func TestBindingType(t *testing.T) {
	num, col := opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER, opendesignerv1.VariableType_VARIABLE_TYPE_COLOR
	for key, want := range map[string]opendesignerv1.VariableType{
		"opacity": num, "rotation": num, "corner_radius": num, "strokes.0.weight": num, "fills.0": col, "strokes.12": col,
	} {
		if got, ok := BindingType(key); !ok || got != want {
			t.Errorf("%q: got %v,%v want %v", key, got, ok, want)
		}
	}
	for _, key := range []string{"", "x", "fills", "fills.", "fills.-1", "fills.01", "fills.a", "fills.0.weight", "strokes.0.color", "strokes.0.weight.x", "opacity.0"} {
		if _, ok := BindingType(key); ok {
			t.Errorf("%q must not be a binding key", key)
		}
	}
}

func TestSetVariableRejectsOutOfRangeColor(t *testing.T) {
	doc := themed(t)
	err := Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetVariable{SetVariable: &opendesignerv1.SetVariable{Variable: &opendesignerv1.Variable{
		Id: "bg", CollectionId: "theme", Type: opendesignerv1.VariableType_VARIABLE_TYPE_COLOR,
		Values: map[string]*opendesignerv1.VariableValue{"light": colorVal(2, 0, 0)}}}}})
	if !errors.Is(err, ErrVariableValue) {
		t.Fatalf("err=%v, want ErrVariableValue", err)
	}
}
