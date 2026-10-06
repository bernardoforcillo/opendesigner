package store

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// TrashDir is the folder (inside the workspace) where deleted documents end
// up. It does not show up in Scan: its name lacks the bundle suffix.
const TrashDir = ".trash"

// SetName changes the document's name and makes it durable in meta.json.
// It goes through the Bundle (and its b.mu) and NOT through an external rewrite of the file:
// Snapshot keeps the meta in memory and rewrites it on every snapshot, so an
// "outside" rewrite would be undone with the old name at the first snapshot.
func (b *Bundle) SetName(name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("the document name cannot be empty")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	m := b.meta
	m.Name = name
	return b.writeMetaLocked(m)
}

// ModTime is the document's "real" last modification: the most recent of
// meta.json (updated on every snapshot), snapshot.pb and the oplog file
// (touched on every operation). UpdatedAt alone would stay frozen until the
// next snapshot (every 256 ops), and a Home showing "modified 3 hours ago" on a
// document just touched would be a lie. Zero if the folder does not exist.
func ModTime(workspace, docID string) time.Time {
	dir := filepath.Join(workspace, docID+bundleSuffix)
	var latest time.Time
	for _, name := range []string{"oplog", "snapshot.pb", metaFileName} {
		if st, err := os.Stat(filepath.Join(dir, name)); err == nil && st.ModTime().After(latest) {
			latest = st.ModTime()
		}
	}
	return latest.UTC()
}

// Trash moves the document's bundle to <workspace>/.trash instead of
// deleting it: deleting by mistake must remain recoverable by hand. The
// destination name carries a timestamp, so deleting the same id twice (a
// recreated bundle) does not collide. The caller guarantees that no Bundle is
// still open on that folder.
func Trash(workspace, docID string) error {
	src := filepath.Join(workspace, docID+bundleSuffix)
	if st, err := os.Stat(src); err != nil {
		return err
	} else if !st.IsDir() {
		return fmt.Errorf("%s is not a directory", src)
	}
	trash := filepath.Join(workspace, TrashDir)
	if err := os.MkdirAll(trash, 0o755); err != nil {
		return err
	}
	dst := filepath.Join(trash, fmt.Sprintf("%s%s-%d", docID, bundleSuffix, time.Now().UnixNano()))
	if err := os.Rename(src, dst); err != nil {
		return err
	}
	return syncDir(workspace)
}

// Exists: the bundle's folder is there. It creates nothing (Open does).
func Exists(workspace, docID string) bool {
	st, err := os.Stat(filepath.Join(workspace, docID+bundleSuffix))
	return err == nil && st.IsDir()
}
