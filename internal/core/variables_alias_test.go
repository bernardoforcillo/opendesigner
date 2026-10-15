package core

import (
	"errors"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

func strVal(s string) *opendesignerv1.VariableValue {
	return &opendesignerv1.VariableValue{Kind: &opendesignerv1.VariableValue_Text{Text: s}}
}

func setVar(v *opendesignerv1.Variable) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetVariable{SetVariable: &opendesignerv1.SetVariable{Variable: v}}}
}

func bindOp(id string, b map[string]string) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: id, Patch: &opendesignerv1.Node{Bindings: b}, Mask: mask("bindings")}}}
}

func TestBindingTypeTextAndFontSize(t *testing.T) {
	if got, ok := BindingType("font_size"); !ok || got != opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER {
		t.Errorf("font_size: %v,%v", got, ok)
	}
	if got, ok := BindingType("text"); !ok || got != opendesignerv1.VariableType_VARIABLE_TYPE_STRING {
		t.Errorf("text: %v,%v", got, ok)
	}
	for _, key := range []string{"text.0", "font_size.0", "fontSize"} {
		if _, ok := BindingType(key); ok {
			t.Errorf("%q must not be a binding key", key)
		}
	}
}

func TestAliasResolvesInTheAliasNodeMode(t *testing.T) {
	doc := themed(t)
	mustApply(t, doc,
		// A semantic token in the same collection, and one in a collection whose
		// mode ids do not match (it reads the target's first mode).
		setVar(&opendesignerv1.Variable{Id: "surface", CollectionId: "theme", Type: opendesignerv1.VariableType_VARIABLE_TYPE_COLOR, AliasOf: "bg"}),
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetCollection{SetCollection: &opendesignerv1.SetCollection{Collection: &opendesignerv1.VariableCollection{
			Id: "brand", Name: "Brand", Modes: []*opendesignerv1.VariableMode{{Id: "default"}}}}}},
		setVar(&opendesignerv1.Variable{Id: "card", CollectionId: "brand", Type: opendesignerv1.VariableType_VARIABLE_TYPE_COLOR, AliasOf: "surface"}),
		bindOp("r", map[string]string{"fills.0": "surface"}),
	)
	if got := ResolveNode(doc, doc.Nodes["r"]).GetFills()[0].GetSolid().GetColor().GetR(); got != 1 {
		t.Fatalf("light: r=%v, want 1", got)
	}
	mustApply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: "f", Patch: &opendesignerv1.Node{Modes: map[string]string{"theme": "dark"}}, Mask: mask("modes")}}})
	if got := ResolveNode(doc, doc.Nodes["r"]).GetFills()[0].GetSolid().GetColor().GetR(); got != 0 {
		t.Fatalf("dark: r=%v, want the target's dark value 0", got)
	}
	// "default" is not a mode of "theme": the target's first mode (light) applies,
	// whatever the node pins.
	mustApply(t, doc, bindOp("r", map[string]string{"fills.0": "card"}))
	if got := ResolveNode(doc, doc.Nodes["r"]).GetFills()[0].GetSolid().GetColor().GetR(); got != 1 {
		t.Fatalf("cross-collection alias: r=%v, want the first mode's 1", got)
	}
}

func TestAliasValidation(t *testing.T) {
	doc := themed(t)
	mustApply(t, doc, setVar(&opendesignerv1.Variable{Id: "a", CollectionId: "theme", Type: opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER, AliasOf: "dim"}))
	num, col := opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER, opendesignerv1.VariableType_VARIABLE_TYPE_COLOR
	for name, v := range map[string]*opendesignerv1.Variable{
		"missing target": {Id: "x", CollectionId: "theme", Type: num, AliasOf: "nope"},
		"type mismatch":  {Id: "x", CollectionId: "theme", Type: col, AliasOf: "dim"},
		"self":           {Id: "x", CollectionId: "theme", Type: num, AliasOf: "x"},
		"cycle":          {Id: "dim", CollectionId: "theme", Type: num, AliasOf: "a"},
		"with values":    {Id: "x", CollectionId: "theme", Type: num, AliasOf: "dim", Values: map[string]*opendesignerv1.VariableValue{"light": numVal(1)}},
	} {
		if err := Apply(doc, setVar(v)); !errors.Is(err, ErrVariableAlias) {
			t.Errorf("%s: err=%v, want ErrVariableAlias", name, err)
		}
	}
}

