package server

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
	"github.com/bernardoforcillo/brawt/internal/store"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

func createOp(id string) *brawtv1.Op {
	return &brawtv1.Op{OpId: "op-" + id, DocId: "doc1", Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{
		Node: &brawtv1.Node{Id: id, ParentId: "page1", OrderKey: "a0", Visible: true, Opacity: 1,
			Shape: &brawtv1.Node_Rect{Rect: &brawtv1.RectNode{}}}}}}
}

// mustSubscribe subscribes and fails the test if the hub cannot serve the
// requested catch-up (see ErrHistoryTooOld).
func mustSubscribe(t *testing.T, h *Hub, sinceSeq uint64) (<-chan *brawtv1.OpRecord, func()) {
	t.Helper()
	ch, cancel, err := h.Subscribe(sinceSeq)
	if err != nil {
		t.Fatalf("Subscribe(%d): %v", sinceSeq, err)
	}
	return ch, cancel
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
	ch, cancel := mustSubscribe(t, h, 0)
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
	ch, cancel := mustSubscribe(t, h, 0) // sinceSeq 0 → deve ricevere seq 1 in catch-up
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

// Fix-round regression tests (2026-08-01): each targets one blocking finding
// from the Task 6 review of 6f979d0.

// finding: Submit stored the caller's op pointer directly in the retained
// OpRecord; combined with core.Apply's applyCreate aliasing the Node into
// doc.Nodes, a later SetProps on the same node silently rewrote the node
// embedded in the node's earlier, already-broadcast CreateNode OpRecord.
func TestSubmitDoesNotAliasNodeIntoHistoricalRecord(t *testing.T) {
	h := newTestHub(t)
	rec1, err := h.Submit("c1", createOp("n1"))
	if err != nil {
		t.Fatal(err)
	}
	origX := rec1.GetOp().GetCreateNode().GetNode().GetX()
	if origX != 0 {
		t.Fatalf("precondition: want fresh node x=0, got %v", origX)
	}

	setX := &brawtv1.Op{OpId: "op-set1", DocId: "doc1", Kind: &brawtv1.Op_SetProps{SetProps: &brawtv1.SetProperties{
		Id:    "n1",
		Patch: &brawtv1.Node{X: 999},
		Mask:  &fieldmaskpb.FieldMask{Paths: []string{"x"}},
	}}}
	if _, err := h.Submit("c1", setX); err != nil {
		t.Fatal(err)
	}

	if got := rec1.GetOp().GetCreateNode().GetNode().GetX(); got != origX {
		t.Fatalf("historical CreateNode record was mutated by a later SetProps: x = %v, want %v (unchanged)", got, origX)
	}
	// Sanity: the live document DID move, so this isn't just a no-op mask.
	doc, _ := h.Snapshot()
	if got := doc.GetNodes()["n1"].GetX(); got != 999 {
		t.Fatalf("live doc x = %v, want 999 (SetProps should still apply)", got)
	}
}

// Second fix-round regression tests (2026-08-01): each targets one blocking
// finding from the re-review of the first fix round (commits
// 39ffc8b..ea277c5).

// finding: the fix-round hardening above only cloned the caller's op into
// the retained OpRecord (rec.Op); h.doc was still built by
// core.Apply(next, op) on the original, un-cloned op, so applyCreate
// aliased the caller's Node straight into h.doc.Nodes. h.doc kept aliasing
// caller-owned objects after Submit returned, contradicting the adjacent
// comment's own claim that "the caller is free to reuse or mutate [op]
// once Submit returns."
func TestSubmitDoesNotAliasCallerOpIntoDoc(t *testing.T) {
	h := newTestHub(t)
	op := createOp("n1")
	if _, err := h.Submit("c1", op); err != nil {
		t.Fatal(err)
	}

	// Mutate the caller's op after Submit has returned, exactly as the
	// adjacent comment says callers are free to do.
	op.GetCreateNode().GetNode().X = 999

	doc, _ := h.Snapshot()
	if got := doc.GetNodes()["n1"].GetX(); got != 0 {
		t.Fatalf("h.doc aliased the caller's op: node x = %v after caller mutated op, want 0 (unaffected)", got)
	}
}

// finding: Subscribe's returned cancel func unconditionally called
// close(s.ch) with no guard, so calling cancel() twice panicked (close of
// closed channel). Nothing documented a single-call-only contract, and it
// deviated from the idiomatic Go convention (e.g. context.CancelFunc) of
// idempotent cancel funcs.
func TestSubscribeCancelIsIdempotent(t *testing.T) {
	h := newTestHub(t)
	_, cancel := mustSubscribe(t, h, 0)

	cancel() // first call: must not panic
	cancel() // second call: must also not panic
}

// finding: Subscribe's catch-up loop did a blocking channel send (no
// select/default) into a fixed 256-capacity channel while holding h.mu.
// With no compaction wired up, a catch-up backlog exceeding capacity would
// deadlock Subscribe forever while holding the mutex, freezing every other
// Submit/Subscribe/Snapshot call on the Hub. Populate history directly
// (bypassing Submit's real fsync-per-op cost) to reproduce the backlog
// cheaply.
func TestSubscribeCatchUpBeyondChannelCapacityDoesNotBlock(t *testing.T) {
	h := newTestHub(t)

	const backlog = subscriberChanCap + 50
	h.mu.Lock()
	for i := uint64(1); i <= backlog; i++ {
		h.history = append(h.history, &brawtv1.OpRecord{Seq: i, Op: createOp(fmt.Sprintf("n%d", i))})
	}
	h.seq = backlog
	h.mu.Unlock()

	type result struct {
		ch     <-chan *brawtv1.OpRecord
		cancel func()
		err    error
	}
	done := make(chan result, 1)
	go func() {
		// h.Subscribe, not mustSubscribe: t.Fatalf must not be called from a
		// goroutine other than the test's own.
		ch, cancel, err := h.Subscribe(0)
		done <- result{ch, cancel, err}
	}()

	select {
	case r := <-done:
		if r.err != nil {
			t.Fatalf("Subscribe(0): %v", r.err)
		}
		defer r.cancel()
		count := 0
	drain:
		for {
			select {
			case _, ok := <-r.ch:
				if !ok {
					break drain
				}
				count++
			default:
				break drain
			}
		}
		if count != backlog {
			t.Fatalf("catch-up delivered %d records, want %d", count, backlog)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Subscribe deadlocked on a catch-up backlog exceeding channel capacity")
	}
}

// finding: core.Apply mutated h.doc in place before h.bundle.Append
// persisted the record; if Append failed, the mutation and h.seq increment
// were never rolled back, so a failed Submit still silently diverged the
// in-memory document from the persisted oplog.
func TestSubmitDoesNotMutateDocWhenAppendFails(t *testing.T) {
	dir := t.TempDir()
	b, err := store.Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewHub(b)
	if err != nil {
		t.Fatal(err)
	}

	beforeDoc, beforeSeq := h.Snapshot()

	// Force bundle.Append to fail: pre-create "oplog" as a directory so
	// os.OpenFile for the oplog file errors out.
	oplogPath := filepath.Join(dir, "doc1.brawt", "oplog")
	if err := os.Mkdir(oplogPath, 0o755); err != nil {
		t.Fatal(err)
	}

	if _, err := h.Submit("c1", createOp("n1")); err == nil {
		t.Fatal("expected Submit to fail when the oplog can't be appended to")
	}

	afterDoc, afterSeq := h.Snapshot()
	if afterSeq != beforeSeq {
		t.Fatalf("seq changed after a failed Submit: before=%d after=%d", beforeSeq, afterSeq)
	}
	if len(afterDoc.GetNodes()) != len(beforeDoc.GetNodes()) {
		t.Fatalf("doc node count changed after a failed Submit: before=%d after=%d", len(beforeDoc.GetNodes()), len(afterDoc.GetNodes()))
	}
	if _, exists := afterDoc.GetNodes()["n1"]; exists {
		t.Fatal("node n1 present in the document despite its Submit failing to persist")
	}
}

// finding: NewHub loaded doc+seq via b.Load() but never reconstructed
// h.history from the bundle's pre-existing persisted oplog, so Subscribe's
// catch-up silently returned nothing for any sinceSeq below the hub's
// startup seq after a server restart/reopen of an existing document.
func TestNewHubReconstructsHistoryAfterRestart(t *testing.T) {
	dir := t.TempDir()

	b1, err := store.Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	h1, err := NewHub(b1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h1.Submit("c1", createOp("n1")); err != nil {
		t.Fatal(err)
	}
	if _, err := h1.Submit("c1", createOp("n2")); err != nil {
		t.Fatal(err)
	}

	// Simulate a server restart: reopen the same on-disk bundle in a brand
	// new Hub, with no shared in-memory state with h1.
	b2, err := store.Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	h2, err := NewHub(b2)
	if err != nil {
		t.Fatal(err)
	}

	ch, cancel := mustSubscribe(t, h2, 0)
	defer cancel()

	got := map[uint64]bool{}
	for i := 0; i < 2; i++ {
		select {
		case rec := <-ch:
			got[rec.Seq] = true
		case <-time.After(time.Second):
			t.Fatalf("timed out waiting for post-restart catch-up record %d (got so far: %v)", i, got)
		}
	}
	if !got[1] || !got[2] {
		t.Fatalf("post-restart catch-up missing records: got=%v want seq 1 and 2", got)
	}
}

// finding (CRITICAL): a torn oplog append permanently bricked the document.
// bundle.Append used protodelim's two-Write framing, so a crash between the
// length prefix and the payload left a dangling prefix; Load's isEOF check
// only matched io.EOF, not the io.ErrUnexpectedEOF protodelim returns for a
// truncated payload, so NewHub -- and therefore every OpenDocument and
// SubmitOp for that doc_id -- failed forever with "read oplog: unexpected
// EOF" while the healthy records sat right there on disk.
//
// This is the end-to-end assertion for the whole fix: a document whose
// oplog ends mid-record must still open, must expose every intact record,
// and must accept new ops afterwards.
func TestNewHubOpensDocumentWithTornOplogTail(t *testing.T) {
	dir := t.TempDir()

	b1, err := store.Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	h1, err := NewHub(b1)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"n1", "n2", "n3"} {
		if _, err := h1.Submit("c1", createOp(id)); err != nil {
			t.Fatal(err)
		}
	}

	oplogPath := filepath.Join(dir, "doc1.brawt", "oplog")
	fi, err := os.Stat(oplogPath)
	if err != nil {
		t.Fatal(err)
	}
	good := fi.Size()

	// A fourth op starts to hit the disk, then the machine loses power
	// partway through the record.
	if _, err := h1.Submit("c1", createOp("n4")); err != nil {
		t.Fatal(err)
	}
	torn, err := os.Stat(oplogPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(oplogPath, good+(torn.Size()-good)/2); err != nil {
		t.Fatal(err)
	}

	// Restart: the document must still open.
	b2, err := store.Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	h2, err := NewHub(b2)
	if err != nil {
		t.Fatalf("NewHub must open a document whose oplog tail is torn, got: %v", err)
	}
	doc, seq := h2.Snapshot()
	if seq != 3 {
		t.Fatalf("seq = %d, want 3", seq)
	}
	if len(doc.GetNodes()) != 3 {
		t.Fatalf("nodes = %d, want 3", len(doc.GetNodes()))
	}

	// The oplog must be genuinely repaired: editing continues from seq 3
	// and survives another restart.
	rec, err := h2.Submit("c1", createOp("n4"))
	if err != nil {
		t.Fatalf("Submit after torn-tail recovery: %v", err)
	}
	if rec.Seq != 4 {
		t.Fatalf("post-recovery seq = %d, want 4", rec.Seq)
	}
	b3, err := store.Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	h3, err := NewHub(b3)
	if err != nil {
		t.Fatalf("NewHub after repair+append: %v", err)
	}
	doc3, seq3 := h3.Snapshot()
	if seq3 != 4 || len(doc3.GetNodes()) != 4 {
		t.Fatalf("after repair+append: seq = %d nodes = %d, want 4/4", seq3, len(doc3.GetNodes()))
	}
}
