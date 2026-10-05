package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/flow"
	"github.com/bernardoforcillo/opendesigner/internal/store"
	"google.golang.org/protobuf/encoding/protojson"
)

const flowUsage = `usage: opendesigner flow <spec|tests|coverage|check|tasks> [options]

  spec      Markdown specification of the flows (for people and agents)
  tests     Playwright e2e tests (TypeScript) generated from the paths
  coverage  implemented screens and tested transitions in the repository
  check     graph problems; exits with 1 if there are any (CI gate)
  tasks     checklist of the gaps, to paste into an issue tracker

options:
  -workspace DIR   documents directory (default: same as 'serve')
  -doc ID|NAME     document, by id or exact name (may be omitted if it is the only one)
  -flow ID         a single flow (default: all)
  -repo DIR        repository to scan for coverage/tasks (default: .)
  -out FILE        write to a file instead of stdout
  -format md|json  coverage and check format (default md)
  -min PCT         coverage: exit with 1 if the total is below PCT
`

// runFlow runs `opendesigner flow ...` and returns the exit code. It opens the
// document OFFLINE from the workspace (read-only, no server needed):
// that is why it works in CI, where the document is a file in the repository.
func runFlow(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "-h" || args[0] == "-help" || args[0] == "--help" {
		fmt.Fprint(stderr, flowUsage)
		return 2
	}
	sub, args := args[0], args[1:]
	switch sub {
	case "spec", "tests", "coverage", "check", "tasks":
	default:
		fmt.Fprintf(stderr, "unknown subcommand %q\n\n%s", sub, flowUsage)
		return 2
	}

	fs := flag.NewFlagSet("flow "+sub, flag.ContinueOnError)
	fs.SetOutput(stderr)
	workspace := fs.String("workspace", defaultWorkspace(), "documents workspace dir")
	docRef := fs.String("doc", "", "document id or exact name")
	flowID := fs.String("flow", "", "flow id (default: all)")
	repo := fs.String("repo", ".", "repository to scan")
	out := fs.String("out", "", "write to this file instead of stdout")
	format := fs.String("format", "md", "md or json")
	min := fs.Float64("min", 0, "coverage: minimum total percentage")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *format != "md" && *format != "json" {
		fmt.Fprintf(stderr, "-format must be md or json, not %q\n", *format)
		return 2
	}

	doc, err := openOffline(*workspace, *docRef)
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}
	if *flowID != "" {
		if _, ok := doc.GetFlows()[*flowID]; !ok {
			fmt.Fprintf(stderr, "error: flow %q does not exist in document %q\n", *flowID, doc.GetName())
			return 2
		}
	}

	var text string
	code := 0
	switch sub {
	case "spec":
		text = flow.Spec(doc, *flowID)
	case "tests":
		text, err = flow.PlaywrightTests(doc, *flowID, flow.PlaywrightOptions{})
	case "tasks":
		var cov *flow.CoverageReport
		if cov, err = flow.Coverage(doc, *flowID, *repo); err == nil {
			text = flow.Tasks(doc, *flowID, cov)
		}
	case "coverage":
		var cov *flow.CoverageReport
		if cov, err = flow.Coverage(doc, *flowID, *repo); err != nil {
			break
		}
		if *format == "json" {
			var b []byte
			b, err = json.MarshalIndent(cov, "", "  ")
			text = string(b) + "\n"
		} else {
			text = cov.Markdown()
		}
		if err == nil && *min > 0 && cov.Totals.Percent < *min {
			fmt.Fprintf(stderr, "coverage %.1f%% below the threshold %.1f%%\n", cov.Totals.Percent, *min)
			code = 1
		}
	case "check":
		reports := flow.Analyze(doc, *flowID)
		text, code = renderCheck(doc, reports, *format)
	}
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}

	if *out != "" {
		if err := os.WriteFile(*out, []byte(text), 0o644); err != nil {
			fmt.Fprintln(stderr, "error:", err)
			return 2
		}
		fmt.Fprintf(stderr, "wrote %s\n", *out)
		return code
	}
	fmt.Fprint(stdout, text)
	return code
}

// renderCheck prints the reports' problems and returns 1 if there is at least one.
func renderCheck(doc *opendesignerv1.Document, reports []*opendesignerv1.FlowReport, format string) (string, int) {
	total := 0
	for _, r := range reports {
		total += len(r.GetIssues())
	}
	code := 0
	if total > 0 {
		code = 1
	}
	if format == "json" {
		resp := &opendesignerv1.AnalyzeFlowsResponse{Reports: reports}
		b, _ := protojson.MarshalOptions{Multiline: true, Indent: "  "}.Marshal(resp)
		return string(b) + "\n", code
	}
	var b strings.Builder
	for _, r := range reports {
		name := doc.GetFlows()[r.GetFlowId()].GetName()
		if name == "" {
			name = r.GetFlowId()
		}
		for _, is := range r.GetIssues() {
			fmt.Fprintf(&b, "[%s] %s: %s\n", is.GetKind(), name, is.GetMessage())
		}
	}
	if total == 0 {
		fmt.Fprintf(&b, "OK: %d flows without problems\n", len(reports))
	} else {
		fmt.Fprintf(&b, "\n%d problems in %d flows\n", total, len(reports))
	}
	return b.String(), code
}

// openOffline resolves -doc (id or exact name) in the workspace and rebuilds its
// state from snapshot and oplog, without modifying anything. Without -doc it
// only works if the workspace has a single document.
func openOffline(workspace, ref string) (*opendesignerv1.Document, error) {
	metas, err := store.Scan(workspace)
	if err != nil {
		return nil, err
	}
	if len(metas) == 0 {
		return nil, fmt.Errorf("no documents in workspace %s", workspace)
	}
	var matches []store.Meta
	switch {
	case ref == "" && len(metas) == 1:
		matches = metas
	case ref == "":
		return nil, errors.New("multiple documents in the workspace: specify -doc\n" + listMetas(metas))
	default:
		for _, m := range metas {
			if m.ID == ref {
				matches = []store.Meta{m}
				break
			}
		}
		if matches == nil {
			for _, m := range metas {
				if m.Name == ref {
					matches = append(matches, m)
				}
			}
		}
	}
	switch len(matches) {
	case 0:
		return nil, fmt.Errorf("document %q not found (searching by id or exact name)\n%s", ref, listMetas(metas))
	case 1:
	default:
		return nil, fmt.Errorf("the name %q is ambiguous, use the id\n%s", ref, listMetas(matches))
	}
	doc, _, err := store.LoadReadOnly(workspace, matches[0].ID)
	return doc, err
}

func listMetas(metas []store.Meta) string {
	var b strings.Builder
	for _, m := range metas {
		fmt.Fprintf(&b, "  %s  %q\n", m.ID, m.Name)
	}
	return strings.TrimRight(b.String(), "\n")
}
