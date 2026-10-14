package core

import (
	"errors"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

func col(r, g, b float32) *opendesignerv1.Color { return &opendesignerv1.Color{R: r, G: g, B: b, A: 1} }

func setVar(v *opendesignerv1.Variable) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetVariable{SetVariable: &opendesignerv1.SetVariable{Variable: v}}}
}

func setModes(ids ...string) *opendesignerv1.Op {
	var ms []*opendesignerv1.Mode
	for _, id := range ids {
		ms = append(ms, &opendesignerv1.Mode{Id: id, Name: id})
	}
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetModes{SetModes: &opendesignerv1.SetModes{Modes: ms}}}
}

func TestSetVariableUpsertAndDelete(t *testing.T) {
	doc := NewDocument("d", "d")
	v := &opendesignerv1.Variable{Id: "v1", Name: "color/brand", Values: map[string]*opendesignerv1.Color{"light": col(1, 0, 0)}}
	if err := Apply(doc, setVar(v)); err != nil {
		t.Fatal(err)
	}
	if doc.Variables["v1"].GetName() != "color/brand" {
		t.Fatalf("variable not stored: %v", doc.Variables)
	}
	v2 := &opendesignerv1.Variable{Id: "v1", Name: "color/brand", Values: map[string]*opendesignerv1.Color{"light": col(0, 1, 0)}}
	if err := Apply(doc, setVar(v2)); err != nil {
		t.Fatal(err)
	}
	if got := doc.Variables["v1"].GetValues()["light"].GetG(); got != 1 {
		t.Fatalf("upsert did not replace: g=%v", got)
	}
	del := &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteVariable{DeleteVariable: &opendesignerv1.DeleteVariable{Id: "v1"}}}
	if err := Apply(doc, del); err != nil {
		t.Fatal(err)
	}
	if err := Apply(doc, del); !errors.Is(err, ErrVariableNotFound) {
		t.Fatalf("deleting twice: want ErrVariableNotFound, got %v", err)
	}
}

func TestSetVariableRejectsInvalid(t *testing.T) {
	doc := NewDocument("d", "d")
	for name, v := range map[string]*opendesignerv1.Variable{
		"nil":       nil,
		"no id":     {Name: "x"},
		"no name":   {Id: "v"},
		"nil value": {Id: "v", Name: "x", Values: map[string]*opendesignerv1.Color{"light": nil}},
	} {
		if err := Apply(doc, setVar(v)); !errors.Is(err, ErrNilVariable) {
			t.Errorf("%s: want ErrNilVariable, got %v", name, err)
		}
	}
	if len(doc.Variables) != 0 {
		t.Fatalf("rejected ops must leave the document unchanged: %v", doc.Variables)
	}
}

func TestVariableValueForUnknownModeRejectedOnceModesExist(t *testing.T) {
	doc := NewDocument("d", "d")
	if err := Apply(doc, setModes("light", "dark")); err != nil {
		t.Fatal(err)
	}
	v := &opendesignerv1.Variable{Id: "v", Name: "x", Values: map[string]*opendesignerv1.Color{"sepia": col(1, 1, 1)}}
	if err := Apply(doc, setVar(v)); !errors.Is(err, ErrBadMode) {
		t.Fatalf("want ErrBadMode, got %v", err)
	}
}

