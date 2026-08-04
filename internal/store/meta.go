package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	// bundleSuffix is what makes a directory in the workspace a document.
	bundleSuffix = ".opendesigner"
	// metaFileName holds the bundle's identity (see Meta).
	metaFileName = "meta.json"
	// DefaultName is the name given to a document that has none: a bundle
	// written before meta.json existed, or one whose meta.json is unreadable.
	DefaultName = "Untitled"
)

// Meta is a document's identity -- who it is, as opposed to what it contains.
//
// It lives in <bundle>/meta.json, next to the content (snapshot.pb + oplog),
// and it exists because the content alone cannot answer the two questions a
// document browser asks. The name was previously held only in memory: no Op
// kind can set it, so it is never in the oplog, and its only durable home was
// snapshot.pb -- which was written by nobody, so after a restart every
// document reopened as "Untitled" and the workspace could not be listed at
// all without replaying every bundle's entire oplog just to read one string.
//
// It is JSON, not proto, deliberately: it is the one file a user may have to
// read or repair by hand when a bundle is otherwise unopenable, and it is
// written once per document (plus once per snapshot) rather than per op, so
// nothing about it is on a hot path.
//
// The id is stored even though the directory name already carries it. They
// are cross-checked on read: the directory name wins (it is the id that
// actually opens the bundle), and a mismatch means the directory was copied
// or renamed, which is worth detecting rather than trusting.
type Meta struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

func (b *Bundle) metaPath() string { return filepath.Join(b.dir, metaFileName) }

// Meta returns a copy of the bundle's identity.
func (b *Bundle) Meta() Meta {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.meta
}

// initMetaLocked loads meta.json into b, synthesising one when the bundle has
// none (a document being created now, one written before meta.json existed,
// or one whose identity file was deleted). The synthesised name is the
// snapshot's if there is one, otherwise defaultName.
//
// A meta.json that exists but cannot be read or parsed is an error, not a
// reason to fall back to defaultName: overwriting it would silently rename the
// document to "Untitled" forever, and the failure may well be transient (the
// same reason readOplogLocked refuses to repair on an I/O fault). Scan makes
// the opposite trade-off for listing only -- see there.
func (b *Bundle) initMetaLocked(defaultName string) error {
	m, ok, err := readMetaFile(b.metaPath())
	if err != nil {
		return err
	}
	if ok {
		// The directory name is the authoritative id (it is what HubFor
		// resolves), so a copied/renamed bundle adopts its new identity
		// rather than claiming the original's.
		m.ID = b.docID
		if m.Name == "" {
			m.Name = defaultName
		}
		b.meta = m
		return nil
	}
	// The bundle has no identity file. Before falling back to the caller's
	// default, take the name from the snapshot if there is one: a document
	// whose meta.json was lost still knows what it is called, and renaming it
	// to "Untitled" here is exactly the divergence this file exists to
	// prevent. (A caller-supplied name only loses to a snapshot for an id
	// that already has content, which Create -- minting a fresh UUID -- never
	// does.)
	name := b.nameFromSnapshotLocked()
	if name == "" {
		name = defaultName
	}
	if name == "" {
		name = DefaultName
	}
	now := time.Now().UTC()
	return b.writeMetaLocked(Meta{ID: b.docID, Name: name, CreatedAt: now, UpdatedAt: now})
}

// writeMetaLocked commits m as the bundle's identity atomically (temp file +
// rename + fsync), so a crash mid-write can never leave a document with a
// half-written identity, and adopts it in memory only once that has
// succeeded. b.mu must be held.
//
// The order is the point. Snapshot used to bump b.meta.UpdatedAt and then
// write, so a failed write left Meta() -- and therefore ListDocuments --
// reporting a "last modified" that is on no disk anywhere and disappears at
// the next restart.
func (b *Bundle) writeMetaLocked(m Meta) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	// Exclude readers for the duration of the temp+rename commit: see
	// metaFileMu.
	metaFileMu.Lock()
	err = writeFileSync(b.metaPath(), data, 0o644)
	metaFileMu.Unlock()
	if err != nil {
		return fmt.Errorf("write %s: %w", metaFileName, err)
	}
	b.meta = m
	return nil
}

// metaFileMu serialises meta.json's readers against the rename that publishes
// a new one.
//
// meta.json is the only file in a bundle that is read WITHOUT holding b.mu:
// Scan reads every bundle's copy, lock-free, on every ListDocuments -- the
// call the editor makes at boot -- so it is the only file whose reader can
// overlap its own writer. On Windows that overlap is fatal rather than
// merely racy: os.Rename is MoveFileEx(MOVEFILE_REPLACE_EXISTING)
// (GOROOT/src/internal/syscall/windows/syscall_windows.go), which refuses to
// replace a file that any handle is open on -- verified here in every sharing
// mode, including FILE_SHARE_DELETE -- and fails immediately with "Access is
// denied" instead of waiting. With four goroutines scanning, the very first
// snapshot of a document failed to refresh its meta.json that way.
//
// A lock rather than a retry loop because the collision is entirely
// in-process and therefore entirely preventable: the store already serialises
// every other file in a bundle through b.mu, and this restores that
// discipline for the one file that escaped it. Readers do not exclude each
// other, and the writer runs once per document plus once per snapshot, so
// nothing here is on a hot path. (A handle held by another *process* -- a
// text editor, an indexer -- can still delay a rename; no in-process
// coordination can fix that, and it is not what this defect was.)
var metaFileMu sync.RWMutex

// readMetaFile reads one meta.json. ok is false only when the file is absent,
// which is the single tolerated absence (see initMetaLocked).
func readMetaFile(path string) (Meta, bool, error) {
	metaFileMu.RLock()
	data, err := os.ReadFile(path)
	metaFileMu.RUnlock()
	if err != nil {
		if os.IsNotExist(err) {
			return Meta{}, false, nil
		}
		return Meta{}, false, err
	}
	var m Meta
	if err := json.Unmarshal(data, &m); err != nil {
		return Meta{}, false, fmt.Errorf("parse %s: %w", path, err)
	}
	return m, true, nil
}

// Scan returns the identity of every document bundle in workspace, sorted
// oldest first (then by id, so the order is total and stable).
//
// This is what makes a workspace browsable: before it, the set of documents
// lived only in the server process's memory and in the browser's
// localStorage, so a restart -- or a cleared localStorage -- orphaned every
// bundle on disk even though all of them were intact.
//
// A bundle whose meta.json is missing, unreadable or malformed is still
// listed, under DefaultName. That is deliberately the opposite of the strict
// treatment in initMetaLocked: everything needed to *open* the document (its
// id) comes from the directory name, and its content is untouched, so
// dropping it from the listing -- or failing the whole listing because one
// bundle out of fifty has a damaged identity file -- would put every other
// document out of reach to report a problem with one. Opening that bundle
// still surfaces the error.
func Scan(workspace string) ([]Meta, error) {
	entries, err := os.ReadDir(workspace)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var out []Meta
	for _, e := range entries {
		if !e.IsDir() || !strings.HasSuffix(e.Name(), bundleSuffix) {
			continue
		}
		id := strings.TrimSuffix(e.Name(), bundleSuffix)
		if id == "" {
			continue
		}
		m, ok, err := readMetaFile(filepath.Join(workspace, e.Name(), metaFileName))
		if err != nil || !ok {
			m = Meta{}
		}
		m.ID = id
		if m.Name == "" {
			m.Name = DefaultName
		}
		out = append(out, m)
	}

	sort.Slice(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.Before(out[j].CreatedAt)
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}
