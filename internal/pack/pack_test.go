package pack_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	. "github.com/bernardoforcillo/opendesigner/internal/codegen/samples"
	"github.com/bernardoforcillo/opendesigner/internal/pack"
)

func sample() *opendesignerv1.Document {
	b := New("11111111-1111-1111-1111-111111111111", "Shop")
	b.Add("scr", "page1", "Screen", 0, 0, 300, 300, Frame(false, nil), Fill(Solid(C(1, 1, 1))))
	b.Add("a/b", "scr", "Odd id", 10, 10, 50, 50, Rect(4), Fill(Solid(C(0.2, 0.4, 0.8))))
	b.Add(".hidden", "scr", "Dot id", 70, 10, 50, 50, Ellipse())
	b.Flow("f", "Flow", "scr")
	return b.Doc
}

func TestRoundTrip(t *testing.T) {
	dir := t.TempDir()
	doc := sample()
	if err := pack.Pack(doc, "", dir); err != nil {
		t.Fatal(err)
	}
	got, _, err := pack.Unpack(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(doc, got) {
		t.Fatalf("round trip differs:\nwant %v\ngot  %v", doc, got)
	}
}

func TestLayoutIsOneFilePerNodeAndStable(t *testing.T) {
	dir := t.TempDir()
	doc := sample()
	if err := pack.Pack(doc, "", dir); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(filepath.Join(dir, "nodes"))
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	want := []string{"%2Ehidden.json", "a%2Fb.json", "scr.json"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("node files = %v, want %v", names, want)
	}
	read := func() map[string]string {
		out := map[string]string{}
		_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
			if err == nil && !d.IsDir() {
				b, _ := os.ReadFile(p)
				out[p] = string(b)
			}
			return nil
		})
		return out
	}
	first := read()
	for i := 0; i < 3; i++ {
		if err := pack.Pack(doc, "", dir); err != nil {
			t.Fatal(err)
		}
	}
	again := read()
	for p, v := range first {
		if again[p] != v {
			t.Errorf("%s changed between packs", p)
		}
	}
	// Sorted keys, indented, one trailing newline.
	n := first[filepath.Join(dir, "nodes", "a%2Fb.json")]
	if !strings.HasPrefix(n, "{\n  \"fills\"") || !strings.HasSuffix(n, "}\n") {
		t.Errorf("node file shape:\n%s", n)
	}
	// Moving ONE node changes ONE node file.
	moved := proto.Clone(doc).(*opendesignerv1.Document)
	moved.Nodes["a/b"].X = 99
	if err := pack.Pack(moved, "", dir); err != nil {
		t.Fatal(err)
	}
	changed := 0
	for p, v := range read() {
		if first[p] != v {
			changed++
			if !strings.HasSuffix(p, "a%2Fb.json") {
				t.Errorf("unexpected change in %s", p)
			}
		}
	}
	if changed != 1 {
		t.Errorf("%d files changed, want 1", changed)
	}
}

func TestPackRemovesFilesOfDeletedNodesAndCopiesAssets(t *testing.T) {
	dir := t.TempDir()
	doc := sample()
	assets := t.TempDir()
	_ = os.WriteFile(filepath.Join(assets, "abc123"), []byte("img"), 0o644)
	if err := pack.Pack(doc, assets, dir); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "assets", "abc123")); err != nil || string(b) != "img" {
		t.Fatalf("asset copy: %q %v", b, err)
	}
	delete(doc.Nodes, "a/b")
	if err := pack.Pack(doc, assets, dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "nodes", "a%2Fb.json")); !os.IsNotExist(err) {
		t.Errorf("the file of a deleted node must go: %v", err)
	}
	got, _, _ := pack.Unpack(dir)
	if len(got.GetNodes()) != 2 {
		t.Errorf("nodes after delete = %d", len(got.GetNodes()))
	}
}

func TestUnpackRejectsBrokenFolders(t *testing.T) {
	dir := t.TempDir()
	if err := pack.Pack(sample(), "", dir); err != nil {
		t.Fatal(err)
	}
	// A node file whose content says it is another node.
	_ = os.Rename(filepath.Join(dir, "nodes", "scr.json"), filepath.Join(dir, "nodes", "liar.json"))
	if _, _, err := pack.Unpack(dir); err == nil || !strings.Contains(err.Error(), "holds node") {
		t.Errorf("mismatched id: %v", err)
	}
	if _, _, err := pack.Unpack(t.TempDir()); err == nil {
		t.Error("an empty folder is not a pack")
	}
}
