package codesync_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
	"github.com/bernardoforcillo/opendesigner/internal/codesync"
)

func buttonDoc() *opendesignerv1.Document {
	solid := &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{Color: &opendesignerv1.Color{R: 1, A: 1}}}}
	rect := func(id, name string, w float64) *opendesignerv1.Node {
		return &opendesignerv1.Node{Id: id, ParentId: "s", OrderKey: id, Name: name, Visible: true, Opacity: 1, X: 200, Width: w, Height: 20,
			Fills: []*opendesignerv1.Paint{solid}, Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}}}
	}
	return &opendesignerv1.Document{
		Id: "doc", Name: "Buttons", SchemaVersion: 1,
		Pages: []*opendesignerv1.Page{{Id: "page1", Name: "Page 1"}},
		Nodes: map[string]*opendesignerv1.Node{
			"s":  {Id: "s", ParentId: "page1", OrderKey: "a", Name: "Home", Visible: true, Opacity: 1, Width: 400, Height: 300, Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}},
			"ma": rect("ma", "Button S", 80),
			"mb": rect("mb", "Button L", 160),
			"i1": {Id: "i1", ParentId: "s", OrderKey: "z", Name: "i1", Visible: true, Opacity: 1, Width: 80, Height: 20, Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: "a"}}},
		},
		Components: map[string]*opendesignerv1.Component{
			"a": {RootNodeId: "ma", Name: "Button/S", SetId: "set", Variant: map[string]string{"Size": "S"}},
			"b": {RootNodeId: "mb", Name: "Button/L", SetId: "set", Variant: map[string]string{"Size": "L"}},
		},
		ComponentSets: map[string]*opendesignerv1.ComponentSet{"set": {Id: "set", Name: "Button", Axes: []*opendesignerv1.VariantAxis{{Name: "Size", Options: []string{"S", "L"}}}}},
	}
}

func export(t *testing.T, d *opendesignerv1.Document) []codegen.File {
	t.Helper()
	out, err := codegen.Generate(d, codegen.Options{Target: codegen.TargetReact}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return out.Files
}

func exported(files []codegen.File, p string) []byte {
	for _, f := range files {
		if f.Path == p {
			return f.Content
		}
	}
	return nil
}

func TestCheckStatuses(t *testing.T) {
	doc := buttonDoc()
	files := export(t, doc)
	design := exported(files, "src/components/Button.tsx")
	if design == nil {
		t.Fatal("no Button.tsx exported")
	}

	// Unmapped first: the set is reported once.
	rep := codesync.Check(doc, files, func(string) ([]byte, error) { return nil, os.ErrNotExist })
	if len(rep.Entries) != 0 || len(rep.Unmapped) != 1 || rep.Unmapped[0].Name != "Button" || rep.Unmapped[0].ExportedPath != "src/components/Button.tsx" {
		t.Fatalf("unmapped = %+v", rep)
	}

	// Mapping ONE member covers the whole set's file.
	doc.Nodes["mb"].Meta = map[string]string{codesync.MetaFile: "ui/Button.tsx"}
	disk := map[string][]byte{}
	read := func(p string) ([]byte, error) {
		if b, ok := disk[p]; ok {
			return b, nil
		}
		return nil, os.ErrNotExist
	}
	check := func() codesync.Entry {
		r := codesync.Check(doc, files, read)
		if len(r.Entries) != 1 || len(r.Unmapped) != 0 {
			t.Fatalf("report = %+v", r)
		}
		return r.Entries[0]
	}

	if e := check(); e.Status != codesync.Missing {
		t.Errorf("no file: %+v", e)
	}
	disk["ui/Button.tsx"] = []byte(strings.ReplaceAll(string(design), "\n", "\r\n") + "\n\n")
	if e := check(); e.Status != codesync.InSync {
		t.Errorf("CRLF and trailing blank lines must not count: %+v", e)
	}
	edited := []byte(strings.Replace(string(design), "export function", "// hand edit\nexport function", 1))
	disk["ui/Button.tsx"] = edited
	e := check()
	if e.Status != codesync.Drifted || !strings.Contains(e.Detail, "hand edit") {
		t.Errorf("no baseline: %+v", e)
	}

	// Baseline = the design as exported: the code moved.
	doc.Nodes["mb"].Meta[codesync.MetaHash] = codesync.Hash(design)
	if e := check(); e.Status != codesync.CodeChanged {
		t.Errorf("code moved: %+v", e)
	}
	// Baseline = the code: the design moved.
	doc.Nodes["mb"].Meta[codesync.MetaHash] = codesync.Hash(edited)
	if e := check(); e.Status != codesync.DesignChanged {
		t.Errorf("design moved: %+v", e)
	}
	doc.Nodes["mb"].Meta[codesync.MetaHash] = "0000"
	if e := check(); e.Status != codesync.Diverged {
		t.Errorf("both moved: %+v", e)
	}
	if rep := codesync.Check(doc, files, read); rep.Drift() != 1 {
		t.Errorf("drift = %d", rep.Drift())
	}

	// An escaping path, and a node that exports nothing.
	doc.Nodes["mb"].Meta = map[string]string{codesync.MetaFile: "../etc/passwd"}
	if e := check(); e.Status != codesync.Missing || !strings.Contains(e.Detail, "leaves") {
		t.Errorf("escape: %+v", e)
	}
	doc.Nodes["mb"].Meta = map[string]string{codesync.MetaFile: "x.tsx"}
	doc.Nodes["ghost"] = &opendesignerv1.Node{Id: "ghost", Name: "Ghost", Meta: map[string]string{codesync.MetaFile: "g.tsx"}}
	delete(doc.Nodes["mb"].Meta, codesync.MetaFile)
	if r := codesync.Check(doc, files, read); len(r.Entries) != 1 || r.Entries[0].Status != codesync.NotExported {
		t.Errorf("ghost: %+v", r.Entries)
	}
}

func TestDirReaderStaysInside(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := codesync.DirReader(root)
	if b, err := r("a.txt"); err != nil || string(b) != "x" {
		t.Errorf("read: %q %v", b, err)
	}
	for _, bad := range []string{"../a.txt", "/etc/passwd", "", "a/../../b"} {
		if _, err := r(bad); err == nil {
			t.Errorf("%q must be refused", bad)
		}
	}
}
