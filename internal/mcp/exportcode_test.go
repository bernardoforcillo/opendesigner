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
	// The native targets: same document, Swift / Kotlin sources.
	swiftDir := filepath.Join(t.TempDir(), "ios")
	if out, err := s.ExportCode(ctx, odmcp.ExportCodeInput{OutDir: swiftDir, Target: "swiftui"}); err != nil || out.Target != "swiftui" {
		t.Fatalf("swiftui: %+v %v", out, err)
	}
	loginSwift, err := os.ReadFile(filepath.Join(swiftDir, "Sources/Screens/Login.swift"))
	if err != nil || !strings.Contains(string(loginSwift), "router.go(.home)") {
		t.Errorf("Login.swift without the wiring (%v):\n%s", err, loginSwift)
	}
	ktDir := filepath.Join(t.TempDir(), "android")
	if _, err := s.ExportCode(ctx, odmcp.ExportCodeInput{OutDir: ktDir, Target: "compose"}); err != nil {
		t.Fatalf("compose: %v", err)
	}
	loginKt, err := os.ReadFile(filepath.Join(ktDir, "app/src/main/kotlin/design/generated/screens/Login.kt"))
	if err != nil || !strings.Contains(string(loginKt), `onNavigate("Home")`) {
		t.Errorf("Login.kt without the wiring (%v):\n%s", err, loginKt)
	}
	rsDir := filepath.Join(t.TempDir(), "leptos")
	if out, err := s.ExportCode(ctx, odmcp.ExportCodeInput{OutDir: rsDir, Target: "leptos"}); err != nil || out.Target != "leptos" {
		t.Fatalf("leptos: %+v %v", out, err)
	}
	loginRs, err := os.ReadFile(filepath.Join(rsDir, "src/screens/login.rs"))
	if err != nil || !strings.Contains(string(loginRs), `navigate("/home"`) {
		t.Errorf("login.rs without the wiring (%v):\n%s", err, loginRs)
	}
	// Clear errors.
	if _, err := s.ExportCode(ctx, odmcp.ExportCodeInput{}); err == nil {
		t.Error("empty outDir accepted")
	}
	if _, err := s.ExportCode(ctx, odmcp.ExportCodeInput{OutDir: t.TempDir(), Target: "vue"}); err == nil || !strings.Contains(err.Error(), "vue") {
		t.Errorf("unknown target: %v", err)
	}
}
