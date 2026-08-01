package server

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"connectrpc.com/connect"
	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
)

// finding: Manager.infos was purely in-memory and the workspace directory was
// never scanned, so ListDocuments returned an empty list after any restart --
// the only way back into a document was the browser's localStorage entry, and
// clearing it orphaned every bundle on disk. A fresh Manager over an existing
// workspace must list what is actually there, and open it under its real name.
func TestFreshManagerListsDocumentsOnDisk(t *testing.T) {
	ws := t.TempDir()

	m1 := NewManager(ws)
	info, err := m1.Create("Progetto Alfa")
	if err != nil {
		t.Fatal(err)
	}
	h1, err := m1.HubFor(info.GetId())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h1.Submit("c1", createOp("n1")); err != nil {
		t.Fatal(err)
	}

	// Restart: a brand new Manager over the same workspace, sharing no
	// in-memory state with m1.
	m2 := NewManager(ws)
	docs, err := m2.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(docs) != 1 {
		t.Fatalf("List() returned %d documents, want 1 (the bundle on disk)", len(docs))
	}
	if docs[0].GetId() != info.GetId() {
		t.Fatalf("List()[0].id = %q, want %q", docs[0].GetId(), info.GetId())
	}
	if docs[0].GetName() != "Progetto Alfa" {
		t.Fatalf("List()[0].name = %q, want %q", docs[0].GetName(), "Progetto Alfa")
	}

	// And it must open under its real name, at the seq it was left at.
	h2, err := m2.HubFor(info.GetId())
	if err != nil {
		t.Fatal(err)
	}
	doc, seq := h2.Snapshot()
	if doc.GetName() != "Progetto Alfa" {
		t.Fatalf("reopened document name = %q, want %q", doc.GetName(), "Progetto Alfa")
	}
	if seq != 1 {
		t.Fatalf("reopened seq = %d, want 1", seq)
	}
	if _, ok := doc.GetNodes()["n1"]; !ok {
		t.Fatalf("reopened document is missing node n1: %v", doc.GetNodes())
	}
}

// The same thing over the wire, which is where it actually bit: after a
// restart ListDocuments answered with an empty list, so the editor could only
// reach a document through the id in the browser's localStorage.
func TestListDocumentsAfterARestartOverTheWire(t *testing.T) {
	ws := t.TempDir()
	ctx := context.Background()

	first := newTestClientOn(t, ws)
	info, err := first.CreateDocument(ctx, connect.NewRequest(&brawtv1.CreateDocumentRequest{Name: "Progetto Alfa"}))
	if err != nil {
		t.Fatal(err)
	}

	second := newTestClientOn(t, ws)
	list, err := second.ListDocuments(ctx, connect.NewRequest(&brawtv1.ListDocumentsRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	docs := list.Msg.GetDocs()
	if len(docs) != 1 || docs[0].GetId() != info.Msg.GetId() || docs[0].GetName() != "Progetto Alfa" {
		t.Fatalf("ListDocuments after a restart = %v, want the one document %q named %q",
			docs, info.Msg.GetId(), "Progetto Alfa")
	}

	open, err := second.OpenDocument(ctx, connect.NewRequest(&brawtv1.OpenRequest{DocId: docs[0].GetId()}))
	if err != nil {
		t.Fatal(err)
	}
	if open.Msg.GetSnapshot().GetName() != "Progetto Alfa" {
		t.Fatalf("OpenDocument after a restart: name = %q, want %q", open.Msg.GetSnapshot().GetName(), "Progetto Alfa")
	}
}

// The workspace holds bundle directories, but nothing stops a user (or another
// tool) from leaving other files in it. Only <uuid>.brawt directories are
// documents, and an id the Manager would refuse to open (HubFor validates it as
// a UUID) must not be advertised as openable.
func TestListIgnoresEntriesThatAreNotBundles(t *testing.T) {
	ws := t.TempDir()

	m := NewManager(ws)
	info, err := m.Create("Vero")
	if err != nil {
		t.Fatal(err)
	}

	for _, name := range []string{"notes.txt", "random-dir", "not-a-uuid.brawt"} {
		path := filepath.Join(ws, name)
		if filepath.Ext(name) == ".txt" {
			if err := os.WriteFile(path, []byte("hi"), 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		if err := os.MkdirAll(path, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	docs, err := NewManager(ws).List()
	if err != nil {
		t.Fatal(err)
	}
	if len(docs) != 1 || docs[0].GetId() != info.GetId() {
		t.Fatalf("List() = %v, want exactly the one real bundle %q", docs, info.GetId())
	}
}
