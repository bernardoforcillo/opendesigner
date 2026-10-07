package mcp_test

import (
	"context"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestVariantToolsEndToEnd: builds a two-variant "Button" set with a text and a boolean
// property, puts an instance on the hover variant with property values, reads it all
// back through list_components / get_document, and checks the rejections the tools
// report before sending and the cascades.
func TestVariantToolsEndToEnd(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	master := func(name string) (root, label, icon string) {
		root = frame(t, s, name)
		l, err := s.CreateText(ctx, odmcp.CreateTextInput{ParentId: root, Content: name, Width: 100, Height: 20})
		if err != nil {
			t.Fatal(err)
		}
		return root, l.NodeId, rect(t, s, root, "Icon")
	}
	r1, l1, i1 := master("Default")
	r2, l2, i2 := master("Hover")
	c1, err := s.CreateComponent(ctx, odmcp.CreateComponentInput{RootNodeId: r1, Name: "Button"})
	if err != nil {
		t.Fatal(err)
	}
	c2, err := s.CreateComponent(ctx, odmcp.CreateComponentInput{RootNodeId: r2, Name: "Button hover"})
	if err != nil {
		t.Fatal(err)
	}

	set, err := s.SetComponentSet(ctx, odmcp.SetComponentSetInput{Name: "Button", Axes: []odmcp.VariantAxisIO{{Name: "State", Options: []string{"default", "hover"}}}})
	if err != nil || set.ComponentSetId == "" {
		t.Fatalf("SetComponentSet = %+v %v", set, err)
	}
	props := func(label, icon string) []odmcp.ComponentPropertyIO {
		return []odmcp.ComponentPropertyIO{
			{Name: "Label", Type: "text", DefaultValue: "Button", TargetNodeIds: []string{label}},
			{Name: "ShowIcon", Type: "boolean", DefaultValue: "true", TargetNodeIds: []string{icon}},
		}
	}
	if _, err := s.SetComponentDef(ctx, odmcp.SetComponentDefInput{ComponentId: c1.ComponentId, SetId: set.ComponentSetId, Variant: map[string]string{"State": "default"}, Properties: props(l1, i1)}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetComponentDef(ctx, odmcp.SetComponentDefInput{ComponentId: c2.ComponentId, SetId: set.ComponentSetId, Variant: map[string]string{"State": "hover"}, Properties: props(l2, i2)}); err != nil {
		t.Fatal(err)
	}

	inst, err := s.CreateInstance(ctx, odmcp.CreateInstanceInput{ComponentId: c1.ComponentId, X: 10, Y: 10})
	if err != nil {
		t.Fatalf("CreateInstance: %v", err)
	}
	if _, err := s.SetInstanceProps(ctx, odmcp.SetInstancePropsInput{
		InstanceId: inst.NodeId, PropertyValues: map[string]string{"Label": "Save", "ShowIcon": "false"}, VariantProps: map[string]string{"State": "hover"},
	}); err != nil {
		t.Fatal(err)
	}

	sets, _ := s.ListComponentSets(ctx, struct{}{})
	if len(sets.ComponentSets) != 1 || len(sets.ComponentSets[0].Members) != 2 || sets.ComponentSets[0].Axes[0].Name != "State" {
		t.Fatalf("ListComponentSets = %+v", sets)
	}
	comps, _ := s.ListComponents(ctx, struct{}{})
	var found odmcp.ComponentView
	for _, c := range comps.Components {
		if c.Id == c2.ComponentId {
			found = c
		}
	}
	if found.SetId != set.ComponentSetId || found.Variant["State"] != "hover" || len(found.Properties) != 2 || found.Properties[0].Type != "text" {
		t.Fatalf("ListComponents hover = %+v", found)
	}
	doc, _ := s.GetDocument(ctx, struct{}{})
	if len(doc.ComponentSets) != 1 {
		t.Fatalf("get_document.componentSets = %+v", doc.ComponentSets)
	}

	for name, call := range map[string]func() error{
		"set without axes": func() error {
			_, err := s.SetComponentSet(ctx, odmcp.SetComponentSetInput{Name: "x"})
			return err
		},
		"duplicate variant": func() error {
			_, err := s.SetComponentDef(ctx, odmcp.SetComponentDefInput{ComponentId: c2.ComponentId, SetId: set.ComponentSetId, Variant: map[string]string{"State": "default"}})
			return err
		},
		"incomplete variant": func() error {
			_, err := s.SetComponentDef(ctx, odmcp.SetComponentDefInput{ComponentId: c1.ComponentId, SetId: set.ComponentSetId})
			return err
		},
		"bad property type": func() error {
			_, err := s.SetComponentDef(ctx, odmcp.SetComponentDefInput{ComponentId: c1.ComponentId, Properties: []odmcp.ComponentPropertyIO{{Name: "P", Type: "number", TargetNodeIds: []string{i1}}}})
			return err
		},
		"target outside the master": func() error {
			_, err := s.SetComponentDef(ctx, odmcp.SetComponentDefInput{ComponentId: c1.ComponentId, Properties: []odmcp.ComponentPropertyIO{{Name: "P", Type: "boolean", DefaultValue: "true", TargetNodeIds: []string{i2}}}})
			return err
		},
		"instance props on a non-instance": func() error {
			_, err := s.SetInstanceProps(ctx, odmcp.SetInstancePropsInput{InstanceId: r1})
			return err
		},
		"unknown property": func() error {
			_, err := s.SetInstanceProps(ctx, odmcp.SetInstancePropsInput{InstanceId: inst.NodeId, PropertyValues: map[string]string{"Nope": "x"}})
			return err
		},
		"unknown option": func() error {
			_, err := s.SetInstanceProps(ctx, odmcp.SetInstancePropsInput{InstanceId: inst.NodeId, VariantProps: map[string]string{"State": "pressed"}})
			return err
		},
		"missing set": func() error { _, err := s.DeleteComponentSet(ctx, odmcp.IdInput{Id: "ghost"}); return err },
	} {
		if err := call(); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}

	// Deleting the set detaches both members; the instance keeps its (now ignored) choice.
	if _, err := s.DeleteComponentSet(ctx, odmcp.IdInput{Id: set.ComponentSetId}); err != nil {
		t.Fatal(err)
	}
	comps, _ = s.ListComponents(ctx, struct{}{})
	for _, c := range comps.Components {
		if c.SetId != "" || len(c.Variant) != 0 {
			t.Fatalf("component %s still in the set: %+v", c.Id, c)
		}
	}
	_ = opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_TEXT
}
