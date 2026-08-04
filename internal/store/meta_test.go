package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// finding: Document.name lived only in memory. No Op kind can set it, so it is
// never in the oplog, and its only durable home was snapshot.pb -- which
// nothing wrote. After a restart, opening a document by id reopened it as
// "Untitled", permanently.
func TestOpenKeepsThePersistedNameOverTheCallersDefault(t *testing.T) {
	ws := t.TempDir()

	b, err := Open(ws, "doc1", "Il mio disegno")
	if err != nil {
		t.Fatal(err)
	}
	if got := b.Meta().Name; got != "Il mio disegno" {
		t.Fatalf("Meta().Name = %q, want %q", got, "Il mio disegno")
	}

	// A restart: the caller (server.Manager.HubFor) resolves a bare doc id
	// and has no idea what the document is called.
	reopened, err := Open(ws, "doc1", DefaultName)
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.Meta().Name; got != "Il mio disegno" {
		t.Fatalf("after reopen with the default name, Meta().Name = %q, want %q", got, "Il mio disegno")
	}
	doc, _, err := reopened.Load()
	if err != nil {
		t.Fatal(err)
	}
	if doc.GetName() != "Il mio disegno" {
		t.Fatalf("Load() document name = %q, want %q", doc.GetName(), "Il mio disegno")
	}
	if doc.GetId() != "doc1" {
		t.Fatalf("Load() document id = %q, want %q", doc.GetId(), "doc1")
	}
}

// snapshotNamed gives dir/doc1.opendesigner a snapshot whose embedded Document
// carries name -- i.e. the state every document reaches after 256 ops.
func snapshotNamed(t *testing.T, ws, name string) {
	t.Helper()
	b, err := Open(ws, "doc1", name)
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Append(rec(1, createOp("n1", 5))); err != nil {
		t.Fatal(err)
	}
	doc, seq, err := b.Load()
	if err != nil {
		t.Fatal(err)
	}
	if doc.GetName() != name {
		t.Fatalf("precondition: the document to be snapshotted is named %q, want %q", doc.GetName(), name)
	}
	if err := b.Snapshot(doc, seq); err != nil {
		t.Fatal(err)
	}
}

