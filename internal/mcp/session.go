// Package mcp drives a shared opendesigner document from an MCP server.
//
// A Session is the transport- and stdio-agnostic core: it connects to a running
// `opendesigner serve` as a Connect RPC client, holds a LOCAL copy of the
// authoritative document, and keeps that copy in lockstep with the hub by
// applying every OpRecord the Subscribe stream broadcasts -- including the ones
// the web client submits, which is what makes MCP and the browser co-design the
// same op-log. The tool handlers in tools.go read and write through a Session;
// main.go wires a Session to an mcp.Server over stdio. Splitting the two keeps
// the connect+open+subscribe+tool logic testable against a real in-memory serve
// without the stdio loop.
package mcp

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1/opendesignerv1connect"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/google/uuid"
)

const (
	// minBackoff/maxBackoff bound the reconnect delay when the Subscribe stream
	// drops. The delay resets to minBackoff whenever a reconnection actually
	// makes progress (its seq advances), so a healthy but flaky link never
	// creeps up to the ceiling.
	minBackoff = 200 * time.Millisecond
	maxBackoff = 5 * time.Second

	// applyWaitTimeout bounds how long a write tool waits for the Subscribe
	// stream to fold its just-submitted op back into the local doc. The op is
	// already durable once SubmitOp acked; this only gives the tool
	// read-your-writes consistency, so it must never block a handler forever.
	applyWaitTimeout = 10 * time.Second
)

// NewClient builds the h2c-only Connect client `opendesigner mcp` uses to talk
// to a running `opendesigner serve`. It mirrors internal/server/h2c_test.go:
// cleartext HTTP/2 with prior knowledge (no ALPN, no TLS), which is what the
// local serve listens for and what connect's server-streaming Subscribe needs.
func NewClient(serverURL string) opendesignerv1connect.DocumentServiceClient {
	p := new(http.Protocols)
	p.SetUnencryptedHTTP2(true)
	transport := &http.Transport{Protocols: p}
	return opendesignerv1connect.NewDocumentServiceClient(&http.Client{Transport: transport}, serverURL)
}

// Session holds the local mirror of one shared document and the client that
// drives it. The mirror (doc, seq, updated) is guarded by mu; the Subscribe
// goroutine and every tool handler take mu to touch it.
type Session struct {
	client   opendesignerv1connect.DocumentServiceClient
	docID    string
	clientID string
	logger   *log.Logger

	// orderCounter feeds nextOrderKey. Atomic so a create tool need not take mu
	// merely to mint a fresh, strictly increasing order key.
	orderCounter uint64

	mu  sync.Mutex
	doc *opendesignerv1.Document
	seq uint64
	// updated is closed (and replaced) each time seq advances, so waitForSeq
	// can block on a write landing without polling. A fresh channel is minted
	// under mu on every advance; a waiter captures the current one before it
	// sleeps, so it never misses a wakeup.
	updated chan struct{}

	// joined is true while the agent's presence stream is open (presence.go).
	joined bool
}

// NewSession builds a Session over an already-constructed client. logger may be
// nil (logs are then discarded); main passes a stderr logger because stdout is
// the MCP stdio channel and must carry protocol bytes only. clientID may be
// empty; a random one is minted so the hub can attribute this session's ops.
func NewSession(client opendesignerv1connect.DocumentServiceClient, docID, clientID string, logger *log.Logger) *Session {
	if logger == nil {
		logger = log.New(io.Discard, "", 0)
	}
	if clientID == "" {
		clientID = "mcp-" + uuid.NewString()
	}
	return &Session{
		client:   client,
		docID:    docID,
		clientID: clientID,
		logger:   logger,
		updated:  make(chan struct{}),
	}
}

// ClientID reports the id this session submits ops under.
func (s *Session) ClientID() string { return s.clientID }

func (s *Session) logf(format string, args ...any) { s.logger.Printf(format, args...) }

// Open loads the authoritative snapshot and its seq into the local mirror. It
// is the first call after NewSession, and also the recovery path when the
// Subscribe stream reports its catch-up point was compacted away (see SyncLoop).
func (s *Session) Open(ctx context.Context) error {
	res, err := s.client.OpenDocument(ctx, connect.NewRequest(&opendesignerv1.OpenRequest{DocId: s.docID}))
	if err != nil {
		return fmt.Errorf("open document %s: %w", s.docID, err)
	}
	s.mu.Lock()
	s.doc = res.Msg.GetSnapshot()
	s.seq = res.Msg.GetSeq()
	s.signalLocked()
	s.mu.Unlock()
	return nil
}