func TestSetModesValidatesAndDropsStaleValues(t *testing.T) {
	doc := NewDocument("d", "d")
	if err := Apply(doc, setModes("light", "dark")); err != nil {
		t.Fatal(err)
	}
	v := &opendesignerv1.Variable{Id: "v", Name: "x", Values: map[string]*opendesignerv1.Color{"light": col(1, 1, 1), "dark": col(0, 0, 0)}}
	if err := Apply(doc, setVar(v)); err != nil {
		t.Fatal(err)
	}
	orig := doc.Variables["v"]
	if err := Apply(doc, setModes("light")); err != nil {
		t.Fatal(err)
	}
	if _, ok := doc.Variables["v"].GetValues()["dark"]; ok {
		t.Fatal("value of a removed mode must be dropped")
	}
	if _, ok := orig.GetValues()["dark"]; !ok {
		t.Fatal("the original variable must not be mutated in place (copy-on-write)")
	}
	for _, bad := range [][]string{{"a", "a"}, {""}} {
		if err := Apply(doc, setModes(bad...)); !errors.Is(err, ErrBadMode) {
			t.Errorf("modes %v: want ErrBadMode, got %v", bad, err)
		}
	}
	if len(doc.Modes) != 1 || doc.Modes[0].GetId() != "light" {
		t.Fatalf("a rejected SetModes must leave the modes unchanged: %v", doc.Modes)
	}
}

// --- kinds, aliases, bindings -----------------------------------------------------

const (
	tColor  = opendesignerv1.VariableType_VARIABLE_TYPE_COLOR
	tNumber = opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER
	tString = opendesignerv1.VariableType_VARIABLE_TYPE_STRING
)

func applyAll(t *testing.T, doc *opendesignerv1.Document, ops ...*opendesignerv1.Op) {
	t.Helper()
	for _, op := range ops {
		if err := Apply(doc, op); err != nil {
			t.Fatalf("Apply: %v", err)
		}
	}
}

func numVar(id string, vals map[string]float64) *opendesignerv1.Variable {
	return &opendesignerv1.Variable{Id: id, Name: "n/" + id, Type: tNumber, Numbers: vals}
}

func TestVariableKindsKeepToTheirOwnMap(t *testing.T) {
	doc := NewDocument("d", "d")
	bad := map[string]*opendesignerv1.Variable{
		"number with colour values": {Id: "a", Name: "a", Type: tNumber, Values: map[string]*opendesignerv1.Color{"x": col(1, 1, 1)}},
		"colour with numbers":       {Id: "b", Name: "b", Type: tColor, Numbers: map[string]float64{"x": 1}},
		"string with numbers":       {Id: "c", Name: "c", Type: tString, Numbers: map[string]float64{"x": 1}},
	}
	for name, v := range bad {
		if err := Apply(doc, setVar(v)); !errors.Is(err, ErrNilVariable) {
			t.Errorf("%s: want ErrNilVariable, got %v", name, err)
		}
	}
	applyAll(t, doc, setModes("light", "dark"), setVar(numVar("n", map[string]float64{"light": 4, "dark": 8})))
	if err := Apply(doc, setVar(numVar("m", map[string]float64{"sepia": 1}))); !errors.Is(err, ErrBadMode) {
		t.Fatalf("number for an unknown mode: want ErrBadMode, got %v", err)
	}
	// Removing a mode drops numbers and strings too.
	applyAll(t, doc, setModes("light"))
	if _, ok := doc.Variables["n"].GetNumbers()["dark"]; ok {
		t.Fatal("a removed mode's number must be dropped")
	}
	if doc.Variables["n"].GetType() != tNumber {
		t.Fatal("rewriting the variable on mode removal lost its type")
	}
}

