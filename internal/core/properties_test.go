package core

import (
	"errors"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

const (
	pBool = opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_BOOLEAN
	pText = opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_TEXT
)

// addChild creates `n` under `parent` (addNode always puts nodes on the page).
func addChild(t *testing.T, doc *opendesignerv1.Document, parent string, n *opendesignerv1.Node) {
	t.Helper()
	n.ParentId, n.Visible, n.Opacity = parent, true, 1
	applyAll(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}})
}

func propsOp(comp string, ps ...*opendesignerv1.ComponentProperty) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComponentProperties{SetComponentProperties: &opendesignerv1.SetComponentProperties{ComponentId: comp, Properties: ps}}}
}

func instPropOp(inst, name, value string) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstanceProperty{SetInstanceProperty: &opendesignerv1.SetInstanceProperty{InstanceId: inst, Name: name, Value: value}}}
}

func TestComponentPropertyDefinitions(t *testing.T) {
	doc := NewDocument("d", "d")
	_, label := button(t, doc, "a", "a")
	button(t, doc, "b", "b")
	good := &opendesignerv1.ComponentProperty{Name: "Label", Type: pText, NodeId: label, DefaultValue: "Hi"}
	flag := &opendesignerv1.ComponentProperty{Name: "Show root", Type: pBool, NodeId: "a-root"}
	applyAll(t, doc, propsOp("a", good, flag))
	got := doc.Components["a"].Properties
	if len(got) != 2 || got[1].DefaultValue != "true" {
		t.Fatalf("a boolean without a default must default to true: %v", got)
	}
	for name, op := range map[string]*opendesignerv1.Op{
		"unknown component": propsOp("ghost", good),
		"duplicate name":    propsOp("a", good, good),
		"empty name":        propsOp("a", &opendesignerv1.ComponentProperty{Type: pBool, NodeId: label}),
		"target elsewhere":  propsOp("a", &opendesignerv1.ComponentProperty{Name: "X", Type: pBool, NodeId: "b-label"}),
		"unknown node":      propsOp("a", &opendesignerv1.ComponentProperty{Name: "X", Type: pBool, NodeId: "ghost"}),
		"text on a frame":   propsOp("a", &opendesignerv1.ComponentProperty{Name: "X", Type: pText, NodeId: "a-root"}),
		"bad boolean":       propsOp("a", &opendesignerv1.ComponentProperty{Name: "X", Type: pBool, NodeId: label, DefaultValue: "maybe"}),
		"no type":           propsOp("a", &opendesignerv1.ComponentProperty{Name: "X", NodeId: label}),
	} {
		if err := Apply(doc, op); err == nil {
			t.Errorf("%s: must be refused", name)
		}
	}
	if len(doc.Components["a"].Properties) != 2 {
		t.Fatal("a refused op changed the definitions")
	}
}

func TestInstancePropertyValuesAndEffects(t *testing.T) {
	doc := NewDocument("d", "d")
	_, label := button(t, doc, "a", "a")
	applyAll(t, doc, propsOp("a",
		&opendesignerv1.ComponentProperty{Name: "Label", Type: pText, NodeId: label, DefaultValue: "Hi"},
		&opendesignerv1.ComponentProperty{Name: "Icon", Type: pBool, NodeId: label, DefaultValue: "false"}))
	addNode(t, doc, &opendesignerv1.Node{Id: "i", OrderKey: "z", Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: "a"}}})

	inst := func() *opendesignerv1.InstanceNode { return doc.Nodes["i"].GetInstance() }
	fx := EffectsOf(doc, inst())
	if fx.Text[label] != "Hi" || fx.Visible[label] {
		t.Fatalf("defaults: %+v", fx)
	}
	applyAll(t, doc, instPropOp("i", "Label", "Buy"), instPropOp("i", "Icon", "true"))
	fx = EffectsOf(doc, inst())
	if fx.Text[label] != "Buy" || !fx.Visible[label] {
		t.Fatalf("values must win over defaults: %+v", fx)
	}
	applyAll(t, doc, instPropOp("i", "Label", ""))
	if _, ok := inst().PropertyValues["Label"]; ok || EffectsOf(doc, inst()).Text[label] != "Hi" {
		t.Fatal("an empty value must go back to the default")
	}
	for name, op := range map[string]*opendesignerv1.Op{
		"unknown instance": instPropOp("ghost", "Icon", "true"),
		"not an instance":  instPropOp("a-root", "Icon", "true"),
		"unknown property": instPropOp("i", "Nope", "true"),
		"bad boolean":      instPropOp("i", "Icon", "maybe"),
	} {
		if err := Apply(doc, op); err == nil {
			t.Errorf("%s: must be refused", name)
		}
	}
	if err := Apply(doc, instPropOp("i", "Nope", "x")); !errors.Is(err, ErrPropertyNotFound) {
		t.Fatalf("want ErrPropertyNotFound, got %v", err)
	}
}

