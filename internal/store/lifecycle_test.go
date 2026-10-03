package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSetNameSurvivesReopen(t *testing.T) {
	ws := t.TempDir()
	id := "11111111-1111-1111-1111-111111111111"
	b, err := Open(ws, id, "Prima")
	if err != nil {
		t.Fatal(err)
	}
	if err := b.SetName("  Seconda  "); err != nil {
		t.Fatal(err)
	}
	if b.Meta().Name != "Seconda" {
		t.Fatalf("name = %q", b.Meta().Name)
	}
	if err := b.SetName("   "); err == nil {
		t.Fatal("un nome vuoto va rifiutato")
	}
	b2, err := Open(ws, id, "x")
	if err != nil {
		t.Fatal(err)
	}
	if b2.Meta().Name != "Seconda" {
		t.Fatalf("riaperto: name = %q", b2.Meta().Name)
	}
}

func TestTrashMovesBundleOutOfScan(t *testing.T) {
	ws := t.TempDir()
	id := "22222222-2222-2222-2222-222222222222"
	if _, err := Open(ws, id, "Da buttare"); err != nil {
		t.Fatal(err)
	}
	if err := Trash(ws, id); err != nil {
		t.Fatal(err)
	}
	metas, err := Scan(ws)
	if err != nil || len(metas) != 0 {
		t.Fatalf("Scan dopo Trash = %v, %v", metas, err)
	}
	entries, err := os.ReadDir(filepath.Join(ws, TrashDir))
	if err != nil || len(entries) != 1 {
		t.Fatalf("il cestino deve contenere il bundle: %v %v", entries, err)
	}
	if err := Trash(ws, id); err == nil {
		t.Fatal("eliminare un documento inesistente deve fallire")
	}
}

func TestModTime(t *testing.T) {
	ws := t.TempDir()
	id := "33333333-3333-3333-3333-333333333333"
	if _, err := Open(ws, id, "T"); err != nil {
		t.Fatal(err)
	}
	if ModTime(ws, id).IsZero() {
		t.Fatal("ModTime zero per un bundle esistente")
	}
	if !ModTime(ws, "44444444-4444-4444-4444-444444444444").IsZero() {
		t.Fatal("ModTime deve essere zero per un documento assente")
	}
}
