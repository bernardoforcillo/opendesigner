package server

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Home: ListDocuments porta ultima modifica e conteggi; Rename e Delete sono
// durevoli; un id sconosciuto non crea documenti.
func TestHomeLifecycleRPCs(t *testing.T) {
	ws := t.TempDir()
	ctx := context.Background()
	c, m := newTestClientWithManager(t, ws)

	created, err := c.CreateDocument(ctx, connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: "Alfa"}))
	if err != nil {
		t.Fatal(err)
	}
	id := created.Msg.GetId()

	// Un frame di primo livello = una schermata; un figlio dentro di esso no.
	h, _ := m.HubFor(id)
	doc, _ := h.Snapshot()
	pageID := doc.GetPages()[0].GetId()
	frame := &opendesignerv1.Node{Id: "f1", ParentId: pageID, OrderKey: "a", Visible: true, Opacity: 1, Width: 390, Height: 844,
		Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}}
	child := &opendesignerv1.Node{Id: "f2", ParentId: "f1", OrderKey: "a", Visible: true, Opacity: 1, Width: 10, Height: 10,
		Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}}
	for _, n := range []*opendesignerv1.Node{frame, child} {
		op := &opendesignerv1.Op{OpId: "o-" + n.Id, DocId: id, Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}}
		if _, err := h.Submit("c", op); err != nil {
			t.Fatal(err)
		}
	}

	list, err := c.ListDocuments(ctx, connect.NewRequest(&opendesignerv1.ListDocumentsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	got := list.Msg.GetDocs()[0]
	if got.GetScreens() != 1 || got.GetFlows() != 0 || got.GetUpdatedAt() == 0 {
		t.Fatalf("DocInfo = %v, want 1 schermata, 0 flussi, updated_at != 0", got)
	}

	// Un processo nuovo (hub non aperto) deve contare allo stesso modo.
	l2, err := NewManager(ws).List()
	if err != nil || l2[0].GetScreens() != 1 {
		t.Fatalf("lista a freddo = %v, %v", l2, err)
	}

	// Rename: validazione, effetto su Open e durata al riavvio.
	if _, err := c.RenameDocument(ctx, connect.NewRequest(&opendesignerv1.RenameDocumentRequest{DocId: id, Name: "  "})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("rename vuoto: %v", err)
	}
	if _, err := c.RenameDocument(ctx, connect.NewRequest(&opendesignerv1.RenameDocumentRequest{DocId: "00000000-0000-0000-0000-000000000000", Name: "x"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("rename di un id sconosciuto: %v", err)
	}
	if _, err := c.RenameDocument(ctx, connect.NewRequest(&opendesignerv1.RenameDocumentRequest{DocId: id, Name: "Beta"})); err != nil {
		t.Fatal(err)
	}
	open, _ := c.OpenDocument(ctx, connect.NewRequest(&opendesignerv1.OpenRequest{DocId: id}))
	if open.Msg.GetSnapshot().GetName() != "Beta" {
		t.Fatalf("nome aperto = %q", open.Msg.GetSnapshot().GetName())
	}
	l3, _ := NewManager(ws).List()
	if l3[0].GetName() != "Beta" {
		t.Fatalf("nome dopo riavvio = %q", l3[0].GetName())
	}

	// Un id sconosciuto non fa nascere un documento.
	unknown := "11111111-2222-3333-4444-555555555555"
	if _, err := c.OpenDocument(ctx, connect.NewRequest(&opendesignerv1.OpenRequest{DocId: unknown})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("open sconosciuto: %v", err)
	}
	if _, err := os.Stat(filepath.Join(ws, unknown+".opendesigner")); err == nil {
		t.Fatal("OpenDocument ha creato un bundle per un id sconosciuto")
	}

	// Delete rifiutato finché qualcuno ha lo stream aperto.
	sctx, cancel := context.WithCancel(ctx)
	stream, err := c.Subscribe(sctx, connect.NewRequest(&opendesignerv1.SubscribeRequest{DocId: id, ClientId: "x"}))
	if err != nil {
		t.Fatal(err)
	}
	for h.Subscribers() == 0 { // lo stream si registra in modo asincrono
		time.Sleep(time.Millisecond)
	}
	if _, err := c.DeleteDocument(ctx, connect.NewRequest(&opendesignerv1.DeleteDocumentRequest{DocId: id})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("delete con stream aperto: %v", err)
	}
	cancel()
	_ = stream.Close()
	for h.Subscribers() != 0 {
		time.Sleep(time.Millisecond)
	}
	if _, err := c.DeleteDocument(ctx, connect.NewRequest(&opendesignerv1.DeleteDocumentRequest{DocId: id})); err != nil {
		t.Fatal(err)
	}
	l4, _ := c.ListDocuments(ctx, connect.NewRequest(&opendesignerv1.ListDocumentsRequest{}))
	if len(l4.Msg.GetDocs()) != 0 {
		t.Fatalf("dopo delete: %v", l4.Msg.GetDocs())
	}
	if entries, _ := os.ReadDir(filepath.Join(ws, ".trash")); len(entries) != 1 {
		t.Fatalf(".trash = %v, il bundle va spostato, non cancellato", entries)
	}
	if _, err := c.DeleteDocument(ctx, connect.NewRequest(&opendesignerv1.DeleteDocumentRequest{DocId: id})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("delete doppio: %v", err)
	}
}
