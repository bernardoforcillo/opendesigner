package core

import (
	"errors"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Boolean variables (bound to "visible") and number variables bound to the spacing and
// padding of an auto layout frame: the layout reads them in the frame's active mode.

func boolVal(b bool) *opendesignerv1.VariableValue {
	return &opendesignerv1.VariableValue{Kind: &opendesignerv1.VariableValue_Boolean{Boolean: b}}
}

func pin(id, mode string) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: id, Patch: &opendesignerv1.Node{Modes: map[string]string{"density": mode}}, Mask: mask("modes")}}}
}

// row: a horizontal auto layout frame f with three 20x10 rectangles a, b, c (no spacing, no padding)
// and a "Density" collection with comfortable / compact modes.
func densityRow(t *testing.T) *opendesignerv1.Document {
	t.Helper()
	doc := NewDocument("d", "d")
	createNode(t, doc, layoutFrameNode("f", "page1", "a0", 200, 100, &al{Direction: horiz}))
	for i, id := range []string{"a", "b", "c"} {
		createNode(t, doc, layoutBox(id, "f", string(rune('a'+i)), 20, 10))
	}
	mustApply(t, doc,
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetCollection{SetCollection: &opendesignerv1.SetCollection{Collection: &opendesignerv1.VariableCollection{
			Id: "density", Name: "Density", Modes: []*opendesignerv1.VariableMode{{Id: "comfortable"}, {Id: "compact"}}}}}},
	)
	return doc
}

func TestSpacingBoundToANumberVariable(t *testing.T) {
	doc := densityRow(t)
	mustApply(t, doc,
		setVar(&opendesignerv1.Variable{Id: "gap", CollectionId: "density", Type: opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER,
			Values: map[string]*opendesignerv1.VariableValue{"comfortable": numVal(16), "compact": numVal(4)}}),
		setVar(&opendesignerv1.Variable{Id: "pad", CollectionId: "density", Type: opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER,
			Values: map[string]*opendesignerv1.VariableValue{"comfortable": numVal(12), "compact": numVal(2)}}),
		bindOp("f", map[string]string{"spacing": "gap", "padding_left": "pad", "padding_top": "pad"}),
	)
	// The first mode: gap 16, padding 12.
	if got := posOf(doc, "b"); got != [2]float64{12 + 20 + 16, 12} {
		t.Fatalf("b at %v, want {48 12}", got)
	}
	// Pinning the frame to compact reflows it; so does editing the variable and unpinning.
	mustApply(t, doc, pin("f", "compact"))
	if got := posOf(doc, "b"); got != [2]float64{2 + 20 + 4, 2} {
		t.Errorf("compact: b at %v, want {26 2}", got)
	}
	mustApply(t, doc, setVar(&opendesignerv1.Variable{Id: "gap", CollectionId: "density", Type: opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER,
		Values: map[string]*opendesignerv1.VariableValue{"comfortable": numVal(16), "compact": numVal(10)}}))
	if got := posOf(doc, "c"); got != [2]float64{2 + 20 + 10 + 20 + 10, 2} {
		t.Errorf("compact gap 10: c at %v, want {62 2}", got)
	}
	// The stored auto layout keeps its literal: the binding is what the layout reads.
	if doc.Nodes["f"].GetFrame().GetAutoLayout().GetSpacing() != 0 {
		t.Error("the binding rewrote the frame's literal spacing")
	}
	// An alias carries the binding along: a semantic token over the primitive.
	mustApply(t, doc,
		setVar(&opendesignerv1.Variable{Id: "gap-sem", CollectionId: "density", Type: opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER, AliasOf: "gap"}),
		bindOp("f", map[string]string{"spacing": "gap-sem"}),
	)
	if got := posOf(doc, "b"); got != [2]float64{0 + 20 + 10, 0} {
		t.Errorf("alias, no padding binding: b at %v, want {30 0}", got)
	}
	// Deleting the variable unbinds it: the literal (0) is back.
	mustApply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteVariable{DeleteVariable: &opendesignerv1.DeleteVariable{Id: "gap"}}})
	if got := posOf(doc, "b"); got != [2]float64{20, 0} {
		t.Errorf("after delete: b at %v, want {20 0}", got)
	}
}

