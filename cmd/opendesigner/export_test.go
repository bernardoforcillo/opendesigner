package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bernardoforcillo/opendesigner/internal/codegen/samples"
	"google.golang.org/protobuf/encoding/protojson"
)

func runExportCLI(t *testing.T, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	var o, e bytes.Buffer
	code = runExport(args, &o, &e)
	return code, o.String(), e.String()
}

// -json: a Document in protojson, without a workspace (it is how tests and
// tools use it); prints the files written.
func TestExportCLIJSON(t *testing.T) {
	b, err := protojson.Marshal(samples.Shop())
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	docFile := filepath.Join(dir, "shop.json")
	if err := os.WriteFile(docFile, b, 0o644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "app")

	code, stdout, stderr := runExportCLI(t, "-json", docFile, "-out", out)
	if code != 0 {
		t.Fatalf("code=%d stderr=%q", code, stderr)
	}
	for _, want := range []string{"src/screens/Login.tsx", "tests/flows.spec.ts", "package.json"} {
		if !strings.Contains(stdout, want) {
			t.Errorf("stdout does not list %s:\n%s", want, stdout)
		}
		if _, err := os.Stat(filepath.Join(out, want)); err != nil {
			t.Errorf("file %s not written", want)
		}
	}

	// Non-empty directory: rejected, unless -force.
	if code, _, stderr = runExportCLI(t, "-json", docFile, "-out", out); code != 2 || !strings.Contains(stderr, "-force") {
		t.Errorf("without -force: code=%d stderr=%q", code, stderr)
	}
	if code, _, stderr = runExportCLI(t, "-json", docFile, "-out", out, "-force"); code != 0 {
		t.Errorf("with -force: code=%d stderr=%q", code, stderr)
	}

	// html and a single flow.
	html := filepath.Join(dir, "html")
	if code, _, stderr = runExportCLI(t, "-json", docFile, "-target", "html", "-flow", "f_purchase", "-out", html); code != 0 {
		t.Fatalf("html: code=%d stderr=%q", code, stderr)
	}
	if _, err := os.Stat(filepath.Join(html, "index.html")); err != nil {
		t.Error("html: index.html not written")
	}

	// Input errors.
	for name, args := range map[string][]string{
		"target": {"-json", docFile, "-target", "vue", "-out", filepath.Join(dir, "x1")},
		"flow":   {"-json", docFile, "-flow", "nope", "-out", filepath.Join(dir, "x2")},
		"file":   {"-json", filepath.Join(dir, "missing.json"), "-out", filepath.Join(dir, "x3")},
		"empty":  {"-workspace", t.TempDir()},
		"option": {"-dunno"},
	} {
		if code, _, _ := runExportCLI(t, args...); code != 2 {
			t.Errorf("%s: code=%d, want 2", name, code)
		}
	}
}

// From the workspace, offline, like `opendesigner flow`: by id or name.
func TestExportCLIWorkspace(t *testing.T) {
	ws := t.TempDir()
	seedDoc(t, ws, "doc-ok", "Healthy", false)
	out := filepath.Join(t.TempDir(), "app")
	code, stdout, stderr := runExportCLI(t, "-workspace", ws, "-doc", "Healthy", "-target", "html", "-out", out)
	if code != 0 {
		t.Fatalf("code=%d stderr=%q", code, stderr)
	}
	if !strings.Contains(stdout, "index.html") || !strings.Contains(stdout, "login.html") {
		t.Errorf("stdout:\n%s", stdout)
	}
}