func TestPropertyValuesSurviveASwapAndOnlyApplyWhereDefined(t *testing.T) {
	doc := NewDocument("d", "d")
	_, la := button(t, doc, "a", "a")
	button(t, doc, "b", "b")
	applyAll(t, doc, propsOp("a", &opendesignerv1.ComponentProperty{Name: "Icon", Type: pBool, NodeId: la}))
	addNode(t, doc, &opendesignerv1.Node{Id: "i", OrderKey: "z", Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: "a"}}})
	applyAll(t, doc, instPropOp("i", "Icon", "false"), swapOp("i", "b"))
	if doc.Nodes["i"].GetInstance().PropertyValues["Icon"] != "false" {
		t.Fatal("a swap must keep the instance's values")
	}
	if fx := EffectsOf(doc, doc.Nodes["i"].GetInstance()); len(fx.Visible) != 0 {
		t.Fatalf("component b has no such property: %+v", fx)
	}
}

func TestDeletingATargetLayerDropsItsProperty(t *testing.T) {
	doc := NewDocument("d", "d")
	_, label := button(t, doc, "a", "a")
	applyAll(t, doc, propsOp("a",
		&opendesignerv1.ComponentProperty{Name: "Label", Type: pText, NodeId: label, DefaultValue: "Hi"},
		&opendesignerv1.ComponentProperty{Name: "Root", Type: pBool, NodeId: "a-root"}))
	applyAll(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteNode{DeleteNode: &opendesignerv1.DeleteNode{Id: label}}})
	got := doc.Components["a"].Properties
	if len(got) != 1 || got[0].Name != "Root" {
		t.Fatalf("the property of the deleted layer must go, the other stay: %v", got)
	}
}

const (
	pNum  = opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_NUMBER
	pSwap = opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_INSTANCE_SWAP
)

func TestNumberProperties(t *testing.T) {
	doc := NewDocument("d", "d")
	_, label := button(t, doc, "a", "a")
	addChild(t, doc, "a-root", &opendesignerv1.Node{Id: "r", OrderKey: "q", Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}}})
	good := []*opendesignerv1.ComponentProperty{
		{Name: "Radius", Type: pNum, NodeId: "r", Attribute: "corner_radius", DefaultValue: "8"},
		{Name: "Size", Type: pNum, NodeId: label, Attribute: "font_size"},
		{Name: "Fade", Type: pNum, NodeId: "r", Attribute: "opacity", DefaultValue: "0.5"},
	}
	applyAll(t, doc, propsOp("a", good...))
	for name, p := range map[string]*opendesignerv1.ComponentProperty{
		"no attribute":         {Name: "X", Type: pNum, NodeId: "r"},
		"unknown attribute":    {Name: "X", Type: pNum, NodeId: "r", Attribute: "width"},
		"radius on a text":     {Name: "X", Type: pNum, NodeId: label, Attribute: "corner_radius"},
		"font size on a rect":  {Name: "X", Type: pNum, NodeId: "r", Attribute: "font_size"},
		"default not a number": {Name: "X", Type: pNum, NodeId: "r", Attribute: "opacity", DefaultValue: "lots"},
	} {
		if err := Apply(doc, propsOp("a", p)); err == nil {
			t.Errorf("%s: must be refused", name)
		}
	}
	addNode(t, doc, &opendesignerv1.Node{Id: "i", OrderKey: "z", Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: "a"}}})
	fx := EffectsOf(doc, doc.Nodes["i"].GetInstance())
	if fx.CornerRadius["r"] != 8 || fx.Opacity["r"] != 0.5 || len(fx.FontSize) != 0 {
		t.Fatalf("defaults: %+v (an empty default writes nothing)", fx)
	}
	applyAll(t, doc, instPropOp("i", "Size", "20"), instPropOp("i", "Radius", "16"))
	fx = EffectsOf(doc, doc.Nodes["i"].GetInstance())
	if fx.FontSize[label] != 20 || fx.CornerRadius["r"] != 16 {
		t.Fatalf("values: %+v", fx)
	}
	if err := Apply(doc, instPropOp("i", "Radius", "wide")); err == nil || !errors.Is(err, ErrBadProperty) {
		t.Fatalf("a non-number must be refused, got %v", err)
	}
}