// SyncLoop subscribes to the hub and applies every broadcast OpRecord to the
// local doc, reconnecting from the last applied seq when the stream drops. It
// blocks until ctx is cancelled; main runs it on its own goroutine. This is the
// ONLY writer of the local doc, so a tool's job is just to submit -- the op
// comes back through here exactly once and mutates the doc down one code path.
func (s *Session) SyncLoop(ctx context.Context) {
	backoff := minBackoff
	for {
		if ctx.Err() != nil {
			return
		}
		s.mu.Lock()
		since := s.seq
		s.mu.Unlock()

		err := s.subscribeOnce(ctx, since)
		if ctx.Err() != nil {
			return
		}

		s.mu.Lock()
		progressed := s.seq > since
		s.mu.Unlock()
		if progressed {
			backoff = minBackoff
		}

		// A since_seq the hub has already compacted into a snapshot comes back
		// as OUT_OF_RANGE. The documented recovery is to re-open the document
		// (fresh snapshot + the seq it is current to) and resubscribe from
		// there; retry immediately, without the reconnect backoff.
		if err != nil && connect.CodeOf(err) == connect.CodeOutOfRange {
			if oerr := s.Open(ctx); oerr != nil {
				s.logf("re-open after out-of-range: %v", oerr)
			} else {
				s.logf("re-opened document %s after history compaction; resuming", s.docID)
				continue
			}
		} else if err != nil {
			s.logf("subscribe stream ended (%v); reconnecting from seq %d in %v", err, since, backoff)
		} else {
			s.logf("subscribe stream closed; reconnecting from seq %d in %v", since, backoff)
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff *= 2; backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

// subscribeOnce runs one Subscribe stream to completion, applying each message.
func (s *Session) subscribeOnce(ctx context.Context, since uint64) error {
	stream, err := s.client.Subscribe(ctx, connect.NewRequest(&opendesignerv1.SubscribeRequest{
		DocId:    s.docID,
		ClientId: s.clientID,
		SinceSeq: since,
	}))
	if err != nil {
		return err
	}
	defer stream.Close()
	for stream.Receive() {
		s.applyServerMsg(stream.Msg())
	}
	return stream.Err()
}

// applyServerMsg folds one ServerMsg into the local doc. Only `applied` records
// mutate it; ack/error messages are logged and ignored (they carry nothing the
// local mirror needs).
func (s *Session) applyServerMsg(msg *opendesignerv1.ServerMsg) {
	rec := msg.GetApplied()
	if rec == nil {
		switch {
		case msg.GetAck() != nil:
			s.logf("subscribe ack: op=%s seq=%d", msg.GetAck().GetOpId(), msg.GetAck().GetSeq())
		case msg.GetError() != nil:
			s.logf("subscribe error: op=%s %s", msg.GetError().GetOpId(), msg.GetError().GetMessage())
		}
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Dedupe by seq: on a reconnect the catch-up backlog can re-deliver records
	// at or below what we already applied. core.Apply is not idempotent (a
	// second CreateNode is ErrNodeExists), so guard before touching the doc.
	if rec.GetSeq() <= s.seq {
		return
	}
	// rec.Op was just unmarshalled off the wire and is owned by this session, so
	// core.Apply aliasing its Node into doc.Nodes (CreateNode) is safe -- nothing
	// else holds it.
	if err := core.Apply(s.doc, rec.GetOp()); err != nil {
		s.logf("apply record seq %d: %v", rec.GetSeq(), err)
		return
	}
	s.seq = rec.GetSeq()
	s.signalLocked()
}

// signalLocked wakes every waitForSeq waiter and arms the next wait. mu held.
func (s *Session) signalLocked() {
	close(s.updated)
	s.updated = make(chan struct{})
}

// waitForSeq blocks until the local doc has applied up to target (or ctx ends).
func (s *Session) waitForSeq(ctx context.Context, target uint64) error {
	for {
		s.mu.Lock()
		if s.seq >= target {
			s.mu.Unlock()
			return nil
		}
		ch := s.updated
		s.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// submit sends op to the hub and, once acked, waits for the Subscribe stream to
// bring it back into the local doc so a read immediately after a write sees it.
// The wait is best-effort: the op is durable the moment SubmitOp returns, so a
// wait timeout is logged, not surfaced as a tool failure. Returns the acked seq.
func (s *Session) submit(ctx context.Context, op *opendesignerv1.Op) (uint64, error) {
	if op.OpId == "" {
		op.OpId = uuid.NewString()
	}
	op.DocId = s.docID
	res, err := s.client.SubmitOp(ctx, connect.NewRequest(&opendesignerv1.SubmitOpRequest{
		DocId:    s.docID,
		ClientId: s.clientID,
		Op:       op,
	}))
	if err != nil {
		return 0, err
	}
	seq := res.Msg.GetAck().GetSeq()
	wctx, cancel := context.WithTimeout(ctx, applyWaitTimeout)
	defer cancel()
	if werr := s.waitForSeq(wctx, seq); werr != nil {
		s.logf("op seq %d acked but not yet locally applied: %v", seq, werr)
	}
	s.announce(ctx, op)
	return seq, nil
}

// nextOrderKey mints a strictly increasing, lexicographically sortable order
// key. Nodes are sorted by order_key string (ties broken by id in
// core.ChildrenOf), so a zero-padded monotonic counter keeps this session's
// creations in creation order. Collisions with the web client's fractional keys
// are harmless -- the id tiebreak makes the order total, and order is editable.
func (s *Session) nextOrderKey() string {
	return fmt.Sprintf("a%09d", atomic.AddUint64(&s.orderCounter, 1))
}

// firstPageID resolves the default parent for a create tool: the first page.
func (s *Session) firstPageID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if pages := s.doc.GetPages(); len(pages) > 0 {
		return pages[0].GetId()
	}
	return ""
}
