// Package store persiste un documento come bundle-directory: snapshot + op-log append-only.
package store

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"google.golang.org/protobuf/proto"
)

type Bundle struct {
	mu    sync.Mutex
	dir   string // <workspace>/<docID>.opendesigner
	docID string
	// meta is the document's identity as persisted in meta.json (see
	// meta.go). It is the single source of the document's name: Load seeds a
	// fresh document from it, so a bundle can never be opened under one name
	// and replayed under another.
	meta Meta

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

// Open prepares the bundle directory for docID and returns a handle to it.
//
// name is only a default: a bundle that already knows its own name (from
// meta.json) keeps it, so a caller that has no idea what the document is
// called -- server.Manager.HubFor, resolving a bare doc id -- no longer
// renames every document it opens to "Untitled". Bundle.Meta() reports the
// identity that actually applies.
func Open(workspace, docID, name string) (*Bundle, error) {
	dir := filepath.Join(workspace, docID+bundleSuffix)
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
	b := &Bundle{dir: dir, docID: docID}
	// No other goroutine can reach b yet; initMetaLocked's "locked" contract
	// is satisfied vacuously.
	if err := b.initMetaLocked(name); err != nil {
		return nil, err
	}
	return b, nil
}

func (b *Bundle) snapshotPath() string { return filepath.Join(b.dir, "snapshot.pb") }
func (b *Bundle) oplogPath() string    { return filepath.Join(b.dir, "oplog") }

// seqPath is where the snapshot's seq used to live, back when it was a
// separate file. Nothing reads it any more -- the seq travels inside
// snapshot.pb (see snapshotfile.go) -- and Snapshot deletes it, so it exists
// only to name the leftover from an older build.
func (b *Bundle) seqPath() string { return filepath.Join(b.dir, "snapshot.seq") }

// Load ricostruisce documento e ultimo seq: snapshot + replay oplog.
func (b *Bundle) Load() (*opendesignerv1.Document, uint64, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	doc := core.NewDocument(b.docID, b.meta.Name)
	var seq uint64

	payload, snapSeq, ok, err := b.readSnapshotLocked()
	if err != nil {
		return nil, 0, err
	}
	if ok {
		if err := proto.Unmarshal(payload, doc); err != nil {
			return nil, 0, fmt.Errorf("unmarshal snapshot: %w", err)
		}
		// proto.Unmarshal RESETS the message before decoding (it merges only
		// with UnmarshalOptions.Merge), so the identity seeded above is gone
		// and the snapshot's own embedded copy has silently replaced it.
		// meta.json is the single source of the name -- it is what Scan
		// lists, and the one file a user can repair by hand -- so put it
		// back. Without this the two diverge the moment they differ: a
		// bundle renamed by editing meta.json goes on OPENING under its old
		// name, and one whose meta.json was lost lists as "Untitled" while
		// opening as itself. Now that every document acquires a snapshot
		// after 256 ops, that is the normal case rather than an edge one.
		doc.Id = b.docID
		doc.Name = b.meta.Name
		seq = snapSeq
	}

	recs, err := b.readOplogLocked()
	if err != nil {
		return nil, 0, err
	}
	for _, rec := range recs {
		// Snapshot() rewrites the oplog only *after* the new snapshot has
		// already landed on disk. A crash in that window leaves oplog
		// records whose state is already baked into the snapshot we just
		// loaded. Re-applying them would hit core.ErrNodeExists on a
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

// readSnapshotLocked returns the marshalled Document held in snapshot.pb and
// the seq it was taken at. ok is false when the bundle has no snapshot yet,
// which is the only tolerated absence: the document and its seq come out of
// the same file, so they can never be read as a mismatched pair, and any
// other failure is surfaced rather than degraded into "no snapshot".
//
// b.mu must be held.
func (b *Bundle) readSnapshotLocked() (payload []byte, seq uint64, ok bool, err error) {
	data, err := os.ReadFile(b.snapshotPath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, 0, false, nil
		}
		return nil, 0, false, err
	}
	seq, payload, err = decodeSnapshotFile(data)
	if err != nil {
		return nil, 0, false, fmt.Errorf("read snapshot: %w", err)
	}
	return payload, seq, true, nil
}

// nameFromSnapshotLocked returns the document name embedded in snapshot.pb,
// or "" when the bundle has no snapshot or it cannot be read.
//
// It is the recovery half of "meta.json owns the name": a bundle whose
// identity file was deleted or corrupted still carries its name inside the
// snapshot, and adopting it there beats renaming the document to the caller's
// default -- which is how meta.json and snapshot.pb came to disagree in the
// first place. Every failure is silent on purpose: this is best-effort
// recovery of a string, and initMetaLocked's job (giving the bundle an
// identity it can be listed and opened under) must not fail because the
// content is damaged. Opening the document still surfaces that damage.
//
// b.mu must be held.
func (b *Bundle) nameFromSnapshotLocked() string {
	payload, _, ok, err := b.readSnapshotLocked()
	if err != nil || !ok {
		return ""
	}
	var doc opendesignerv1.Document
	if err := proto.Unmarshal(payload, &doc); err != nil {
		return ""
	}
	return doc.GetName()
}

// readSnapshotSeq returns the seq the persisted snapshot was taken at, or 0
// if the bundle has no snapshot yet. Shared by Load (replay) and History
// (in-memory catch-up reconstruction) so both agree on exactly which oplog
// records are already folded into the snapshot.
//
// b.mu must be held.
func (b *Bundle) readSnapshotSeq() (uint64, error) {
	_, seq, _, err := b.readSnapshotLocked()
	return seq, err
}

// History returns the oplog records not yet folded into the snapshot: the
// same records Load replays on top of snapshot.pb, but returned instead of
// applied. Load alone only exposes the resulting Document + seq, which
// isn't enough for a caller (server.NewHub) that needs to reconstruct an
// in-memory catch-up backlog after a restart — without this, Subscribe on a
// freshly reopened document has no history to serve for any sinceSeq below
// the hub's startup seq, even though those records are sitting right there
// on disk.
func (b *Bundle) History() ([]*opendesignerv1.OpRecord, error) {
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
	var recs []*opendesignerv1.OpRecord
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
func (b *Bundle) readOplogLocked() ([]*opendesignerv1.OpRecord, error) {
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

	var recs []*opendesignerv1.OpRecord
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
func scanFrames(f oplogFile, fr *frameReader, size int64) ([]*opendesignerv1.OpRecord, int64, error) {
	var recs []*opendesignerv1.OpRecord
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
		rec := &opendesignerv1.OpRecord{}
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
// when this call wrote the file header, i.e. when it created the oplog: on
// POSIX the file's *directory entry* is not durable until the directory
// itself is synced, so without it a brand-new document's very first op could
// be acked and then disappear entirely on power loss.
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
func (b *Bundle) Append(recrd *opendesignerv1.OpRecord) error {
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
		// The file header went out with this record, so this call created
		// the oplog and its directory entry still needs to be made durable.
		// Keying off the header (rather than a pre-open stat for "does the
		// file exist") also covers the file left behind empty by a
		// rolled-back create.
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
	// A fresh oplog gets its file header written in the same single Write as
	// the first record, so the file is never observable as "header, but no
	// record" either.
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

// ErrSnapshotCommitted reports that a snapshot committed -- the document is
// published and the oplog is compacted, both fsynced -- but the identity
// refresh that follows it (meta.json's updatedAt) did not.
//
// It exists so the one step of Snapshot that happens AFTER the point of no
// return is distinguishable from the steps before it. Nothing durable was
// lost when this is returned: the document is exactly as safe as it is after
// a fully successful snapshot, only its "last modified" is stale until the
// next one rewrites it. errors.Is(err, ErrSnapshotCommitted) is therefore the
// test for "may I act on this snapshot having happened?".
var ErrSnapshotCommitted = errors.New("snapshot committed but meta.json was not refreshed")

// Snapshot riscrive lo snapshot al seq dato e compatta l'oplog.
//
// doc must be the state produced by applying every op up to and including
// seq, and nothing after it -- which is precisely what server.Hub.Snapshot
// returns. That contract is not merely documented: a call whose seq is older
// than the one already persisted is a no-op (see the guard below), so a stale
// clone cannot lose data, it just does nothing.
//
// The commit is two steps, in this order:
//
//  1. Publish the new snapshot. The document and the seq it was taken at
//     live in ONE file (see snapshotfile.go), so the single rename that
//     publishes it commits both or neither. There is no window in which a
//     document is on disk paired with somebody else's seq.
//  2. Compact the oplog down to the records the snapshot does not already
//     contain.
//
// Step 2 is not part of step 1's atomic commit, and does not need to be: a
// crash between them leaves records the snapshot already contains sitting in
// the oplog, and Load skips any record whose seq is <= the snapshot's (see
// Load). So the pair self-heals rather than failing, and it only works in
// this order -- compacting first would delete records that the snapshot
// hasn't committed yet.
func (b *Bundle) Snapshot(doc *opendesignerv1.Document, seq uint64) error {
	// Marshal AND write the new snapshot before taking the lock. b.mu also
	// serialises Append, so every microsecond spent holding it is an edit
	// waiting on an fsync, and the document is the one part of a snapshot
	// whose size grows with the drawing: marshalling it, writing it out and
	// fsyncing it is by far the longest thing a snapshot does.
	//
	// None of it is observable until the rename below, so none of it needs
	// the lock. What the lock does have to cover is the decision to publish
	// together with the publishing itself -- otherwise two overlapping
	// snapshots could both pass the "only move forward" guard and then commit
	// in the opposite order.
	data, err := proto.Marshal(doc)
	if err != nil {
		return err
	}
	staged, err := stageFileSync(b.snapshotPath(), encodeSnapshotFile(seq, data), 0o644)
	if err != nil {
		return fmt.Errorf("write snapshot: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			// Either the guard below rejected this snapshot or the commit
			// failed; nothing must be left behind in the bundle either way.
			os.Remove(staged)
		}
	}()

	b.mu.Lock()
	defer b.mu.Unlock()

	// Snapshots only move forward. Publishing an older one would not just
	// rewind snapshot.pb: step 2 then compacts the oplog against that older
	// seq, and the records that could have replayed the difference back are
	// already gone -- the newer snapshot's own compaction dropped them. Both
	// files end up rewound, permanently, and nothing returns an error.
	//
	// This is a no-op rather than a failure because no caller has to have
	// done anything wrong to reach it: Hub.Snapshot releases h.mu before this
	// takes b.mu, so two overlapping snapshots can arrive here in the opposite
	// order to the seqs they captured. What the loser asked for -- a persisted
	// snapshot at least as new as its seq -- is already true.
	//
	// seq == persisted is deliberately allowed through: rewriting the same
	// snapshot is idempotent, and it finishes a compaction that a crash
	// interrupted between the two steps below.
	persisted, err := b.readSnapshotSeq()
	if err != nil {
		// The persisted seq is unreadable, so there is no way to tell whether
		// this call moves the bundle forward or backward. Refuse: a snapshot
		// is also a compaction, and compacting against an unknown baseline is
		// exactly how the oplog gets destroyed.
		return fmt.Errorf("read persisted snapshot seq: %w", err)
	}
	if seq < persisted {
		return nil
	}

	// One rename publishes the document and its seq together (they are one
	// file), so this is the instant the snapshot exists.
	if err := commitStagedFile(staged, b.snapshotPath()); err != nil {
		return fmt.Errorf("write snapshot: %w", err)
	}
	committed = true
	// Nothing reads snapshot.seq any more, so an older build's leftover is
	// inert and its removal is worth no error path of its own: failing the
	// snapshot over a file that has no readers would be the bigger bug.
	_ = os.Remove(b.seqPath())

	if err := b.compactOplogLocked(seq); err != nil {
		return err
	}

	// A snapshot is the moment the document's content becomes durable as a
	// whole, which is exactly what "last modified" means for a document
	// browser -- there is no cheaper place to record it, since the
	// alternative is rewriting meta.json on every appended op.
	//
	// It runs last, and its failure is reported as ErrSnapshotCommitted rather
	// than as a plain error, because by this point BOTH commits above are on
	// disk and fsynced: the snapshot is published and the oplog is compacted.
	// A caller that reads any error as "the snapshot did not happen" then
	// skips whatever it does after a successful one -- server.Hub drops the
	// history records the new snapshot covers -- and so grows an in-memory
	// history for ever while the on-disk snapshot moves on without it. The
	// failure is still reported (a store that cannot write a 200-byte file is
	// not healthy, and the timestamp really is stale until the next snapshot
	// rewrites it), just not as a lost snapshot.
	updated := b.meta
	updated.UpdatedAt = time.Now().UTC()
	if err := b.writeMetaLocked(updated); err != nil {
		return fmt.Errorf("%w: %w", ErrSnapshotCommitted, err)
	}
	return nil
}

// compactOplogLocked rewrites the oplog with only the records the snapshot
// at snapSeq does NOT already contain.
//
// It replaces a plain O_TRUNC of the whole file, which threw away every
// record regardless of the seq it was asked to compact to. That is not a
// crash-only defect: Hub.Snapshot releases the hub lock before Bundle.Snapshot
// takes b.mu, so ops submitted and acked in between are appended after the
// snapshot was taken and are not in it. Truncating everything erased exactly
// those -- invisibly, because the in-memory hub still had them, until the
// next restart silently rewound the document.
//
// The surviving records are re-framed into a fresh file that is fsynced and
// renamed over the oplog, so the compaction is atomic too: a crash leaves
// either the old oplog or the new one, never a half-rewritten log.
//
// Records are selected by seq rather than by position: a bundle recovering
// from an interrupted compaction can hold already-snapshotted records after
// newer ones, and the predicate has to match the skip Load applies.
//
// b.mu must be held.
func (b *Bundle) compactOplogLocked(snapSeq uint64) error {
	recs, err := b.readOplogLocked()
	if err != nil {
		return fmt.Errorf("read oplog to compact it: %w", err)
	}

	// The file header goes out even when nothing survives, so the oplog is
	// always a valid, self-describing oplog on disk rather than zero bytes.
	buf := encodeFileHeader()
	for _, rec := range recs {
		if rec.GetSeq() <= snapSeq {
			continue
		}
		payload, merr := proto.Marshal(rec)
		if merr != nil {
			return fmt.Errorf("re-encode oplog record seq %d: %w", rec.GetSeq(), merr)
		}
		buf = append(buf, encodeFrame(payload)...)
	}
	if err := writeFileSync(b.oplogPath(), buf, 0o644); err != nil {
		return fmt.Errorf("compact oplog: %w", err)
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
func writeFileSync(path string, data []byte, perm os.FileMode) error {
	tmpName, err := stageFileSync(path, data, perm)
	if err != nil {
		return err
	}
	if err := commitStagedFile(tmpName, path); err != nil {
		os.Remove(tmpName)
		return err
	}
	return nil
}

// stageFileSync writes data to a temp file next to path, fsyncs it and
// returns its name. Nothing at path changes: the staged file becomes the file
// only when commitStagedFile renames it there.
//
// The split exists so the expensive half can happen without whatever lock
// protects path. Bundle.Snapshot writes a file the size of the whole document
// while b.mu -- the lock every Append needs -- would otherwise be held.
//
// The caller owns the returned temp file and must either commit or remove it.
func stageFileSync(path string, data []byte, perm os.FileMode) (name string, err error) {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".tmp-*")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	defer func() {
		if err != nil {
			os.Remove(tmpName)
		}
	}()

	if _, err = tmp.Write(data); err != nil {
		tmp.Close()
		return "", err
	}
	if err = tmp.Sync(); err != nil {
		tmp.Close()
		return "", err
	}
	if err = tmp.Close(); err != nil {
		return "", err
	}
	if err = os.Chmod(tmpName, perm); err != nil {
		return "", err
	}
	return tmpName, nil
}

// commitStagedFile publishes a file staged by stageFileSync: one rename, then
// an fsync of the directory so the rename itself is durable and not just the
// bytes it points at.
func commitStagedFile(tmpName, path string) error {
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	return syncDir(filepath.Dir(path))
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
