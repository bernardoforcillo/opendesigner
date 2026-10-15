package mcp_test

import (
	"context"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestAliasAndStringVariablesTools: a string variable and an alias of it bound
// to a text node's content, a number bound to its font size, and the rejections
// the tools report before sending.
func TestAliasAndStringVariablesTools(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	home := frame(t, s, "Home")
	label, err := s.CreateText(ctx, odmcp.CreateTextInput{ParentId: home, Width: 100, Height: 20, Content: "hi"})
	if err != nil {
		t.Fatal(err)
	}
	col, err := s.CreateCollection(ctx, odmcp.CreateCollectionInput{Name: "Copy", Modes: []string{"EN", "IT"}})
	if err != nil {
		t.Fatal(err)
	}
	hello, bonjour := "Hello", "Ciao"
	prim, err := s.SetVariable(ctx, odmcp.SetVariableInput{CollectionId: col.CollectionId, Name: "prim/greeting", Type: "string",
		Values: map[string]odmcp.ValueIO{"EN": {Text: &hello}, "IT": {Text: &bonjour}}})
	if err != nil {
		t.Fatal(err)
	}
	sem, err := s.SetVariable(ctx, odmcp.SetVariableInput{CollectionId: col.CollectionId, Name: "sem/title", Type: "string", AliasOf: prim.VariableId})
	if err != nil {
		t.Fatalf("alias: %v", err)
	}
	size := 24.0
	fs, err := s.SetVariable(ctx, odmcp.SetVariableInput{CollectionId: col.CollectionId, Name: "size/title", Type: "number",
		Values: map[string]odmcp.ValueIO{"EN": {Number: &size}}})
	if err != nil {
		t.Fatal(err)
	}
	for prop, id := range map[string]string{"text": sem.VariableId, "font_size": fs.VariableId} {
		if _, err := s.BindVariable(ctx, odmcp.BindVariableInput{NodeIds: []string{label.NodeId}, Property: prop, VariableId: id}); err != nil {
			t.Fatalf("bind %s: %v", prop, err)
		}
	}

	list, _ := s.ListVariables(ctx, struct{}{})
	var seen bool
	for _, v := range list.Collections[0].Variables {
		if v.Id == sem.VariableId {
			seen = v.AliasOf == prim.VariableId && v.Type == "string" && len(v.Values) == 0
		}
		if v.Id == prim.VariableId && (v.Values[col.Modes["EN"]].Text == nil || *v.Values[col.Modes["EN"]].Text != "Hello") {
			t.Fatalf("string value lost: %+v", v)
		}
	}
	if !seen {
		t.Fatalf("alias not listed: %+v", list)
	}

	for name, call := range map[string]func() error{
		"alias of a variable of another type": func() error {
			_, err := s.SetVariable(ctx, odmcp.SetVariableInput{CollectionId: col.CollectionId, Name: "x", Type: "number", AliasOf: prim.VariableId})
			return err
		},
		"alias of nothing": func() error {
			_, err := s.SetVariable(ctx, odmcp.SetVariableInput{CollectionId: col.CollectionId, Name: "x", Type: "string", AliasOf: "ghost"})
			return err
		},
		"cycle": func() error {
			_, err := s.SetVariable(ctx, odmcp.SetVariableInput{Id: prim.VariableId, CollectionId: col.CollectionId, Name: "prim/greeting", Type: "string", AliasOf: sem.VariableId})
			return err
		},
		"alias with values": func() error {
			_, err := s.SetVariable(ctx, odmcp.SetVariableInput{CollectionId: col.CollectionId, Name: "x", Type: "string", AliasOf: prim.VariableId,
				Values: map[string]odmcp.ValueIO{"EN": {Text: &hello}}})
			return err
		},
		"text value for a number": func() error {
			_, err := s.SetVariable(ctx, odmcp.SetVariableInput{CollectionId: col.CollectionId, Name: "x", Type: "number", Values: map[string]odmcp.ValueIO{"EN": {Text: &hello}}})
			return err
		},
		"string bound to font_size": func() error {
			_, err := s.BindVariable(ctx, odmcp.BindVariableInput{NodeIds: []string{label.NodeId}, Property: "font_size", VariableId: prim.VariableId})
			return err
		},
	} {
		if err := call(); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}

	// Deleting the primitive takes its alias and the text binding with it.
	if _, err := s.DeleteVariable(ctx, odmcp.IdInput{Id: prim.VariableId}); err != nil {
		t.Fatal(err)
	}
	doc, _ := s.GetDocument(ctx, struct{}{})
	for _, n := range doc.Nodes {
		if n.Id == label.NodeId && (n.Bindings["text"] != "" || n.Bindings["font_size"] != fs.VariableId) {
			t.Fatalf("bindings after delete = %+v", n.Bindings)
		}
	}
	list, _ = s.ListVariables(ctx, struct{}{})
	if got := len(list.Collections[0].Variables); got != 1 {
		t.Fatalf("variables left = %d, want 1 (the font size)", got)
	}
}
