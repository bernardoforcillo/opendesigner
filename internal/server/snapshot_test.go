package server

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/bernardoforcillo/opendesigner/internal/store"
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
	fi, err := os.Stat(filepath.Join(dir, "doc1.opendesigner", "oplog"))
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

// gatedBundle is a store.Bundle whose disk work can be held open. It models
// the one property of the real bundle this test turns on: Append and Snapshot
// are mutually exclusive (store.Bundle serialises both on b.mu, because
// compaction rewrites the file Append appends to), so a Submit landing while
// a snapshot is writing has to wait for it.
//
// Nothing else about it is a fake: the hub's own state, locks and goroutines
// are the production ones. Parking a REAL bundle mid-write is not possible
// from here -- store's fault-injection seam is unexported -- and parking the
// hub just before it calls the bundle proves nothing at all, which is exactly
// what the previous version of this test did.
type gatedBundle struct {
	mu sync.Mutex // stands in for store.Bundle.mu

	once      sync.Once     // only the FIRST snapshot is held open
	entered   chan struct{} // closed once Snapshot holds mu
	release   chan struct{} // close to let Snapshot finish
	appending chan struct{} // receives once per Append, before it waits on mu
}

func newGatedBundle() *gatedBundle {
	return &gatedBundle{
		entered:   make(chan struct{}),
		release:   make(chan struct{}),
		appending: make(chan struct{}, 8),
	}
}

func (g *gatedBundle) Load() (*opendesignerv1.Document, uint64, error) {
	return core.NewDocument("doc1", "Untitled"), 0, nil
}
func (g *gatedBundle) History() ([]*opendesignerv1.OpRecord, error) { return nil, nil }

func (g *gatedBundle) Append(*opendesignerv1.OpRecord) error {
	// Announced BEFORE the wait, so a test that has received this knows the
	// submitting goroutine is already inside Append -- past everything Submit
	// does under a hub lock -- and is about to block for as long as the
	// snapshot holds g.mu.
	g.appending <- struct{}{}
	g.mu.Lock()
	defer g.mu.Unlock()
	return nil
}

func (g *gatedBundle) Snapshot(*opendesignerv1.Document, uint64) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	// Only the first one is held open: releasing it lets the queued Submit
	// through, and that Submit triggers another snapshot which must not park
	// (and must not close an already-closed channel).
	g.once.Do(func() {
		close(g.entered)
		<-g.release
	})
	return nil
}