func TestVisibilityBoundToABooleanVariable(t *testing.T) {
	doc := densityRow(t)
	mustApply(t, doc,
		setVar(&opendesignerv1.Variable{Id: "show", CollectionId: "density", Type: opendesignerv1.VariableType_VARIABLE_TYPE_BOOLEAN,
			Values: map[string]*opendesignerv1.VariableValue{"comfortable": boolVal(true), "compact": boolVal(false)}}),
		bindOp("b", map[string]string{"visible": "show"}),
	)
	if got := posOf(doc, "c"); got != [2]float64{40, 0} {
		t.Fatalf("c at %v, want {40 0}", got)
	}
	mustApply(t, doc, pin("f", "compact"))
	if got := posOf(doc, "c"); got != [2]float64{20, 0} {
		t.Errorf("hidden in compact: c at %v, want {20 0}", got)
	}
	if !doc.Nodes["b"].GetVisible() {
		t.Error("the binding rewrote the node's literal visibility")
	}
	if r := ResolveNode(doc, doc.Nodes["b"]); r.GetVisible() {
		t.Error("ResolveNode left b visible in compact")
	}
	// Changing the value shows it again.
	mustApply(t, doc, setVar(&opendesignerv1.Variable{Id: "show", CollectionId: "density", Type: opendesignerv1.VariableType_VARIABLE_TYPE_BOOLEAN,
		Values: map[string]*opendesignerv1.VariableValue{"comfortable": boolVal(true), "compact": boolVal(true)}}))
	if got := posOf(doc, "c"); got != [2]float64{40, 0} {
		t.Errorf("shown again: c at %v, want {40 0}", got)
	}
}

func TestBooleanVariableRules(t *testing.T) {
	doc := densityRow(t)
	apply := func(op *opendesignerv1.Op) error { return Apply(doc, op) }
	// A boolean variable holds booleans only, and binds only to visible.
	if err := apply(setVar(&opendesignerv1.Variable{Id: "x", CollectionId: "density", Type: opendesignerv1.VariableType_VARIABLE_TYPE_BOOLEAN,
		Values: map[string]*opendesignerv1.VariableValue{"comfortable": numVal(1)}})); !errors.Is(err, ErrVariableValue) {
		t.Errorf("number in a boolean variable: %v", err)
	}
	mustApply(t, doc, setVar(&opendesignerv1.Variable{Id: "show", CollectionId: "density", Type: opendesignerv1.VariableType_VARIABLE_TYPE_BOOLEAN,
		Values: map[string]*opendesignerv1.VariableValue{"comfortable": boolVal(true)}}))
	if err := apply(bindOp("a", map[string]string{"opacity": "show"})); !errors.Is(err, ErrBindingVariable) {
		t.Errorf("a boolean bound to opacity: %v", err)
	}
	if err := apply(bindOp("a", map[string]string{"visible": "nope"})); !errors.Is(err, ErrBindingVariable) {
		t.Errorf("visible bound to a missing variable: %v", err)
	}
	mustApply(t, doc, setVar(&opendesignerv1.Variable{Id: "show2", CollectionId: "density", Type: opendesignerv1.VariableType_VARIABLE_TYPE_BOOLEAN, AliasOf: "show"}))
	if err := apply(setVar(&opendesignerv1.Variable{Id: "num", CollectionId: "density", Type: opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER, AliasOf: "show"})); !errors.Is(err, ErrVariableAlias) {
		t.Errorf("a number aliasing a boolean: %v", err)
	}
	// A cycle between booleans is refused like any other.
	if err := apply(setVar(&opendesignerv1.Variable{Id: "show", CollectionId: "density", Type: opendesignerv1.VariableType_VARIABLE_TYPE_BOOLEAN, AliasOf: "show2"})); err == nil {
		t.Error("alias cycle accepted")
	}
}
