package server

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
	"github.com/bernardoforcillo/brawt/internal/store"
	"google.golang.org/protobuf/proto"
)

// finding (cross-cutting): Bundle.Snapshot had no production caller, so
// oplogs were never compacted, Hub.history grew for the life of the process
// and the document's name had no durable home. These tests cover the wiring.

func hubOn(t *testing.T, dir, name string) *Hub {
	t.Helper()
	b, err := store.Open(dir, "doc1", name)
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewHub(b)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func oplogSize(t *testing.T, dir string) int64 {
	t.Helper()
	fi, err := os.Stat(filepath.Join(dir, "doc1.brawt", "oplog"))
	if err != nil {
		t.Fatal(err)
	}
	return fi.Size()
}

func submitN(t *testing.T, h *Hub, from, to int) {
	t.Helper()
	for i := from; i <= to; i++ {
		if _, err := h.Submit("c1", createOp(fmt.Sprintf("n%d", i))); err != nil {
			t.Fatalf("Submit n%d: %v", i, err)
		}
	}
}

// The end-to-end assertion, against the production threshold: nothing ever
// called Bundle.Snapshot, so the oplog only ever grew. After enough ops to
// cross snapshotEveryOps it must be SMALLER than it was one op earlier, and a
// reload must still reconstruct exactly the same document.
func TestSubmitCompactsOplogAtTheProductionThreshold(t *testing.T) {
	dir := t.TempDir()
	h := hubOn(t, dir, "Untitled")

	submitN(t, h, 1, snapshotEveryOps-1)
	h.waitSnapshots() // nothing to wait for yet; makes the size below stable
	before := oplogSize(t, dir)

	submitN(t, h, snapshotEveryOps, snapshotEveryOps)
	h.waitSnapshots()
	after := oplogSize(t, dir)

	if after >= before {
		t.Fatalf("oplog did not shrink at the snapshot threshold: %d bytes after %d ops, %d bytes after %d",
			after, snapshotEveryOps, before, snapshotEveryOps-1)
	}
	if err := h.snapshotErr; err != nil {
		t.Fatalf("background snapshot failed: %v", err)
	}

	// Compaction must not have cost anything: reloading the compacted bundle
	// has to produce the identical document at the identical seq.
	wantDoc, wantSeq := h.Snapshot()
	reloaded := hubOn(t, dir, "Untitled")
	gotDoc, gotSeq := reloaded.Snapshot()
	if gotSeq != wantSeq {
		t.Fatalf("reloaded seq = %d, want %d", gotSeq, wantSeq)
	}
	if !proto.Equal(gotDoc, wantDoc) {
		t.Fatalf("reloaded document differs from the live one\n got: %v\nwant: %v", gotDoc, wantDoc)
	}
}

// A snapshot must drop exactly the prefix it covers from h.history -- no
// less (the memory is the point) and no more (the rest is what catch-up
// still needs).
func TestSnapshotTrimsHistoryToWhatCatchUpStillNeeds(t *testing.T) {
	dir := t.TempDir()
	h := hubOn(t, dir, "Untitled")
	h.snapshotEvery = 4 // a real threshold costs 256 fsyncs

	submitN(t, h, 1, 4)
	h.waitSnapshots()

	h.mu.Lock()
	n, base := len(h.history), h.historyBase
	h.mu.Unlock()
	if n != 0 || base != 4 {
		t.Fatalf("after a snapshot at seq 4: history holds %d records (base %d), want 0 (base 4)", n, base)
	}

	// Ops after the snapshot are retained and still served.
	submitN(t, h, 5, 6)
	h.mu.Lock()
	n, base = len(h.history), h.historyBase
	h.mu.Unlock()
	if n != 2 || base != 4 {
		t.Fatalf("after 2 further ops: history holds %d records (base %d), want 2 (base 4)", n, base)
	}

	ch, cancel := mustSubscribe(t, h, 4)
	defer cancel()
	for _, want := range []uint64{5, 6} {
		select {
		case rec := <-ch:
			if rec.GetSeq() != want {
				t.Fatalf("catch-up seq = %d, want %d", rec.GetSeq(), want)
			}
		case <-time.After(time.Second):
			t.Fatalf("no catch-up record for seq %d", want)
		}
	}
}

// Compaction makes a since_seq unserviceable for the first time. The hub must
// say so rather than hand back a backlog with a hole in it: a missed
// CreateNode makes every later op on that node a silent no-op on the client.
func TestSubscribeRejectsASinceSeqThatWasCompactedAway(t *testing.T) {
	dir := t.TempDir()
	h := hubOn(t, dir, "Untitled")
	h.snapshotEvery = 4

	submitN(t, h, 1, 5)
	h.waitSnapshots()

	if _, _, err := h.Subscribe(0); !errors.Is(err, ErrHistoryTooOld) {
		t.Fatalf("Subscribe(0) after compaction: err = %v, want ErrHistoryTooOld", err)
	}
	if _, _, err := h.Subscribe(3); !errors.Is(err, ErrHistoryTooOld) {
		t.Fatalf("Subscribe(3) after compaction: err = %v, want ErrHistoryTooOld", err)
	}
	// The boundary itself is serviceable: everything above it is retained.
	if _, cancel, err := h.Subscribe(4); err != nil {
		t.Fatalf("Subscribe(4) after a snapshot at seq 4: %v", err)
	} else {
		cancel()
	}
}

// A reload has to stitch the snapshot back together with the oplog tail that
// followed it, and it has to do so repeatedly -- a document is snapshotted
// many times over its life.
func TestReloadAfterRepeatedCompactionRebuildsTheSameDocument(t *testing.T) {
	dir := t.TempDir()
	h := hubOn(t, dir, "Il mio disegno")
	h.snapshotEvery = 4

	submitN(t, h, 1, 10) // crosses the threshold twice, plus a tail
	h.waitSnapshots()
	if err := h.snapshotErr; err != nil {
		t.Fatalf("background snapshot failed: %v", err)
	}

	wantDoc, wantSeq := h.Snapshot()
	if wantSeq != 10 || len(wantDoc.GetNodes()) != 10 {
		t.Fatalf("precondition: seq = %d, nodes = %d, want 10/10", wantSeq, len(wantDoc.GetNodes()))
	}

	// A restart that has no idea what the document is called.
	reloaded := hubOn(t, dir, store.DefaultName)
	gotDoc, gotSeq := reloaded.Snapshot()
	if gotSeq != wantSeq {
		t.Fatalf("reloaded seq = %d, want %d", gotSeq, wantSeq)
	}
	if !proto.Equal(gotDoc, wantDoc) {
		t.Fatalf("reloaded document differs from the live one\n got: %v\nwant: %v", gotDoc, wantDoc)
	}
	if gotDoc.GetName() != "Il mio disegno" {
		t.Fatalf("reloaded document name = %q, want %q", gotDoc.GetName(), "Il mio disegno")
	}

	// It must also come back with a usable catch-up history for the records
	// the snapshot does not cover, and keep accepting ops.
	if _, cancel, err := reloaded.Subscribe(gotSeq); err != nil {
		t.Fatalf("Subscribe at the reloaded seq: %v", err)
	} else {
		cancel()
	}
	if rec, err := reloaded.Submit("c1", createOp("n11")); err != nil || rec.GetSeq() != 11 {
		t.Fatalf("Submit after reload: rec = %v, err = %v, want seq 11", rec, err)
	}
}

// The snapshot must run off the Submit path: the naive wiring (hub.Snapshot()
// then bundle.Snapshot() inline) would hold h.mu -- the lock that also backs
// OpenDocument and Subscribe -- across a marshal, two fsyncs and a rename.
// Hold a snapshot open at its disk write and check the hub still answers.
func TestHubKeepsServingWhileASnapshotIsWriting(t *testing.T) {
	dir := t.TempDir()
	h := hubOn(t, dir, "Untitled")
	h.snapshotEvery = 2

	entered := make(chan struct{})
	release := make(chan struct{})
	h.snapshotGate = func() {
		close(entered)
		<-release
	}

	submitN(t, h, 1, 2) // triggers the snapshot
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the snapshot goroutine never started")
	}

	// With the snapshot parked mid-flight, readers must not be blocked.
	done := make(chan struct{})
	go func() {
		defer close(done)
		if doc, seq := h.Snapshot(); doc == nil || seq != 2 {
			t.Errorf("Snapshot() during a background snapshot: doc = %v, seq = %d", doc, seq)
			return
		}
		if _, cancel, err := h.Subscribe(2); err != nil {
			t.Errorf("Subscribe() during a background snapshot: %v", err)
		} else {
			cancel()
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the hub lock was held across the snapshot: OpenDocument/Subscribe blocked behind it")
	}

	close(release)
	h.waitSnapshots()
}

// A snapshot is an optimisation: every op is already durable in the oplog
// when it runs. A failing one must therefore not fail the Submit that
// triggered it, must not lose anything, and must not be swallowed.
func TestAFailedSnapshotLosesNothing(t *testing.T) {
	dir := t.TempDir()
	h := hubOn(t, dir, "Untitled")
	h.snapshotEvery = 4

	// Make the snapshot's final rename fail: writeFileSync renames its temp
	// file onto snapshot.pb, which cannot replace a directory.
	snapPath := filepath.Join(dir, "doc1.brawt", "snapshot.pb")
	if err := os.Mkdir(snapPath, 0o755); err != nil {
		t.Fatal(err)
	}

	submitN(t, h, 1, 5) // every Submit must still succeed
	h.waitSnapshots()

	h.mu.Lock()
	snapErr, n := h.snapshotErr, len(h.history)
	h.mu.Unlock()
	if snapErr == nil {
		t.Fatal("a snapshot that could not be written reported no error")
	}
	if n != 5 {
		t.Fatalf("history holds %d records after a failed snapshot, want all 5 (nothing may be dropped before the snapshot is durable)", n)
	}

	// Nothing was compacted away either: the whole document replays.
	if err := os.Remove(snapPath); err != nil {
		t.Fatal(err)
	}
	reloaded := hubOn(t, dir, "Untitled")
	doc, seq := reloaded.Snapshot()
	if seq != 5 || len(doc.GetNodes()) != 5 {
		t.Fatalf("after a failed snapshot, reload gives seq = %d nodes = %d, want 5/5", seq, len(doc.GetNodes()))
	}
}

// Records are trimmed by seq, and the trim must release the memory it claims
// to: re-slicing h.history would keep the whole original backing array (and
// every dropped record) alive.
func TestTrimHistoryReleasesTheDroppedRecords(t *testing.T) {
	h := newTestHub(t)

	h.mu.Lock()
	for i := uint64(1); i <= 10; i++ {
		h.history = append(h.history, &brawtv1.OpRecord{Seq: i})
	}
	h.seq = 10
	h.trimHistoryLocked(6)
	got := make([]uint64, 0, len(h.history))
	for _, rec := range h.history {
		got = append(got, rec.GetSeq())
	}
	capacity, base := cap(h.history), h.historyBase
	h.mu.Unlock()

	if fmt.Sprint(got) != fmt.Sprint([]uint64{7, 8, 9, 10}) {
		t.Fatalf("history after trim(6) = %v, want [7 8 9 10]", got)
	}
	if base != 6 {
		t.Fatalf("historyBase = %d, want 6", base)
	}
	if capacity != 4 {
		t.Fatalf("history capacity = %d after trimming to 4 records: the dropped records are still reachable", capacity)
	}
}
