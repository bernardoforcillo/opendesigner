package mcp_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestRunPipelineTool: with noTests the tool prototypes the flows and writes the
// project, reporting one result per flow (no node or browser is needed).
func TestRunPipelineTool(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	// A document without flows is refused with a hint.
	if _, err := s.RunPipeline(ctx, odmcp.RunPipelineInput{NoTests: true}); err == nil {
		t.Fatal("pipeline ran on a document without flows")
	}

	login, home := frame(t, s, "Login"), frame(t, s, "Home")
	fl, err := s.CreateFlow(ctx, odmcp.CreateFlowInput{Name: "Access", StartId: login})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetTransition(ctx, odmcp.SetTransitionInput{FlowId: fl.FlowId, FromId: login, ToId: home, Label: ptr("Enter")}); err != nil {
		t.Fatal(err)
	}

	dir := filepath.Join(t.TempDir(), "app")
	rep, err := s.RunPipeline(ctx, odmcp.RunPipelineInput{OutDir: dir, NoTests: true})
	if err != nil {
		t.Fatal(err)
	}
	if !rep.OK || len(rep.Flows) != 1 || rep.Flows[0].Name != "Access" || rep.Flows[0].Status != "skipped" {
		t.Fatalf("report = %+v", rep)
	}
	if _, err := os.Stat(filepath.Join(dir, "tests", "flows.spec.ts")); err != nil {
		t.Errorf("project not written: %v", err)
	}
	if _, err := s.RunPipeline(ctx, odmcp.RunPipelineInput{OutDir: dir, NoTests: true}); err != nil {
		t.Fatal(err) // codegen failure is a report, not a tool error
	}
}
