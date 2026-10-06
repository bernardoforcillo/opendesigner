package mcp_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestExportCodeTool: the agent draws two screens and a flow, exports, and
// finds on disk the project with the wired button and the generated tests.
func TestExportCodeTool(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	login, home := frame(t, s, "Login"), frame(t, s, "Home")
	btn := frame(t, s, "Button")
	if _, err := s.SetNodeMeta(ctx, odmcp.SetNodeMetaInput{Id: btn, Meta: map[string]string{"test.id": "go-home"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ReparentNode(ctx, odmcp.ReparentNodeInput{Id: btn, NewParentId: login}); err != nil {
		t.Fatal(err)
	}
	fl, err := s.CreateFlow(ctx, odmcp.CreateFlowInput{Name: "Access", StartId: login})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetTransition(ctx, odmcp.SetTransitionInput{FlowId: fl.FlowId, FromId: login, ToId: home, Label: ptr("Enter"), ElementId: ptr(btn)}); err != nil {
		t.Fatal(err)
	}

	dir := filepath.Join(t.TempDir(), "app")
	out, err := s.ExportCode(ctx, odmcp.ExportCodeInput{OutDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if out.Target != "react" || len(out.Files) == 0 {
		t.Fatalf("out = %+v", out)
	}
	for _, p := range []string{"package.json", "src/App.tsx", "src/screens/Login.tsx", "src/screens/Home.tsx", "tests/flows.spec.ts"} {
		if _, err := os.Stat(filepath.Join(dir, p)); err != nil {
			t.Errorf("file %s not written: %v", p, err)
		}
	}
	login1, _ := os.ReadFile(filepath.Join(dir, "src/screens/Login.tsx"))
	if !strings.Contains(string(login1), `data-testid="go-home"`) || !strings.Contains(string(login1), `navigate("/home")`) {
		t.Errorf("Login.tsx without the wiring:\n%s", login1)
	}

	// A non-empty directory is rejected; with force it is overwritten.
	if _, err := s.ExportCode(ctx, odmcp.ExportCodeInput{OutDir: dir}); err == nil {
		t.Error("non-empty directory accepted without force")
	}
	if _, err := s.ExportCode(ctx, odmcp.ExportCodeInput{OutDir: dir, Force: true, Target: "html"}); err != nil {
		t.Errorf("html con force: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "index.html")); err != nil {
		t.Errorf("html: index.html missing: %v", err)
	}
	// Clear errors.
	if _, err := s.ExportCode(ctx, odmcp.ExportCodeInput{}); err == nil {
		t.Error("empty outDir accepted")
	}
	if _, err := s.ExportCode(ctx, odmcp.ExportCodeInput{OutDir: t.TempDir(), Target: "vue"}); err == nil || !strings.Contains(err.Error(), "vue") {
		t.Errorf("unknown target: %v", err)
	}
}
