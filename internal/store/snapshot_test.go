package store

import (
	"bytes"
	"os"
	"strings"
	"testing"

	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
	"github.com/bernardoforcillo/brawt/internal/core"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

// The crash windows exercised here cannot be produced by crashing a real
// process at the right microsecond, so every one of them is CONSTRUCTED: the
// oplog is captured byte-for-byte before a snapshot and written back
// afterwards ("the compaction never ran"), a stale snapshot.seq is planted by
// hand ("the second rename never happened"), a persisted byte is flipped.

// setXOp is a SetProperties op, so these tests cover an op kind that mutates
// an existing node rather than only appending new ones.
func setXOp(id string, x float64) *brawtv1.Op {
	return &brawtv1.Op{OpId: "op-set-" + id, DocId: "doc1", Kind: &brawtv1.Op_SetProps{SetProps: &brawtv1.SetProperties{
		Id: id, Patch: &brawtv1.Node{X: x}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"x"}},
	}}}
}

func mustAppend(t *testing.T, b *Bundle, r *brawtv1.OpRecord) {
	t.Helper()
	if err := b.Append(r); err != nil {
		t.Fatalf("append seq %d: %v", r.GetSeq(), err)
	}
}

// readOplogRaw captures the oplog exactly as it sits on disk, so a later
// writeOplogRaw can put a bundle back into the state it was in before
// Snapshot compacted it -- i.e. simulate a crash between the two stages of
// the snapshot commit.
func readOplogRaw(t *testing.T, b *Bundle) []byte {
	t.Helper()
	data, err := os.ReadFile(b.oplogPath())
	if err != nil {
		t.Fatalf("read oplog: %v", err)
	}
	return data
}

func writeOplogRaw(t *testing.T, b *Bundle, data []byte) {
	t.Helper()
	if err := os.WriteFile(b.oplogPath(), data, 0o644); err != nil {
		t.Fatalf("write oplog: %v", err)
	}
}

func mustLoad(t *testing.T, dir string) (*brawtv1.Document, uint64) {
	t.Helper()
	b, err := Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	doc, seq, err := b.Load()
	if err != nil {
		t.Fatalf("Load(): %v", err)
	}
	return doc, seq
}

// TestSnapshotKeepsRecordsNewerThanItsSeq is the race the only natural M1
// wiring has: the snapshot is taken from the hub at seq 1 and, while it is
// being written, the user finishes a drag and seq 2 and 3 are appended and
// acked. Those records are not in the snapshot, so compaction must keep
// them -- truncating the whole oplog silently rewinds the document on the
// next restart.
func TestSnapshotKeepsRecordsNewerThanItsSeq(t *testing.T) {
	dir := t.TempDir()
	b, err := Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}

	mustAppend(t, b, rec(1, createOp("n1", 1)))
	docAt1, seqAt1, err := b.Load()
	if err != nil {
		t.Fatal(err)
	}
	if seqAt1 != 1 {
		t.Fatalf("setup: seq = %d, want 1", seqAt1)
	}

	// Ops that land after the snapshot was taken but before it is committed.
	mustAppend(t, b, rec(2, createOp("n2", 2)))
	mustAppend(t, b, rec(3, createOp("n3", 3)))

	if err := b.Snapshot(docAt1, seqAt1); err != nil {
		t.Fatalf("Snapshot(): %v", err)
	}

	doc, seq := mustLoad(t, dir)
	if seq != 3 {
		t.Fatalf("seq = %d, want 3 (records newer than the snapshot were destroyed)", seq)
	}
	if len(doc.Nodes) != 3 {
		t.Fatalf("nodes = %d, want 3 (records newer than the snapshot were destroyed)", len(doc.Nodes))
	}
}

