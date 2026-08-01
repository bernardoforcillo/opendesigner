package store

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"os"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"
)

// oplogSize returns the current byte length of the bundle's oplog.
func oplogSize(t *testing.T, b *Bundle) int64 {
	t.Helper()
	fi, err := os.Stat(b.oplogPath())
	if err != nil {
		t.Fatalf("stat oplog: %v", err)
	}
	return fi.Size()
}

// appendGood writes n records (n1..nN) and returns the oplog size after each.
func appendGood(t *testing.T, b *Bundle, n int) []int64 {
	t.Helper()
	sizes := make([]int64, 0, n)
	for i := 1; i <= n; i++ {
		if err := b.Append(rec(uint64(i), createOp(nodeName(i), float64(i)))); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
		sizes = append(sizes, oplogSize(t, b))
	}
	return sizes
}

func nodeName(i int) string { return fmt.Sprintf("n%d", i) }

// flipByte flips every bit of the byte at off in the oplog, in place.
func flipByte(t *testing.T, b *Bundle, off int64) {
	t.Helper()
	f, err := os.OpenFile(b.oplogPath(), os.O_RDWR, 0o644)
	if err != nil {
		t.Fatalf("open oplog: %v", err)
	}
	defer f.Close()
	var buf [1]byte
	if _, err := f.ReadAt(buf[:], off); err != nil {
		t.Fatalf("read byte at %d: %v", off, err)
	}
	buf[0] ^= 0xFF
	if _, err := f.WriteAt(buf[:], off); err != nil {
		t.Fatalf("write byte at %d: %v", off, err)
	}
}

// TestLoadRecoversDanglingLengthPrefix models the exact crash the review
// describes: the process died after the framing header of the next record
// hit the disk but before its payload did. The oplog therefore ends in a
// dangling prefix that describes bytes which are not there.
//
// Load must replay every intact record, repair the file by truncating the
// dangling prefix away, and keep serving the document. A torn tail must
// never make a document permanently unopenable.
func TestLoadRecoversDanglingLengthPrefix(t *testing.T) {
	dir := t.TempDir()
	b, err := Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	sizes := appendGood(t, b, 3)
	good := sizes[2]

	// Fourth record starts to land, then power loss: only the first few
	// framing bytes made it (fewer than a whole record header).
	if err := b.Append(rec(4, createOp("n4", 4))); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(b.oplogPath(), good+5); err != nil {
		t.Fatal(err)
	}

	b2, _ := Open(dir, "doc1", "Untitled")
	doc, seq, err := b2.Load()
	if err != nil {
		t.Fatalf("Load() must recover a torn tail, got error: %v", err)
	}
	if seq != 3 {
		t.Fatalf("seq = %d, want 3", seq)
	}
	if len(doc.Nodes) != 3 {
		t.Fatalf("nodes = %d, want 3", len(doc.Nodes))
	}
	if got := oplogSize(t, b2); got != good {
		t.Fatalf("oplog size after recovery = %d, want %d (file must be truncated back to the last good record)", got, good)
	}

	// The file must be genuinely repaired, not merely read past: a fresh
	// append has to land at the recovered offset and round-trip.
	if err := b2.Append(rec(4, createOp("n4", 44))); err != nil {
		t.Fatal(err)
	}
	b3, _ := Open(dir, "doc1", "Untitled")
	doc3, seq3, err := b3.Load()
	if err != nil {
		t.Fatalf("Load() after repair+append: %v", err)
	}
	if seq3 != 4 {
		t.Fatalf("seq = %d, want 4", seq3)
	}
	if len(doc3.Nodes) != 4 {
		t.Fatalf("nodes = %d, want 4", len(doc3.Nodes))
	}
	if doc3.Nodes["n4"].GetX() != 44 {
		t.Fatalf("n4.x = %v, want 44", doc3.Nodes["n4"].GetX())
	}
}

// TestLoadRecoversHalfWrittenPayload lops off half of the last record's
// payload -- the header is complete and claims more bytes than the file
// holds.
func TestLoadRecoversHalfWrittenPayload(t *testing.T) {
	dir := t.TempDir()
	b, _ := Open(dir, "doc1", "Untitled")
	sizes := appendGood(t, b, 3)
	good := sizes[2]

	if err := b.Append(rec(4, createOp("n4", 4))); err != nil {
		t.Fatal(err)
	}
	full := oplogSize(t, b)
	if err := os.Truncate(b.oplogPath(), good+(full-good)/2); err != nil {
		t.Fatal(err)
	}

	b2, _ := Open(dir, "doc1", "Untitled")
	doc, seq, err := b2.Load()
	if err != nil {
		t.Fatalf("Load() must recover a half-written record, got error: %v", err)
	}
	if seq != 3 || len(doc.Nodes) != 3 {
		t.Fatalf("seq = %d nodes = %d, want 3/3", seq, len(doc.Nodes))
	}
	if got := oplogSize(t, b2); got != good {
		t.Fatalf("oplog size after recovery = %d, want %d", got, good)
	}
}

