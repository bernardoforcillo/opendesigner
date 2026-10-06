package mcp_test

import (
	"context"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestConstraintsAndLayoutSizingTools: resizing a frame through set_properties moves its
// children by the constraints set with set_constraints, an auto layout frame wraps and
// fills, and the node views report it all.
func TestConstraintsAndLayoutSizingTools(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	f, err := s.CreateFrame(ctx, odmcp.CreateFrameInput{X: 0, Y: 0, Width: 200, Height: 100, Name: "F"})
	if err != nil {
		t.Fatal(err)
	}
	k, err := s.CreateRectangle(ctx, odmcp.CreateShapeInput{ParentId: f.NodeId, X: 10, Y: 10, Width: 150, Height: 20, Name: "K"})
	if err != nil {
		t.Fatal(err)
	}
	if out, err := s.SetConstraints(ctx, odmcp.SetConstraintsInput{NodeIds: []string{k.NodeId}, Horizontal: "stretch", Vertical: "max"}); err != nil || out.Changed != 1 {
		t.Fatalf("SetConstraints = %+v %v", out, err)
	}
	w, h := 300.0, 150.0
	if _, err := s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: f.NodeId, Width: &w, Height: &h}); err != nil {
		t.Fatal(err)
	}
	doc, _ := s.GetDocument(ctx, struct{}{})
	for _, n := range doc.Nodes {
		if n.Id == k.NodeId {
			if n.Width != 250 || n.Y != 60 || n.X != 10 || n.ConstraintX != "stretch" || n.ConstraintY != "max" {
				t.Fatalf("the child did not follow the resize by its constraints: %+v", n)
			}
		}
	}

	// A wrapping auto layout frame with a filling child.
	row, err := s.CreateFrame(ctx, odmcp.CreateFrameInput{Width: 100, Height: 10, Name: "Row", AutoLayout: &odmcp.AutoLayoutSpec{
		Direction: "horizontal", Spacing: 10, Wrap: true, CrossSpacing: 5, HugHeight: true,
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
	doc, _ = s.GetDocument(ctx, struct{}{})
	pos := map[string][2]float64{}
	var rowH float64
	for _, n := range doc.Nodes {
		pos[n.Id] = [2]float64{n.X, n.Y}
		if n.Id == row.NodeId {
			rowH = n.Height
			if n.AutoLayout == nil || !n.AutoLayout.Wrap || n.AutoLayout.CrossSpacing != 5 {
				t.Fatalf("auto layout view = %+v", n.AutoLayout)
			}
		}
	}
	// 40+10+40 = 90 fits 100; the third (40) goes to a second line 20+5 below. Height hugs: 20+5+20.
	if pos[kids[0]] != [2]float64{0, 0} || pos[kids[1]] != [2]float64{50, 0} || pos[kids[2]] != [2]float64{0, 25} || rowH != 45 {
		t.Fatalf("wrapped layout = %v height %v", pos, rowH)
	}

	if _, err := s.SetAutoLayout(ctx, odmcp.SetAutoLayoutInput{Id: row.NodeId, AutoLayout: &odmcp.AutoLayoutSpec{Direction: "horizontal", Spacing: 10}}); err != nil {
		t.Fatal(err)
	}
	if out, err := s.SetLayoutSizing(ctx, odmcp.SetLayoutSizingInput{NodeIds: []string{kids[2]}, Width: "fill", Height: "fill"}); err != nil || out.Changed != 1 {
		t.Fatalf("SetLayoutSizing = %+v %v", out, err)
	}
	doc, _ = s.GetDocument(ctx, struct{}{})
	for _, n := range doc.Nodes {
		if n.Id == kids[2] {
			// 100 - 40 - 40 - 2 gaps(20) = 0 free: the filling child gets 0 width, and spans the row's height.
			if n.LayoutSizingX != "fill" || n.LayoutSizingY != "fill" {
				t.Fatalf("view = %+v", n)
			}
		}
	}

	for name, call := range map[string]func() error{
		"no axis": func() error {
			_, err := s.SetConstraints(ctx, odmcp.SetConstraintsInput{NodeIds: []string{k.NodeId}})
			return err
		},
		"bad constraint": func() error {
			_, err := s.SetConstraints(ctx, odmcp.SetConstraintsInput{NodeIds: []string{k.NodeId}, Horizontal: "left"})
			return err
		},
		"unknown node": func() error {
			_, err := s.SetConstraints(ctx, odmcp.SetConstraintsInput{NodeIds: []string{"ghost"}, Horizontal: "max"})
			return err
		},
		"bad sizing": func() error {
			_, err := s.SetLayoutSizing(ctx, odmcp.SetLayoutSizingInput{NodeIds: []string{k.NodeId}, Width: "grow"})
			return err
		},
		"no nodes": func() error { _, err := s.SetLayoutSizing(ctx, odmcp.SetLayoutSizingInput{Width: "fill"}); return err },
		"negative spacing": func() error {
			_, err := s.SetAutoLayout(ctx, odmcp.SetAutoLayoutInput{Id: row.NodeId, AutoLayout: &odmcp.AutoLayoutSpec{Direction: "horizontal", CrossSpacing: -1}})
			return err
		},
	} {
		if err := call(); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}
