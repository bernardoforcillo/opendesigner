package store

import (
	"bytes"
	"errors"
	"io"
	"os"
	"testing"
)

// The failures this file exercises -- a write that stops half way because
// the disk filled up, a read that fails because the sector under it is bad
// -- are the ones the oplog format exists to survive, and are exactly the
// ones a test cannot provoke from a real filesystem. Bundle.openOplog is the
// seam that lets them be constructed deterministically.

// shortWriteFile lets limit bytes of every Write actually reach the disk and
// then reports err, which is what ENOSPC, a quota, or EIO look like from Go:
// a partial write plus an error. The bytes that made it stay on the file.
type shortWriteFile struct {
	*os.File
	limit int
	err   error
}

func (f *shortWriteFile) Write(p []byte) (int, error) {
	if len(p) > f.limit {
		p = p[:f.limit]
	}
	n, err := f.File.Write(p)
	if err != nil {
		return n, err
	}
	return n, f.err
}

// failingSyncFile fails fsync (the write landed in the page cache but the
// device rejected the flush).
type failingSyncFile struct {
	*os.File
	err error
}

func (f *failingSyncFile) Sync() error { return f.err }

// failingCloseFile fails Close, which is how a filesystem reports a deferred
// write error that only surfaced when the handle was released.
type failingCloseFile struct {
	*os.File
	err error
}

func (f *failingCloseFile) Close() error {
	f.File.Close()
	return f.err
}

// badSectorFile makes every byte from badFrom onwards unreadable, through
// both the sequential and the random-access read paths -- a bad sector, a
// disconnected volume, EIO. The bytes are still on disk and perfectly
// intact; they just cannot be read right now, which is precisely why a
// reader must not respond by deleting them.
type badSectorFile struct {
	*os.File
	badFrom int64
	err     error
}

func (f *badSectorFile) Read(p []byte) (int, error) {
	off, err := f.File.Seek(0, io.SeekCurrent)
	if err != nil {
		return 0, err
	}
	if off >= f.badFrom {
		return 0, f.err
	}
	if int64(len(p)) > f.badFrom-off {
		p = p[:f.badFrom-off]
	}
	return f.File.Read(p)
}

func (f *badSectorFile) ReadAt(p []byte, off int64) (int, error) {
	if off >= f.badFrom {
		return 0, f.err
	}
	if int64(len(p)) > f.badFrom-off {
		n, _ := f.File.ReadAt(p[:f.badFrom-off], off)
		return n, f.err
	}
	return f.File.ReadAt(p, off)
}

// openReal opens the oplog for real; the wrap callback decides what fault,
// if any, to layer on top of the handle for the flags it was opened with.
func openReal(wrap func(f *os.File, flag int) oplogFile) func(string, int, os.FileMode) (oplogFile, error) {
	return func(path string, flag int, perm os.FileMode) (oplogFile, error) {
		f, err := os.OpenFile(path, flag, perm)
		if err != nil {
			return nil, err
		}
		return wrap(f, flag), nil
	}
}

// failingReader returns err after n bytes, without ever reaching EOF.
type failingReader struct {
	r   io.Reader
	n   int
	err error
}

func (fr *failingReader) Read(p []byte) (int, error) {
	if fr.n <= 0 {
		return 0, fr.err
	}
	if len(p) > fr.n {
		p = p[:fr.n]
	}
	n, err := fr.r.Read(p)
	fr.n -= n
	return n, err
}

// --- Append must be all-or-nothing --------------------------------------

// TestAppendRollsBackPartialWrite is the ENOSPC-resume scenario, with no
// crash anywhere in it: the disk fills up part way through record 4, the
// user frees some space, and the next op is appended successfully. Without a
// rollback the fragment of record 4 is still sitting in the file, the
// resumed record lands right behind it, and the oplog now has damage in the
// MIDDLE with healthy records after it -- which the reader must refuse to
// repair, so the document can never be opened again.
func TestAppendRollsBackPartialWrite(t *testing.T) {
	dir := t.TempDir()
	b, err := Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	appendGood(t, b, 3)
	good := oplogSize(t, b)

	enospc := errors.New("simulated ENOSPC: no space left on device")
	b.openOplog = openReal(func(f *os.File, flag int) oplogFile {
		if flag&os.O_APPEND != 0 {
			return &shortWriteFile{File: f, limit: 6, err: enospc}
		}
		return f // the rollback's own handle must work
	})

	aerr := b.Append(rec(4, createOp("n4", 4)))
	if aerr == nil {
		t.Fatal("Append must report a write that only partly landed")
	}
	if !errors.Is(aerr, enospc) {
		t.Fatalf("error = %v, want it to wrap the underlying write error", aerr)
	}
	if got := oplogSize(t, b); got != good {
		t.Fatalf("oplog size after the failed append = %d, want %d (the %d partial bytes must be rolled back, or the next append mis-frames the file forever)", got, good, got-good)
	}

	// Space frees up and the op is retried. It has to land on a clean frame
	// boundary and the document has to stay readable.
	b.openOplog = nil
	if err := b.Append(rec(4, createOp("n4", 44))); err != nil {
		t.Fatal(err)
	}
	b2, _ := Open(dir, "doc1", "Untitled")
	doc, seq, err := b2.Load()
	if err != nil {
		t.Fatalf("Load() after a rolled-back append + retry: %v", err)
	}
	if seq != 4 {
		t.Fatalf("seq = %d, want 4", seq)
	}
	if len(doc.Nodes) != 4 || doc.Nodes["n4"].GetX() != 44 {
		t.Fatalf("nodes = %d n4.x = %v, want 4/44", len(doc.Nodes), doc.Nodes["n4"].GetX())
	}
}

