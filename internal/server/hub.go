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

type subscriber struct{ ch chan *brawtv1.OpRecord }

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
	return &Hub{bundle: b, doc: doc, seq: seq, subs: map[*subscriber]struct{}{}}, nil
}

func (h *Hub) Submit(clientID string, op *brawtv1.Op) (*brawtv1.OpRecord, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := core.Apply(h.doc, op); err != nil {
		return nil, err
	}
	h.seq++
	rec := &brawtv1.OpRecord{Seq: h.seq, Ts: timestamppb.Now(), ClientId: clientID, Op: op}
	if err := h.bundle.Append(rec); err != nil {
		return nil, err
	}
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
	s := &subscriber{ch: make(chan *brawtv1.OpRecord, 256)}
	for _, rec := range h.history { // catch-up
		if rec.Seq > sinceSeq {
			s.ch <- rec
		}
	}
	h.subs[s] = struct{}{}
	cancel := func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		delete(h.subs, s)
		close(s.ch)
	}
	return s.ch, cancel
}

func (h *Hub) Snapshot() (*brawtv1.Document, uint64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return proto.Clone(h.doc).(*brawtv1.Document), h.seq
}
