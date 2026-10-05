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

// Home: ListDocuments carries the last-modified time and counts; Rename and Delete are
// durable; an unknown id does not create documents.
func TestHomeLifecycleRPCs(t *testing.T) {
	ws := t.TempDir()
	ctx := context.Background()
	c, m := newTestClientWithManager(t, ws)

	created, err := c.CreateDocument(ctx, connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: "Alpha"}))
	if err != nil {
		t.Fatal(err)
	}
	id := created.Msg.GetId()

	// A top-level frame = a screen; a child inside it is not.
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
		t.Fatalf("DocInfo = %v, want 1 screen, 0 flows, updated_at != 0", got)
	}

	// A new process (hub not open) must count the same way.
	l2, err := NewManager(ws).List()
	if err != nil || l2[0].GetScreens() != 1 {
		t.Fatalf("cold list = %v, %v", l2, err)
	}

	// Rename: validation, effect on Open and durability across a restart.
	if _, err := c.RenameDocument(ctx, connect.NewRequest(&opendesignerv1.RenameDocumentRequest{DocId: id, Name: "  "})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("empty rename: %v", err)
	}
	if _, err := c.RenameDocument(ctx, connect.NewRequest(&opendesignerv1.RenameDocumentRequest{DocId: "00000000-0000-0000-0000-000000000000", Name: "x"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("rename of an unknown id: %v", err)
	}
	if _, err := c.RenameDocument(ctx, connect.NewRequest(&opendesignerv1.RenameDocumentRequest{DocId: id, Name: "Beta"})); err != nil {
		t.Fatal(err)
	}
	open, _ := c.OpenDocument(ctx, connect.NewRequest(&opendesignerv1.OpenRequest{DocId: id}))
	if open.Msg.GetSnapshot().GetName() != "Beta" {
		t.Fatalf("open name = %q", open.Msg.GetSnapshot().GetName())
	}
	l3, _ := NewManager(ws).List()
	if l3[0].GetName() != "Beta" {
		t.Fatalf("name after restart = %q", l3[0].GetName())
	}

	// An unknown id does not bring a document into being.
	unknown := "11111111-2222-3333-4444-555555555555"
	if _, err := c.OpenDocument(ctx, connect.NewRequest(&opendesignerv1.OpenRequest{DocId: unknown})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("unknown open: %v", err)
	}
	if _, err := os.Stat(filepath.Join(ws, unknown+".opendesigner")); err == nil {
		t.Fatal("OpenDocument created a bundle for an unknown id")
	}

	// Delete is refused while someone has the stream open.
	sctx, cancel := context.WithCancel(ctx)
	stream, err := c.Subscribe(sctx, connect.NewRequest(&opendesignerv1.SubscribeRequest{DocId: id, ClientId: "x"}))
	if err != nil {
		t.Fatal(err)
	}
	for h.Subscribers() == 0 { // the stream registers asynchronously
		time.Sleep(time.Millisecond)
	}
	if _, err := c.DeleteDocument(ctx, connect.NewRequest(&opendesignerv1.DeleteDocumentRequest{DocId: id})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("delete with an open stream: %v", err)
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
		t.Fatalf("after delete: %v", l4.Msg.GetDocs())
	}
	if entries, _ := os.ReadDir(filepath.Join(ws, ".trash")); len(entries) != 1 {
		t.Fatalf(".trash = %v, the bundle must be moved, not deleted", entries)
	}
	if _, err := c.DeleteDocument(ctx, connect.NewRequest(&opendesignerv1.DeleteDocumentRequest{DocId: id})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("double delete: %v", err)
	}
}
