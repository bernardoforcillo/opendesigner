package mcp_test

import (
	"context"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestVariablesToolsEndToEnd: creates a themed collection, a color and a number
// variable, binds them to a node, pins a frame to dark, reads everything back and
// checks the cascades and the rejections the tools report before sending.
func TestVariablesToolsEndToEnd(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	home := frame(t, s, "Home")
	card := rect(t, s, home, "Card")

	col, err := s.CreateCollection(ctx, odmcp.CreateCollectionInput{Name: "Theme", Modes: []string{"Light", "Dark"}})
	if err != nil || col.CollectionId == "" || len(col.Modes) != 2 {
		t.Fatalf("CreateCollection = %+v %v", col, err)
	}
	bg, err := s.SetVariable(ctx, odmcp.SetVariableInput{
		CollectionId: col.CollectionId, Name: "color/bg", Type: "color",
		// modes by NAME and by id, mixed
		Values: map[string]odmcp.ValueIO{
			"Light":           {Color: &odmcp.ColorIO{R: 1, G: 1, B: 1, A: 1}},
			col.Modes["Dark"]: {Color: &odmcp.ColorIO{R: 0, G: 0, B: 0, A: 1}},
		},
	})
	if err != nil || bg.VariableId == "" {
		t.Fatalf("SetVariable(color) = %+v %v", bg, err)
	}
	half := 0.5
	dim, err := s.SetVariable(ctx, odmcp.SetVariableInput{
		CollectionId: col.CollectionId, Name: "opacity/dim", Type: "number",
		Values: map[string]odmcp.ValueIO{"Light": {Number: &half}},
	})
	if err != nil {
		t.Fatal(err)
	}

	list, _ := s.ListVariables(ctx, struct{}{})
	if len(list.Collections) != 1 || len(list.Collections[0].Variables) != 2 || list.Collections[0].Modes[0].Name != "Light" {
		t.Fatalf("ListVariables = %+v", list)
	}

	if out, err := s.BindVariable(ctx, odmcp.BindVariableInput{NodeIds: []string{card}, Property: "fills.0", VariableId: bg.VariableId}); err != nil || out.Changed != 1 {
		t.Fatalf("BindVariable = %+v %v", out, err)
	}
	if _, err := s.BindVariable(ctx, odmcp.BindVariableInput{NodeIds: []string{card}, Property: "opacity", VariableId: dim.VariableId}); err != nil {
		t.Fatal(err)
	}
	// rebinding the same thing changes nothing
	if out, _ := s.BindVariable(ctx, odmcp.BindVariableInput{NodeIds: []string{card}, Property: "opacity", VariableId: dim.VariableId}); out.Changed != 0 {
		t.Fatalf("idempotent bind changed %d nodes", out.Changed)
	}
	if out, err := s.SetNodeMode(ctx, odmcp.SetNodeModeInput{NodeIds: []string{home}, CollectionId: col.CollectionId, ModeId: col.Modes["Dark"]}); err != nil || out.Changed != 1 {
		t.Fatalf("SetNodeMode = %+v %v", out, err)
	}

	doc, _ := s.GetDocument(ctx, struct{}{})
	if len(doc.Variables) != 1 {
		t.Fatalf("get_document.variables = %+v", doc.Variables)
	}
	for _, n := range doc.Nodes {
		switch n.Id {
		case card:
			if n.Bindings["fills.0"] != bg.VariableId || n.Bindings["opacity"] != dim.VariableId {
				t.Fatalf("card bindings = %+v", n.Bindings)
			}
		case home:
			if n.Modes[col.CollectionId] != col.Modes["Dark"] {
				t.Fatalf("home modes = %+v", n.Modes)
			}
		}
	}

	// Rejections come back with the authority's message, before anything is sent.
	for name, call := range map[string]func() error{
		"wrong type": func() error {
			_, err := s.BindVariable(ctx, odmcp.BindVariableInput{NodeIds: []string{card}, Property: "fills.0", VariableId: dim.VariableId})
			return err
		},
		"unknown property": func() error {
			_, err := s.BindVariable(ctx, odmcp.BindVariableInput{NodeIds: []string{card}, Property: "bogus", VariableId: bg.VariableId})
			return err
		},
		"unknown node": func() error {
			_, err := s.BindVariable(ctx, odmcp.BindVariableInput{NodeIds: []string{"ghost"}, Property: "opacity", VariableId: dim.VariableId})
			return err
		},
		"unknown mode": func() error {
			_, err := s.SetNodeMode(ctx, odmcp.SetNodeModeInput{NodeIds: []string{home}, CollectionId: col.CollectionId, ModeId: "sepia"})
			return err
		},
		"unknown mode in a value": func() error {
			_, err := s.SetVariable(ctx, odmcp.SetVariableInput{CollectionId: col.CollectionId, Name: "x", Type: "number", Values: map[string]odmcp.ValueIO{"Sepia": {Number: &half}}})
			return err
		},
		"value of the wrong type": func() error {
			_, err := s.SetVariable(ctx, odmcp.SetVariableInput{CollectionId: col.CollectionId, Name: "x", Type: "color", Values: map[string]odmcp.ValueIO{"Light": {Number: &half}}})
			return err
		},
		"type change": func() error {
			_, err := s.SetVariable(ctx, odmcp.SetVariableInput{Id: bg.VariableId, CollectionId: col.CollectionId, Name: "color/bg", Type: "number", Values: map[string]odmcp.ValueIO{"Light": {Number: &half}}})
			return err
		},
		"missing variable": func() error { _, err := s.DeleteVariable(ctx, odmcp.IdInput{Id: "ghost"}); return err },
	} {
		if err := call(); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}

	// delete_variable unbinds it; delete_collection removes the rest.
	if _, err := s.DeleteVariable(ctx, odmcp.IdInput{Id: dim.VariableId}); err != nil {
		t.Fatal(err)
	}
	doc, _ = s.GetDocument(ctx, struct{}{})
	for _, n := range doc.Nodes {
		if n.Id == card && (len(n.Bindings) != 1 || n.Bindings["opacity"] != "") {
			t.Fatalf("after delete_variable card bindings = %+v", n.Bindings)
		}
	}
	if _, err := s.DeleteCollection(ctx, odmcp.IdInput{Id: col.CollectionId}); err != nil {
		t.Fatal(err)
	}
	doc, _ = s.GetDocument(ctx, struct{}{})
	if len(doc.Variables) != 0 {
		t.Fatalf("collections left: %+v", doc.Variables)
	}
	for _, n := range doc.Nodes {
		if len(n.Bindings) != 0 || len(n.Modes) != 0 {
			t.Fatalf("node %s kept bindings/modes: %+v %+v", n.Id, n.Bindings, n.Modes)
		}
	}
}
