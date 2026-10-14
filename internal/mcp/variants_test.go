package mcp_test

import (
	"context"
	"strings"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestVariantToolsEndToEnd: an agent makes two button masters, groups them into
// a set, places an instance and switches its variant, and meets the refusals it
// must be able to act on.
func TestVariantToolsEndToEnd(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	small, large := frame(t, s, "Button S"), frame(t, s, "Button L")
	cs, err := s.CreateComponent(ctx, odmcp.CreateComponentInput{RootNodeId: small, Name: "Button/S"})
	if err != nil {
		t.Fatal(err)
	}
	cl, err := s.CreateComponent(ctx, odmcp.CreateComponentInput{RootNodeId: large, Name: "Button/L"})
	if err != nil {
		t.Fatal(err)
	}

	set, err := s.SetComponentSet(ctx, odmcp.SetComponentSetInput{Name: "Button", Properties: []odmcp.VariantPropertyIO{{Name: "Size", Values: []string{"S", "L"}}}})
	if err != nil || set.SetId == "" {
		t.Fatalf("SetComponentSet: %+v %v", set, err)
	}
	if _, err := s.SetComponentSet(ctx, odmcp.SetComponentSetInput{Name: "Bad", Properties: []odmcp.VariantPropertyIO{{Name: "Size"}}}); err == nil || !strings.Contains(err.Error(), "at least one value") {
		t.Fatalf("a property without values must be refused with the rule named, got %v", err)
	}
	if _, err := s.SetComponentSet(ctx, odmcp.SetComponentSetInput{Id: "ghost", Name: "x"}); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("replacing an unknown set must say not found, got %v", err)
	}

	if _, err := s.SetComponentVariant(ctx, odmcp.SetComponentVariantInput{ComponentId: cs.ComponentId, SetId: set.SetId, Variant: map[string]string{"Size": "S"}}); err != nil {
		t.Fatalf("assign S: %v", err)
	}
	if _, err := s.SetComponentVariant(ctx, odmcp.SetComponentVariantInput{ComponentId: cl.ComponentId, SetId: set.SetId, Variant: map[string]string{"Size": "S"}}); err == nil || !strings.Contains(err.Error(), "already") {
		t.Fatalf("a duplicate combination must be refused, got %v", err)
	}
	if _, err := s.SetComponentVariant(ctx, odmcp.SetComponentVariantInput{ComponentId: cl.ComponentId, SetId: set.SetId, Variant: map[string]string{"Size": "L"}}); err != nil {
		t.Fatalf("assign L: %v", err)
	}

	inst, err := s.CreateInstance(ctx, odmcp.CreateInstanceInput{ComponentId: cs.ComponentId, X: 10, Y: 10})
	if err != nil {
		t.Fatalf("CreateInstance: %v", err)
	}
	if _, err := s.SwapInstance(ctx, odmcp.SwapInstanceInput{InstanceId: inst.NodeId, ComponentId: cl.ComponentId}); err != nil {
		t.Fatalf("SwapInstance: %v", err)
	}
	if _, err := s.SwapInstance(ctx, odmcp.SwapInstanceInput{InstanceId: small, ComponentId: cl.ComponentId}); err == nil || !strings.Contains(err.Error(), "not an instance") {
		t.Fatalf("swapping a non-instance must be refused, got %v", err)
	}

	list, _ := s.ListComponentSets(ctx, struct{}{})
	if len(list.Sets) != 1 || len(list.Sets[0].Members) != 2 || list.Sets[0].Members[0].Variant["Size"] == "" {
		t.Fatalf("ListComponentSets = %+v", list)
	}
	doc, _ := s.GetDocument(ctx, struct{}{})
	if len(doc.ComponentSets) != 1 {
		t.Fatalf("get_document lacks the sets: %+v", doc.ComponentSets)
	}
	comps, _ := s.ListComponents(ctx, struct{}{})
	for _, c := range comps.Components {
		if c.SetId != set.SetId || c.Variant["Size"] == "" {
			t.Errorf("list_components lacks the variant: %+v", c)
		}
	}

	// Editing the set migrates members; a clash is refused.
	if _, err := s.SetComponentSet(ctx, odmcp.SetComponentSetInput{Id: set.SetId, Name: "Button", Properties: []odmcp.VariantPropertyIO{{Name: "Size", Values: []string{"S", "L", "XL"}}}}); err != nil {
		t.Fatalf("adding a value: %v", err)
	}
	if _, err := s.SetComponentSet(ctx, odmcp.SetComponentSetInput{Id: set.SetId, Name: "Button", Properties: []odmcp.VariantPropertyIO{{Name: "Size", Values: []string{"X"}}}}); err == nil || !strings.Contains(err.Error(), "same variant") {
		t.Fatalf("a clash must be refused, got %v", err)
	}
	if _, err := s.DeleteComponentSet(ctx, odmcp.SetIdInput{Id: set.SetId}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.DeleteComponentSet(ctx, odmcp.SetIdInput{Id: set.SetId}); err == nil {
		t.Fatal("deleting twice must fail")
	}
}
