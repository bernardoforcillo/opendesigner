package mcp_test

import (
	"context"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestGridLayoutTools: a grid frame made through create_frame lays its children into cells,
// set_grid_cell moves one into another cell and spans it, and bad input is refused.
func TestGridLayoutTools(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	grid, err := s.CreateFrame(ctx, odmcp.CreateFrameInput{Width: 210, Height: 100, Name: "Grid", AutoLayout: &odmcp.AutoLayoutSpec{
		Mode: "grid", ColumnGap: 10, RowGap: 4,
		Columns: []odmcp.GridTrackSpec{{Kind: "fixed", Size: 50}, {Kind: "fr", Size: 1}, {Kind: "fr", Size: 1}},
		Rows:    []odmcp.GridTrackSpec{{Kind: "hug"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	var kids []string
	for range 3 {
		r, err := s.CreateRectangle(ctx, odmcp.CreateShapeInput{ParentId: grid.NodeId, Width: 20, Height: 30})
		if err != nil {
			t.Fatal(err)
		}
		kids = append(kids, r.NodeId)
	}
	byID := func() map[string]odmcp.NodeView {
		doc, _ := s.GetDocument(ctx, struct{}{})
		out := map[string]odmcp.NodeView{}
		for _, n := range doc.Nodes {
			out[n.Id] = n
		}
		return out
	}
	got := byID()
	// Columns: 50, then (210 - 50 - 20) / 2 = 70 each; auto-placed in the first row.
	for i, wantX := range []float64{0, 60, 140} {
		if got[kids[i]].X != wantX || got[kids[i]].Y != 0 {
			t.Errorf("child %d is at (%v, %v), want (%v, 0)", i, got[kids[i]].X, got[kids[i]].Y, wantX)
		}
	}
	if al := got[grid.NodeId].AutoLayout; al == nil || al.Mode != "grid" || len(al.Columns) != 3 || al.Columns[1].Kind != "fr" {
		t.Errorf("the node view reports %+v", al)
	}

	if out, err := s.SetGridCell(ctx, odmcp.SetGridCellInput{NodeIds: kids[:1], Column: 2, ColumnSpan: 2, Row: 2}); err != nil || out.Changed != 1 {
		t.Fatalf("SetGridCell = %+v %v", out, err)
	}
	got = byID()
	if a := got[kids[0]]; a.X != 60 || a.Y != 34 || a.GridCell == nil || a.GridCell.ColumnSpan != 2 {
		t.Errorf("the spanning child is at (%v, %v) with cell %+v, want (60, 34)", a.X, a.Y, a.GridCell)
	}

	if _, err := s.SetGridCell(ctx, odmcp.SetGridCellInput{NodeIds: kids, Column: 5000}); err == nil {
		t.Error("a column of 5000 was accepted")
	}
	if _, err := s.SetAutoLayout(ctx, odmcp.SetAutoLayoutInput{Id: grid.NodeId, AutoLayout: &odmcp.AutoLayoutSpec{
		Mode: "grid", Columns: []odmcp.GridTrackSpec{{Kind: "wide"}},
	}}); err == nil {
		t.Error("an unknown track kind was accepted")
	}
	if _, err := s.SetAutoLayout(ctx, odmcp.SetAutoLayoutInput{Id: grid.NodeId, AutoLayout: &odmcp.AutoLayoutSpec{Mode: "masonry", Direction: "horizontal"}}); err == nil {
		t.Error("an unknown mode was accepted")
	}
}
