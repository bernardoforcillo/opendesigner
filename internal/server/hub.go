// Package server: hub per-doc + handler Connect.
package server

import (
	"sync"

	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
	"github.com/bernardoforcillo/brawt/internal/core"
	"github.com/bernardoforcillo/brawt/internal/store"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type subscriber struct {
	ch chan *brawtv1.OpRecord
	// closeOnce guards close(ch) in the cancel func returned by Subscribe:
	// cancel must be safe to call more than once (matching the idiomatic
	// Go convention of idempotent cancel funcs, e.g. context.CancelFunc),
	// since callers with multiple exit paths (e.g. a Sync handler that
	// cancels on both an incoming error and a deferred cleanup) may invoke
	// it more than once. Without this, a second close(ch) panics.
	closeOnce sync.Once
}

// subscriberChanCap is the minimum buffered capacity for a subscriber's
// channel. Subscribe grows it per-subscriber to also fit that subscriber's
// own catch-up backlog (see Subscribe) so registering never blocks.
const subscriberChanCap = 256

// Hub serializza gli Op di UN documento e li ritrasmette ai subscriber.
type Hub struct {
	mu      sync.Mutex
	bundle  *store.Bundle
	doc     *brawtv1.Document
	seq     uint64
	history []*brawtv1.OpRecord // record dallo snapshot in poi (per catch-up)
	subs    map[*subscriber]struct{}
}

func NewHub(b *store.Bundle) (*Hub, error) {
	doc, seq, err := b.Load()
	if err != nil {
		return nil, err
	}
	// Load only replays the persisted oplog into doc; it doesn't hand back
	// the individual records. Reconstruct history from the bundle too, so
	// Subscribe's catch-up still works for sinceSeq below this hub's
	// startup seq after a server restart/reopen of an existing document.
	history, err := b.History()
	if err != nil {
		return nil, err
	}
	return &Hub{bundle: b, doc: doc, seq: seq, history: history, subs: map[*subscriber]struct{}{}}, nil
}

func (h *Hub) Submit(clientID string, op *brawtv1.Op) (*brawtv1.OpRecord, error) {
	h.mu.Lock()
	defer h.mu.Unlock()

	// core.Apply mutates its Document argument in place, and for CreateNode
	// it aliases op's Node straight into doc.Nodes without copying it. Apply
	// to a scratch clone of h.doc first, and only publish it as the new
	// h.doc after the record has been durably appended: if Append fails,
	// h.doc/h.seq must be left exactly as they were, or the in-memory
	// document would silently diverge from the persisted oplog for the rest
	// of the process's life. As a side benefit, every successful generation
	// of h.doc is now a fresh proto.Clone, so a node object touched while
	// applying one op can never again be the same Go object touched while
	// applying a later op on that same node id.
	//
	// Apply a clone of op (never the caller's op) to next: core.Apply's
	// CreateNode aliases its op's Node straight into doc.Nodes, so applying
	// the caller's own op would leave h.doc aliasing caller-owned objects
	// post-commit, contradicting the promise that the caller is free to
	// reuse or mutate op once Submit returns.
	next := proto.Clone(h.doc).(*brawtv1.Document)
	if err := core.Apply(next, proto.Clone(op).(*brawtv1.Op)); err != nil {
		return nil, err
	}

	rec := &brawtv1.OpRecord{
		Seq:      h.seq + 1,
		Ts:       timestamppb.Now(),
		ClientId: clientID,
		// A second, independent clone of op — not the pointer applied to
		// next above, and not the caller's op. rec is retained in h.history
		// and handed to subscriber goroutines that read/marshal it outside
		// h.mu, so it must not alias a node object living inside h.doc
		// (which a later SetProps on that node would mutate in place and so
		// silently corrupt this historical record), nor the caller's op.
		Op: proto.Clone(op).(*brawtv1.Op),
	}
	if err := h.bundle.Append(rec); err != nil {
		return nil, err
	}

	h.doc = next
	h.seq = rec.Seq
	h.history = append(h.history, rec)
	for s := range h.subs {
		select {
		case s.ch <- rec:
		default: // subscriber lento: drop, si riallinea via since_seq alla riconnessione
		}
	}
	return rec, nil
}

func (h *Hub) Subscribe(sinceSeq uint64) (<-chan *brawtv1.OpRecord, func()) {
	h.mu.Lock()
	defer h.mu.Unlock()

	var backlog []*brawtv1.OpRecord
	for _, rec := range h.history {
		if rec.Seq > sinceSeq {
			backlog = append(backlog, rec)
		}
	}

	// Size the channel to fit the whole catch-up backlog up front so
	// registering a subscriber can never block. history has no compaction
	// wired up yet (M0) and grows unboundedly, so a fixed subscriberChanCap
	// buffer can be smaller than the backlog; a blocking send here — while
	// still holding h.mu, before the caller has any chance to drain a
	// channel it hasn't even received yet — would deadlock this call
	// forever and, because h.mu is held, every other Submit/Subscribe/
	// Snapshot on the Hub right along with it.
	capacity := subscriberChanCap
	if n := len(backlog); n > capacity {
		capacity = n
	}
	s := &subscriber{ch: make(chan *brawtv1.OpRecord, capacity)}
	for _, rec := range backlog {
		s.ch <- rec
	}

	h.subs[s] = struct{}{}
	cancel := func() {
		h.mu.Lock()
		delete(h.subs, s)
		h.mu.Unlock()
		// Idempotent: cancel is a func(), not a method, so nothing stops a
		// caller from invoking it more than once (e.g. once on an error
		// path and once in a deferred cleanup); sync.Once makes a repeat
		// call a no-op instead of a close-of-closed-channel panic.
		s.closeOnce.Do(func() { close(s.ch) })
	}
	return s.ch, cancel
}

func (h *Hub) Snapshot() (*brawtv1.Document, uint64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return proto.Clone(h.doc).(*brawtv1.Document), h.seq
}
