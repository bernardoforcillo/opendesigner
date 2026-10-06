package store

import (
	"os"
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func rec(seq uint64, op *opendesignerv1.Op) *opendesignerv1.OpRecord {
	return &opendesignerv1.OpRecord{Seq: seq, Ts: timestamppb.New(timeZero()), ClientId: "c1", Op: op}
}

func createOp(id string, x float64) *opendesignerv1.Op {
	return &opendesignerv1.Op{OpId: "op-" + id, DocId: "doc1", Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{
		Node: &opendesignerv1.Node{Id: id, ParentId: "page1", OrderKey: "a0", Visible: true, Opacity: 1, X: x,
			Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}}},
	}}}
}

func TestAppendReplay(t *testing.T) {
	dir := t.TempDir()
	b, err := Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Append(rec(1, createOp("n1", 5))); err != nil {
		t.Fatal(err)
	}
	if err := b.Append(rec(2, createOp("n2", 9))); err != nil {
		t.Fatal(err)
	}
	// reopen from scratch: it must rebuild from the (empty) snapshot + oplog
	b2, err := Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	doc, seq, err := b2.Load()
	if err != nil {
		t.Fatal(err)
	}
	if seq != 2 {
		t.Fatalf("seq = %d, want 2", seq)
	}
	if len(doc.Nodes) != 2 {
		t.Fatalf("nodes = %d, want 2", len(doc.Nodes))
	}
}

// TestSnapshotCompactsOplog: when the snapshot covers everything in the
// oplog, nothing survives compaction and the next op simply continues from
// seq+1 on top of the snapshot.
func TestSnapshotCompactsOplog(t *testing.T) {
	dir := t.TempDir()
	b, _ := Open(dir, "doc1", "Untitled")
	_ = b.Append(rec(1, createOp("n1", 5)))
	doc, seq, _ := b.Load()
	if err := b.Snapshot(doc, seq); err != nil {
		t.Fatal(err)
	}
	// after the snapshot, a new op continues from seq+1
	_ = b.Append(rec(2, &opendesignerv1.Op{OpId: "m", DocId: "doc1", Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: "n1", Patch: &opendesignerv1.Node{X: 99}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"x"}}}}}))
	b2, _ := Open(dir, "doc1", "Untitled")
	doc2, seq2, _ := b2.Load()
	if seq2 != 2 || doc2.Nodes["n1"].X != 99 {
		t.Fatalf("post-snapshot replay wrong: seq=%d x=%v", seq2, doc2.Nodes["n1"].X)
	}
}

// TestLoadSelfHealsStaleOplogAfterSnapshot reproduces the crash window
// between Snapshot() publishing the new snapshot and it compacting the
// oplog: leftover oplog records whose Seq is already baked into the
// snapshot must not be re-applied (which would hit core.ErrNodeExists for
// a duplicate CreateNode and fail Load() permanently) -- Load() must skip
// them and self-heal instead.
func TestLoadSelfHealsStaleOplogAfterSnapshot(t *testing.T) {
	dir := t.TempDir()
	b, _ := Open(dir, "doc1", "Untitled")

	r1 := rec(1, createOp("n1", 5))
	r2 := rec(2, createOp("n2", 9))
	if err := b.Append(r1); err != nil {
		t.Fatal(err)
	}
	if err := b.Append(r2); err != nil {
		t.Fatal(err)
	}
	doc, seq, err := b.Load()
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Snapshot(doc, seq); err != nil {
		t.Fatal(err)
	}

	// Simulate the crash: the snapshot (seq=2) landed and was fsync'd, but
	// the oplog compaction never happened -- so re-append the exact same
	// already-applied records back onto the oplog.
	if err := b.Append(r1); err != nil {
		t.Fatal(err)
	}
	if err := b.Append(r2); err != nil {
		t.Fatal(err)
	}

	b2, _ := Open(dir, "doc1", "Untitled")
	doc2, seq2, err := b2.Load()
	if err != nil {
		t.Fatalf("Load() should self-heal stale oplog entries, got error: %v", err)
	}
	if seq2 != 2 {
		t.Fatalf("seq = %d, want 2", seq2)
	}
	if len(doc2.Nodes) != 2 {
		t.Fatalf("nodes = %d, want 2 (stale duplicate entries must not double-apply)", len(doc2.Nodes))
	}
}

// TestLoadSelfHealsStaleOplogWithNewerTail additionally checks that once
// the stale (already-snapshotted) prefix is skipped, replay still resumes
// correctly on any genuinely new records appended after the crash window.
func TestLoadSelfHealsStaleOplogWithNewerTail(t *testing.T) {
	dir := t.TempDir()
	b, _ := Open(dir, "doc1", "Untitled")

	r1 := rec(1, createOp("n1", 5))
	if err := b.Append(r1); err != nil {
		t.Fatal(err)
	}
	doc, seq, err := b.Load()
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Snapshot(doc, seq); err != nil {
		t.Fatal(err)
	}

	// Leftover stale record from the interrupted compaction, followed by a
	// genuinely new op appended after the "crash".
	if err := b.Append(r1); err != nil {
		t.Fatal(err)
	}
	if err := b.Append(rec(2, createOp("n2", 9))); err != nil {
		t.Fatal(err)
	}

	b2, _ := Open(dir, "doc1", "Untitled")
	doc2, seq2, err := b2.Load()
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}
	if seq2 != 2 {
		t.Fatalf("seq = %d, want 2", seq2)
	}
	if len(doc2.Nodes) != 2 {
		t.Fatalf("nodes = %d, want 2", len(doc2.Nodes))
	}
}

// TestSnapshotDurablyWritesFiles asserts Snapshot() leaves snapshot.pb
// present and correctly readable back -- i.e. the temp-file + fsync + rename
// path in writeFileSync actually lands the data, it isn't just a no-op
// refactor -- and that the seq it was taken at comes back out of that one
// file, with no second file involved.
//
// (The two-file version of this test asserted that a missing or unparseable
// snapshot.seq made Load() fail. That was the crash window, not a desirable
// invariant: see TestSnapshotIsSelfContained and
// TestLoadIgnoresStaleSnapshotSeqFile in snapshot_test.go.)
func TestSnapshotDurablyWritesFiles(t *testing.T) {
	dir := t.TempDir()
	b, _ := Open(dir, "doc1", "Untitled")
	_ = b.Append(rec(1, createOp("n1", 5)))
	doc, seq, err := b.Load()
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Snapshot(doc, seq); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(b.snapshotPath()); err != nil {
		t.Fatalf("snapshot.pb missing after Snapshot(): %v", err)
	}
	b.mu.Lock()
	gotSeq, err := b.readSnapshotSeq()
	b.mu.Unlock()
	if err != nil {
		t.Fatalf("read back snapshot seq: %v", err)
	}
	if gotSeq != 1 {
		t.Fatalf("snapshot seq = %d, want 1", gotSeq)
	}
	if _, err := os.Stat(b.seqPath()); !os.IsNotExist(err) {
		t.Fatalf("snapshot.seq still exists after Snapshot(): stat err = %v", err)
	}
	// No leftover temp files from writeFileSync. writeFileSync creates its
	// temp file via os.CreateTemp(filepath.Dir(path), ...), i.e. inside the
	// bundle directory (b.dir = "<dir>/doc1.opendesigner"), not in the workspace
	// root (dir) itself -- scan b.dir, or a real leftover ".tmp-*" file
	// would never be seen here.
	entries, err := os.ReadDir(b.dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp-") {
			t.Fatalf("leftover temp file: %s", e.Name())
		}
	}
}
