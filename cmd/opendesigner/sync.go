package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
	"github.com/bernardoforcillo/opendesigner/internal/codesync"
	"github.com/bernardoforcillo/opendesigner/internal/store"
)

const syncUsage = `usage: opendesigner sync [options]

Reports drift between the design and the code that implements it. Components and screens are mapped to
files with the node meta "code.file" (the MCP tool map_component_code, or set_node_meta); the design is
exported in memory and compared with each mapped file. Exit status: 0 in sync, 1 drift, 2 error.

options:
  -workspace DIR   documents directory (default: same as 'serve')
  -doc ID|NAME     document, by id or exact name (may be omitted if it is the only one)
  -json FILE       instead of the workspace: a Document in protojson
  -assets DIR      with -json: assets directory (files named after the hash)
  -dir DIR         the code project root the mapped files are relative to (default .)
  -target react|html   what the design is exported as for the comparison (default react)
  -format text|json    output (default text)
`

// runSync runs `opendesigner sync ...` and returns the exit code. Read-only, like export and flow:
// recording a baseline (accept_code_sync) writes the document, so it is an MCP / editor action.
func runSync(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("sync", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { fmt.Fprint(stderr, syncUsage) }
	workspace := fs.String("workspace", defaultWorkspace(), "documents workspace dir")
	docRef := fs.String("doc", "", "document id or exact name")
	jsonFile := fs.String("json", "", "protojson Document file (instead of the workspace)")
	assetsDir := fs.String("assets", "", "with -json: assets directory")
	dir := fs.String("dir", ".", "code project root")
	target := fs.String("target", "react", "react or html")
	format := fs.String("format", "text", "text or json")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *target != string(codegen.TargetReact) && *target != string(codegen.TargetHTML) {
		fmt.Fprintf(stderr, "error: -target must be react or html, not %q\n", *target)
		return 2
	}
	if *format != "text" && *format != "json" {
		fmt.Fprintf(stderr, "error: -format must be text or json, not %q\n", *format)
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
	res, err := codegen.Generate(doc, codegen.Options{Target: codegen.Target(*target)}, assets)
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}
	rep := codesync.Check(doc, res.Files, codesync.DirReader(*dir))

	if *format == "json" {
		b, _ := json.MarshalIndent(map[string]any{"drift": rep.Drift(), "entries": rep.Entries, "unmapped": rep.Unmapped}, "", "  ")
		fmt.Fprintln(stdout, string(b))
	} else {
		for _, e := range rep.Entries {
			fmt.Fprintf(stdout, "%-15s %s (%s) -> %s\n", e.Status, e.Name, e.NodeID, e.File)
			if e.Detail != "" {
				fmt.Fprintf(stdout, "                %s\n", e.Detail)
			}
		}
		for _, u := range rep.Unmapped {
			fmt.Fprintf(stdout, "%-15s %s (%s) exports as %s\n", "unmapped", u.Name, u.NodeID, u.ExportedPath)
		}
		fmt.Fprintf(stdout, "%d mapped, %d not in sync, %d unmapped\n", len(rep.Entries), rep.Drift(), len(rep.Unmapped))
	}
	if rep.Drift() > 0 {
		return 1
	}
	return 0
}
