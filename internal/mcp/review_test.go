package mcp_test

import (
	"context"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestReviewDesignTool: the agent sees a contrast failure on its own work, fixes it and the
// review comes back clean.
func TestReviewDesignTool(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	scr := frame(t, s, "Screen")
	pale := odmcp.RGBA{R: 0.8, G: 0.8, B: 0.8, A: 1}
	white := odmcp.RGBA{R: 1, G: 1, B: 1, A: 1}
	if _, err := s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: scr, Fills: []odmcp.RGBA{white}}); err != nil {
		t.Fatal(err)
	}
	txt, err := s.CreateText(ctx, odmcp.CreateTextInput{ParentId: scr, Content: "Hello", X: 4, Y: 4, Name: "Greeting"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: txt.NodeId, Fills: []odmcp.RGBA{pale}}); err != nil {
		t.Fatal(err)
	}
	out, err := s.ReviewDesign(ctx, struct{}{})
	if err != nil {
		t.Fatal(err)
	}
	if out.Errors != 1 || len(out.Issues) != 1 || out.Issues[0].Rule != "contrast" || out.Issues[0].NodeName != "Greeting" {
		t.Fatalf("review = %+v", out)
	}
	dark := odmcp.RGBA{R: 0.1, G: 0.1, B: 0.1, A: 1}
	if _, err := s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: txt.NodeId, Fills: []odmcp.RGBA{dark}}); err != nil {
		t.Fatal(err)
	}
	if out, _ := s.ReviewDesign(ctx, struct{}{}); len(out.Issues) != 0 || out.Issues == nil {
		t.Fatalf("after the fix: %+v", out)
	}
}

// TestCreateBoardObjectTool: an agent draws a kanban board and a sticky note, the nodes land in
// the document, and bad input is refused with the reason.
func TestCreateBoardObjectTool(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	k, err := s.CreateBoardObject(ctx, odmcp.CreateBoardObjectInput{Kind: "kanban", Items: []string{"Todo", "Done"}, Name: "Sprint"})
	if err != nil || k.NodeCount < 5 || k.Width != 2*240+16 {
		t.Fatalf("kanban = %+v %v", k, err)
	}
	if _, err := s.CreateBoardObject(ctx, odmcp.CreateBoardObjectInput{Kind: "sticky", Items: []string{"Remember"}, Color: "blue"}); err != nil {
		t.Fatal(err)
	}
	doc, err := s.GetDocument(ctx, struct{}{})
	if err != nil {
		t.Fatal(err)
	}
	var groups int
	for _, n := range doc.Nodes {
		if n.Id == k.NodeId && n.Name != "Sprint" {
			t.Errorf("name = %q", n.Name)
		}
		if n.Kind == "group" {
			groups++
		}
	}
	if groups != 2 {
		t.Errorf("groups = %d, want 2", groups)
	}
	if _, err := s.CreateBoardObject(ctx, odmcp.CreateBoardObjectInput{Kind: "whiteboard"}); err == nil {
		t.Error("an unknown kind must be refused")
	}
}