// renameByHand edits meta.json the way a user would, which is the stated
// reason it is JSON rather than proto.
func renameByHand(t *testing.T, ws, name string) {
	t.Helper()
	path := filepath.Join(ws, "doc1"+bundleSuffix, metaFileName)
	m, ok, err := readMetaFile(path)
	if err != nil || !ok {
		t.Fatalf("read %s: ok=%v err=%v", path, ok, err)
	}
	m.Name = name
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

// finding: meta.json was documented as the single source of the document's
// name, but Load seeded core.NewDocument from it and then called
// proto.Unmarshal, which RESETS the message -- so the snapshot's embedded name
// silently won. Renaming a document by editing meta.json changed what
// ListDocuments showed and not what OpenDocument returned.
func TestTheNameComesFromMetaNotFromTheSnapshot(t *testing.T) {
	ws := t.TempDir()
	snapshotNamed(t, ws, "Alfa")
	renameByHand(t, ws, "Beta")

	reopened, err := Open(ws, "doc1", DefaultName)
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.Meta().Name; got != "Beta" {
		t.Fatalf("Meta().Name = %q, want %q", got, "Beta")
	}
	doc, _, err := reopened.Load()
	if err != nil {
		t.Fatal(err)
	}
	if doc.GetName() != "Beta" {
		t.Fatalf("Load() document name = %q, want %q: the snapshot's embedded name is still winning", doc.GetName(), "Beta")
	}
	if doc.GetId() != "doc1" {
		t.Fatalf("Load() document id = %q, want %q", doc.GetId(), "doc1")
	}
	// The listing and the open agree, which is the whole property.
	metas, err := Scan(ws)
	if err != nil {
		t.Fatal(err)
	}
	if len(metas) != 1 || metas[0].Name != "Beta" {
		t.Fatalf("Scan() = %+v, want one document named Beta", metas)
	}
}

// The other direction of the same divergence: a bundle whose meta.json is
// lost listed as "Untitled" and opened as itself. The name is recovered from
// the snapshot rather than overwritten with the caller's default, so the
// listing and the open agree again -- under the real name.
func TestABundleThatLostItsMetaFileRecoversTheNameFromItsSnapshot(t *testing.T) {
	ws := t.TempDir()
	snapshotNamed(t, ws, "Alfa")
	if err := os.Remove(filepath.Join(ws, "doc1"+bundleSuffix, metaFileName)); err != nil {
		t.Fatal(err)
	}

	// server.Manager.HubFor resolving a bare doc id: it has no idea what the
	// document is called.
	reopened, err := Open(ws, "doc1", DefaultName)
	if err != nil {
		t.Fatal(err)
	}
	if got := reopened.Meta().Name; got != "Alfa" {
		t.Fatalf("Meta().Name = %q after losing meta.json, want the snapshot's %q", got, "Alfa")
	}
	doc, _, err := reopened.Load()
	if err != nil {
		t.Fatal(err)
	}
	if doc.GetName() != "Alfa" {
		t.Fatalf("Load() document name = %q, want %q", doc.GetName(), "Alfa")
	}
	metas, err := Scan(ws)
	if err != nil {
		t.Fatal(err)
	}
	if len(metas) != 1 || metas[0].Name != "Alfa" {
		t.Fatalf("Scan() = %+v, want one document named Alfa", metas)
	}
}

// Timestamps are part of the identity: created once, and refreshed when the
// content becomes durable as a whole.
func TestMetaTimestampsSurviveAReopen(t *testing.T) {
	ws := t.TempDir()
	b, err := Open(ws, "doc1", "Alfa")
	if err != nil {
		t.Fatal(err)
	}
	created := b.Meta().CreatedAt
	if created.IsZero() {
		t.Fatal("CreatedAt is zero on a freshly created bundle")
	}

	if err := b.Append(rec(1, createOp("n1", 5))); err != nil {
		t.Fatal(err)
	}
	doc, seq, err := b.Load()
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Snapshot(doc, seq); err != nil {
		t.Fatal(err)
	}

	updated := b.Meta().UpdatedAt
	if updated.Before(created) {
		t.Fatalf("UpdatedAt %v is before CreatedAt %v", updated, created)
	}
	if !b.Meta().CreatedAt.Equal(created) {
		t.Fatalf("CreatedAt changed on snapshot: %v -> %v", created, b.Meta().CreatedAt)
	}

	reopened, err := Open(ws, "doc1", DefaultName)
	if err != nil {
		t.Fatal(err)
	}
	m := reopened.Meta()
	if !m.CreatedAt.Equal(created) || !m.UpdatedAt.Equal(updated) {
		t.Fatalf("timestamps did not survive the reopen: got created=%v updated=%v, want %v / %v",
			m.CreatedAt, m.UpdatedAt, created, updated)
	}
	if m.ID != "doc1" {
		t.Fatalf("Meta().ID = %q, want %q", m.ID, "doc1")
	}
}

// A bundle written before meta.json existed (every M0 document) must adopt an
// identity on open rather than being rejected or staying unlistable.
func TestOpenGivesAPreExistingBundleAnIdentity(t *testing.T) {
	ws := t.TempDir()
	b, err := Open(ws, "doc1", "Alfa")
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Append(rec(1, createOp("n1", 5))); err != nil {
		t.Fatal(err)
	}
	// Roll the bundle back to the pre-meta.json layout.
	if err := os.Remove(b.metaPath()); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(ws, "doc1", DefaultName)
	if err != nil {
		t.Fatalf("Open on a bundle with no meta.json: %v", err)
	}
	m := reopened.Meta()
	if m.ID != "doc1" || m.Name != DefaultName || m.CreatedAt.IsZero() {
		t.Fatalf("synthesised identity = %+v, want id doc1 / name %q / a creation time", m, DefaultName)
	}
	if _, err := os.Stat(reopened.metaPath()); err != nil {
		t.Fatalf("meta.json was not written for a pre-existing bundle: %v", err)
	}
	// The content is untouched.
	doc, seq, err := reopened.Load()
	if err != nil {
		t.Fatal(err)
	}
	if seq != 1 || len(doc.GetNodes()) != 1 {
		t.Fatalf("seq = %d nodes = %d, want 1/1", seq, len(doc.GetNodes()))
	}
}

// A meta.json that is present but unreadable is NOT treated as absent:
// falling back to the default would silently rename the document to
// "Untitled" forever, and the failure may be transient.
func TestOpenRefusesADamagedMetaFile(t *testing.T) {
	ws := t.TempDir()
	b, err := Open(ws, "doc1", "Alfa")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(b.metaPath(), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := Open(ws, "doc1", DefaultName); err == nil {
		t.Fatal("Open accepted a bundle whose meta.json cannot be parsed")
	} else if !strings.Contains(err.Error(), metaFileName) {
		t.Fatalf("error does not name the offending file: %v", err)
	}
}

// Scan is what makes a workspace browsable at all: before it, the set of
// documents lived only in the server's memory and the browser's localStorage.
func TestScanListsEveryBundleOldestFirst(t *testing.T) {
	ws := t.TempDir()
	for _, d := range []struct{ id, name string }{{"doc1", "Alfa"}, {"doc2", "Beta"}, {"doc3", "Gamma"}} {
		if _, err := Open(ws, d.id, d.name); err != nil {
			t.Fatal(err)
		}
	}
	// Noise that is not a document.
	if err := os.WriteFile(filepath.Join(ws, "notes.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(ws, "scratch"), 0o755); err != nil {
		t.Fatal(err)
	}

	metas, err := Scan(ws)
	if err != nil {
		t.Fatal(err)
	}
	if len(metas) != 3 {
		t.Fatalf("Scan() returned %d documents, want 3: %+v", len(metas), metas)
	}
	for i, want := range []string{"doc1", "doc2", "doc3"} {
		if metas[i].ID != want {
			t.Fatalf("Scan()[%d].ID = %q, want %q (oldest first)", i, metas[i].ID, want)
		}
	}
	if metas[1].Name != "Beta" {
		t.Fatalf("Scan()[1].Name = %q, want Beta", metas[1].Name)
	}
}

// Listing degrades where opening refuses: everything needed to reach the
// document (its id) is in the directory name, so one damaged identity file
// must not put every other document in the workspace out of reach.
func TestScanStillListsABundleWithADamagedMetaFile(t *testing.T) {
	ws := t.TempDir()
	good, err := Open(ws, "doc1", "Alfa")
	if err != nil {
		t.Fatal(err)
	}
	_ = good
	bad, err := Open(ws, "doc2", "Beta")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bad.metaPath(), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	// And one that never had a meta.json at all.
	if err := os.MkdirAll(filepath.Join(ws, "doc3"+bundleSuffix), 0o755); err != nil {
		t.Fatal(err)
	}

	metas, err := Scan(ws)
	if err != nil {
		t.Fatalf("Scan() failed because of one damaged bundle: %v", err)
	}
	byID := map[string]Meta{}
	for _, m := range metas {
		byID[m.ID] = m
	}
	if len(byID) != 3 {
		t.Fatalf("Scan() returned %d documents, want 3: %+v", len(byID), metas)
	}
	if byID["doc1"].Name != "Alfa" {
		t.Fatalf("the healthy bundle lost its name: %+v", byID["doc1"])
	}
	if byID["doc2"].Name != DefaultName || byID["doc3"].Name != DefaultName {
		t.Fatalf("a bundle with no usable identity should be listed as %q: %+v %+v", DefaultName, byID["doc2"], byID["doc3"])
	}
}

// finding: Scan read every bundle's meta.json with no coordination against
// the process's own writer. On Windows os.Rename cannot replace a file that
// any handle is open on, so a Scan running while a snapshot refreshed
// meta.json made the rename fail with "Access is denied" -- and, because that
// write is the last step of Bundle.Snapshot, an already-committed snapshot
// reported failure. Manager.List calls Scan on every ListDocuments, i.e. the
// call the editor makes at boot.
func TestSnapshotSucceedsWhileTheWorkspaceIsBeingScanned(t *testing.T) {
	ws := t.TempDir()
	b, err := Open(ws, "doc1", "Alfa")
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Append(rec(1, createOp("n1", 5))); err != nil {
		t.Fatal(err)
	}
	doc, seq, err := b.Load()
	if err != nil {
		t.Fatal(err)
	}

	stop := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				metas, err := Scan(ws)
				if err != nil {
					t.Errorf("Scan while a snapshot was running: %v", err)
					return
				}
				// A reader must also never observe a half-published
				// identity: the rename is atomic, so it sees the old
				// meta.json or the new one and both name the document.
				if len(metas) != 1 || metas[0].Name != "Alfa" {
					t.Errorf("Scan saw %+v, want one document named Alfa", metas)
					return
				}
			}
		}()
	}
	defer func() {
		close(stop)
		wg.Wait()
	}()

	for i := 0; i < 30; i++ {
		if err := b.Snapshot(doc, seq); err != nil {
			t.Fatalf("snapshot %d failed while the workspace was being scanned: %v", i, err)
		}
	}
}

// A workspace directory that does not exist yet is an empty workspace, not an
// error: the server creates it at startup, but a Manager may be asked to list
// before anything has been created in it.
func TestScanOnAMissingWorkspaceIsEmpty(t *testing.T) {
	metas, err := Scan(filepath.Join(t.TempDir(), "nope"))
	if err != nil {
		t.Fatalf("Scan on a missing workspace: %v", err)
	}
	if len(metas) != 0 {
		t.Fatalf("Scan on a missing workspace returned %+v", metas)
	}
}
