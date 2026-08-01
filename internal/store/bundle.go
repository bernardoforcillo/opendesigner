// Package store persiste un documento come bundle-directory: snapshot + op-log append-only.
package store

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"

	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
	"github.com/bernardoforcillo/brawt/internal/core"
	"google.golang.org/protobuf/proto"
)

type Bundle struct {
	mu    sync.Mutex
	dir   string // <workspace>/<docID>.brawt
	docID string
	name  string

	// openOplog opens the oplog file. It exists so tests can inject the
	// disk failures this package is written to survive -- a short write, a
	// failing fsync, a read that returns EIO -- which cannot be produced
	// from a real filesystem. nil (always, in production) means the real
	// file.
	openOplog func(path string, flag int, perm os.FileMode) (oplogFile, error)
}

// openOplogFile opens the bundle's oplog, honouring the test seam.
func (b *Bundle) openOplogFile(flag int, perm os.FileMode) (oplogFile, error) {
	if b.openOplog != nil {
		return b.openOplog(b.oplogPath(), flag, perm)
	}
	f, err := os.OpenFile(b.oplogPath(), flag, perm)
	if err != nil {
		// Returning f directly would hand back a non-nil interface holding
		// a nil *os.File.
		return nil, err
	}
	return f, nil
}

func Open(workspace, docID, name string) (*Bundle, error) {
	dir := filepath.Join(workspace, docID+".brawt")
	if err := os.MkdirAll(filepath.Join(dir, "assets"), 0o755); err != nil {
		return nil, err
	}
	// A directory entry created by mkdir is only durable once its *parent*
	// directory is fsynced; without this a brand-new bundle (and therefore
	// the first ops appended into it) can vanish on power loss even though
	// every write inside it was fsynced.
	if err := syncDir(dir); err != nil {
		return nil, err
	}
	if err := syncDir(workspace); err != nil {
		return nil, err
	}
	return &Bundle{dir: dir, docID: docID, name: name}, nil
}

func (b *Bundle) snapshotPath() string { return filepath.Join(b.dir, "snapshot.pb") }
func (b *Bundle) seqPath() string      { return filepath.Join(b.dir, "snapshot.seq") }
func (b *Bundle) oplogPath() string    { return filepath.Join(b.dir, "oplog") }

// Load ricostruisce documento e ultimo seq: snapshot + replay oplog.
func (b *Bundle) Load() (*brawtv1.Document, uint64, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	doc := core.NewDocument(b.docID, b.name)
	var seq uint64

	if data, err := os.ReadFile(b.snapshotPath()); err == nil {
		if err := proto.Unmarshal(data, doc); err != nil {
			return nil, 0, fmt.Errorf("unmarshal snapshot: %w", err)
		}
		// snapshot.pb and snapshot.seq are written as a pair (see Snapshot);
		// if snapshot.pb exists, snapshot.seq must exist and parse cleanly.
		// Silently defaulting to seq=0 here would hand callers a document
		// that doesn't match the seq it's paired with, so any read/parse
		// failure is surfaced instead of swallowed.
		if seq, err = b.readSnapshotSeq(); err != nil {
			return nil, 0, err
		}
	} else if !os.IsNotExist(err) {
		return nil, 0, err
	}

	recs, err := b.readOplogLocked()
	if err != nil {
		return nil, 0, err
	}
	for _, rec := range recs {
		// Snapshot() truncates the oplog only *after* the new snapshot.pb/
		// snapshot.seq have already landed on disk. A crash in that window
		// (after snapshot.seq is written, before Truncate runs) can leave
		// oplog records whose state is already baked into the snapshot we
		// just loaded. Re-applying them would hit core.ErrNodeExists on a
		// duplicate CreateNode and fail Load() permanently, so skip any
		// record already covered by the persisted snapshot seq -- this
		// makes replay idempotent/self-healing across that crash window.
		if rec.GetSeq() <= seq {
			continue
		}
		if err := core.Apply(doc, rec.GetOp()); err != nil {
			return nil, 0, fmt.Errorf("replay seq %d: %w", rec.GetSeq(), err)
		}
		seq = rec.GetSeq()
	}
	return doc, seq, nil
}

// readSnapshotSeq returns the seq persisted in snapshot.seq if snapshot.pb
// exists on disk, or 0 if the bundle has no snapshot yet. Shared by Load
// (replay) and History (in-memory catch-up reconstruction) so both agree on
// exactly which oplog records are already folded into the snapshot.
func (b *Bundle) readSnapshotSeq() (uint64, error) {
	if _, err := os.Stat(b.snapshotPath()); err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}
	s, err := os.ReadFile(b.seqPath())
	if err != nil {
		return 0, fmt.Errorf("read snapshot seq: %w", err)
	}
	seq, err := strconv.ParseUint(strings.TrimSpace(string(s)), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse snapshot seq %q: %w", s, err)
	}
	return seq, nil
}

