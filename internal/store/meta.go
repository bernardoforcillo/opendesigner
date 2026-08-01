package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	// bundleSuffix is what makes a directory in the workspace a document.
	bundleSuffix = ".brawt"
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

// initMetaLocked loads meta.json into b, creating it from defaultName when the
// bundle has none (a document being created now, or one written before
// meta.json existed).
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
	if defaultName == "" {
		defaultName = DefaultName
	}
	now := time.Now().UTC()
	b.meta = Meta{ID: b.docID, Name: defaultName, CreatedAt: now, UpdatedAt: now}
	return b.writeMetaLocked()
}

// writeMetaLocked commits meta.json atomically (temp file + rename + fsync),
// so a crash mid-write can never leave a document with a half-written
// identity. b.mu must be held.
func (b *Bundle) writeMetaLocked() error {
	data, err := json.MarshalIndent(b.meta, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := writeFileSync(b.metaPath(), data, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", metaFileName, err)
	}
	return nil
}

// readMetaFile reads one meta.json. ok is false only when the file is absent,
// which is the single tolerated absence (see initMetaLocked).
func readMetaFile(path string) (Meta, bool, error) {
	data, err := os.ReadFile(path)
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
