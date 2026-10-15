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
