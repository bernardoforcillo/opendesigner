package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"

	"github.com/bernardoforcillo/opendesigner/internal/pipeline"
	"github.com/bernardoforcillo/opendesigner/internal/store"
)

const pipelineUsage = `usage: opendesigner pipeline [options]

Runs prototype -> codegen -> Playwright end to end: analyses the flows, exports the
react project, installs it and runs the Playwright tests generated from the flows,
then reports the result per flow. Exit code: 0 all green, 1 a stage or a test failed,
2 bad usage. Needs node/npm (and network on the first run) unless -skip-install.

options:
  -workspace DIR   documents directory (default: same as 'serve')
  -doc ID|NAME     document, by id or exact name (may be omitted if it is the only one)
  -flow ID         a single flow (default: all)
  -out DIR         where to write the project (default: a temporary directory)
  -force           allow a non-empty -out
  -skip-install    node_modules and the Playwright browser are already there
  -no-tests        stop after codegen (write the project only)
  -format md|json  report format (default md)
`

// pipelineRunner runs npm/npx; tests replace it.
var pipelineRunner pipeline.Runner = pipeline.ExecRunner{}

// runPipeline runs `opendesigner pipeline ...` and returns the exit code.
func runPipeline(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("pipeline", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { fmt.Fprint(stderr, pipelineUsage) }
	workspace := fs.String("workspace", defaultWorkspace(), "documents workspace dir")
	docRef := fs.String("doc", "", "document id or exact name")
	flowID := fs.String("flow", "", "flow id (default: all)")
	out := fs.String("out", "", "project output directory")
	force := fs.Bool("force", false, "allow a non-empty output directory")
	skipInstall := fs.Bool("skip-install", false, "do not run npm install / playwright install")
	noTests := fs.Bool("no-tests", false, "stop after codegen")
	format := fs.String("format", "md", "md or json")
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
	rep, err := pipeline.Run(context.Background(), doc, store.NewAssets(*workspace, doc.GetId()), pipeline.Options{
		FlowID: *flowID, OutDir: *out, Force: *force, SkipInstall: *skipInstall, SkipTests: *noTests, Runner: pipelineRunner,
	})
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}
	if *format == "json" {
		b, _ := json.MarshalIndent(rep, "", "  ")
		fmt.Fprintln(stdout, string(b))
	} else {
		fmt.Fprint(stdout, rep.Markdown())
	}
	if !rep.OK {
		return 1
	}
	return 0
}