// TestLoadRejectsCorruptTailRecord flips a byte inside the *last* record's
// payload. The record is fully present but its checksum no longer matches,
// so it must be treated as a torn tail: the healthy prefix replays and the
// bad record is dropped, never silently applied as if it were intact.
func TestLoadRejectsCorruptTailRecord(t *testing.T) {
	dir := t.TempDir()
	b, _ := Open(dir, "doc1", "Untitled")
	sizes := appendGood(t, b, 3)
	good := sizes[2]

	if err := b.Append(rec(4, createOp("n4", 4))); err != nil {
		t.Fatal(err)
	}
	full := oplogSize(t, b)
	flipByte(t, b, good+(full-good)/2) // somewhere inside record 4's payload

	b2, _ := Open(dir, "doc1", "Untitled")
	doc, seq, err := b2.Load()
	if err != nil {
		t.Fatalf("Load() must survive a corrupt tail record, got error: %v", err)
	}
	if seq != 3 {
		t.Fatalf("seq = %d, want 3 (the corrupt record must not be applied)", seq)
	}
	if len(doc.Nodes) != 3 {
		t.Fatalf("nodes = %d, want 3", len(doc.Nodes))
	}
	if got := oplogSize(t, b2); got != good {
		t.Fatalf("oplog size after recovery = %d, want %d", got, good)
	}
}

// TestLoadSurfacesMidFileCorruption flips a byte inside record 2 of 3.
// Truncation cannot repair that: records 3.. are healthy and sit after the
// damage. Load must fail loudly, naming the byte offset, rather than
// silently dropping the healthy suffix or applying a corrupt record.
func TestLoadSurfacesMidFileCorruption(t *testing.T) {
	dir := t.TempDir()
	b, _ := Open(dir, "doc1", "Untitled")
	sizes := appendGood(t, b, 3)
	before := oplogSize(t, b)

	flipByte(t, b, sizes[0]+(sizes[1]-sizes[0])/2) // inside record 2's payload

	b2, _ := Open(dir, "doc1", "Untitled")
	_, _, err := b2.Load()
	if err == nil {
		t.Fatal("Load() must report corruption in the middle of the oplog, got nil")
	}
	if !strings.Contains(err.Error(), "offset") {
		t.Fatalf("error = %v, want it to name the corrupt offset", err)
	}
	// Mid-file corruption must never trigger the truncate-to-last-good
	// repair: that would throw away the healthy records after the damage.
	if got := oplogSize(t, b2); got != before {
		t.Fatalf("oplog was truncated to %d (was %d) on mid-file corruption -- healthy records were destroyed", got, before)
	}
}

// TestHistoryRecoversTornTail: History() feeds the hub's catch-up backlog
// and reads the same file, so it must tolerate a torn tail exactly like
// Load does.
func TestHistoryRecoversTornTail(t *testing.T) {
	dir := t.TempDir()
	b, _ := Open(dir, "doc1", "Untitled")
	sizes := appendGood(t, b, 3)
	good := sizes[2]

	if err := b.Append(rec(4, createOp("n4", 4))); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(b.oplogPath(), good+3); err != nil {
		t.Fatal(err)
	}

	b2, _ := Open(dir, "doc1", "Untitled")
	recs, err := b2.History()
	if err != nil {
		t.Fatalf("History() must recover a torn tail, got error: %v", err)
	}
	if len(recs) != 3 {
		t.Fatalf("history = %d records, want 3", len(recs))
	}
	if recs[2].GetSeq() != 3 {
		t.Fatalf("last history seq = %d, want 3", recs[2].GetSeq())
	}
}

// TestLoadRecoversTornTailOnFirstRecord: the very first append tore. There
// is no good prefix at all, so Load must hand back an empty document rather
// than a permanent error.
func TestLoadRecoversTornTailOnFirstRecord(t *testing.T) {
	dir := t.TempDir()
	b, _ := Open(dir, "doc1", "Untitled")
	if err := b.Append(rec(1, createOp("n1", 1))); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(b.oplogPath(), 4); err != nil {
		t.Fatal(err)
	}

	b2, _ := Open(dir, "doc1", "Untitled")
	doc, seq, err := b2.Load()
	if err != nil {
		t.Fatalf("Load() must recover a torn first record, got error: %v", err)
	}
	if seq != 0 || len(doc.Nodes) != 0 {
		t.Fatalf("seq = %d nodes = %d, want 0/0", seq, len(doc.Nodes))
	}
	if got := oplogSize(t, b2); got != 0 {
		t.Fatalf("oplog size = %d, want 0", got)
	}
	if err := b2.Append(rec(1, createOp("n1", 7))); err != nil {
		t.Fatal(err)
	}
	b3, _ := Open(dir, "doc1", "Untitled")
	doc3, seq3, err := b3.Load()
	if err != nil {
		t.Fatal(err)
	}
	if seq3 != 1 || doc3.Nodes["n1"].GetX() != 7 {
		t.Fatalf("seq = %d x = %v, want 1/7", seq3, doc3.Nodes["n1"].GetX())
	}
}

