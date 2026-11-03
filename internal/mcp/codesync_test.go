package mcp_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestCodeSyncTools: an agent maps a screen to a file, exports it, edits the design and the code in
// turn, and check_code_sync names which side moved; accept_code_sync sets the baseline.
func TestCodeSyncTools(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	home := frame(t, s, "Home")
	dir := filepath.Join(t.TempDir(), "app")
	if _, err := s.ExportCode(ctx, odmcp.ExportCodeInput{OutDir: dir}); err != nil {
		t.Fatal(err)
	}

	for _, bad := range []string{"../x.tsx", "/etc/passwd"} {
		if _, err := s.MapComponentCode(ctx, odmcp.MapComponentCodeInput{NodeId: home, File: bad}); err == nil {
			t.Errorf("%q accepted", bad)
		}
	}
	if _, err := s.MapComponentCode(ctx, odmcp.MapComponentCodeInput{NodeId: "ghost", File: "a.tsx"}); err == nil {
		t.Error("unknown node accepted")
	}
	if _, err := s.MapComponentCode(ctx, odmcp.MapComponentCodeInput{NodeId: home, File: "src/screens/Home.tsx"}); err != nil {
		t.Fatal(err)
	}

	check := func() odmcp.CheckCodeSyncOutput {
		t.Helper()
		out, err := s.CheckCodeSync(ctx, odmcp.CheckCodeSyncInput{Dir: dir})
		if err != nil || len(out.Entries) != 1 {
			t.Fatalf("check = %+v %v", out, err)
		}
		return out
	}
	if out := check(); out.Drift != 0 || out.Entries[0].Status != "in-sync" {
		t.Fatalf("fresh export: %+v", out)
	}

	// The code is edited by hand: no baseline yet, so "drifted".
	file := filepath.Join(dir, "src/screens/Home.tsx")
	orig, _ := os.ReadFile(file)
	if err := os.WriteFile(file, append(append([]byte{}, orig...), []byte("// tweak\n")...), 0o644); err != nil {
		t.Fatal(err)
	}
	if out := check(); out.Drift != 1 || out.Entries[0].Status != "drifted" {
		t.Fatalf("hand edit: %+v", out)
	}
	// Accept the export as the baseline: now the same edit reads as code-changed.
	acc, err := s.AcceptCodeSync(ctx, odmcp.AcceptCodeSyncInput{Dir: dir})
	if err != nil || len(acc.Accepted) != 1 {
		t.Fatalf("accept = %+v %v", acc, err)
	}
	if out := check(); out.Entries[0].Status != "code-changed" {
		t.Fatalf("after accept: %+v", out)
	}
	// Restore the code; then the design moves.
	if err := os.WriteFile(file, orig, 0o644); err != nil {
		t.Fatal(err)
	}
	if out := check(); out.Drift != 0 {
		t.Fatalf("restored: %+v", out)
	}
	if _, err := s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: home, Width: ptr(240.0)}); err != nil {
		t.Fatal(err)
	}
	if out := check(); out.Entries[0].Status != "design-changed" {
		t.Fatalf("design edit: %+v", out)
	}

	// Errors, and unmapping.
	if _, err := s.CheckCodeSync(ctx, odmcp.CheckCodeSyncInput{}); err == nil {
		t.Error("empty dir accepted")
	}
	if _, err := s.CheckCodeSync(ctx, odmcp.CheckCodeSyncInput{Dir: dir, Target: "swiftui"}); err == nil {
		t.Error("swiftui accepted")
	}
	if _, err := s.AcceptCodeSync(ctx, odmcp.AcceptCodeSyncInput{Dir: dir, NodeIds: []string{"ghost"}}); err == nil {
		t.Error("unknown node accepted")
	}
	if _, err := s.MapComponentCode(ctx, odmcp.MapComponentCodeInput{NodeId: home}); err != nil {
		t.Fatal(err)
	}
	if out, err := s.CheckCodeSync(ctx, odmcp.CheckCodeSyncInput{Dir: dir}); err != nil || len(out.Entries) != 0 {
		t.Errorf("unmapped: %+v %v", out, err)
	}
}
