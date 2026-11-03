// Package pipeline runs the whole design-to-tested-app chain in one go:
// prototype (the flow graph is analysed) -> codegen (the react project is
// written) -> install -> Playwright (the tests generated from the flows run
// against the app), and reports a result per flow.
//
// The external commands (npm, npx) go through the Runner interface so the chain
// can be tested without a network or a browser.
package pipeline

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
	"github.com/bernardoforcillo/opendesigner/internal/flow"
)

// Stage and result statuses.
const (
	StatusPassed  = "passed"
	StatusFailed  = "failed"
	StatusSkipped = "skipped"
)

// Runner runs an external command in dir and returns its stdout. A non-zero
// exit is NOT an error (Playwright exits 1 when a test fails and still prints
// the report): it is returned as exitCode; err is for "could not run".
type Runner interface {
	Run(ctx context.Context, dir, name string, args ...string) (stdout []byte, exitCode int, err error)
}

// ExecRunner runs real processes.
type ExecRunner struct{}

func (ExecRunner) Run(ctx context.Context, dir, name string, args ...string) ([]byte, int, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		// Keep the tail of stderr next to stdout: it is where npm explains itself.
		return append(out, tail(stderr.String(), 2000)...), ee.ExitCode(), nil
	}
	return out, 0, err
}

// Options configures Run.
type Options struct {
	FlowID string // "" = all flows
	OutDir string // where the project is written; "" = a fresh temp directory
	Force  bool   // allow a non-empty OutDir
	// SkipInstall assumes node_modules (and the Playwright browser) are already there.
	SkipInstall bool
	// SkipTests stops after codegen: useful to produce the project only.
	SkipTests bool
	Runner    Runner // nil = ExecRunner
	// Project, if set, is the already generated react project (the MCP tool gets it
	// from the server, which owns the assets): codegen is not run again.
	Project *codegen.Output
}

// Stage is one step of the chain.
type Stage struct {
	Name   string `json:"name"` // prototype, codegen, install, playwright
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
}

