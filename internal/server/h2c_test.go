package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"
	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
	"github.com/bernardoforcillo/brawt/gen/brawt/v1/brawtv1connect"
)

// serverProtocols mirrors `brawt serve`: HTTP/1.1 (static frontend) plus cleartext
// HTTP/2 (h2c), which connect's streaming requires. Since Go 1.24 this comes
// from net/http alone — no golang.org/x/net/http2/h2c.
func serverProtocols() *http.Protocols {
	p := new(http.Protocols)
	p.SetHTTP1(true)
	p.SetUnencryptedHTTP2(true)
	return p
}

// clientProtocols enables h2c *only*. Cleartext has no ALPN to negotiate with, so a
// client offering HTTP/1.1 as well would simply use it. Restricting the set forces
// prior-knowledge h2c, which is what this test is here to exercise.
func clientProtocols() *http.Protocols {
	p := new(http.Protocols)
	p.SetUnencryptedHTTP2(true)
	return p
}

// TestSubscribeAndSubmitOverH2C exercises the transport `brawt serve` actually runs
// on: no TLS, h2c on both ends. It guards the stdlib-only server setup in
// cmd/brawt/main.go — a green run proves h2c negotiation succeeded end to end for
// both halves of the new RPC pair (unary SubmitOp and server-streaming Subscribe).
func TestSubscribeAndSubmitOverH2C(t *testing.T) {
	svc := NewDocumentService(NewManager(t.TempDir()))
	path, handler := brawtv1connect.NewDocumentServiceHandler(svc)

	srv := httptest.NewUnstartedServer(httpMux(path, handler))
	srv.Config.Protocols = serverProtocols()
	srv.Start() // cleartext: the h2c path, not StartTLS
	t.Cleanup(srv.Close)

	transport := &http.Transport{Protocols: clientProtocols()}
	client := brawtv1connect.NewDocumentServiceClient(&http.Client{Transport: transport}, srv.URL)

	ctx := context.Background()
	info, err := client.CreateDocument(ctx, connect.NewRequest(&brawtv1.CreateDocumentRequest{Name: "H2C"}))
	if err != nil {
		t.Fatalf("CreateDocument over h2c: %v", err)
	}
	docID := info.Msg.GetId()

	// Subscribe first, then submit — on a goroutine, because CallServerStream
	// only returns once the server has flushed response headers with its first
	// message (see subscribeAsync). since_seq=0 keeps this deterministic even if
	// the submit wins the race: the record then arrives as catch-up instead of
	// as a live broadcast, exactly once either way.
	msgs := subscribeAsync(t, ctx, client, &brawtv1.SubscribeRequest{
		DocId: docID, ClientId: "h2c-client", SinceSeq: 0,
	})

	op := &brawtv1.Op{OpId: "op-h2c", DocId: docID, Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{
		Node: &brawtv1.Node{
			Id: "n1", ParentId: "page1", OrderKey: "a0", Visible: true, Opacity: 1,
			Width: 100, Height: 80,
			Shape: &brawtv1.Node_Rect{Rect: &brawtv1.RectNode{}},
		},
	}}}
	res, err := client.SubmitOp(ctx, connect.NewRequest(&brawtv1.SubmitOpRequest{
		DocId: docID, ClientId: "h2c-client", Op: op,
	}))
	if err != nil {
		t.Fatalf("SubmitOp over h2c: %v", err)
	}
	if got := res.Msg.GetAck().GetOpId(); got != "op-h2c" {
		t.Fatalf("ack op_id = %q, want op-h2c", got)
	}
	if got := res.Msg.GetAck().GetSeq(); got != 1 {
		t.Fatalf("ack seq = %d, want 1", got)
	}

	msg := nextMsg(t, msgs)
	applied := msg.GetApplied()
	if applied == nil {
		t.Fatalf("first server message over h2c = %v, want applied", msg)
	}
	if got := applied.GetOp().GetCreateNode().GetNode().GetId(); got != "n1" {
		t.Fatalf("applied node id = %q, want n1", got)
	}
	if applied.GetSeq() != 1 {
		t.Fatalf("applied seq = %d, want 1", applied.GetSeq())
	}
}
