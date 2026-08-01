package server

import (
	"context"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"connectrpc.com/connect"
	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
	"github.com/bernardoforcillo/brawt/gen/brawt/v1/brawtv1connect"
	"github.com/google/uuid"
)

func newTestClient(t *testing.T) brawtv1connect.DocumentServiceClient {
	t.Helper()
	return newTestClientOn(t, t.TempDir())
}

// newTestClientOn serves an explicit workspace, so a test can start a second
// "process" over documents that already exist on disk.
func newTestClientOn(t *testing.T, workspace string) brawtv1connect.DocumentServiceClient {
	t.Helper()
	svc := NewDocumentService(NewManager(workspace))
	path, handler := brawtv1connect.NewDocumentServiceHandler(svc)
	mux := httpMux(path, handler)
	// Enable HTTP/2 via TLS (the canonical connect-go test pattern): srv.Client()
	// trusts the test cert and negotiates h2 over ALPN. Server streaming
	// (Subscribe) would also work over HTTP/1.1 chunked responses, but h2 is what
	// browsers and `brawt serve` actually use, so exercise that here; the
	// cleartext h2c variant is covered by h2c_test.go.
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

// createNodeOp builds a well-formed CreateNode op for node id `nodeID`.
func createNodeOp(docID, nodeID string) *brawtv1.Op {
	return &brawtv1.Op{OpId: "op-" + nodeID, DocId: docID, Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{
		Node: &brawtv1.Node{Id: nodeID, ParentId: "page1", OrderKey: "a0", Visible: true, Opacity: 1,
			Shape: &brawtv1.Node_Rect{Rect: &brawtv1.RectNode{}}}}}}
}

// subscribeAsync opens a Subscribe stream on its own goroutine and forwards the
// received ServerMsgs on the returned channel.
//
// The goroutine is not decoration: connect's CallServerStream returns only once
// the server has written response headers, and connect flushes them with the
// FIRST streamed message. A subscriber that must already be attached when the
// op is submitted therefore cannot be opened inline — the test would block in
// Subscribe waiting for a message that only its own (never reached) SubmitOp
// could produce. since_seq keeps the result deterministic anyway: Hub.Subscribe
// preloads the catch-up backlog and registers the subscriber under a single
// mutex hold, so a record is delivered exactly once whether the submit lands
// before or after the stream is established.
//
// Cleanup cancels the subscription and waits for the goroutine, so no stream is
// still live when httptest's server Close runs (that cleanup was registered
// earlier by newTestClient, hence runs later).
func subscribeAsync(t *testing.T, parent context.Context, c brawtv1connect.DocumentServiceClient, req *brawtv1.SubscribeRequest) <-chan *brawtv1.ServerMsg {
	t.Helper()
	ctx, cancel := context.WithCancel(parent)
	out := make(chan *brawtv1.ServerMsg, 256)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer close(out)
		stream, err := c.Subscribe(ctx, connect.NewRequest(req))
		if err != nil {
			if ctx.Err() == nil { // a cancelled subscription failing is expected
				t.Errorf("Subscribe: %v", err)
			}
			return
		}
		defer stream.Close()
		for stream.Receive() {
			select {
			case out <- stream.Msg():
			case <-ctx.Done():
				return
			}
		}
		if err := stream.Err(); err != nil && ctx.Err() == nil {
			t.Errorf("Subscribe stream: %v", err)
		}
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})
	return out
}

// nextMsg waits for the next streamed ServerMsg, failing the test rather than
// hanging if the broadcast never arrives.
func nextMsg(t *testing.T, ch <-chan *brawtv1.ServerMsg) *brawtv1.ServerMsg {
	t.Helper()
	select {
	case msg, ok := <-ch:
		if !ok {
			t.Fatal("subscribe stream ended before the expected message")
		}
		return msg
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for a server message")
		return nil
	}
}

// TestSubmitOpAndSubscribeRoundTrip is the replacement for the old bidi Sync
// round trip: SubmitOp (unary) applies and acks, Subscribe (server stream)
// broadcasts the applied record. since_seq=0 makes the ordering between the two
// calls irrelevant — Hub.Subscribe registers the subscriber and preloads its
// catch-up backlog under one mutex hold, so the record is delivered exactly once
// whether the submit lands before or after the stream is established.
func TestSubmitOpAndSubscribeRoundTrip(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()
	info, _ := c.CreateDocument(ctx, connect.NewRequest(&brawtv1.CreateDocumentRequest{Name: "T"}))
	docID := info.Msg.GetId()

	msgs := subscribeAsync(t, ctx, c, &brawtv1.SubscribeRequest{DocId: docID, ClientId: "c1", SinceSeq: 0})

	res, err := c.SubmitOp(ctx, connect.NewRequest(&brawtv1.SubmitOpRequest{
		DocId: docID, ClientId: "c1", Op: createNodeOp(docID, "n1")}))
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Msg.GetAck().GetOpId(); got != "op-n1" {
		t.Fatalf("ack op_id = %q want op-n1", got)
	}
	if got := res.Msg.GetAck().GetSeq(); got != 1 {
		t.Fatalf("ack seq = %d want 1", got)
	}

	msg := nextMsg(t, msgs)
	a := msg.GetApplied()
	if a == nil {
		t.Fatalf("server message = %v, want applied", msg)
	}
	if got := a.GetOp().GetCreateNode().GetNode().GetId(); got != "n1" {
		t.Fatalf("applied node id = %q want n1", got)
	}
	if a.GetSeq() != 1 {
		t.Fatalf("applied seq = %d want 1", a.GetSeq())
	}
}

