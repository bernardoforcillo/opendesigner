package server

import (
	"context"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"
	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
	"github.com/bernardoforcillo/brawt/gen/brawt/v1/brawtv1connect"
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