// TestAppendRollsBackFailedSync: the bytes were handed to the kernel but the
// device refused the flush. Append reports failure, so the record must not
// be left behind for the next Load to find.
func TestAppendRollsBackFailedSync(t *testing.T) {
	dir := t.TempDir()
	b, _ := Open(dir, "doc1", "Untitled")
	appendGood(t, b, 2)
	good := oplogSize(t, b)

	eio := errors.New("simulated EIO: fsync failed")
	b.openOplog = openReal(func(f *os.File, flag int) oplogFile {
		if flag&os.O_APPEND != 0 {
			return &failingSyncFile{File: f, err: eio}
		}
		return f
	})

	if err := b.Append(rec(3, createOp("n3", 3))); !errors.Is(err, eio) {
		t.Fatalf("Append error = %v, want it to wrap the fsync failure", err)
	}
	if got := oplogSize(t, b); got != good {
		t.Fatalf("oplog size after a failed fsync = %d, want %d", got, good)
	}

	b.openOplog = nil
	b2, _ := Open(dir, "doc1", "Untitled")
	_, seq, err := b2.Load()
	if err != nil {
		t.Fatalf("Load() after a rolled-back append: %v", err)
	}
	if seq != 2 {
		t.Fatalf("seq = %d, want 2 (the un-synced record must not survive)", seq)
	}
}

// TestAppendRollsBackFailedClose pins the all-or-nothing contract on the
// last failure path: Close is where a filesystem reports a deferred write
// error. Hub.Submit drops the op entirely when Append fails, so a record
// left on disk here would reappear on the next Load as an op no client was
// ever told about.
func TestAppendRollsBackFailedClose(t *testing.T) {
	dir := t.TempDir()
	b, _ := Open(dir, "doc1", "Untitled")
	appendGood(t, b, 2)
	good := oplogSize(t, b)

	eio := errors.New("simulated deferred write error on close")
	b.openOplog = openReal(func(f *os.File, flag int) oplogFile {
		if flag&os.O_APPEND != 0 {
			return &failingCloseFile{File: f, err: eio}
		}
		return f
	})

	if err := b.Append(rec(3, createOp("n3", 3))); !errors.Is(err, eio) {
		t.Fatalf("Append error = %v, want it to report the close failure", err)
	}
	if got := oplogSize(t, b); got != good {
		t.Fatalf("oplog size after a failed close = %d, want %d", got, good)
	}
}

// --- an I/O error is not damage ------------------------------------------

// TestLoadPropagatesReadErrorInsteadOfTruncating is the counterpart defect:
// the reader used to turn ANY read failure into a torn frame, and a torn
// frame authorises truncating the oplog back to that offset. A flaky volume
// or one bad sector therefore permanently deleted every record from there
// on -- silently, with Load returning success.
func TestLoadPropagatesReadErrorInsteadOfTruncating(t *testing.T) {
	dir := t.TempDir()
	b, _ := Open(dir, "doc1", "Untitled")
	sizes := appendGood(t, b, 3)
	before := oplogSize(t, b)

	eio := errors.New("simulated EIO: unreadable sector")
	b2, _ := Open(dir, "doc1", "Untitled")
	// Records 2 and 3 are intact on disk but momentarily unreadable.
	b2.openOplog = openReal(func(f *os.File, flag int) oplogFile {
		return &badSectorFile{File: f, badFrom: sizes[0], err: eio}
	})

	_, _, err := b2.Load()
	if err == nil {
		t.Fatal("Load() must report an I/O error, not silently return a truncated document")
	}
	if !errors.Is(err, eio) {
		t.Fatalf("error = %v, want it to wrap the underlying I/O error", err)
	}
	if _, torn := asTornFrame(err); torn {
		t.Fatalf("error = %v, want it NOT to be reported as frame damage (that authorises a destructive repair)", err)
	}
	if got := oplogSize(t, b2); got != before {
		t.Fatalf("oplog truncated to %d (was %d): an I/O error must never trigger the torn-tail repair", got, before)
	}

	// The fault clears; nothing was lost.
	b3, _ := Open(dir, "doc1", "Untitled")
	doc, seq, err := b3.Load()
	if err != nil {
		t.Fatalf("Load() once the fault cleared: %v", err)
	}
	if seq != 3 || len(doc.Nodes) != 3 {
		t.Fatalf("seq = %d nodes = %d, want 3/3 -- records were destroyed by the earlier fault", seq, len(doc.Nodes))
	}
}