func TestOptionListProperties(t *testing.T) {
	doc := NewDocument("d", "d")
	_, label := button(t, doc, "a", "a")
	for name, p := range map[string]*opendesignerv1.ComponentProperty{
		"duplicate option":      {Name: "Tone", Type: pText, NodeId: label, Options: []string{"Info", "Info"}},
		"empty option":          {Name: "Tone", Type: pText, NodeId: label, Options: []string{"Info", ""}},
		"default not an option": {Name: "Tone", Type: pText, NodeId: label, Options: []string{"Info", "Warn"}, DefaultValue: "Danger"},
	} {
		if err := Apply(doc, propsOp("a", p)); err == nil {
			t.Errorf("%s: must be refused", name)
		}
	}
	applyAll(t, doc, propsOp("a", &opendesignerv1.ComponentProperty{Name: "Tone", Type: pText, NodeId: label, Options: []string{"Info", "Warn"}, DefaultValue: "Info"}))
	addNode(t, doc, &opendesignerv1.Node{Id: "i", OrderKey: "z", Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: "a"}}})
	applyAll(t, doc, instPropOp("i", "Tone", "Warn"))
	if EffectsOf(doc, doc.Nodes["i"].GetInstance()).Text[label] != "Warn" {
		t.Fatal("an option must write the text")
	}
	if err := Apply(doc, instPropOp("i", "Tone", "Danger")); err == nil {
		t.Fatal("a value outside the option list must be refused")
	}
}

func TestInstanceSwapProperties(t *testing.T) {
	doc := NewDocument("d", "d")
	button(t, doc, "a", "a") // the outer component's master is a-root
	button(t, doc, "b", "b")
	button(t, doc, "c", "c")
	// "a" contains a nested instance of "b".
	addChild(t, doc, "a-root", &opendesignerv1.Node{Id: "nested", OrderKey: "q", Name: "Icon", Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: "b"}}})
	good := &opendesignerv1.ComponentProperty{Name: "Icon", Type: pSwap, NodeId: "nested", DefaultValue: "b"}
	applyAll(t, doc, propsOp("a", good))
	for name, p := range map[string]*opendesignerv1.ComponentProperty{
		"node is not an instance": {Name: "X", Type: pSwap, NodeId: "a-label"},
		"unknown default":         {Name: "X", Type: pSwap, NodeId: "nested", DefaultValue: "ghost"},
		"into itself":             {Name: "X", Type: pSwap, NodeId: "nested", DefaultValue: "a"},
	} {
		if err := Apply(doc, propsOp("a", p)); err == nil {
			t.Errorf("%s: must be refused", name)
		}
	}
	addNode(t, doc, &opendesignerv1.Node{Id: "i", OrderKey: "z", Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: "a"}}})
	if EffectsOf(doc, doc.Nodes["i"].GetInstance()).Swap["nested"] != "b" {
		t.Fatal("the default must show")
	}
	applyAll(t, doc, instPropOp("i", "Icon", "c"))
	if EffectsOf(doc, doc.Nodes["i"].GetInstance()).Swap["nested"] != "c" {
		t.Fatal("the value must win")
	}
	if err := Apply(doc, instPropOp("i", "Icon", "ghost")); err == nil {
		t.Fatal("an unknown component must be refused")
	}
}
