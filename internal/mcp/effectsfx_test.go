package mcp_test

import (
	"context"
	"reflect"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestProgressiveBlurNoiseTextureAndGlassTools: set_properties writes the new effect kinds with
// their defaults, get_document lists the kinds, and out-of-range values are refused.
func TestProgressiveBlurNoiseTextureAndGlassTools(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	r, err := s.CreateRectangle(ctx, odmcp.CreateShapeInput{X: 0, Y: 0, Width: 80, Height: 80, Name: "R"})
	if err != nil {
		t.Fatal(err)
	}
	kinds := func() []string {
		t.Helper()
		doc, _ := s.GetDocument(ctx, struct{}{})
		for _, n := range doc.Nodes {
			if n.Id == r.NodeId {
				return n.EffectKinds
			}
		}
		t.Fatal("node not in the document view")
		return nil
	}

	end, seed, density := 24.0, uint32(9), 0.7
	_, err = s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: r.NodeId, Effects: []odmcp.EffectSpec{
		{Kind: "dropShadow", Blur: 4},
		{Kind: "progressiveBlur", EffectFx: odmcp.EffectFx{EndRadius: &end, Background: true}},
		{Kind: "noise", EffectFx: odmcp.EffectFx{Mode: "duo", Density: &density, Seed: &seed}},
		{Kind: "texture"},
		{Kind: "glass"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"dropShadow", "progressiveBlur", "noise", "texture", "glass"}
	if got := kinds(); !reflect.DeepEqual(got, want) {
		t.Fatalf("effectKinds = %v, want %v", got, want)
	}

	badDensity, badLight := 1.5, 2.0
	negative := -1.0
	for name, e := range map[string]odmcp.EffectSpec{
		"noise mode":    {Kind: "noise", EffectFx: odmcp.EffectFx{Mode: "grain"}},
		"noise density": {Kind: "noise", EffectFx: odmcp.EffectFx{Density: &badDensity}},
		"glass light":   {Kind: "glass", EffectFx: odmcp.EffectFx{Light: &badLight}},
		"blur radius":   {Kind: "progressiveBlur", EffectFx: odmcp.EffectFx{StartRadius: &negative}},
		"texture":       {Kind: "texture", EffectFx: odmcp.EffectFx{Intensity: &badLight}},
	} {
		if _, err := s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: r.NodeId, Effects: []odmcp.EffectSpec{e}}); err == nil {
			t.Errorf("%s: set_properties must refuse %+v", name, e)
		}
	}
	if got := kinds(); !reflect.DeepEqual(got, want) {
		t.Fatalf("a refused write changed the effects: %v", got)
	}
}
