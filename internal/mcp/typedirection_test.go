package mcp_test

import (
	"context"
	"strings"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestTextDirectionAndWritingModeThroughTheTools: direction and writing mode round-trip through
// create_text and set_text, "auto" / "horizontal" clear them, and a bad name is refused.
func TestTextDirectionAndWritingModeThroughTheTools(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()
	home := frame(t, s, "Home")

	made, err := s.CreateText(ctx, odmcp.CreateTextInput{
		ParentId: home, Content: "مرحبا", Width: 200, Height: 60,
		TextFormat: odmcp.TextFormat{Direction: "rtl", WritingMode: "vertical"},
	})
	if err != nil {
		t.Fatal(err)
	}
	read := func() *odmcp.TextFormat {
		doc, err := s.GetDocument(ctx, struct{}{})
		if err != nil {
			t.Fatal(err)
		}
		for _, n := range doc.Nodes {
			if n.Id == made.NodeId {
				return n.Format
			}
		}
		return nil
	}
	if f := read(); f == nil || f.Direction != "rtl" || f.WritingMode != "vertical" {
		t.Fatalf("created format = %+v", f)
	}
	if _, err := s.SetText(ctx, odmcp.SetTextInput{Id: made.NodeId, Content: "x", TextFormat: odmcp.TextFormat{Direction: "auto", WritingMode: "horizontal"}}); err != nil {
		t.Fatal(err)
	}
	if f := read(); f != nil {
		t.Fatalf("cleared format = %+v", f)
	}
	if _, err := s.SetText(ctx, odmcp.SetTextInput{Id: made.NodeId, Content: "x", TextFormat: odmcp.TextFormat{Direction: "sideways"}}); err == nil || !strings.Contains(err.Error(), "direction") {
		t.Fatalf("bad direction error = %v", err)
	}
}
