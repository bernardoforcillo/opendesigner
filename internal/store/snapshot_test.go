package store

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"slices"
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

// oplogSeqsOnDisk returns the seq of every record actually present in the
// oplog file. It is the only way to tell "compaction dropped the prefix" from
// "Load merely skipped it": both Load and History filter out records whose seq
// is <= the persisted snapshot's, so every document-level assertion is
// identical whether the records are gone or still sitting there.
func oplogSeqsOnDisk(t *testing.T, b *Bundle) []uint64 {
	t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	recs, err := b.readOplogLocked()
	if err != nil {
		t.Fatalf("read oplog: %v", err)
	}
	seqs := make([]uint64, 0, len(recs))
	for _, r := range recs {
		seqs = append(seqs, r.GetSeq())
	}
	return seqs
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

// finding: the meta.json refresh is the last step of Snapshot and shared its
// error return, so a failure there reported an ALREADY-COMMITTED snapshot as
// failed -- document published, oplog compacted, both fsynced. The hub reads
// that as "no snapshot happened" and keeps every covered record in memory for
// the life of the process.
func TestSnapshotThatCannotRefreshMetaIsStillCommitted(t *testing.T) {
	dir := t.TempDir()
	b, err := Open(dir, "doc1", "Alfa")
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 3; i++ {
		mustAppend(t, b, rec(uint64(i), createOp(fmt.Sprintf("n%d", i), float64(i))))
	}
	doc, seq, err := b.Load()
	if err != nil {
		t.Fatal(err)
	}
	before := b.Meta()

	// Break the identity refresh and nothing else: writeFileSync commits by
	// renaming its temp file onto meta.json, and no rename can replace a
	// directory.
	if err := os.Remove(b.metaPath()); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(b.metaPath(), 0o755); err != nil {
		t.Fatal(err)
	}

	err = b.Snapshot(doc, seq)
	if err == nil {
		t.Fatal("a snapshot that could not refresh meta.json reported no error at all")
	}
	if !errors.Is(err, ErrSnapshotCommitted) {
		t.Fatalf("Snapshot() error = %v, want one wrapping ErrSnapshotCommitted so a caller can tell it from a lost snapshot", err)
	}

	// Everything the error says committed, committed.
	b.mu.Lock()
	persisted, perr := b.readSnapshotSeq()
	b.mu.Unlock()
	if perr != nil {
		t.Fatalf("read the persisted snapshot seq: %v", perr)
	}
	if persisted != seq {
		t.Fatalf("persisted snapshot seq = %d, want %d: the snapshot did not commit", persisted, seq)
	}
	if got := oplogSeqsOnDisk(t, b); len(got) != 0 {
		t.Fatalf("oplog still holds %v after a snapshot at seq %d: it did not compact", got, seq)
	}

	// And the in-memory identity still describes what is on disk: UpdatedAt
	// was bumped before the write, so Meta() went on reporting a "last
	// modified" no reader would ever see and that vanished on the next
	// restart.
	if got := b.Meta(); !got.UpdatedAt.Equal(before.UpdatedAt) {
		t.Fatalf("Meta().UpdatedAt = %v after a failed refresh, want the persisted %v", got.UpdatedAt, before.UpdatedAt)
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

// TestSnapshotDropsRecordsItAlreadyContains is the half of compaction that no
// document-level assertion can see. A snapshot at the tip must leave the oplog
// EMPTY, not merely full of records everybody agrees to ignore: Load and
// History both skip seq <= the snapshot's, so disabling compaction entirely
// changes no reloaded document anywhere -- it only makes the log, and the
// startup parse of it, grow without bound. This asserts the file itself.
func TestSnapshotDropsRecordsItAlreadyContains(t *testing.T) {
	dir := t.TempDir()
	b, err := Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 5; i++ {
		mustAppend(t, b, rec(uint64(i), createOp(fmt.Sprintf("n%d", i), float64(i))))
	}
	before := len(readOplogRaw(t, b))

	doc, seq, err := b.Load()
	if err != nil {
		t.Fatal(err)
	}
	if seq != 5 {
		t.Fatalf("setup: seq = %d, want 5", seq)
	}
	if err := b.Snapshot(doc, seq); err != nil {
		t.Fatalf("Snapshot(): %v", err)
	}

	if got := oplogSeqsOnDisk(t, b); len(got) != 0 {
		t.Fatalf("oplog still holds records %v after a snapshot at seq 5: the covered prefix was not dropped, so the log grows without bound", got)
	}
	after := len(readOplogRaw(t, b))
	if int64(after) != oplogHeaderSize {
		t.Fatalf("oplog is %d bytes after compaction (was %d), want the %d byte file header alone", after, before, oplogHeaderSize)
	}
}

// TestSnapshotDropsOnlyThePrefixItCovers: compaction is a predicate over seq,
// not "empty the file". With a snapshot at seq 2 over an oplog holding 1..5,
// exactly [3 4 5] may survive on disk -- dropping less leaks the covered
// prefix forever, dropping more destroys acked ops.
func TestSnapshotDropsOnlyThePrefixItCovers(t *testing.T) {
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
	if seqAt2 != 2 {
		t.Fatalf("setup: seq = %d, want 2", seqAt2)
	}
	// Appended after the snapshot was taken from the hub, before it commits.
	mustAppend(t, b, rec(3, createOp("n3", 3)))
	mustAppend(t, b, rec(4, createOp("n4", 4)))
	mustAppend(t, b, rec(5, createOp("n5", 5)))

	if err := b.Snapshot(docAt2, seqAt2); err != nil {
		t.Fatalf("Snapshot(): %v", err)
	}

	got := oplogSeqsOnDisk(t, b)
	if !slices.Equal(got, []uint64{3, 4, 5}) {
		t.Fatalf("oplog holds %v after a snapshot at seq 2, want [3 4 5]", got)
	}
	// History is the same predicate read back through the public API, so the
	// two must agree: nothing was left behind for Load to paper over.
	hist, err := b.History()
	if err != nil {
		t.Fatalf("History(): %v", err)
	}
	if len(hist) != 3 {
		t.Fatalf("History() = %d records, want 3", len(hist))
	}

	doc, seq := mustLoad(t, dir)
	if seq != 5 || len(doc.Nodes) != 5 {
		t.Fatalf("reload: seq = %d, nodes = %d, want 5 and 5", seq, len(doc.Nodes))
	}
}

// TestSnapshotRefusesAnUnreadablePersistedSeq: deciding whether a snapshot
// moves the bundle forward requires reading the seq already on disk. When that
// read fails the answer is unknown, and Snapshot is also a compaction --
// compacting against an unknown baseline is precisely how acked ops get
// deleted. It must refuse and leave the oplog exactly as it found it.
func TestSnapshotRefusesAnUnreadablePersistedSeq(t *testing.T) {
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
	if err := b.Snapshot(docAt2, seqAt2); err != nil {
		t.Fatalf("Snapshot(): %v", err)
	}
	mustAppend(t, b, rec(3, createOp("n3", 3)))
	mustAppend(t, b, rec(4, createOp("n4", 4)))
	oplogBefore := readOplogRaw(t, b)

	// Rot in place: the bytes still look like a snapshot file, but the
	// checksum no longer matches, so the seq they carry cannot be trusted.
	data, err := os.ReadFile(b.snapshotPath())
	if err != nil {
		t.Fatal(err)
	}
	data[len(data)-1] ^= 0xff
	if err := os.WriteFile(b.snapshotPath(), data, 0o644); err != nil {
		t.Fatal(err)
	}

	if err := b.Snapshot(docAt2, 9); err == nil {
		t.Fatal("Snapshot() compacted the oplog against an unreadable baseline, want an error")
	}
	if got := readOplogRaw(t, b); !bytes.Equal(got, oplogBefore) {
		t.Fatalf("oplog changed under a refused snapshot: %d bytes, was %d", len(got), len(oplogBefore))
	}
}

// TestSnapshotIgnoresASeqOlderThanThePersistedOne guards the direction that
// destroys data outright. Snapshot(doc, seq) both overwrites snapshot.pb and
// compacts the oplog against seq, so a call carrying an OLDER seq than the one
// already on disk rewinds the snapshot and then deletes the very records that
// would have replayed the difference back -- every op in between is gone from
// both files, with no error anywhere.
//
// This is reachable, not theoretical: Hub.Snapshot releases h.mu before
// Bundle.Snapshot takes b.mu, so two overlapping snapshot goroutines can
// arrive here in the opposite order to the seqs they captured. Neither caller
// did anything wrong, so the older one is a no-op rather than an error.
func TestSnapshotIgnoresASeqOlderThanThePersistedOne(t *testing.T) {
	dir := t.TempDir()
	b, err := Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	mustAppend(t, b, rec(1, createOp("n1", 1)))
	mustAppend(t, b, rec(2, createOp("n2", 2)))
	// The stale clone: goroutine B captured the hub at seq 2 and is slow.
	docAt2, seqAt2, err := b.Load()
	if err != nil {
		t.Fatal(err)
	}

	mustAppend(t, b, rec(3, createOp("n3", 3)))
	mustAppend(t, b, rec(4, createOp("n4", 4)))
	docAt4, seqAt4, err := b.Load()
	if err != nil {
		t.Fatal(err)
	}
	if seqAt4 != 4 {
		t.Fatalf("setup: seq = %d, want 4", seqAt4)
	}
	// Goroutine A wins the lock and commits the newer snapshot, which also
	// compacts the oplog down to its header -- 3 and 4 now live only in
	// snapshot.pb.
	if err := b.Snapshot(docAt4, seqAt4); err != nil {
		t.Fatalf("Snapshot(4): %v", err)
	}

	// Goroutine B arrives second with the older state.
	if err := b.Snapshot(docAt2, seqAt2); err != nil {
		t.Fatalf("Snapshot(2) on top of a newer snapshot: %v", err)
	}

	b.mu.Lock()
	persisted, err := b.readSnapshotSeq()
	b.mu.Unlock()
	if err != nil {
		t.Fatalf("read back snapshot seq: %v", err)
	}
	if persisted != 4 {
		t.Fatalf("persisted snapshot seq = %d, want 4 (a stale snapshot overwrote a newer one)", persisted)
	}

	doc, seq := mustLoad(t, dir)
	if seq != 4 {
		t.Fatalf("seq = %d, want 4 (ops 3..4 were destroyed: rewound snapshot + compaction against the older seq)", seq)
	}
	if len(doc.Nodes) != 4 {
		t.Fatalf("nodes = %d, want 4 (ops 3..4 were destroyed)", len(doc.Nodes))
	}
}
