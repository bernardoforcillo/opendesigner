package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/bernardoforcillo/opendesigner/internal/codegen/samples"
	"github.com/bernardoforcillo/opendesigner/internal/store"
)

// TestPackUnpackThroughTheWorkspace: a document goes from a workspace to a folder and into
// ANOTHER workspace unchanged, and unpack refuses to overwrite without -force.
func TestPackUnpackThroughTheWorkspace(t *testing.T) {
	id := uuid.NewString()
	b := samples.New(id, "Shop")
	b.Add("scr", "page1", "Screen", 0, 0, 100, 100, samples.Frame(false, nil))
	src := t.TempDir()
	if err := store.Import(src, b.Doc, ""); err != nil {
		t.Fatal(err)
	}
	folder := filepath.Join(t.TempDir(), "design")
	var out, errb bytes.Buffer
	if code := runPack([]string{"-workspace", src, "-doc", "Shop", folder}, &out, &errb); code != 0 {
		t.Fatalf("pack: %d %s", code, errb.String())
	}
	if _, err := os.Stat(filepath.Join(folder, "nodes", "scr.json")); err != nil {
		t.Fatal(err)
	}

	dst := t.TempDir()
	out.Reset()
	if code := runUnpack([]string{"-workspace", dst, folder}, &out, &errb); code != 0 {
		t.Fatalf("unpack: %d %s", code, errb.String())
	}
	doc, _, err := store.LoadReadOnly(dst, id)
	if err != nil || doc.GetName() != "Shop" || doc.GetNodes()["scr"] == nil {
		t.Fatalf("unpacked document = %v %v", doc, err)
	}
	errb.Reset()
	if code := runUnpack([]string{"-workspace", dst, folder}, &out, &errb); code != 2 || !strings.Contains(errb.String(), "-force") {
		t.Fatalf("second unpack: %d %q", code, errb.String())
	}
	if code := runUnpack([]string{"-workspace", dst, "-force", folder}, &out, &errb); code != 0 {
		t.Fatalf("forced unpack: %d %s", code, errb.String())
	}
}
