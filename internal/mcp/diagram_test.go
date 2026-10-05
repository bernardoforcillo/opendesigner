package mcp_test

import (
	"context"
	"strings"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const flowText = "flowchart TD\n  A[Start] --> B{Ok?}\n  B -->|si| C[Fatto]\n  B -->|no| A"

// TestDiagramToolsEndToEnd: create_diagram disegna un gruppo normale nel
// documento condiviso, list_diagrams ne rilegge il sorgente, update_diagram lo
// ridisegna al suo posto, e un testo illeggibile non lascia niente a metà.
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
		t.Fatalf("radice = %+v (%v)", root, ok)
	}
	if len(doc.Nodes) != out.NodeCount {
		t.Errorf("nodi nel documento = %d, attesi %d", len(doc.Nodes), out.NodeCount)
	}
	children := 0
	for _, n := range doc.Nodes {
		if n.ParentId == out.NodeId {
			children++
		}
	}
	if children != out.NodeCount-1 {
		t.Errorf("figli diretti = %d, attesi %d", children, out.NodeCount-1)
	}

	// un secondo diagramma finisce a destra del primo, senza coprirlo
	second, err := s.CreateDiagram(ctx, odmcp.CreateDiagramInput{Source: "sequenceDiagram\nA->>B: ciao"})
	if err != nil {
		t.Fatal(err)
	}
	doc, _ = s.GetDocument(ctx, struct{}{})
	r2, _ := nodeByID(doc, second.NodeId)
	if r2.X < out.Width {
		t.Errorf("il secondo diagramma deve stare a destra: x=%v, larghezza del primo %v", r2.X, out.Width)
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
		t.Errorf("sorgente riletto = %+v", first)
	}

	// update: stessa posizione e nome, id nuovo, il vecchio gruppo sparisce
	up, err := s.UpdateDiagram(ctx, odmcp.UpdateDiagramInput{Id: out.NodeId, Source: "classDiagram\nAnimal <|-- Duck"})
	if err != nil {
		t.Fatalf("UpdateDiagram: %v", err)
	}
	doc, _ = s.GetDocument(ctx, struct{}{})
	if _, still := nodeByID(doc, out.NodeId); still {
		t.Error("il vecchio gruppo doveva essere cancellato")
	}
	nr, ok := nodeByID(doc, up.NodeId)
	if !ok || nr.Name != "Login" || nr.X != root.X || nr.Y != root.Y || up.Kind != "class" {
		t.Errorf("nuovo gruppo = %+v (%v) %+v", nr, ok, up)
	}
	for _, n := range doc.Nodes {
		if n.ParentId == out.NodeId {
			t.Fatal("restano figli del vecchio gruppo")
		}
	}

	// errori: nessuna modifica
	before := len(doc.Nodes)
	if _, err := s.CreateDiagram(ctx, odmcp.CreateDiagramInput{Source: "erDiagram\nA ||--o{ B : x"}); err == nil || !strings.Contains(err.Error(), "non è supportato") {
		t.Errorf("tipo non supportato: %v", err)
	}
	if _, err := s.UpdateDiagram(ctx, odmcp.UpdateDiagramInput{Id: up.NodeId, Source: "graph TD\nA -->"}); err == nil {
		t.Error("testo illeggibile deve fallire")
	}
	if _, err := s.UpdateDiagram(ctx, odmcp.UpdateDiagramInput{Id: "nope", Source: flowText}); err == nil {
		t.Error("id sconosciuto deve fallire")
	}
	rect, _ := s.CreateRectangle(ctx, odmcp.CreateShapeInput{Width: 1, Height: 1})
	if _, err := s.UpdateDiagram(ctx, odmcp.UpdateDiagramInput{Id: rect.NodeId, Source: flowText}); err == nil || !strings.Contains(err.Error(), "not a diagram") {
		t.Errorf("un nodo qualunque non è un diagramma: %v", err)
	}
	doc, _ = s.GetDocument(ctx, struct{}{})
	if len(doc.Nodes) != before+1 {
		t.Errorf("gli errori hanno lasciato nodi: %d -> %d", before, len(doc.Nodes))
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
			t.Errorf("tool %s non registrato", name)
		}
	}
	for _, kw := range []string{"classDiagram", "sequenceDiagram", "stateDiagram", "flowchart"} {
		if !strings.Contains(have["create_diagram"], kw) {
			t.Errorf("la descrizione deve spiegare %s", kw)
		}
	}
	res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "create_diagram", Arguments: map[string]any{"source": "sequenceDiagram\nAlice->>Bob: Ciao\nBob-->>Alice: Ciao a te"}})
	if err != nil || res.IsError {
		t.Fatalf("create_diagram: %v %+v", err, res)
	}
	res, err = cs.CallTool(ctx, &mcp.CallToolParams{Name: "create_diagram", Arguments: map[string]any{"source": "gantt\ntitle x"}})
	if err != nil || !res.IsError {
		t.Fatalf("un tipo non supportato deve essere un errore di tool: %v %+v", err, res)
	}
}
