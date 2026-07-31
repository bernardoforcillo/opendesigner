package server

import (
	"testing"
	"time"

	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
	"github.com/bernardoforcillo/brawt/internal/store"
)

func createOp(id string) *brawtv1.Op {
	return &brawtv1.Op{OpId: "op-" + id, DocId: "doc1", Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{
		Node: &brawtv1.Node{Id: id, ParentId: "page1", OrderKey: "a0", Visible: true, Opacity: 1,
			Shape: &brawtv1.Node_Rect{Rect: &brawtv1.RectNode{}}}}}}
}

func newTestHub(t *testing.T) *Hub {
	t.Helper()
	b, err := store.Open(t.TempDir(), "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewHub(b)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func TestSubmitAssignsIncrementingSeq(t *testing.T) {
	h := newTestHub(t)
	r1, err := h.Submit("c1", createOp("n1"))
	if err != nil {
		t.Fatal(err)
	}
	r2, _ := h.Submit("c1", createOp("n2"))
	if r1.Seq != 1 || r2.Seq != 2 {
		t.Fatalf("seq = %d,%d want 1,2", r1.Seq, r2.Seq)
	}
}

func TestSubscriberReceivesBroadcast(t *testing.T) {
	h := newTestHub(t)
	ch, cancel := h.Subscribe(0)
	defer cancel()
	_, _ = h.Submit("c1", createOp("n1"))
	select {
	case rec := <-ch:
		if rec.GetOp().GetCreateNode().GetNode().GetId() != "n1" {
			t.Fatalf("unexpected record: %v", rec)
		}
	case <-time.After(time.Second):
		t.Fatal("no broadcast received")
	}
}

func TestSubscribeCatchUp(t *testing.T) {
	h := newTestHub(t)
	_, _ = h.Submit("c1", createOp("n1")) // seq 1, prima della subscribe
	ch, cancel := h.Subscribe(0)          // sinceSeq 0 → deve ricevere seq 1 in catch-up
	defer cancel()
	select {
	case rec := <-ch:
		if rec.Seq != 1 {
			t.Fatalf("catch-up seq = %d want 1", rec.Seq)
		}
	case <-time.After(time.Second):
		t.Fatal("no catch-up record")
	}
}
