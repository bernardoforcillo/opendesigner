package mcp_test

import (
	"context"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestLayoutLimitsAndPositioningTools: a limit clamps a child of an auto layout frame, an
// absolute child leaves the flow, and the node views report both.
func TestLayoutLimitsAndPositioningTools(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	row, err := s.CreateFrame(ctx, odmcp.CreateFrameInput{Width: 300, Height: 50, Name: "Row", AutoLayout: &odmcp.AutoLayoutSpec{
		Direction: "horizontal", Spacing: 10,
	}})
	if err != nil {
		t.Fatal(err)
	}
	var kids []string
	for range 3 {
		r, err := s.CreateRectangle(ctx, odmcp.CreateShapeInput{ParentId: row.NodeId, Width: 40, Height: 20})
		if err != nil {
			t.Fatal(err)
		}
		kids = append(kids, r.NodeId)
	}
	maxW := 25.0
	if out, err := s.SetLayoutLimits(ctx, odmcp.SetLayoutLimitsInput{NodeIds: kids[:1], MaxWidth: &maxW}); err != nil || out.Changed != 1 {
		t.Fatalf("SetLayoutLimits = %+v %v", out, err)
	}
	if out, err := s.SetLayoutPositioning(ctx, odmcp.SetLayoutPositioningInput{NodeIds: kids[2:], Positioning: "absolute"}); err != nil || out.Changed != 1 {
		t.Fatalf("SetLayoutPositioning = %+v %v", out, err)
	}
	doc, _ := s.GetDocument(ctx, struct{}{})
	got := map[string]odmcp.NodeView{}
	for _, n := range doc.Nodes {
		got[n.Id] = n
	}
	if a := got[kids[0]]; a.Width != 25 || a.MaxWidth != 25 {
		t.Errorf("the first child is %v wide (limit %v), want 25", a.Width, a.MaxWidth)
	}
	if b := got[kids[1]]; b.X != 35 {
		t.Errorf("the second child is at x=%v, want 35 (after the clamped first one)", b.X)
	}
	if c := got[kids[2]]; c.LayoutPositioning != "absolute" {
		t.Errorf("the third child reports %q, want absolute", c.LayoutPositioning)
	}

	negative := -1.0
	for name, err := range map[string]error{
		"negative limit": func() error {
			_, err := s.SetLayoutLimits(ctx, odmcp.SetLayoutLimitsInput{NodeIds: kids, MinWidth: &negative})
			return err
		}(),
		"no limit given": func() error {
			_, err := s.SetLayoutLimits(ctx, odmcp.SetLayoutLimitsInput{NodeIds: kids})
			return err
		}(),
		"bad positioning": func() error {
			_, err := s.SetLayoutPositioning(ctx, odmcp.SetLayoutPositioningInput{NodeIds: kids, Positioning: "fixed"})
			return err
		}(),
	} {
		if err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}
