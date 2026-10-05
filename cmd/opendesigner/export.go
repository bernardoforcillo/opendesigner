package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
	"github.com/bernardoforcillo/opendesigner/internal/store"
	"google.golang.org/protobuf/encoding/protojson"
)

const exportUsage = `usage: opendesigner export [options]

Exports the design as code (React + Tailwind or HTML), with the flows
wired and the Playwright tests of the paths.

options:
  -workspace DIR   documents directory (default: same as 'serve')
  -doc ID|NAME     document, by id or exact name (may be omitted if it is the only one)
  -json FILE       instead of the workspace: a Document in protojson
  -assets DIR      with -json: assets directory (files named after the hash)
  -target react|html   what to generate (default react)
  -out DIR         destination directory (default ./export)
  -flow ID         wire (and test) a single flow (default: all)
  -force           allow a non-empty destination directory
`

// runExport runs `opendesigner export ...` and returns the exit code.
// Like `flow`, it opens the document OFFLINE (read-only): it works in CI and in
// repositories, where the document is a file.
func runExport(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("export", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { fmt.Fprint(stderr, exportUsage) }
	workspace := fs.String("workspace", defaultWorkspace(), "documents workspace dir")
	docRef := fs.String("doc", "", "document id or exact name")
	jsonFile := fs.String("json", "", "protojson Document file (instead of the workspace)")
	assetsDir := fs.String("assets", "", "with -json: assets directory")
	target := fs.String("target", "react", "react or html")
	out := fs.String("out", "export", "output directory")
	flowID := fs.String("flow", "", "flow id (default: all)")
	force := fs.Bool("force", false, "allow a non-empty output directory")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	var (
		doc    *opendesignerv1.Document
		assets codegen.AssetSource
		err    error
	)
	if *jsonFile != "" {
		doc, err = loadJSONDocument(*jsonFile)
		if err == nil && *assetsDir != "" {
			assets = codegen.DirAssets(*assetsDir)
		}
	} else {
		doc, err = openOffline(*workspace, *docRef)
		if err == nil {
			assets = store.NewAssets(*workspace, doc.GetId())
		}
	}
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}

	res, err := codegen.Generate(doc, codegen.Options{Target: codegen.Target(*target), FlowID: *flowID}, assets)
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}
	written, err := codegen.WriteFiles(res, *out, *force)
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}
	for _, w := range res.Warnings {
		fmt.Fprintln(stderr, "warning:", w)
	}
	fmt.Fprintf(stdout, "%d files written to %s:\n", len(written), *out)
	for _, p := range written {
		fmt.Fprintln(stdout, "  "+p)
	}
	return 0
}

func loadJSONDocument(path string) (*opendesignerv1.Document, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	doc := &opendesignerv1.Document{}
	if err := (protojson.UnmarshalOptions{DiscardUnknown: false}).Unmarshal(b, doc); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return doc, nil
}
