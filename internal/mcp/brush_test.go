package mcp_test

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestBrushStrokeTool: set_stroke takes a brush preset or an explicit kind with parameters, stores it on
// the stroke, lets explicit fields override the preset and refuses unknown names and out-of-range values.
func TestBrushStrokeTool(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()
	home := frame(t, s, "Home")
	n, err := s.CreateRectangle(ctx, odmcp.CreateShapeInput{ParentId: home, Width: 40, Height: 40})
	if err != nil {
		t.Fatal(err)
	}
	black := odmcp.RGBA{A: 1}
	stored := func() *opendesignerv1.Stroke {
		open, err := odmcp.NewClient(url).OpenDocument(ctx, connect.NewRequest(&opendesignerv1.OpenRequest{DocId: docID}))
		if err != nil {
			t.Fatal(err)
		}
		return open.Msg.GetSnapshot().GetNodes()[n.NodeId].GetStrokes()[0]
	}
	set := func(b *odmcp.BrushSpec) error {
		_, err := s.SetStroke(ctx, odmcp.SetStrokeInput{Id: n.NodeId, Strokes: []odmcp.StrokeSpec{{Color: black, Weight: 6, Brush: b}}})
		return err
	}
	if err := set(&odmcp.BrushSpec{Preset: "leaves"}); err != nil {
		t.Fatal(err)
	}
	if b := stored().GetBrush(); b.GetKind() != opendesignerv1.BrushKind_BRUSH_KIND_SCATTER || b.GetTip() != opendesignerv1.BrushTip_BRUSH_TIP_LEAF || b.GetSpacing() != 1.5 || b.GetSeed() != 4 {
		t.Fatalf("leaves preset = %v", b)
	}
	sp, seed := 0.9, uint32(99)
	if err := set(&odmcp.BrushSpec{Preset: "marker", Tip: "square", Spacing: &sp, Seed: &seed}); err != nil {
		t.Fatal(err)
	}
	if b := stored().GetBrush(); b.GetKind() != opendesignerv1.BrushKind_BRUSH_KIND_STRETCH || b.GetTip() != opendesignerv1.BrushTip_BRUSH_TIP_SQUARE || b.GetSpacing() != 0.9 || b.GetSeed() != 99 {
		t.Fatalf("explicit fields must override the preset, got %v", b)
	}
	if err := set(&odmcp.BrushSpec{Kind: "scatter"}); err != nil {
		t.Fatal(err)
	}
	if b := stored().GetBrush(); b.GetSpacing() != 1 {
		t.Fatalf("a kind without spacing defaults to one weight, got %v", b)
	}
	if err := set(&odmcp.BrushSpec{Preset: "none"}); err != nil {
		t.Fatal(err)
	}
	if b := stored().GetBrush(); b != nil {
		t.Fatalf("none keeps a brush: %v", b)
	}
	bad, big := -1.0, 100.0
	for name, spec := range map[string]*odmcp.BrushSpec{
		"unknown preset": {Preset: "glitter"},
		"unknown kind":   {Kind: "smear"},
		"unknown tip":    {Kind: "scatter", Tip: "star"},
		"no kind":        {Tip: "dot"},
		"negative":       {Kind: "scatter", Scatter: &bad},
		"spacing range":  {Kind: "scatter", Spacing: &big},
	} {
		if err := set(spec); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
