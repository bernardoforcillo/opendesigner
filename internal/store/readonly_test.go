package store

import (
	"os"
	"path/filepath"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// LoadReadOnly reads snapshot+oplog without modifying the bundle: not even when
// the oplog has a torn tail (which Bundle.Load would repair by truncating).
func TestLoadReadOnlyLeavesBundleUntouched(t *testing.T) {
	ws := t.TempDir()
	b, err := Open(ws, "doc1", "Test")
	if err != nil {
		t.Fatal(err)
	}
	rec := &opendesignerv1.OpRecord{Seq: 1, Op: &opendesignerv1.Op{OpId: "o1", Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{
		Node: &opendesignerv1.Node{Id: "n1", ParentId: "page1", OrderKey: "a", Name: "Home", Visible: true, Opacity: 1},
	}}}}
	if err := b.Append(rec); err != nil {
		t.Fatal(err)
	}
	oplog := filepath.Join(ws, "doc1"+bundleSuffix, "oplog")
	f, err := os.OpenFile(oplog, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.Write([]byte{0x42, 0x52, 0x57}) // fragment of an interrupted append
	f.Close()
	before, _ := os.ReadFile(oplog)

	doc, seq, err := LoadReadOnly(ws, "doc1")
	if err != nil {
		t.Fatal(err)
	}
	if seq != 1 || doc.GetNodes()["n1"].GetName() != "Home" || doc.GetName() != "Test" {
		t.Fatalf("doc = %v seq = %d", doc, seq)
	}
	after, _ := os.ReadFile(oplog)
	if string(before) != string(after) {
		t.Error("LoadReadOnly ha modificato l'oplog originale")
	}

	if _, _, err := LoadReadOnly(ws, "nope"); err == nil {
		t.Error("nonexistent document must give an error")
	}
	if _, err := os.Stat(filepath.Join(ws, "nope"+bundleSuffix)); err == nil {
		t.Error("LoadReadOnly must not create a bundle")
	}
}