// TestHistoryPropagatesReadError: History feeds the hub's catch-up backlog
// off the same file and through the same scan, so it must make the same
// distinction. Answering an I/O fault with a short backlog would hand
// reconnecting clients a silently incomplete history.
func TestHistoryPropagatesReadError(t *testing.T) {
	dir := t.TempDir()
	b, _ := Open(dir, "doc1", "Untitled")
	sizes := appendGood(t, b, 3)
	before := oplogSize(t, b)

	eio := errors.New("simulated EIO: unreadable sector")
	b2, _ := Open(dir, "doc1", "Untitled")
	b2.openOplog = openReal(func(f *os.File, flag int) oplogFile {
		return &badSectorFile{File: f, badFrom: sizes[1], err: eio}
	})

	recs, err := b2.History()
	if err == nil {
		t.Fatalf("History() must report an I/O error, got %d records and nil", len(recs))
	}
	if !errors.Is(err, eio) {
		t.Fatalf("error = %v, want it to wrap the underlying I/O error", err)
	}
	if got := oplogSize(t, b2); got != before {
		t.Fatalf("oplog truncated to %d (was %d) on an I/O error", got, before)
	}
}

// TestFrameReaderPropagatesIOError is the unit-level statement of the rule:
// only a file that ends early is damage. Anything else keeps its identity so
// callers can inspect it with errors.Is/As.
func TestFrameReaderPropagatesIOError(t *testing.T) {
	eio := errors.New("simulated EIO")
	frame := encodeFrame([]byte("payload bytes"))

	for _, tc := range []struct {
		name  string
		after int // bytes served before the failure
	}{
		{"during the frame header", 6},
		{"during the payload", int(frameHeaderSize) + 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fr := newFrameReader(&failingReader{r: bytes.NewReader(frame), n: tc.after, err: eio}, oplogHeaderSize)
			_, err := fr.next()
			if !errors.Is(err, eio) {
				t.Fatalf("error = %v, want it to wrap %v", err, eio)
			}
			if _, torn := asTornFrame(err); torn {
				t.Fatalf("error = %v, want it NOT to be an *errTornFrame", err)
			}
		})
	}
}

// TestFrameReaderTornFrameWrapsCause: a genuinely short file is still damage,
// and the errTornFrame it produces must carry its cause rather than flatten
// it into a message.
func TestFrameReaderTornFrameWrapsCause(t *testing.T) {
	frame := encodeFrame([]byte("payload bytes"))

	for _, tc := range []struct {
		name string
		keep int
	}{
		{"header cut short", 5},
		{"payload cut short", len(frame) - 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fr := newFrameReader(bytes.NewReader(frame[:tc.keep]), oplogHeaderSize)
			_, err := fr.next()
			torn, ok := asTornFrame(err)
			if !ok {
				t.Fatalf("error = %v, want an *errTornFrame", err)
			}
			if torn.Offset != oplogHeaderSize {
				t.Fatalf("offset = %d, want %d", torn.Offset, oplogHeaderSize)
			}
			if !errors.Is(err, io.ErrUnexpectedEOF) {
				t.Fatalf("error = %v, want it to wrap io.ErrUnexpectedEOF", err)
			}
		})
	}
}

// TestFindFrameAfterReportsReadError: whether intact records follow the
// damage is the question that decides if truncating is safe. If it cannot be
// answered, it must be raised, not defaulted to "no" (which is the answer
// that permits deletion).
func TestFindFrameAfterReportsReadError(t *testing.T) {
	dir := t.TempDir()
	b, _ := Open(dir, "doc1", "Untitled")
	sizes := appendGood(t, b, 3)
	size := oplogSize(t, b)

	f, err := os.Open(b.oplogPath())
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	eio := errors.New("simulated EIO")
	bad := &badSectorFile{File: f, badFrom: sizes[0], err: eio}
	found, ferr := findFrameAfter(bad, sizes[0], size)
	if !errors.Is(ferr, eio) {
		t.Fatalf("error = %v, want it to wrap %v", ferr, eio)
	}
	if found {
		t.Fatal("found = true, want false alongside the error")
	}

	// Sanity: with no fault it still finds the healthy frames it is meant to.
	found, ferr = findFrameAfter(f, sizes[0], size)
	if ferr != nil || !found {
		t.Fatalf("findFrameAfter over a healthy file = %v, %v; want true, nil", found, ferr)
	}
}
