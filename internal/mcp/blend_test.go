package mcp_test

import (
	"context"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestBlendModeAndEffectsTools: set_properties writes the blend mode and the new
// effect kinds, and the node view reports the blend mode.
func TestBlendModeAndEffectsTools(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	r, err := s.CreateRectangle(ctx, odmcp.CreateShapeInput{X: 0, Y: 0, Width: 50, Height: 50, Name: "R"})
	if err != nil {
		t.Fatal(err)
	}
	mode := "multiply"
	_, err = s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: r.NodeId, BlendMode: &mode, Effects: []odmcp.EffectSpec{
		{Kind: "dropShadow", OffsetY: 2, Blur: 4}, {Kind: "innerShadow", Blur: 2}, {Kind: "backgroundBlur", Radius: 8},
	}})
	if err != nil {
		t.Fatal(err)
	}
	doc, _ := s.GetDocument(ctx, struct{}{})
	found := false
	for _, n := range doc.Nodes {
		if n.Id == r.NodeId {
			found = true
			if n.BlendMode != "multiply" {
				t.Errorf("blendMode = %q", n.BlendMode)
			}
		}
	}
	if !found {
		t.Fatal("node not in the document view")
	}
	bad := "plaid"
	if _, err := s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: r.NodeId, BlendMode: &bad}); err == nil {
		t.Error("an unknown blend mode must be rejected")
	}
	if _, err := s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: r.NodeId, Effects: []odmcp.EffectSpec{{Kind: "glow"}}}); err == nil {
		t.Error("an unknown effect kind must be rejected")
	}
}