func TestAliases(t *testing.T) {
	doc := NewDocument("d", "d")
	applyAll(t, doc, setModes("light", "dark"),
		setVar(&opendesignerv1.Variable{Id: "base", Name: "base", Values: map[string]*opendesignerv1.Color{"light": col(1, 0, 0), "dark": col(0, 0, 1)}}))
	alias := &opendesignerv1.Variable{Id: "sem", Name: "semantic", AliasOf: "base"}
	applyAll(t, doc, setVar(alias))
	if c, ok := ColorValue(doc, doc.Variables["sem"]); !ok || c.GetR() != 1 {
		t.Fatalf("alias must read the target's default-mode colour, got %v %v", c, ok)
	}
	// Changing the target is seen through the alias.
	applyAll(t, doc, setVar(&opendesignerv1.Variable{Id: "base", Name: "base", Values: map[string]*opendesignerv1.Color{"light": col(0, 1, 0)}}))
	if c, _ := ColorValue(doc, doc.Variables["sem"]); c.GetG() != 1 {
		t.Fatalf("alias did not follow its target: %v", c)
	}
	cases := map[string]*opendesignerv1.Variable{
		"unknown target":       {Id: "x", Name: "x", AliasOf: "ghost"},
		"self":                 {Id: "x", Name: "x", AliasOf: "x"},
		"carries values":       {Id: "x", Name: "x", AliasOf: "base", Values: map[string]*opendesignerv1.Color{"light": col(1, 1, 1)}},
		"different kind":       {Id: "x", Name: "x", Type: tNumber, AliasOf: "base"},
		"cycle through others": {Id: "base", Name: "base", AliasOf: "sem"},
	}
	for name, v := range cases {
		if err := Apply(doc, setVar(v)); !errors.Is(err, ErrBadAlias) {
			t.Errorf("%s: want ErrBadAlias, got %v", name, err)
		}
	}
	// Deleting the target leaves a dangling alias that reads as "no value".
	applyAll(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteVariable{DeleteVariable: &opendesignerv1.DeleteVariable{Id: "base"}}})
	if _, ok := ColorValue(doc, doc.Variables["sem"]); ok {
		t.Fatal("a dangling alias must not resolve")
	}
}

func addNode(t *testing.T, doc *opendesignerv1.Document, n *opendesignerv1.Node) {
	t.Helper()
	n.ParentId, n.Visible = "page1", true
	if n.Opacity == 0 {
		n.Opacity = 1
	}
	applyAll(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}})
}

func bindOp(id string, b map[string]string) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: id, Patch: &opendesignerv1.Node{Bindings: b}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"bindings"}},
	}}}
}

func TestBindingsDriveNodeProperties(t *testing.T) {
	doc := NewDocument("d", "d")
	text := &opendesignerv1.Node{Id: "t", OrderKey: "b", Shape: &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{Content: "old", Style: &opendesignerv1.TextStyle{FontSize: 12}}}}
	addNode(t, doc, &opendesignerv1.Node{Id: "r", OrderKey: "a", Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}}})
	addNode(t, doc, text)
	applyAll(t, doc, setModes("light", "dark"),
		setVar(numVar("radius", map[string]float64{"light": 8, "dark": 16})),
		setVar(numVar("size", map[string]float64{"light": 20})),
		setVar(numVar("op", map[string]float64{"light": 0.5})),
		setVar(&opendesignerv1.Variable{Id: "copy", Name: "copy", Type: tString, Strings: map[string]string{"light": "Hello"}}))
	applyAll(t, doc,
		bindOp("r", map[string]string{"corner_radius": "radius", "opacity": "op"}),
		bindOp("t", map[string]string{"font_size": "size", "text": "copy"}))
	if doc.Nodes["r"].GetRect().GetCornerRadius() != 8 || doc.Nodes["r"].GetOpacity() != 0.5 {
		t.Fatalf("rect not driven: %v", doc.Nodes["r"])
	}
	if tx := doc.Nodes["t"].GetText(); tx.GetStyle().GetFontSize() != 20 || tx.GetContent() != "Hello" {
		t.Fatalf("text not driven: %v", tx)
	}
	// Changing the variable restyles the bound node, in the same op.
	applyAll(t, doc, setVar(numVar("radius", map[string]float64{"light": 12, "dark": 16})))
	if doc.Nodes["r"].GetRect().GetCornerRadius() != 12 {
		t.Fatal("the bound radius did not follow the variable")
	}
	// A SetText on a bound text loses to the binding.
	applyAll(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetText{SetText: &opendesignerv1.SetText{Id: "t", Content: "typed"}}})
	if doc.Nodes["t"].GetText().GetContent() != "Hello" {
		t.Fatal("a bound text must keep following its variable")
	}
	// Deleting the variable keeps the last value.
	applyAll(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteVariable{DeleteVariable: &opendesignerv1.DeleteVariable{Id: "radius"}}})
	if doc.Nodes["r"].GetRect().GetCornerRadius() != 12 {
		t.Fatal("deleting the variable must leave the last value")
	}
}

