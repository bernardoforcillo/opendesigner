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

func runSyncCLI(t *testing.T, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	var o, e bytes.Buffer
	code = runSync(args, &o, &e)
	return code, o.String(), e.String()
}

// A screen mapped to its exported file is in sync (exit 0); after a hand edit it drifts (exit 1).
func TestSyncCLI(t *testing.T) {
	doc := samples.Shop()
	found := false
	for _, n := range doc.GetNodes() {
		if n.GetName() == "Login" {
			found = true
			n.Meta = map[string]string{"code.file": "src/screens/Login.tsx"}
		}
	}
	if !found {
		t.Fatal("Shop has no Login screen")
	}
	b, err := protojson.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	docFile := filepath.Join(dir, "shop.json")
	if err := os.WriteFile(docFile, b, 0o644); err != nil {
		t.Fatal(err)
	}
	app := filepath.Join(dir, "app")
	if code, _, stderr := runExportCLI(t, "-json", docFile, "-out", app); code != 0 {
		t.Fatalf("export: %d %s", code, stderr)
	}

	code, stdout, stderr := runSyncCLI(t, "-json", docFile, "-dir", app)
	if code != 0 || !strings.Contains(stdout, "in-sync") || !strings.Contains(stdout, "1 mapped, 0 not in sync") {
		t.Fatalf("in sync: code=%d stdout=%q stderr=%q", code, stdout, stderr)
	}

	file := filepath.Join(app, "src/screens/Login.tsx")
	src, _ := os.ReadFile(file)
	if err := os.WriteFile(file, append(src, []byte("// hand edit\n")...), 0o644); err != nil {
		t.Fatal(err)
	}
	code, stdout, _ = runSyncCLI(t, "-json", docFile, "-dir", app)
	if code != 1 || !strings.Contains(stdout, "drifted") {
		t.Errorf("drift: code=%d stdout=%q", code, stdout)
	}
	code, stdout, _ = runSyncCLI(t, "-json", docFile, "-dir", app, "-format", "json")
	if code != 1 || !strings.Contains(stdout, `"drift": 1`) {
		t.Errorf("json: code=%d stdout=%q", code, stdout)
	}

	if code, _, stderr = runSyncCLI(t, "-json", docFile, "-target", "vue"); code != 2 || !strings.Contains(stderr, "vue") {
		t.Errorf("bad target: %d %q", code, stderr)
	}
	if code, _, _ = runSyncCLI(t, "-json", filepath.Join(dir, "nope.json")); code != 2 {
		t.Errorf("missing document: %d", code)
	}
}