// The snapshot runs off the Submit path so that the hub keeps serving while
// it writes. The wiring that matters is not that the disk work is on a
// goroutine -- it always was -- but that a Submit which lands mid-snapshot
// waits for it WITHOUT holding the lock OpenDocument and Subscribe need.
// Before, Submit held h.mu across bundle.Append, so one client's op arriving
// during a snapshot stalled every reader of that document for the whole
// write: a marshal of the entire document, three fsynced atomic writes and a
// full oplog read.
func TestSubmitWaitingOnASnapshotDoesNotStallReaders(t *testing.T) {
	g := newGatedBundle()
	h, err := newHub(g)
	if err != nil {
		t.Fatal(err)
	}
	h.snapshotEvery = 1

	// One op: durable, then a snapshot starts and parks holding the bundle
	// lock -- where a real snapshot spends its whole life.
	if _, err := h.Submit("c1", createOp("n1")); err != nil {
		t.Fatal(err)
	}
	<-g.appending
	select {
	case <-g.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the snapshot goroutine never reached the bundle")
	}

	// A second op arrives mid-snapshot. It cannot complete -- Append waits on
	// the bundle lock -- and that is fine and expected.
	submitted := make(chan struct{})
	go func() {
		defer close(submitted)
		if _, err := h.Submit("c1", createOp("n2")); err != nil {
			t.Errorf("Submit during a snapshot: %v", err)
		}
	}()
	<-g.appending // it is now inside Append, waiting

	// What must NOT happen is that wait spreading to the readers.
	done := make(chan struct{})
	go func() {
		defer close(done)
		if doc, seq := h.Snapshot(); doc == nil || seq != 1 {
			t.Errorf("Snapshot() while a Submit waits on a snapshot: doc = %v, seq = %d", doc, seq)
			return
		}
		if _, cancel, err := h.Subscribe(1); err != nil {
			t.Errorf("Subscribe() while a Submit waits on a snapshot: %v", err)
		} else {
			cancel()
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("OpenDocument/Subscribe blocked: the Submit waiting for the snapshot was holding the hub's state lock")
	}

	close(g.release)
	<-submitted
	h.waitSnapshots()

	// And the op that waited did land, in order.
	if doc, seq := h.Snapshot(); seq != 2 || len(doc.GetNodes()) != 2 {
		t.Fatalf("after the snapshot: seq = %d nodes = %d, want 2/2", seq, len(doc.GetNodes()))
	}
}

// The same disk work must not stall readers through the snapshot goroutine
// either: it takes the hub lock only after the bundle has finished with it.
// This is the real-bundle half of the test above -- no fake anywhere, just a
// slow enough snapshot to be observed.
func TestHubKeepsServingWhileASnapshotIsWriting(t *testing.T) {
	dir := t.TempDir()
	h := hubOn(t, dir, "Untitled")
	h.snapshotEvery = 8

	submitN(t, h, 1, 8) // triggers a real snapshot: marshal, fsync, compact

	// Readers must answer while it is in flight. They are not synchronised
	// with the disk work -- there is no way to be -- so this hammers them
	// until it has finished, and every single answer must be prompt and
	// correct.
	for {
		done := make(chan struct{})
		go func() {
			defer close(done)
			if doc, seq := h.Snapshot(); doc == nil || seq != 8 {
				t.Errorf("Snapshot() during a background snapshot: doc = %v, seq = %d", doc, seq)
				return
			}
			if _, cancel, err := h.Subscribe(8); err != nil {
				t.Errorf("Subscribe() during a background snapshot: %v", err)
			} else {
				cancel()
			}
		}()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("a reader blocked behind the snapshot")
		}
		h.mu.Lock()
		running := h.snapshotting
		h.mu.Unlock()
		if !running {
			break
		}
	}
	h.waitSnapshots()
	if err := h.snapshotErr; err != nil {
		t.Fatalf("background snapshot failed: %v", err)
	}
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
	snapPath := filepath.Join(dir, "doc1.opendesigner", "snapshot.pb")
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

// finding: a snapshot whose ONLY failure is the meta.json refresh has already
// committed -- document published, oplog compacted, both fsynced -- but
// runSnapshot treated every error alike and skipped trimHistoryLocked. The
// unbounded-history fix then silently stops applying: history keeps every
// record for the life of the process while historyBase falls permanently
// behind the seq on disk, so Subscribe also keeps serving a backlog the
// snapshot has already absorbed.
func TestASnapshotThatOnlyFailedToRefreshMetaStillTrimsHistory(t *testing.T) {
	dir := t.TempDir()
	h := hubOn(t, dir, "Untitled")
	h.snapshotEvery = 4

	// Break the identity refresh and nothing else (see the store-side test):
	// the temp+rename commit cannot replace a directory.
	metaPath := filepath.Join(dir, "doc1.opendesigner", "meta.json")
	if err := os.Remove(metaPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(metaPath, 0o755); err != nil {
		t.Fatal(err)
	}

	submitN(t, h, 1, 4)
	h.waitSnapshots()

	h.mu.Lock()
	n, base, snapErr := len(h.history), h.historyBase, h.snapshotErr
	h.mu.Unlock()
	if n != 0 || base != 4 {
		t.Fatalf("history holds %d records (base %d) after a snapshot that committed, want 0 (base 4)", n, base)
	}
	if snapErr == nil || !errors.Is(snapErr, store.ErrSnapshotCommitted) {
		t.Fatalf("snapshotErr = %v, want the failed meta refresh recorded (not swallowed) as ErrSnapshotCommitted", snapErr)
	}
	// The catch-up the snapshot absorbed is genuinely gone, not merely
	// unreported.
	if _, _, err := h.Subscribe(0); !errors.Is(err, ErrHistoryTooOld) {
		t.Fatalf("Subscribe(0) after the snapshot: err = %v, want ErrHistoryTooOld", err)
	}

	// And the document really is on disk at that seq: put meta.json back and
	// reload.
	if err := os.Remove(metaPath); err != nil {
		t.Fatal(err)
	}
	reloaded := hubOn(t, dir, store.DefaultName)
	if doc, seq := reloaded.Snapshot(); seq != 4 || len(doc.GetNodes()) != 4 {
		t.Fatalf("reload gives seq = %d nodes = %d, want 4/4", seq, len(doc.GetNodes()))
	}
}

// Records are trimmed by seq, and the trim must release the memory it claims
// to: re-slicing h.history would keep the whole original backing array (and
// every dropped record) alive.
func TestTrimHistoryReleasesTheDroppedRecords(t *testing.T) {
	h := newTestHub(t)

	h.mu.Lock()
	for i := uint64(1); i <= 10; i++ {
		h.history = append(h.history, &opendesignerv1.OpRecord{Seq: i})
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