// History returns the oplog records not yet folded into the snapshot: the
// same records Load replays on top of snapshot.pb, but returned instead of
// applied. Load alone only exposes the resulting Document + seq, which
// isn't enough for a caller (server.NewHub) that needs to reconstruct an
// in-memory catch-up backlog after a restart — without this, Subscribe on a
// freshly reopened document has no history to serve for any sinceSeq below
// the hub's startup seq, even though those records are sitting right there
// on disk.
func (b *Bundle) History() ([]*brawtv1.OpRecord, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	snapSeq, err := b.readSnapshotSeq()
	if err != nil {
		return nil, err
	}

	all, err := b.readOplogLocked()
	if err != nil {
		return nil, err
	}
	var recs []*brawtv1.OpRecord
	for _, rec := range all {
		// Mirrors the skip in Load: a record already folded into snapshot.pb
		// (seq <= snapSeq) is not part of the post-snapshot history.
		if rec.GetSeq() <= snapSeq {
			continue
		}
		recs = append(recs, rec)
	}
	return recs, nil
}

// readOplogLocked returns every intact record in the oplog, in file order.
//
// It is the single place that decides what a damaged oplog means, and it
// distinguishes two cases:
//
//   - A torn tail: the file ends in a frame that was never fully written
//     (short header, short payload, or a payload whose checksum doesn't
//     match), with nothing intact after it. This is the ordinary crash /
//     ENOSPC outcome. The healthy prefix is returned and the file is
//     truncated back to the end of the last intact record, so the document
//     stays openable and the next Append lands on a clean boundary instead
//     of after a dangling prefix that would mis-frame everything downstream.
//
//   - Damage in the middle of an otherwise complete file: intact frames
//     follow the damaged one. Truncating would silently destroy those
//     healthy records, so the offset is reported instead and nothing is
//     modified.
//
// A third case is deliberately NOT damage: a read that fails for any reason
// other than hitting the end of the file. The bytes may be perfectly fine
// and merely unreadable right now, so such an error is propagated and the
// file is left exactly as it is -- repairing on an I/O fault would answer a
// transient problem by permanently deleting records.
//
// b.mu must be held.
func (b *Bundle) readOplogLocked() ([]*brawtv1.OpRecord, error) {
	f, err := b.openOplogFile(os.O_RDONLY, 0)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	closed := false
	defer func() {
		if !closed {
			f.Close()
		}
	}()

	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := fi.Size()
	if size == 0 {
		return nil, nil
	}

	var recs []*brawtv1.OpRecord
	repairAt := int64(-1)

	if herr := checkFileHeader(f, size); herr != nil {
		if _, torn := asTornFrame(herr); !torn {
			// The header is intact but says this isn't a format this build
			// reads. Nothing to repair -- report it and leave the file be.
			return nil, fmt.Errorf("read oplog: %w", herr)
		}
		// Only a fragment of the file header ever landed, so no record can
		// possibly be in there: reset the file to empty.
		repairAt = 0
	}

	if repairAt < 0 {
		if _, err := f.Seek(oplogHeaderSize, io.SeekStart); err != nil {
			return nil, err
		}
		fr := newFrameReader(f, oplogHeaderSize)
		recs, repairAt, err = scanFrames(f, fr, size)
		if err != nil {
			return nil, err
		}
	}

	if repairAt >= 0 {
		// Close before truncating: a read handle is still open above, and
		// the repair must be durable before any caller acts on the
		// recovered state.
		closed = true
		if err := f.Close(); err != nil {
			return nil, err
		}
		if err := b.truncateOplogLocked(repairAt); err != nil {
			return nil, fmt.Errorf("repair torn oplog tail at offset %d: %w", repairAt, err)
		}
	}
	return recs, nil
}