// TestSubmitOpsBroadcastToSubscriber pushes many ops through the unary handler
// while a subscriber is streaming, and asserts every op yields exactly its Ack
// (with a monotonically increasing seq) and exactly one Applied record on the
// stream — no loss, no duplication, no deadlock.
func TestSubmitOpsBroadcastToSubscriber(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()
	info, _ := c.CreateDocument(ctx, connect.NewRequest(&brawtv1.CreateDocumentRequest{Name: "M"}))
	docID := info.Msg.GetId()

	msgs := subscribeAsync(t, ctx, c, &brawtv1.SubscribeRequest{DocId: docID, ClientId: "c1", SinceSeq: 0})

	const n = 25
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("n%d", i)
		res, err := c.SubmitOp(ctx, connect.NewRequest(&brawtv1.SubmitOpRequest{
			DocId: docID, ClientId: "c1", Op: createNodeOp(docID, id)}))
		if err != nil {
			t.Fatalf("SubmitOp %s: %v", id, err)
		}
		if got := res.Msg.GetAck().GetOpId(); got != "op-"+id {
			t.Fatalf("ack op_id = %q want op-%s", got, id)
		}
		if got := res.Msg.GetAck().GetSeq(); got != uint64(i+1) {
			t.Fatalf("ack seq for %s = %d want %d", id, got, i+1)
		}
	}

	applied := map[string]int{}
	for len(applied) < n {
		msg := nextMsg(t, msgs)
		ap := msg.GetApplied()
		if ap == nil {
			t.Fatalf("server message = %v, want applied", msg)
		}
		applied[ap.GetOp().GetCreateNode().GetNode().GetId()]++
	}
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("n%d", i)
		if got := applied[id]; got != 1 {
			t.Fatalf("applied for %s seen %d times, want 1", id, got)
		}
	}
}

