package store

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBookRecordRoundTrip(t *testing.T) {
	ws := t.TempDir()
	if l, err := ListBooks(ws); err != nil || len(l) != 0 {
		t.Fatalf("empty workspace: %v %v", l, err)
	}
	b := BookRecord{ID: "b1", Name: "One", DocIDs: []string{"x", "y"}, StyleSourceID: "y", StartNumber: 7, UpdatedAt: time.Unix(100, 0).UTC()}
	if err := SaveBook(ws, b); err != nil {
		t.Fatal(err)
	}
	got, err := LoadBook(ws, "b1")
	if err != nil || got.Name != "One" || len(got.DocIDs) != 2 || got.StyleSourceID != "y" || got.StartNumber != 7 {
		t.Fatalf("got %+v %v", got, err)
	}
	// A broken file is left out of the list; a book directory is not a document.
	if err := os.WriteFile(filepath.Join(ws, BooksDir, "bad.json"), []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}
	if l, _ := ListBooks(ws); len(l) != 1 {
		t.Fatalf("list %v", l)
	}
	if m, _ := Scan(ws); len(m) != 0 {
		t.Fatalf("Scan took the books for documents: %v", m)
	}
	for _, id := range []string{"", "../x", "a/b", ".hidden"} {
		if _, err := LoadBook(ws, id); !errors.Is(err, ErrNoBook) {
			t.Errorf("id %q: %v", id, err)
		}
	}
	if err := DeleteBook(ws, "b1"); err != nil {
		t.Fatal(err)
	}
	if err := DeleteBook(ws, "b1"); !errors.Is(err, ErrNoBook) {
		t.Fatalf("second delete: %v", err)
	}
}