func TestBindingsAreValidated(t *testing.T) {
	doc := NewDocument("d", "d")
	addNode(t, doc, &opendesignerv1.Node{Id: "r", OrderKey: "a", Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}}})
	applyAll(t, doc, setVar(numVar("n", map[string]float64{"x": 1})),
		setVar(&opendesignerv1.Variable{Id: "s", Name: "s", Type: tString, Strings: map[string]string{"x": "a"}}),
		setVar(&opendesignerv1.Variable{Id: "c", Name: "c", Values: map[string]*opendesignerv1.Color{"x": col(1, 1, 1)}}))
	for name, b := range map[string]map[string]string{
		"unknown property":    {"width": "n"},
		"unknown variable":    {"opacity": "ghost"},
		"colour for a number": {"opacity": "c"},
		"string for a number": {"opacity": "s"},
		"font size on a rect": {"font_size": "n"},
		"text on a rect":      {"text": "s"},
	} {
		if err := Apply(doc, bindOp("r", b)); !errors.Is(err, ErrBadBinding) {
			t.Errorf("%s: want ErrBadBinding, got %v", name, err)
		}
	}
	// A rejected bind must leave the node untouched, and creating a node with a
	// bad binding is refused too.
	if len(doc.Nodes["r"].GetBindings()) != 0 {
		t.Fatal("a rejected binding was stored")
	}
	bad := &opendesignerv1.Node{Id: "z", ParentId: "page1", OrderKey: "z", Bindings: map[string]string{"opacity": "ghost"}}
	if err := Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: bad}}}); !errors.Is(err, ErrBadBinding) {
		t.Fatalf("create with a bad binding: want ErrBadBinding, got %v", err)
	}
}

func TestGradientStopsFollowTheirVariable(t *testing.T) {
	doc := NewDocument("d", "d")
	grad := &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Linear{Linear: &opendesignerv1.GradientPaint{
		X2: 1, Stops: []*opendesignerv1.GradientStop{
			{Color: col(0, 0, 0), Position: 0, VariableId: "brand"},
			{Color: col(1, 1, 1), Position: 1},
		}}}}
	applyAll(t, doc, setVar(&opendesignerv1.Variable{Id: "brand", Name: "brand", Values: map[string]*opendesignerv1.Color{"x": col(1, 0, 0)}}))
	n := &opendesignerv1.Node{Id: "r", OrderKey: "a", Fills: []*opendesignerv1.Paint{grad}, Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}}}
	addNode(t, doc, n)
	stop := func() *opendesignerv1.Color { return doc.Nodes["r"].GetFills()[0].GetLinear().GetStops()[0].GetColor() }
	if stop().GetR() != 1 {
		t.Fatalf("the bound stop must take the variable's colour on create, got %v", stop())
	}
	applyAll(t, doc, setVar(&opendesignerv1.Variable{Id: "brand", Name: "brand", Values: map[string]*opendesignerv1.Color{"x": col(0, 0, 1)}}))
	if stop().GetB() != 1 {
		t.Fatalf("the bound stop did not follow the variable, got %v", stop())
	}
	if doc.Nodes["r"].GetFills()[0].GetLinear().GetStops()[1].GetColor().GetR() != 1 {
		t.Fatal("an unbound stop must stay as it was")
	}
	// The op's own message must not have been written through.
	if grad.GetLinear().GetStops()[0].GetColor().GetR() != 0 {
		t.Fatal("resolveStops mutated the caller's paint instead of a copy")
	}
}