// scanFrames decodes frames until the file ends cleanly or a damaged frame
// is reached. On damage it returns the records read so far plus the offset
// the file must be truncated to; it returns an error only when the damage
// is unrecoverable (see readOplogLocked).
func scanFrames(f oplogFile, fr *frameReader, size int64) ([]*brawtv1.OpRecord, int64, error) {
	var recs []*brawtv1.OpRecord
	for {
		start := fr.off
		payload, err := fr.next()
		if err != nil {
			// Damage first: an *errTornFrame wraps io.ErrUnexpectedEOF, so
			// checking for a clean EOF before it would misread a torn frame
			// as the end of the file.
			torn, ok := asTornFrame(err)
			if !ok {
				if errors.Is(err, io.EOF) {
					break // clean end of file
				}
				// An I/O failure, not damage. Report it and repair nothing:
				// repairAt stays -1 so the file is not touched.
				return nil, -1, fmt.Errorf("read oplog: %w", err)
			}
			intact, ferr := findFrameAfter(f, torn.Offset+1, size)
			if ferr != nil {
				// Whether healthy records follow the damage is exactly what
				// decides if truncating is safe, and that question could not
				// be answered. Refuse to guess.
				return nil, -1, fmt.Errorf("read oplog: %w", ferr)
			}
			if intact {
				return nil, -1, fmt.Errorf("read oplog: %w; intact records follow it, so this is corruption in the middle of the file rather than a torn tail -- truncating would destroy them, so the oplog is left untouched for manual repair", torn)
			}
			return recs, torn.Offset, nil
		}
		rec := &brawtv1.OpRecord{}
		if err := proto.Unmarshal(payload, rec); err != nil {
			// The checksum matched, so these are exactly the bytes that
			// were written: this is not torn-write damage and truncation
			// would be the wrong response.
			return nil, -1, fmt.Errorf("read oplog: record at offset %d has a valid checksum but is not a valid OpRecord: %w", start, err)
		}
		recs = append(recs, rec)
	}
	return recs, -1, nil
}

// truncateOplogLocked cuts the oplog back to n bytes and fsyncs it.
// b.mu must be held.
func (b *Bundle) truncateOplogLocked(n int64) (err error) {
	// O_WRONLY, deliberately not O_APPEND: Windows opens an append handle
	// with FILE_APPEND_DATA instead of GENERIC_WRITE, and truncating through
	// it fails with "Access is denied". Append therefore closes its own
	// handle and calls this rather than truncating in place.
	f, ferr := b.openOplogFile(os.O_WRONLY, 0o644)
	if ferr != nil {
		return ferr
	}
	defer func() {
		if cerr := f.Close(); cerr != nil && err == nil {
			err = cerr
		}
	}()
	if err = f.Truncate(n); err != nil {
		return err
	}
	return f.Sync()
}

// Append aggiunge un OpRecord in coda all'oplog come singolo frame
// autodescrittivo (magic + length + CRC-32C + payload; vedi reader.go).
//
// The whole frame is built in memory and handed to the kernel in ONE Write
// so an interrupted append leaves a frame that is detectably short or fails
// its checksum, never a dangling length prefix that a later append would
// silently write past (which is what the previous protodelim two-Write
// framing produced, permanently mis-framing the rest of the file).
//
// After the record's own fsync, the containing directory is fsynced too
// when this call wrote the file header, i.e. when it created the oplog (or
// re-seeded one Snapshot had truncated): on POSIX the file's *directory
// entry* is not durable until the directory itself is synced, so without it
// a brand-new document's very first op could be acked and then disappear
// entirely on power loss.
//
// Append is all-or-nothing: if it returns an error, the oplog is left at
// exactly the size it had on entry. A failing write (ENOSPC, a quota, EIO)
// can leave part of the frame on disk, and leaving those bytes there is what
// turns a transient, survivable failure into permanent corruption -- the
// next successful Append lands a complete frame directly after the fragment,
// producing damage in the MIDDLE of the file with healthy records after it,
// which readOplogLocked must (correctly) refuse to repair. No crash is
// needed for that; a freed-up disk is enough. So any failure here rolls the
// file back to its pre-write size, and the caller's op is simply not
// persisted -- which is what Hub.Submit already assumes when Append fails.
func (b *Bundle) Append(recrd *brawtv1.OpRecord) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	payload, err := proto.Marshal(recrd)
	if err != nil {
		return err
	}
	frame := encodeFrame(payload)

	f, err := b.openOplogFile(os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}

	preSize, err := appendFrame(f, frame)
	// Close can report deferred write errors (and always releases the
	// handle), so its failure must not be discarded: reporting success on
	// an append that never landed is exactly how the in-memory document
	// silently diverges from the oplog.
	if cerr := f.Close(); cerr != nil && err == nil {
		err = cerr
	}
	if err != nil {
		// preSize < 0 means the pre-write size was never established, so
		// there is no size to roll back to; truncating to a guess would be
		// far worse than leaving the file alone.
		if preSize >= 0 {
			if rerr := b.truncateOplogLocked(preSize); rerr != nil {
				err = errors.Join(err, fmt.Errorf("roll back partial oplog append to %d bytes: %w", preSize, rerr))
			}
		}
		return err
	}
	if preSize == 0 {
		// The file header went out with this record, so this call either
		// created the oplog or re-seeded a Snapshot-truncated one; either way
		// the directory entry still needs to be made durable. Keying off the
		// header (rather than a pre-open stat for "does the file exist")
		// also covers the file left behind empty by a rolled-back create.
		return syncDir(b.dir)
	}
	return nil
}