// TestSubscribeCatchUpFromSinceSeq: a subscriber joining after the fact with
// since_seq must receive only the records strictly newer than it.
func TestSubscribeCatchUpFromSinceSeq(t *testing.T) {
	c := newTestClient(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	info, _ := c.CreateDocument(ctx, connect.NewRequest(&brawtv1.CreateDocumentRequest{Name: "C"}))
	docID := info.Msg.GetId()

	for _, id := range []string{"n1", "n2", "n3"} {
		if _, err := c.SubmitOp(ctx, connect.NewRequest(&brawtv1.SubmitOpRequest{
			DocId: docID, ClientId: "c1", Op: createNodeOp(docID, id)})); err != nil {
			t.Fatalf("SubmitOp %s: %v", id, err)
		}
	}

	stream, err := c.Subscribe(ctx, connect.NewRequest(&brawtv1.SubscribeRequest{
		DocId: docID, ClientId: "c2", SinceSeq: 1}))
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()

	for _, want := range []struct {
		seq    uint64
		nodeID string
	}{{2, "n2"}, {3, "n3"}} {
		if !stream.Receive() {
			t.Fatalf("receive seq %d: %v", want.seq, stream.Err())
		}
		ap := stream.Msg().GetApplied()
		if ap == nil {
			t.Fatalf("server message = %v, want applied", stream.Msg())
		}
		if ap.GetSeq() != want.seq {
			t.Fatalf("applied seq = %d want %d", ap.GetSeq(), want.seq)
		}
		if got := ap.GetOp().GetCreateNode().GetNode().GetId(); got != want.nodeID {
			t.Fatalf("applied node id = %q want %q", got, want.nodeID)
		}
	}
}

// TestSubmitOpErrors pins the error mapping: an unknown/malformed doc_id is
// NotFound, and a core.Apply failure (here: a duplicate node id) surfaces as
// InvalidArgument instead of being swallowed into an in-band ErrorMsg the way
// the bidi stream had to.
func TestSubmitOpErrors(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()
	info, _ := c.CreateDocument(ctx, connect.NewRequest(&brawtv1.CreateDocumentRequest{Name: "E"}))
	docID := info.Msg.GetId()

	if _, err := c.SubmitOp(ctx, connect.NewRequest(&brawtv1.SubmitOpRequest{
		DocId: "../../evil", ClientId: "c1", Op: createNodeOp(docID, "n1")})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("SubmitOp(traversal doc_id) code = %v (err %v), want not_found", connect.CodeOf(err), err)
	}

	if _, err := c.SubmitOp(ctx, connect.NewRequest(&brawtv1.SubmitOpRequest{
		DocId: docID, ClientId: "c1"})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("SubmitOp(no op) code = %v (err %v), want invalid_argument", connect.CodeOf(err), err)
	}

	if _, err := c.SubmitOp(ctx, connect.NewRequest(&brawtv1.SubmitOpRequest{
		DocId: docID, ClientId: "c1", Op: createNodeOp(docID, "n1")})); err != nil {
		t.Fatalf("first SubmitOp: %v", err)
	}
	// Same node id again: core.Apply rejects it.
	if _, err := c.SubmitOp(ctx, connect.NewRequest(&brawtv1.SubmitOpRequest{
		DocId: docID, ClientId: "c1", Op: createNodeOp(docID, "n1")})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("SubmitOp(duplicate node) code = %v (err %v), want invalid_argument", connect.CodeOf(err), err)
	}
}

// finding (MINOR, documentservice.go): op.doc_id was never checked against
// SubmitOpRequest.doc_id and was persisted as-is -- a stale/empty scene id
// on the client (a doc switch, a failed bootstrap) would silently write a
// record claiming the wrong document into a valid oplog, with core.Apply
// none the wiser since it ignores op.doc_id entirely.
func TestSubmitOpRejectsOpDocIDMismatch(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()
	info, _ := c.CreateDocument(ctx, connect.NewRequest(&brawtv1.CreateDocumentRequest{Name: "M"}))
	docID := info.Msg.GetId()

	// op.doc_id empty (the client's "scene not loaded yet" default).
	if _, err := c.SubmitOp(ctx, connect.NewRequest(&brawtv1.SubmitOpRequest{
		DocId: docID, ClientId: "c1", Op: createNodeOp("", "n1")})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("SubmitOp(empty op.doc_id) code = %v (err %v), want invalid_argument", connect.CodeOf(err), err)
	}

	// op.doc_id set, but to a different document than the request addresses.
	other, _ := c.CreateDocument(ctx, connect.NewRequest(&brawtv1.CreateDocumentRequest{Name: "Other"}))
	if _, err := c.SubmitOp(ctx, connect.NewRequest(&brawtv1.SubmitOpRequest{
		DocId: docID, ClientId: "c1", Op: createNodeOp(other.Msg.GetId(), "n1")})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("SubmitOp(mismatched op.doc_id) code = %v (err %v), want invalid_argument", connect.CodeOf(err), err)
	}

	// Neither rejected op may have consumed a seq or touched either
	// document: a correctly-addressed op right after must still land at 1.
	res, err := c.SubmitOp(ctx, connect.NewRequest(&brawtv1.SubmitOpRequest{
		DocId: docID, ClientId: "c1", Op: createNodeOp(docID, "n1")}))
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Msg.GetAck().GetSeq(); got != 1 {
		t.Fatalf("ack seq = %d, want 1 (the rejected mismatched ops must not have consumed a seq)", got)
	}

	open, err := c.OpenDocument(ctx, connect.NewRequest(&brawtv1.OpenRequest{DocId: other.Msg.GetId()}))
	if err != nil {
		t.Fatal(err)
	}
	if open.Msg.GetSeq() != 0 || len(open.Msg.GetSnapshot().GetNodes()) != 0 {
		t.Fatalf("the other document was touched by a mismatched op: seq = %d, nodes = %v", open.Msg.GetSeq(), open.Msg.GetSnapshot().GetNodes())
	}
}

// TestSubscribeRejectsTraversalDocID checks the doc_id sanitization on the
// streaming half too: the error may surface either from the call itself or from
// the first Receive, depending on when the handler runs.
func TestSubscribeRejectsTraversalDocID(t *testing.T) {
	c := newTestClient(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream, err := c.Subscribe(ctx, connect.NewRequest(&brawtv1.SubscribeRequest{
		DocId: "../../evil", ClientId: "c1", SinceSeq: 0}))
	if err == nil {
		defer stream.Close()
		if stream.Receive() {
			t.Fatalf("Subscribe(../../evil) delivered %v, want rejection", stream.Msg())
		}
		err = stream.Err()
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("Subscribe(../../evil) code = %v (err %v), want not_found", connect.CodeOf(err), err)
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
