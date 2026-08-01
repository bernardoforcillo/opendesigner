package server

import (
	"context"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"connectrpc.com/connect"
	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
	"github.com/bernardoforcillo/brawt/gen/brawt/v1/brawtv1connect"
	"github.com/google/uuid"
)

func newTestClient(t *testing.T) brawtv1connect.DocumentServiceClient {
	t.Helper()
	svc := NewDocumentService(NewManager(t.TempDir()))
	path, handler := brawtv1connect.NewDocumentServiceHandler(svc)
	mux := httpMux(path, handler)
	// connect bidi streaming (Sync) requires HTTP/2; a plain httptest.NewServer
	// speaks only HTTP/1.1 and answers streaming RPCs with 505. Enable HTTP/2
	// via TLS (the canonical connect-go test pattern); srv.Client() then trusts
	// the test cert and negotiates h2 over ALPN.
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return brawtv1connect.NewDocumentServiceClient(srv.Client(), srv.URL)
}

func TestCreateOpenDocument(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()
	info, err := c.CreateDocument(ctx, connect.NewRequest(&brawtv1.CreateDocumentRequest{Name: "Test"}))
	if err != nil {
		t.Fatal(err)
	}
	open, err := c.OpenDocument(ctx, connect.NewRequest(&brawtv1.OpenRequest{DocId: info.Msg.GetId()}))
	if err != nil {
		t.Fatal(err)
	}
	if open.Msg.GetSnapshot().GetName() != "Test" {
		t.Fatalf("name = %q", open.Msg.GetSnapshot().GetName())
	}
	if open.Msg.GetSeq() != 0 {
		t.Fatalf("fresh doc seq = %d want 0", open.Msg.GetSeq())
	}
}

func TestSyncRoundTrip(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()
	info, _ := c.CreateDocument(ctx, connect.NewRequest(&brawtv1.CreateDocumentRequest{Name: "T"}))
	stream := c.Sync(ctx)
	defer stream.CloseRequest()
	if err := stream.Send(&brawtv1.ClientMsg{Kind: &brawtv1.ClientMsg_Hello{Hello: &brawtv1.Hello{
		DocId: info.Msg.GetId(), ClientId: "c1", SinceSeq: 0}}}); err != nil {
		t.Fatal(err)
	}
	op := &brawtv1.Op{OpId: "op1", DocId: info.Msg.GetId(), Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{
		Node: &brawtv1.Node{Id: "n1", ParentId: "page1", OrderKey: "a0", Visible: true, Opacity: 1,
			Shape: &brawtv1.Node_Rect{Rect: &brawtv1.RectNode{}}}}}}
	if err := stream.Send(&brawtv1.ClientMsg{Kind: &brawtv1.ClientMsg_Submit{Submit: &brawtv1.SubmitOp{Op: op}}}); err != nil {
		t.Fatal(err)
	}
	// attendi finché arriva l'Applied di n1
	for {
		msg, err := stream.Receive()
		if err != nil {
			t.Fatal(err)
		}
		if a := msg.GetApplied(); a != nil && a.GetOp().GetCreateNode().GetNode().GetId() == "n1" {
			if a.GetSeq() != 1 {
				t.Fatalf("applied seq = %d want 1", a.GetSeq())
			}
			return
		}
	}
}

// TestSyncMultipleSubmitsAckAndApplied stresses the reader loop and the single
// writer goroutine together: many SubmitOps in flight means Ack replies (handed
// to the writer via `out`) interleave with the broadcast Applied records the
// writer drains from the subscriber channel. Both must be funnelled through the
// one goroutine that is allowed to call stream.Send. It asserts every op yields
// exactly its Ack and its Applied with no loss, duplication, or deadlock.
func TestSyncMultipleSubmitsAckAndApplied(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()
	info, _ := c.CreateDocument(ctx, connect.NewRequest(&brawtv1.CreateDocumentRequest{Name: "M"}))
	stream := c.Sync(ctx)
	defer stream.CloseRequest()
	if err := stream.Send(&brawtv1.ClientMsg{Kind: &brawtv1.ClientMsg_Hello{Hello: &brawtv1.Hello{
		DocId: info.Msg.GetId(), ClientId: "c1", SinceSeq: 0}}}); err != nil {
		t.Fatal(err)
	}
	const n = 25
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("n%d", i)
		op := &brawtv1.Op{OpId: "op-" + id, DocId: info.Msg.GetId(), Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{
			Node: &brawtv1.Node{Id: id, ParentId: "page1", OrderKey: "a0", Visible: true, Opacity: 1,
				Shape: &brawtv1.Node_Rect{Rect: &brawtv1.RectNode{}}}}}}
		if err := stream.Send(&brawtv1.ClientMsg{Kind: &brawtv1.ClientMsg_Submit{Submit: &brawtv1.SubmitOp{Op: op}}}); err != nil {
			t.Fatal(err)
		}
	}
	acks := map[string]int{}
	applied := map[string]int{}
	for len(acks) < n || len(applied) < n {
		msg, err := stream.Receive()
		if err != nil {
			t.Fatalf("receive: %v (acks=%d applied=%d)", err, len(acks), len(applied))
		}
		if a := msg.GetAck(); a != nil {
			acks[a.GetOpId()]++
		}
		if ap := msg.GetApplied(); ap != nil {
			applied[ap.GetOp().GetCreateNode().GetNode().GetId()]++
		}
	}
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("n%d", i)
		if got := acks["op-"+id]; got != 1 {
			t.Fatalf("ack for op-%s seen %d times, want 1", id, got)
		}
		if got := applied[id]; got != 1 {
			t.Fatalf("applied for %s seen %d times, want 1", id, got)
		}
	}
}

// TestHubForRejectsPathTraversalDocID verifies the doc_id sanitization: a
// client-supplied id containing ".." segments or path separators must be
// rejected before store.Open joins it into a filesystem path, so no bundle
// directory is ever created outside the workspace root.
func TestHubForRejectsPathTraversalDocID(t *testing.T) {
	root := t.TempDir()
	ws := filepath.Join(root, "workspace")
	if err := os.MkdirAll(ws, 0o755); err != nil {
		t.Fatal(err)
	}
	m := NewManager(ws)

	for _, bad := range []string{
		"../evil",
		"..\\evil",
		"../../etc/passwd",
		"a/../../../evil",
		"foo/bar",
		".",
		"..",
		"",
		"not-a-uuid",
	} {
		if _, err := m.HubFor(bad); err == nil {
			t.Fatalf("HubFor(%q) = nil error, want rejection", bad)
		}
	}

	// Nothing may have escaped the workspace: root must still contain only the
	// workspace directory itself.
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name() != "workspace" {
			t.Fatalf("entry created outside workspace root: %q", e.Name())
		}
	}

	// A well-formed (UUID) doc id is still accepted.
	if _, err := m.HubFor(uuid.NewString()); err != nil {
		t.Fatalf("HubFor(valid uuid) unexpected error: %v", err)
	}
}

// TestOpenDocumentRejectsTraversalDocID checks the sanitization end-to-end
// through the Connect handler: OpenDocument with a traversal doc_id returns an
// error rather than touching the filesystem.
func TestOpenDocumentRejectsTraversalDocID(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()
	if _, err := c.OpenDocument(ctx, connect.NewRequest(&brawtv1.OpenRequest{DocId: "../../evil"})); err == nil {
		t.Fatal("OpenDocument(../../evil) = nil error, want rejection")
	}
}