// TestSnapshotRoundTripMatchesFullReplay: snapshot, append more, snapshot
// again, reload. Every op must survive and the reloaded document must be
// byte-identical to one built by replaying every op from scratch.
func TestSnapshotRoundTripMatchesFullReplay(t *testing.T) {
	// Built fresh on each call so the expected document never shares Node
	// pointers with the records handed to Append (applySetProps mutates the
	// node in place, which would otherwise rewrite an op before it is
	// persisted).
	records := func() []*brawtv1.OpRecord {
		return []*brawtv1.OpRecord{
			rec(1, createOp("n1", 1)),
			rec(2, createOp("n2", 2)),
			rec(3, setXOp("n1", 11)),
			rec(4, createOp("n3", 3)),
			rec(5, setXOp("n2", 22)),
		}
	}

	want := core.NewDocument("doc1", "Untitled")
	for _, r := range records() {
		if err := core.Apply(want, r.GetOp()); err != nil {
			t.Fatalf("build expected doc: %v", err)
		}
	}

	dir := t.TempDir()
	b, err := Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	all := records()

	mustAppend(t, b, all[0])
	mustAppend(t, b, all[1])
	doc, seq, err := b.Load()
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Snapshot(doc, seq); err != nil {
		t.Fatalf("first Snapshot(): %v", err)
	}

	mustAppend(t, b, all[2])
	mustAppend(t, b, all[3])
	doc, seq, err = b.Load()
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Snapshot(doc, seq); err != nil {
		t.Fatalf("second Snapshot(): %v", err)
	}

	mustAppend(t, b, all[4])

	got, gotSeq := mustLoad(t, dir)
	if gotSeq != 5 {
		t.Fatalf("seq = %d, want 5", gotSeq)
	}
	if !proto.Equal(got, want) {
		t.Fatalf("reloaded document != full replay\n got: %v\nwant: %v", got, want)
	}
}

// TestSnapshotIsSelfContained: the snapshot file alone must carry both the
// document and the seq it was taken at. The old commit split them across
// snapshot.pb and snapshot.seq as two independent renames, so a crash
// between them (snapshot.pb landed, snapshot.seq did not) left Load with a
// document and no seq -- and it failed permanently with "read snapshot seq".
func TestSnapshotIsSelfContained(t *testing.T) {
	dir := t.TempDir()
	b, err := Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	mustAppend(t, b, rec(1, createOp("n1", 1)))
	mustAppend(t, b, rec(2, createOp("n2", 2)))
	doc, seq, err := b.Load()
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Snapshot(doc, seq); err != nil {
		t.Fatalf("Snapshot(): %v", err)
	}

	// The crash: the second rename never happened. Nothing outside the
	// snapshot file may be needed to open the document.
	if err := os.Remove(b.seqPath()); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}

	got, gotSeq := mustLoad(t, dir)
	if gotSeq != 2 {
		t.Fatalf("seq = %d, want 2", gotSeq)
	}
	if len(got.Nodes) != 2 {
		t.Fatalf("nodes = %d, want 2", len(got.Nodes))
	}
}

// TestLoadIgnoresStaleSnapshotSeqFile is the other half of the same crash:
// a previous snapshot at seq 1 had written snapshot.seq, the new snapshot at
// seq 3 renamed snapshot.pb and then crashed. snapshot.seq still said 1 and
// the oplog still held 2..3, so replay re-applied a CreateNode already baked
// into the snapshot and Load failed forever with core.ErrNodeExists.
//
// A snapshot.seq left behind by an older build must now be inert.
func TestLoadIgnoresStaleSnapshotSeqFile(t *testing.T) {
	dir := t.TempDir()
	b, err := Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	mustAppend(t, b, rec(1, createOp("n1", 1)))
	mustAppend(t, b, rec(2, createOp("n2", 2)))
	mustAppend(t, b, rec(3, createOp("n3", 3)))
	before := readOplogRaw(t, b)

	doc, seq, err := b.Load()
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Snapshot(doc, seq); err != nil {
		t.Fatalf("Snapshot(): %v", err)
	}

	// The crash: neither the oplog compaction nor the seq update happened.
	writeOplogRaw(t, b, before)
	if err := os.WriteFile(b.seqPath(), []byte("1"), 0o644); err != nil {
		t.Fatal(err)
	}

	got, gotSeq := mustLoad(t, dir)
	if gotSeq != 3 {
		t.Fatalf("seq = %d, want 3", gotSeq)
	}
	if len(got.Nodes) != 3 {
		t.Fatalf("nodes = %d, want 3", len(got.Nodes))
	}
}

