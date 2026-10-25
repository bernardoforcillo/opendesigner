package mcp_test

import (
	"context"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestBooleanAndSpacingVariablesTools: a number variable bound to an auto layout frame's
// spacing and a boolean variable bound to a child's visibility; pinning the frame to the
// other mode re-lays it out, and the tools report the new type.
func TestBooleanAndSpacingVariablesTools(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	row, err := s.CreateFrame(ctx, odmcp.CreateFrameInput{Width: 200, Height: 40, Name: "Row", AutoLayout: &odmcp.AutoLayoutSpec{Direction: "horizontal"}})
	if err != nil {
		t.Fatal(err)
	}
	var kids []string
	for range 3 {
		r, err := s.CreateRectangle(ctx, odmcp.CreateShapeInput{ParentId: row.NodeId, Width: 20, Height: 10})
		if err != nil {
			t.Fatal(err)
		}
		kids = append(kids, r.NodeId)
	}
	col, err := s.CreateCollection(ctx, odmcp.CreateCollectionInput{Name: "Density", Modes: []string{"Cozy", "Tight"}})
	if err != nil {
		t.Fatal(err)
	}
	cozy, tight := 12.0, 2.0
	gap, err := s.SetVariable(ctx, odmcp.SetVariableInput{CollectionId: col.CollectionId, Name: "gap", Type: "number",
		Values: map[string]odmcp.ValueIO{"Cozy": {Number: &cozy}, "Tight": {Number: &tight}}})
	if err != nil {
		t.Fatal(err)
	}
	yes, no := true, false
	show, err := s.SetVariable(ctx, odmcp.SetVariableInput{CollectionId: col.CollectionId, Name: "show", Type: "boolean",
		Values: map[string]odmcp.ValueIO{"Cozy": {Boolean: &yes}, "Tight": {Boolean: &no}}})
	if err != nil {
		t.Fatalf("boolean variable: %v", err)
	}
	if _, err := s.BindVariable(ctx, odmcp.BindVariableInput{NodeIds: []string{row.NodeId}, Property: "spacing", VariableId: gap.VariableId}); err != nil {
		t.Fatalf("bind spacing: %v", err)
	}
	if _, err := s.BindVariable(ctx, odmcp.BindVariableInput{NodeIds: kids[1:2], Property: "visible", VariableId: show.VariableId}); err != nil {
		t.Fatalf("bind visible: %v", err)
	}
	xs := func() map[string]float64 {
		doc, _ := s.GetDocument(ctx, struct{}{})
		out := map[string]float64{}
		for _, n := range doc.Nodes {
			out[n.Id] = n.X
		}
		return out
	}
	if x := xs(); x[kids[1]] != 32 || x[kids[2]] != 64 {
		t.Fatalf("cozy: %v, want the second child at 32 and the third at 64", x)
	}
	if _, err := s.SetNodeMode(ctx, odmcp.SetNodeModeInput{NodeIds: []string{row.NodeId}, CollectionId: col.CollectionId, ModeId: col.Modes["Tight"]}); err != nil {
		t.Fatal(err)
	}
	if x := xs(); x[kids[2]] != 22 {
		t.Errorf("tight: the third child is at %v, want 22 (the second is hidden, the gap is 2)", x[kids[2]])
	}
	list, _ := s.ListVariables(ctx, struct{}{})
	var seen bool
	for _, v := range list.Collections[0].Variables {
		if v.Id == show.VariableId {
			seen = v.Type == "boolean" && v.Values[col.Modes["Tight"]].Boolean != nil && !*v.Values[col.Modes["Tight"]].Boolean
		}
	}
	if !seen {
		t.Error("the boolean variable is not listed with its values")
	}
	// Type mismatches are reported before sending.
	if _, err := s.BindVariable(ctx, odmcp.BindVariableInput{NodeIds: kids[:1], Property: "opacity", VariableId: show.VariableId}); err == nil {
		t.Error("a boolean bound to opacity was accepted")
	}
	if _, err := s.BindVariable(ctx, odmcp.BindVariableInput{NodeIds: kids[:1], Property: "visible", VariableId: gap.VariableId}); err == nil {
		t.Error("a number bound to visible was accepted")
	}
}
