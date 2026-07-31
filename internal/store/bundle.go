// Package store persiste un documento come bundle-directory: snapshot + op-log append-only.
package store

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
	"github.com/bernardoforcillo/brawt/internal/core"
	"google.golang.org/protobuf/encoding/protodelim"
	"google.golang.org/protobuf/proto"
)

type Bundle struct {
	mu    sync.Mutex
	dir   string // <workspace>/<docID>.brawt
	docID string
	name  string
}

func Open(workspace, docID, name string) (*Bundle, error) {
	dir := filepath.Join(workspace, docID+".brawt")
	if err := os.MkdirAll(filepath.Join(dir, "assets"), 0o755); err != nil {
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

	f, err := os.Open(b.oplogPath())
	if err != nil {
		if os.IsNotExist(err) {
			return doc, seq, nil
		}
		return nil, 0, err
	}
	defer f.Close()
	r := newReader(f)
	for {
		rec := &brawtv1.OpRecord{}
		if err := protodelim.UnmarshalFrom(r, rec); err != nil {
			if isEOF(err) {
				break
			}
			return nil, 0, fmt.Errorf("read oplog: %w", err)
		}
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

	f, err := os.Open(b.oplogPath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()

	r := newReader(f)
	var recs []*brawtv1.OpRecord
	for {
		rec := &brawtv1.OpRecord{}
		if err := protodelim.UnmarshalFrom(r, rec); err != nil {
			if isEOF(err) {
				break
			}
			return nil, fmt.Errorf("read oplog: %w", err)
		}
		// Mirrors the skip in Load: a record already folded into snapshot.pb
		// (seq <= snapSeq) is not part of the post-snapshot history.
		if rec.GetSeq() <= snapSeq {
			continue
		}
		recs = append(recs, rec)
	}
	return recs, nil
}

// Append aggiunge un OpRecord length-delimited in coda all'oplog.
func (b *Bundle) Append(recrd *brawtv1.OpRecord) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	f, err := os.OpenFile(b.oplogPath(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := protodelim.MarshalTo(f, recrd); err != nil {
		return err
	}
	return f.Sync()
}

// Snapshot riscrive lo snapshot al seq dato e tronca l'oplog.
//
// Each of the three writes below (snapshot.pb, snapshot.seq, oplog
// truncate) is made durable with an explicit fsync before moving to the
// next step, so a crash never leaves a half-written file. The three steps
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

	f, err := os.OpenFile(b.oplogPath(), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("truncate oplog: %w", err)
	}
	defer f.Close()
	if err := f.Sync(); err != nil {
		return fmt.Errorf("sync truncated oplog: %w", err)
	}
	return nil
}

// writeFileSync writes data to a temp file in path's directory, fsyncs it,
// then atomically renames it over path. Unlike os.WriteFile (write-in-place,
// no fsync), this guarantees a reader never observes a partially written
// file, and that once the call returns nil the bytes have actually reached
// disk rather than just the page cache.
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
	return nil
}