// appendFrame writes frame at the end of f and fsyncs it, returning the size
// f had before the write so a failed append can be rolled back to it. That
// size is -1 when it could not be determined.
//
// The rollback itself is Append's job, not this function's: the truncate has
// to happen on a fresh O_WRONLY handle, because Windows opens an O_APPEND
// handle with FILE_APPEND_DATA rather than GENERIC_WRITE and rejects a
// truncate through it with "Access is denied" (verified on Windows 11).
func appendFrame(f oplogFile, frame []byte) (int64, error) {
	fi, err := f.Stat()
	if err != nil {
		return -1, err
	}
	preSize := fi.Size()
	// A fresh (or Snapshot-truncated) oplog gets its file header written in
	// the same single Write as the first record, so the file is never
	// observable as "header, but no record" either.
	if preSize == 0 {
		frame = append(encodeFileHeader(), frame...)
	}
	if _, werr := f.Write(frame); werr != nil {
		return preSize, fmt.Errorf("append oplog record: %w", werr)
	}
	if serr := f.Sync(); serr != nil {
		return preSize, fmt.Errorf("sync oplog: %w", serr)
	}
	return preSize, nil
}

// Snapshot riscrive lo snapshot al seq dato e tronca l'oplog.
//
// Each of the three writes below (snapshot.pb, snapshot.seq, oplog
// truncate) is made durable with an explicit fsync -- of the file's
// contents and, for the two renames, of the bundle directory that holds
// the new entry -- before moving to the next step, so a crash never leaves
// a half-written file or a rename that hasn't committed. The three steps
// are still not a single atomic transaction, though: a crash between them
// can leave the oplog un-truncated even though snapshot.pb/snapshot.seq
// already reflect the new state. Load() tolerates exactly that by
// skipping any oplog record whose seq is <= the persisted snapshot seq
// (see Load), so this ordering is safe to crash into and self-heals on
// the next Load() instead of failing permanently.
func (b *Bundle) Snapshot(doc *brawtv1.Document, seq uint64) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	data, err := proto.Marshal(doc)
	if err != nil {
		return err
	}
	if err := writeFileSync(b.snapshotPath(), data, 0o644); err != nil {
		return fmt.Errorf("write snapshot: %w", err)
	}
	if err := writeFileSync(b.seqPath(), []byte(strconv.FormatUint(seq, 10)), 0o644); err != nil {
		return fmt.Errorf("write snapshot seq: %w", err)
	}

	created := false
	if _, serr := os.Stat(b.oplogPath()); serr != nil {
		if !os.IsNotExist(serr) {
			return serr
		}
		created = true
	}
	f, err := os.OpenFile(b.oplogPath(), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("truncate oplog: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return fmt.Errorf("sync truncated oplog: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close truncated oplog: %w", err)
	}
	if created {
		if err := syncDir(b.dir); err != nil {
			return fmt.Errorf("sync bundle dir: %w", err)
		}
	}
	return nil
}

// writeFileSync writes data to a temp file in path's directory, fsyncs it,
// renames it over path, then fsyncs the directory itself. Unlike
// os.WriteFile (write-in-place, no fsync), this guarantees a reader never
// observes a partially written file, and that once the call returns nil the
// bytes have reached disk rather than just the page cache. The trailing
// directory fsync is what makes the *rename* durable too: on POSIX,
// fsyncing the file only commits its contents, and a crash could otherwise
// leave the directory entry still pointing at the old file (or at nothing,
// for a fresh create) even though this call returned nil.
func writeFileSync(path string, data []byte, perm os.FileMode) (err error) {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		if err != nil {
			os.Remove(tmpName)
		}
	}()

	if _, err = tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err = tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err = tmp.Close(); err != nil {
		return err
	}
	if err = os.Chmod(tmpName, perm); err != nil {
		return err
	}
	if err = os.Rename(tmpName, path); err != nil {
		return err
	}
	return syncDir(dir)
}

// syncDir fsyncs a directory so that entries created or renamed inside it
// are durable, not just the file contents. It is a no-op on Windows: the
// platform exposes no equivalent operation (FlushFileBuffers rejects a
// directory handle), and NTFS metadata ordering is not something user space
// can force. Callers therefore get real crash-durability on POSIX and
// best-effort on Windows, which is the same trade-off every Go database
// makes here.
func syncDir(dir string) (err error) {
	if runtime.GOOS == "windows" {
		return nil
	}
	f, oerr := os.Open(dir)
	if oerr != nil {
		return oerr
	}
	defer func() {
		if cerr := f.Close(); cerr != nil && err == nil {
			err = cerr
		}
	}()
	return f.Sync()
}
