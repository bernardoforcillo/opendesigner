package mcp_test

import (
	"context"
	"strings"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const flowText = "flowchart TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]\n  B -->|no| A"

// TestDiagramToolsEndToEnd: create_diagram draws an ordinary group in the
// shared document, list_diagrams reads its source back, update_diagram redraws
// it in place, and unreadable text leaves nothing half-done.
func TestDiagramToolsEndToEnd(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	out, err := s.CreateDiagram(ctx, odmcp.CreateDiagramInput{Source: flowText, Name: "Login"})
	if err != nil {
		t.Fatalf("CreateDiagram: %v", err)
	}
	if out.Kind != "flowchart" || out.NodeCount < 8 || out.Width <= 0 {
		t.Fatalf("out = %+v", out)
	}

	doc, _ := s.GetDocument(ctx, struct{}{})
	root, ok := nodeByID(doc, out.NodeId)
	if !ok || root.Kind != "group" || root.Name != "Login" || root.X != 0 {
		t.Fatalf("root = %+v (%v)", root, ok)
	}
	if len(doc.Nodes) != out.NodeCount {
		t.Errorf("nodes in the document = %d, want %d", len(doc.Nodes), out.NodeCount)
	}
	children := 0
	for _, n := range doc.Nodes {
		if n.ParentId == out.NodeId {
			children++
		}
	}
	if children != out.NodeCount-1 {
		t.Errorf("direct children = %d, want %d", children, out.NodeCount-1)
	}

	// a second diagram lands to the right of the first, without covering it
	second, err := s.CreateDiagram(ctx, odmcp.CreateDiagramInput{Source: "sequenceDiagram\nA->>B: hello"})
	if err != nil {
		t.Fatal(err)
	}
	doc, _ = s.GetDocument(ctx, struct{}{})
	r2, _ := nodeByID(doc, second.NodeId)
	if r2.X < out.Width {
		t.Errorf("the second diagram must be to the right: x=%v, first's width %v", r2.X, out.Width)
	}

	list, err := s.ListDiagrams(ctx, struct{}{})
	if err != nil || len(list.Diagrams) != 2 {
		t.Fatalf("ListDiagrams = %+v, %v", list, err)
	}
	var first odmcp.DiagramView
	for _, d := range list.Diagrams {
		if d.Id == out.NodeId {
			first = d
		}
	}
	if first.Source != flowText || first.Kind != "flowchart" {
		t.Errorf("source read back = %+v", first)
	}

	// update: same position and name, new id, the old group disappears
	up, err := s.UpdateDiagram(ctx, odmcp.UpdateDiagramInput{Id: out.NodeId, Source: "classDiagram\nAnimal <|-- Duck"})
	if err != nil {
		t.Fatalf("UpdateDiagram: %v", err)
	}
	doc, _ = s.GetDocument(ctx, struct{}{})
	if _, still := nodeByID(doc, out.NodeId); still {
		t.Error("the old group should have been deleted")
	}
	nr, ok := nodeByID(doc, up.NodeId)
	if !ok || nr.Name != "Login" || nr.X != root.X || nr.Y != root.Y || up.Kind != "class" {
		t.Errorf("new group = %+v (%v) %+v", nr, ok, up)
	}
	for _, n := range doc.Nodes {
		if n.ParentId == out.NodeId {
			t.Fatal("children of the old group are left")
		}
	}

	// errors: no change
	before := len(doc.Nodes)
	if _, err := s.CreateDiagram(ctx, odmcp.CreateDiagramInput{Source: "erDiagram\nA ||--o{ B : x"}); err == nil || !strings.Contains(err.Error(), "is not supported") {
		t.Errorf("unsupported type: %v", err)
	}
	if _, err := s.UpdateDiagram(ctx, odmcp.UpdateDiagramInput{Id: up.NodeId, Source: "graph TD\nA -->"}); err == nil {
		t.Error("unreadable text must fail")
	}
	if _, err := s.UpdateDiagram(ctx, odmcp.UpdateDiagramInput{Id: "nope", Source: flowText}); err == nil {
		t.Error("unknown id must fail")
	}
	rect, _ := s.CreateRectangle(ctx, odmcp.CreateShapeInput{Width: 1, Height: 1})
	if _, err := s.UpdateDiagram(ctx, odmcp.UpdateDiagramInput{Id: rect.NodeId, Source: flowText}); err == nil || !strings.Contains(err.Error(), "not a diagram") {
		t.Errorf("an arbitrary node is not a diagram: %v", err)
	}
	doc, _ = s.GetDocument(ctx, struct{}{})
	if len(doc.Nodes) != before+1 {
		t.Errorf("the errors left nodes behind: %d -> %d", before, len(doc.Nodes))
	}
}

func TestDiagramToolsRegistered(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	srv := mcp.NewServer(&mcp.Implementation{Name: "od", Version: "0"}, nil)
	odmcp.RegisterTools(srv, s)
	ct, st := mcp.NewInMemoryTransports()
	if _, err := srv.Connect(ctx, st, nil); err != nil {
		t.Fatal(err)
	}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil).Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()

	tools, _ := cs.ListTools(ctx, nil)
	have := map[string]string{}
	for _, tl := range tools.Tools {
		have[tl.Name] = tl.Description
	}
	for _, name := range []string{"create_diagram", "update_diagram", "list_diagrams"} {
		if _, ok := have[name]; !ok {
			t.Errorf("tool %s not registered", name)
		}
	}
	for _, kw := range []string{"classDiagram", "sequenceDiagram", "stateDiagram", "flowchart"} {
		if !strings.Contains(have["create_diagram"], kw) {
			t.Errorf("the description must explain %s", kw)
		}
	}
	res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "create_diagram", Arguments: map[string]any{"source": "sequenceDiagram\nAlice->>Bob: Hello\nBob-->>Alice: Hello to you"}})
	if err != nil || res.IsError {
		t.Fatalf("create_diagram: %v %+v", err, res)
	}
	res, err = cs.CallTool(ctx, &mcp.CallToolParams{Name: "create_diagram", Arguments: map[string]any{"source": "gantt\ntitle x"}})
	if err != nil || !res.IsError {
		t.Fatalf("an unsupported type must be a tool error: %v %+v", err, res)
	}
}