// TestLoadRecoversFromCrashBeforeOplogCompaction: the snapshot file is
// committed but the oplog rewrite never runs. Load must still open the
// document at a consistent seq -- skipping what the snapshot already
// contains and replaying only what it does not.
func TestLoadRecoversFromCrashBeforeOplogCompaction(t *testing.T) {
	dir := t.TempDir()
	b, err := Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	mustAppend(t, b, rec(1, createOp("n1", 1)))
	mustAppend(t, b, rec(2, createOp("n2", 2)))

	docAt2, seqAt2, err := b.Load()
	if err != nil {
		t.Fatal(err)
	}
	mustAppend(t, b, rec(3, createOp("n3", 3)))
	before := readOplogRaw(t, b)

	if err := b.Snapshot(docAt2, seqAt2); err != nil {
		t.Fatalf("Snapshot(): %v", err)
	}
	writeOplogRaw(t, b, before) // the compaction never landed

	got, gotSeq := mustLoad(t, dir)
	if gotSeq != 3 {
		t.Fatalf("seq = %d, want 3", gotSeq)
	}
	if len(got.Nodes) != 3 {
		t.Fatalf("nodes = %d, want 3", len(got.Nodes))
	}
	if got.Nodes["n3"].GetX() != 3 {
		t.Fatalf("n3.x = %v, want 3", got.Nodes["n3"].GetX())
	}
}

// TestSnapshotOnBundleWithNoOplog: compacting a bundle that has never been
// appended to must leave behind an oplog the next Append can extend, not a
// file the framing can't read.
func TestSnapshotOnBundleWithNoOplog(t *testing.T) {
	dir := t.TempDir()
	b, err := Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Snapshot(core.NewDocument("doc1", "Untitled"), 0); err != nil {
		t.Fatalf("Snapshot(): %v", err)
	}
	mustAppend(t, b, rec(1, createOp("n1", 1)))

	got, gotSeq := mustLoad(t, dir)
	if gotSeq != 1 {
		t.Fatalf("seq = %d, want 1", gotSeq)
	}
	if len(got.Nodes) != 1 {
		t.Fatalf("nodes = %d, want 1", len(got.Nodes))
	}
}

// TestLoadRejectsCorruptedSnapshot: the snapshot file now carries a checksum
// over the document it holds, so a byte that rots in place is reported
// instead of being decoded into a plausible-looking but wrong document.
func TestLoadRejectsCorruptedSnapshot(t *testing.T) {
	dir := t.TempDir()
	b, err := Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	mustAppend(t, b, rec(1, createOp("n1", 1)))
	doc, seq, err := b.Load()
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Snapshot(doc, seq); err != nil {
		t.Fatalf("Snapshot(): %v", err)
	}

	data, err := os.ReadFile(b.snapshotPath())
	if err != nil {
		t.Fatal(err)
	}
	// Rewrite one byte of the persisted document name to another valid
	// letter: the bytes stay a decodable Document, so only a checksum can
	// tell that they are not the ones that were written.
	at := bytes.Index(data, []byte("Untitled"))
	if at < 0 {
		t.Fatalf("document name not found in snapshot file")
	}
	data[at] = 'X'
	if err := os.WriteFile(b.snapshotPath(), data, 0o644); err != nil {
		t.Fatal(err)
	}

	b2, err := Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	got, _, err := b2.Load()
	if err == nil {
		t.Fatalf("Load() accepted a corrupted snapshot, returned name %q", got.GetName())
	}
	if !strings.Contains(err.Error(), "snapshot") {
		t.Fatalf("error = %v, want it to mention the snapshot", err)
	}
}

// TestLoadRejectsTruncatedSnapshot: a snapshot file too short to hold its own
// header must be reported, not read as an empty document at seq 0.
func TestLoadRejectsTruncatedSnapshot(t *testing.T) {
	dir := t.TempDir()
	b, err := Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	mustAppend(t, b, rec(1, createOp("n1", 1)))
	doc, seq, err := b.Load()
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Snapshot(doc, seq); err != nil {
		t.Fatalf("Snapshot(): %v", err)
	}
	if err := os.WriteFile(b.snapshotPath(), []byte("BRA"), 0o644); err != nil {
		t.Fatal(err)
	}

	b2, err := Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := b2.Load(); err == nil {
		t.Fatal("Load() accepted a truncated snapshot file, want an error")
	}
}
