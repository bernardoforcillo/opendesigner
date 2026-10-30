package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bernardoforcillo/opendesigner/internal/pipeline"
)

// fakeRunner stands in for npm/npx: it records the commands and answers the
// Playwright call with a canned JSON report.
type fakeRunner struct {
	calls      []string
	installErr bool
	report     string
	exit       int
}

func (f *fakeRunner) Run(_ context.Context, _ string, name string, args ...string) ([]byte, int, error) {
	f.calls = append(f.calls, name+" "+strings.Join(args, " "))
	if name == "npm" && f.installErr {
		return []byte("ERR! offline"), 1, nil
	}
	if len(args) > 0 && args[0] == "playwright" && len(args) > 1 && args[1] == "test" {
		return []byte(f.report), f.exit, nil
	}
	return nil, 0, nil
}

const pwReport = `npm warn noise
{"suites":[{"title":"flows.spec.ts","suites":[{"title":"Flow: Access","specs":[
 {"title":"path 1: Home → Login → End","tests":[{"status":"expected","results":[{}]}]},
 {"title":"path 2: broken","tests":[{"status":"unexpected","results":[{"error":{"message":"expected /x\nreceived /y"}}]}]},
 {"title":"path 3: todo","tests":[{"status":"skipped","results":[]}]}
]}]}]}`

func runPipelineCLI(t *testing.T, r pipeline.Runner, args ...string) (int, string, string) {
	t.Helper()
	old := pipelineRunner
	pipelineRunner = r
	t.Cleanup(func() { pipelineRunner = old })
	var o, e bytes.Buffer
	code := runPipeline(args, &o, &e)
	return code, o.String(), e.String()
}

func TestPipelineReportsPerFlow(t *testing.T) {
	ws := t.TempDir()
	seedDoc(t, ws, "doc1", "Shop", false)
	out := filepath.Join(t.TempDir(), "app")
	fr := &fakeRunner{report: pwReport, exit: 1}

	code, stdout, stderr := runPipelineCLI(t, fr, "-workspace", ws, "-out", out, "-format", "json")
	if code != 1 {
		t.Fatalf("code=%d stderr=%q out=%s", code, stderr, stdout)
	}
	var rep pipeline.Report
	if err := json.Unmarshal([]byte(stdout), &rep); err != nil {
		t.Fatal(err)
	}
	if rep.OK || len(rep.Flows) != 1 {
		t.Fatalf("report = %+v", rep)
	}
	f := rep.Flows[0]
	if f.Name != "Access" || f.Status != "failed" || f.Passed != 1 || f.Failed != 1 || f.Skipped != 1 {
		t.Errorf("flow = %+v", f)
	}
	if !strings.Contains(f.Tests[1].Error, "received /y") {
		t.Errorf("error lost: %+v", f.Tests[1])
	}
	var names []string
	for _, s := range rep.Stages {
		names = append(names, s.Name+":"+s.Status)
	}
	if got := strings.Join(names, ","); got != "prototype:passed,codegen:passed,install:passed,playwright:failed" {
		t.Errorf("stages = %s", got)
	}
	want := []string{"npm install", "npx playwright install chromium", "npx playwright test --reporter=json"}
	if strings.Join(fr.calls, "|") != strings.Join(want, "|") {
		t.Errorf("calls = %v", fr.calls)
	}
	if _, err := os.Stat(filepath.Join(out, "tests", "flows.spec.ts")); err != nil {
		t.Errorf("project not written: %v", err)
	}
}

func TestPipelineGreenMarkdown(t *testing.T) {
	ws := t.TempDir()
	seedDoc(t, ws, "doc1", "Shop", false)
	green := `{"suites":[{"title":"Flow: Access","specs":[{"title":"p","tests":[{"status":"expected","results":[{}]}]}]}]}`
	fr := &fakeRunner{report: green}
	code, out, _ := runPipelineCLI(t, fr, "-workspace", ws, "-out", filepath.Join(t.TempDir(), "a"), "-skip-install")
	if code != 0 || !strings.Contains(out, "# Pipeline: OK") || !strings.Contains(out, "- Access: passed (1 passed") {
		t.Fatalf("code=%d out=%s", code, out)
	}
	if len(fr.calls) != 1 {
		t.Errorf("skip-install still ran %v", fr.calls)
	}
}

func TestPipelineInstallFailureStopsChain(t *testing.T) {
	ws := t.TempDir()
	seedDoc(t, ws, "doc1", "Shop", false)
	fr := &fakeRunner{installErr: true}
	code, out, _ := runPipelineCLI(t, fr, "-workspace", ws, "-out", filepath.Join(t.TempDir(), "a"))
	if code != 1 || !strings.Contains(out, "install: failed") || !strings.Contains(out, "playwright: skipped") || !strings.Contains(out, "offline") {
		t.Fatalf("code=%d out=%s", code, out)
	}
	if len(fr.calls) != 1 {
		t.Errorf("chain continued: %v", fr.calls)
	}
}

func TestPipelineNoTestsAndErrors(t *testing.T) {
	ws := t.TempDir()
	seedDoc(t, ws, "doc1", "Shop", false)
	fr := &fakeRunner{}
	code, out, _ := runPipelineCLI(t, fr, "-workspace", ws, "-out", filepath.Join(t.TempDir(), "a"), "-no-tests")
	if code != 0 || len(fr.calls) != 0 || !strings.Contains(out, "codegen: passed") {
		t.Fatalf("no-tests: code=%d calls=%v out=%s", code, fr.calls, out)
	}
	if code, _, errOut := runPipelineCLI(t, fr, "-workspace", ws, "-flow", "nope"); code != 2 || !strings.Contains(errOut, "not found") {
		t.Errorf("unknown flow: code=%d err=%q", code, errOut)
	}
	if code, _, _ := runPipelineCLI(t, fr, "-workspace", ws, "-format", "xml"); code != 2 {
		t.Errorf("bad format accepted")
	}
}
