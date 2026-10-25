package mcp_test

import (
	"context"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestInstanceToolsEndToEnd: swap an instance to another component (keeping the override on
// the layer both masters have), reset it, find its main component and detach it.
func TestInstanceToolsEndToEnd(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	master := func(name string, w, h float64) (root, label string) {
		root = frame(t, s, name)
		sz := odmcp.SetPropertiesInput{Id: root, Width: &w, Height: &h}
		if _, err := s.SetProperties(ctx, sz); err != nil {
			t.Fatal(err)
		}
		l, err := s.CreateText(ctx, odmcp.CreateTextInput{ParentId: root, Content: name, Width: 100, Height: 20, Name: "Label"})
		if err != nil {
			t.Fatal(err)
		}
		return root, l.NodeId
	}
	r1, l1 := master("Button", 100, 40)
	r2, l2 := master("Card", 200, 120)
	c1, err := s.CreateComponent(ctx, odmcp.CreateComponentInput{RootNodeId: r1, Name: "Button"})
	if err != nil {
		t.Fatal(err)
	}
	c2, err := s.CreateComponent(ctx, odmcp.CreateComponentInput{RootNodeId: r2, Name: "Card"})
	if err != nil {
		t.Fatal(err)
	}
	inst, err := s.CreateInstance(ctx, odmcp.CreateInstanceInput{ComponentId: c1.ComponentId, X: 10, Y: 10})
	if err != nil {
		t.Fatal(err)
	}
	pay := "Pay"
	if _, err := s.SetInstanceOverride(ctx, odmcp.SetInstanceOverrideInput{InstanceId: inst.NodeId, MasterNodeId: l1, Text: &pay}); err != nil {
		t.Fatal(err)
	}

	out, err := s.SwapInstance(ctx, odmcp.SwapInstanceInput{InstanceId: inst.NodeId, ComponentId: c2.ComponentId})
	if err != nil || out.KeptOverrides != 1 || out.DroppedOverrides != 0 {
		t.Fatalf("SwapInstance = %+v %v", out, err)
	}
	node := func(id string) odmcp.NodeView {
		doc, _ := s.GetDocument(ctx, struct{}{})
		for _, n := range doc.Nodes {
			if n.Id == id {
				return n
			}
		}
		t.Fatalf("node %s not found", id)
		return odmcp.NodeView{}
	}
	if n := node(inst.NodeId); n.Width != 200 || n.Height != 120 {
		t.Errorf("the swapped instance is %v x %v, want the card's 200 x 120", n.Width, n.Height)
	}
	main, err := s.GetMainComponent(ctx, odmcp.MainComponentInput{NodeId: inst.NodeId})
	if err != nil || main.ComponentId != c2.ComponentId || main.RootNodeId != r2 || main.PageId == "" {
		t.Fatalf("GetMainComponent = %+v %v", main, err)
	}

	if _, err := s.ResetInstanceOverrides(ctx, odmcp.ResetOverridesInput{InstanceId: inst.NodeId, MasterNodeId: l2}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ResetInstanceOverrides(ctx, odmcp.ResetOverridesInput{InstanceId: inst.NodeId}); err != nil {
		t.Fatal(err)
	}

	// Rejections reported before sending.
	if _, err := s.SwapInstance(ctx, odmcp.SwapInstanceInput{InstanceId: inst.NodeId, ComponentId: "nope"}); err == nil {
		t.Error("swap to an unknown component was accepted")
	}
	if _, err := s.DetachInstance(ctx, odmcp.DetachInstanceInput{InstanceId: l1}); err == nil {
		t.Error("detaching a text was accepted")
	}

	if _, err := s.SetInstanceOverride(ctx, odmcp.SetInstanceOverrideInput{InstanceId: inst.NodeId, MasterNodeId: l2, Text: &pay}); err != nil {
		t.Fatal(err)
	}
	det, err := s.DetachInstance(ctx, odmcp.DetachInstanceInput{InstanceId: inst.NodeId})
	if err != nil || det.Changed != 2 {
		t.Fatalf("DetachInstance = %+v %v", det, err)
	}
	doc, _ := s.GetDocument(ctx, struct{}{})
	var kids []odmcp.NodeView
	for _, n := range doc.Nodes {
		if n.ParentId == inst.NodeId {
			kids = append(kids, n)
		}
	}
	root := node(inst.NodeId)
	if root.Kind != "frame" || root.Width != 200 || len(kids) != 1 || kids[0].Kind != "text" {
		t.Fatalf("detached = %+v with children %+v", root, kids)
	}
}