func TestDeleteTargetDeletesItsAliasesAndBindings(t *testing.T) {
	doc := themed(t)
	mustApply(t, doc,
		setVar(&opendesignerv1.Variable{Id: "a", CollectionId: "theme", Type: opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER, AliasOf: "dim"}),
		setVar(&opendesignerv1.Variable{Id: "b", CollectionId: "theme", Type: opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER, AliasOf: "a"}),
		bindOp("r", map[string]string{"opacity": "b", "fills.0": "bg"}),
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteVariable{DeleteVariable: &opendesignerv1.DeleteVariable{Id: "dim"}}},
	)
	if doc.Variables["a"] != nil || doc.Variables["b"] != nil {
		t.Fatalf("aliases survived their target: %v", doc.Variables)
	}
	if b := doc.Nodes["r"].GetBindings(); len(b) != 1 || b["fills.0"] != "bg" {
		t.Fatalf("bindings=%v, want only fills.0", b)
	}
}

func TestStringVariableBindsTextAndNumberBindsFontSize(t *testing.T) {
	doc := themed(t)
	txt := &opendesignerv1.Node{Id: "t", ParentId: "f", OrderKey: "a2", Visible: true, Opacity: 1,
		Shape: &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{Content: "hi", Style: &opendesignerv1.TextStyle{FontSize: 12}}}}
	mustApply(t, doc,
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: txt}}},
		setVar(&opendesignerv1.Variable{Id: "title", CollectionId: "theme", Type: opendesignerv1.VariableType_VARIABLE_TYPE_STRING,
			Values: map[string]*opendesignerv1.VariableValue{"light": strVal("Hello"), "dark": strVal("Hola")}}),
		setVar(&opendesignerv1.Variable{Id: "label", CollectionId: "theme", Type: opendesignerv1.VariableType_VARIABLE_TYPE_STRING, AliasOf: "title"}),
		setVar(&opendesignerv1.Variable{Id: "size", CollectionId: "theme", Type: opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER,
			Values: map[string]*opendesignerv1.VariableValue{"light": numVal(20)}}),
		bindOp("t", map[string]string{"text": "label", "font_size": "size"}),
	)
	got := ResolveNode(doc, doc.Nodes["t"]).GetText()
	if got.GetContent() != "Hello" || got.GetStyle().GetFontSize() != 20 {
		t.Fatalf("resolved text=%q size=%v", got.GetContent(), got.GetStyle().GetFontSize())
	}
	if doc.Nodes["t"].GetText().GetContent() != "hi" {
		t.Fatal("ResolveNode mutated the document")
	}
	// A string needs "text", a number needs a number key, whatever the node is.
	for key, id := range map[string]string{"text": "size", "opacity": "title", "font_size": "title", "fills.0": "title"} {
		if err := Apply(doc, bindOp("t", map[string]string{key: id})); !errors.Is(err, ErrBindingVariable) {
			t.Errorf("%s -> %s: err=%v, want ErrBindingVariable", key, id, err)
		}
	}
	// A non-text node ignores text bindings: the literal stays.
	mustApply(t, doc, bindOp("r", map[string]string{"text": "title"}))
	if ResolveNode(doc, doc.Nodes["r"]).GetText() != nil {
		t.Fatal("a rectangle took a text binding")
	}
	// A string variable cannot hold a number.
	err := Apply(doc, setVar(&opendesignerv1.Variable{Id: "bad", CollectionId: "theme", Type: opendesignerv1.VariableType_VARIABLE_TYPE_STRING,
		Values: map[string]*opendesignerv1.VariableValue{"light": numVal(1)}}))
	if !errors.Is(err, ErrVariableValue) {
		t.Fatalf("err=%v, want ErrVariableValue", err)
	}
}