// TestAppendWritesSelfDescribingFrame pins the on-disk layout: a file
// header, then one frame per record carrying its own magic, length and
// CRC-32C. Append must produce exactly these bytes -- the whole point is
// that a reader can tell a real record boundary from leftovers of a torn
// write, which the old varint-only prefix could not.
func TestAppendWritesSelfDescribingFrame(t *testing.T) {
	dir := t.TempDir()
	b, _ := Open(dir, "doc1", "Untitled")
	r := rec(1, createOp("n1", 5))
	if err := b.Append(r); err != nil {
		t.Fatal(err)
	}

	got, err := os.ReadFile(b.oplogPath())
	if err != nil {
		t.Fatal(err)
	}
	payload, err := proto.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	want := append(encodeFileHeader(), encodeFrame(payload)...)
	if !bytes.Equal(got, want) {
		t.Fatalf("oplog bytes = %d, want %d (header %d + frame %d)", len(got), len(want), oplogHeaderSize, int(frameHeaderSize)+len(payload))
	}
	if binary.BigEndian.Uint32(got[oplogHeaderSize+8:oplogHeaderSize+12]) != crc32.Checksum(payload, crcTable) {
		t.Fatal("frame checksum field does not cover the payload")
	}
}

// TestLoadRejectsForeignOplogFormat: an oplog written before this format
// change (M0's protodelim varint framing) has no file header. It must be
// reported as an unreadable format, not mistaken for one huge torn record
// and silently truncated to nothing.
func TestLoadRejectsForeignOplogFormat(t *testing.T) {
	dir := t.TempDir()
	b, _ := Open(dir, "doc1", "Untitled")
	legacy := bytes.Repeat([]byte{0x2A, 0x11, 0x07}, 40)
	if err := os.WriteFile(b.oplogPath(), legacy, 0o644); err != nil {
		t.Fatal(err)
	}

	_, _, err := b.Load()
	if err == nil {
		t.Fatal("Load() must reject an oplog that isn't in the current format, got nil")
	}
	if !strings.Contains(err.Error(), "brawt oplog") {
		t.Fatalf("error = %v, want it to explain the format mismatch", err)
	}
	after, rerr := os.ReadFile(b.oplogPath())
	if rerr != nil {
		t.Fatal(rerr)
	}
	if !bytes.Equal(after, legacy) {
		t.Fatal("an unreadable-format oplog must be left untouched, not truncated")
	}
}

// TestLoadSurfacesDanglingPrefixFollowedByRecords is the ENOSPC variant the
// review calls out: the disk filled up mid-record, then freed up, and a
// later Append landed a complete record right after the dangling prefix.
// The healthy records after the damage must not be thrown away by a
// truncate-to-last-good repair -- Load has to report the offset instead.
func TestLoadSurfacesDanglingPrefixFollowedByRecords(t *testing.T) {
	dir := t.TempDir()
	b, _ := Open(dir, "doc1", "Untitled")

	frame := func(seq uint64, id string) []byte {
		payload, err := proto.Marshal(rec(seq, createOp(id, float64(seq))))
		if err != nil {
			t.Fatal(err)
		}
		return encodeFrame(payload)
	}

	var file []byte
	file = append(file, encodeFileHeader()...)
	file = append(file, frame(1, "n1")...)
	dangling := int64(len(file))
	file = append(file, frame(2, "n2")[:6]...) // ENOSPC: only part of record 2 landed
	file = append(file, frame(3, "n3")...)     // ...then a later append resumed
	if err := os.WriteFile(b.oplogPath(), file, 0o644); err != nil {
		t.Fatal(err)
	}

	_, _, err := b.Load()
	if err == nil {
		t.Fatal("Load() must report a dangling prefix that has intact records after it, got nil")
	}
	if !strings.Contains(err.Error(), fmt.Sprintf("offset %d", dangling)) {
		t.Fatalf("error = %v, want it to name offset %d", err, dangling)
	}
	fi, serr := os.Stat(b.oplogPath())
	if serr != nil {
		t.Fatal(serr)
	}
	if fi.Size() != int64(len(file)) {
		t.Fatalf("oplog size = %d, want %d (the intact record after the damage must not be truncated away)", fi.Size(), len(file))
	}
}