// TestResult is one generated test (one path of a flow).
type TestResult struct {
	Title  string `json:"title"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

// FlowResult is the outcome of one flow.
type FlowResult struct {
	FlowID string `json:"flowId"`
	Name   string `json:"name"`
	Status string `json:"status"` // failed if any test failed, passed if any passed, else skipped
	Issues int    `json:"issues"` // problems `flow check` reports for this flow
	Passed int    `json:"passed"`
	Failed int    `json:"failed"`
	// Skipped counts tests that did not run (test.fixme: the flow lacks a route or locator).
	Skipped int          `json:"skipped"`
	Tests   []TestResult `json:"tests,omitempty"`
}

// Report is the pipeline's result.
type Report struct {
	OutDir   string       `json:"outDir"`
	Stages   []Stage      `json:"stages"`
	Flows    []FlowResult `json:"flows"`
	Warnings []string     `json:"warnings,omitempty"`
	// OK: every stage that ran succeeded and no flow failed.
	OK bool `json:"ok"`
}

// Run executes the chain for doc. A failing stage stops the chain (later stages
// are reported skipped). The error return is only for problems that prevent a
// report (bad input); failures of the chain itself are in the Report.
func Run(ctx context.Context, doc *opendesignerv1.Document, assets codegen.AssetSource, opts Options) (*Report, error) {
	if len(doc.GetFlows()) == 0 {
		return nil, errors.New("the document has no flows: draw a flow before running the pipeline")
	}
	if opts.FlowID != "" {
		if _, ok := doc.GetFlows()[opts.FlowID]; !ok {
			return nil, fmt.Errorf("flow %q not found in the document", opts.FlowID)
		}
	}
	rep := &Report{OutDir: opts.OutDir}
	if rep.OutDir == "" {
		d, err := os.MkdirTemp("", "opendesigner-pipeline-*")
		if err != nil {
			return nil, err
		}
		rep.OutDir = d
	}

	// 1. prototype: analyse the graph. Issues are reported, they do not block:
	// `flow check` is the gate; here the point is to see what the tests say.
	issues := map[string]int{}
	total := 0
	for _, r := range flow.Analyze(doc, opts.FlowID) {
		issues[r.GetFlowId()] = len(r.GetIssues())
		total += len(r.GetIssues())
	}
	rep.Stages = append(rep.Stages, Stage{Name: "prototype", Status: StatusPassed, Detail: fmt.Sprintf("%d flow problems", total)})
	skipRest := func(from int) {
		for _, n := range []string{"codegen", "install", "playwright"}[from:] {
			rep.Stages = append(rep.Stages, Stage{Name: n, Status: StatusSkipped})
		}
	}
	finish := func() (*Report, error) {
		rep.Flows = flowResults(doc, opts.FlowID, issues, nil)
		return rep, nil
	}

	// 2. codegen
	res, err := opts.Project, error(nil)
	if res == nil {
		res, err = codegen.Generate(doc, codegen.Options{Target: codegen.TargetReact, FlowID: opts.FlowID}, assets)
	}
	if err == nil {
		var written []string
		written, err = codegen.WriteFiles(res, rep.OutDir, opts.Force)
		if err == nil {
			rep.Warnings = res.Warnings
			rep.Stages = append(rep.Stages, Stage{Name: "codegen", Status: StatusPassed, Detail: fmt.Sprintf("%d files written", len(written))})
		}
	}
	if err != nil {
		rep.Stages = append(rep.Stages, Stage{Name: "codegen", Status: StatusFailed, Detail: err.Error()})
		skipRest(1)
		return finish()
	}
	if opts.SkipTests {
		rep.Stages = append(rep.Stages, Stage{Name: "install", Status: StatusSkipped}, Stage{Name: "playwright", Status: StatusSkipped})
		rep.Flows = flowResults(doc, opts.FlowID, issues, nil)
		rep.OK = true
		return rep, nil
	}

	runner := opts.Runner
	if runner == nil {
		runner = ExecRunner{}
	}

	// 3. install
	if opts.SkipInstall {
		rep.Stages = append(rep.Stages, Stage{Name: "install", Status: StatusSkipped, Detail: "skipped by request"})
	} else {
		for _, step := range [][]string{{"npm", "install"}, {"npx", "playwright", "install", "chromium"}} {
			out, code, err := runner.Run(ctx, rep.OutDir, step[0], step[1:]...)
			if err != nil || code != 0 {
				detail := strings.Join(step, " ") + " failed"
				if err != nil {
					detail += ": " + err.Error()
				} else {
					detail += fmt.Sprintf(" (exit %d): %s", code, tail(string(out), 600))
				}
				rep.Stages = append(rep.Stages, Stage{Name: "install", Status: StatusFailed, Detail: detail})
				skipRest(2)
				return finish()
			}
		}
		rep.Stages = append(rep.Stages, Stage{Name: "install", Status: StatusPassed})
	}

	// 4. playwright
	out, code, err := runner.Run(ctx, rep.OutDir, "npx", "playwright", "test", "--reporter=json")
	if err != nil {
		rep.Stages = append(rep.Stages, Stage{Name: "playwright", Status: StatusFailed, Detail: err.Error()})
		return finish()
	}
	tests, perr := ParsePlaywrightJSON(out)
	if perr != nil {
		rep.Stages = append(rep.Stages, Stage{Name: "playwright", Status: StatusFailed,
			Detail: fmt.Sprintf("no readable report (exit %d): %v: %s", code, perr, tail(string(out), 600))})
		return finish()
	}
	rep.Flows = flowResults(doc, opts.FlowID, issues, tests)
	failed := 0
	for _, f := range rep.Flows {
		failed += f.Failed
	}
	st := Stage{Name: "playwright", Status: StatusPassed}
	if failed > 0 || code != 0 {
		st.Status = StatusFailed
		st.Detail = fmt.Sprintf("%d failed tests (exit %d)", failed, code)
	}
	rep.Stages = append(rep.Stages, st)
	rep.OK = st.Status == StatusPassed
	return rep, nil
}

// flowResults builds one result per flow, folding the tests Playwright ran
// (keyed by the describe title "Flow: <name>", which flow.PlaywrightTests writes).
func flowResults(doc *opendesignerv1.Document, flowID string, issues map[string]int, tests map[string][]TestResult) []FlowResult {
	ids := make([]string, 0, len(doc.GetFlows()))
	for id := range doc.GetFlows() {
		if flowID == "" || id == flowID {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	var out []FlowResult
	for _, id := range ids {
		name := doc.GetFlows()[id].GetName()
		if name == "" {
			name = id
		}
		fr := FlowResult{FlowID: id, Name: name, Issues: issues[id], Status: StatusSkipped}
		for _, t := range tests[oneLine("Flow: "+name)] {
			fr.Tests = append(fr.Tests, t)
			switch t.Status {
			case StatusPassed:
				fr.Passed++
			case StatusFailed:
				fr.Failed++
			default:
				fr.Skipped++
			}
		}
		switch {
		case fr.Failed > 0:
			fr.Status = StatusFailed
		case fr.Passed > 0:
			fr.Status = StatusPassed
		}
		out = append(out, fr)
	}
	return out
}

// pwSuite mirrors the part of Playwright's JSON reporter we read.
type pwSuite struct {
	Title  string    `json:"title"`
	Suites []pwSuite `json:"suites"`
	Specs  []struct {
		Title string `json:"title"`
		Tests []struct {
			Status  string `json:"status"` // expected, unexpected, flaky, skipped
			Results []struct {
				Error *struct {
					Message string `json:"message"`
				} `json:"error"`
			} `json:"results"`
		} `json:"tests"`
	} `json:"specs"`
}

// ParsePlaywrightJSON reads `playwright test --reporter=json` output into tests
// grouped by describe title. The report may be preceded by npm noise, so it is
// read from the first '{'.
func ParsePlaywrightJSON(data []byte) (map[string][]TestResult, error) {
	i := strings.IndexByte(string(data), '{')
	if i < 0 {
		return nil, errors.New("no JSON object in the output")
	}
	var root struct {
		Suites []pwSuite `json:"suites"`
	}
	if err := json.NewDecoder(strings.NewReader(string(data[i:]))).Decode(&root); err != nil {
		return nil, err
	}
	out := map[string][]TestResult{}
	var walk func(s pwSuite, group string)
	walk = func(s pwSuite, group string) {
		if strings.HasPrefix(s.Title, "Flow: ") {
			group = s.Title
		}
		for _, sp := range s.Specs {
			for _, t := range sp.Tests {
				tr := TestResult{Title: sp.Title}
				switch t.Status {
				case "expected", "flaky":
					tr.Status = StatusPassed
				case "skipped":
					tr.Status = StatusSkipped
				default:
					tr.Status = StatusFailed
					for _, r := range t.Results {
						if r.Error != nil {
							tr.Error = tail(r.Error.Message, 600)
						}
					}
				}
				out[group] = append(out[group], tr)
			}
		}
		for _, c := range s.Suites {
			walk(c, group)
		}
	}
	for _, s := range root.Suites {
		walk(s, "")
	}
	return out, nil
}

// Markdown renders the report for people and agents.
func (r *Report) Markdown() string {
	var b strings.Builder
	verdict := "OK"
	if !r.OK {
		verdict = "FAILED"
	}
	fmt.Fprintf(&b, "# Pipeline: %s\n\nProject: %s\n\n## Stages\n\n", verdict, r.OutDir)
	for _, s := range r.Stages {
		fmt.Fprintf(&b, "- %s: %s", s.Name, s.Status)
		if s.Detail != "" {
			fmt.Fprintf(&b, " (%s)", oneLine(s.Detail))
		}
		b.WriteString("\n")
	}
	b.WriteString("\n## Flows\n\n")
	for _, f := range r.Flows {
		fmt.Fprintf(&b, "- %s: %s (%d passed, %d failed, %d skipped, %d flow problems)\n", f.Name, f.Status, f.Passed, f.Failed, f.Skipped, f.Issues)
		for _, t := range f.Tests {
			if t.Status == StatusFailed {
				fmt.Fprintf(&b, "  - FAILED %s: %s\n", t.Title, oneLine(t.Error))
			}
		}
	}
	for _, w := range r.Warnings {
		fmt.Fprintf(&b, "\nwarning: %s", w)
	}
	return b.String() + "\n"
}

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return "..." + s[len(s)-n:]
}
