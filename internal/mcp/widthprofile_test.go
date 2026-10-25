package mcp_test

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestVariableWidthStrokeTool: set_stroke takes a preset or explicit width points, stores them on the
// stroke and refuses unknown presets and out-of-range points.
func TestVariableWidthStrokeTool(t *testing.T) {
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
	if _, err := s.SetStroke(ctx, odmcp.SetStrokeInput{Id: n.NodeId, Strokes: []odmcp.StrokeSpec{{Color: black, Weight: 8, WidthPreset: "lens"}}}); err != nil {
		t.Fatal(err)
	}
	if p := stored().GetWidthProfile(); len(p) != 3 || p[1].GetPosition() != 0.5 || p[1].GetLeft() != 1 || p[0].GetRight() != 0 {
		t.Fatalf("lens profile = %v", p)
	}
	explicit := []odmcp.WidthPointSpec{{Position: 0, Left: 2, Right: 0.5}, {Position: 1, Left: 0, Right: 0}}
	if _, err := s.SetStroke(ctx, odmcp.SetStrokeInput{Id: n.NodeId, Strokes: []odmcp.StrokeSpec{{Color: black, Weight: 8, WidthPreset: "bulge", WidthProfile: explicit}}}); err != nil {
		t.Fatal(err)
	}
	if p := stored().GetWidthProfile(); len(p) != 2 || p[0].GetLeft() != 2 || p[0].GetRight() != 0.5 {
		t.Fatalf("explicit points must win over the preset, got %v", p)
	}
	if _, err := s.SetStroke(ctx, odmcp.SetStrokeInput{Id: n.NodeId, Strokes: []odmcp.StrokeSpec{{Color: black, Weight: 8, WidthPreset: "uniform"}}}); err != nil {
		t.Fatal(err)
	}
	if p := stored().GetWidthProfile(); len(p) != 0 {
		t.Fatalf("uniform keeps a profile: %v", p)
	}
	for name, spec := range map[string]odmcp.StrokeSpec{
		"unknown preset": {Color: black, Weight: 8, WidthPreset: "wavy"},
		"position range": {Color: black, Weight: 8, WidthProfile: []odmcp.WidthPointSpec{{Position: 2, Left: 1, Right: 1}}},
		"negative width": {Color: black, Weight: 8, WidthProfile: []odmcp.WidthPointSpec{{Position: 0, Left: -1, Right: 1}}},
		"unsorted":       {Color: black, Weight: 8, WidthProfile: []odmcp.WidthPointSpec{{Position: 0.8, Left: 1, Right: 1}, {Position: 0.1, Left: 1, Right: 1}}},
	} {
		if _, err := s.SetStroke(ctx, odmcp.SetStrokeInput{Id: n.NodeId, Strokes: []odmcp.StrokeSpec{spec}}); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
