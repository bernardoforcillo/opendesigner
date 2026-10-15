package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/bernardoforcillo/opendesigner/internal/pack"
	"github.com/bernardoforcillo/opendesigner/internal/store"
)

const packUsage = `usage: opendesigner pack [options] DIR
       opendesigner unpack [options] DIR

pack writes a document as a folder of small, stable, readable files (one JSON file per
node, plus document.json and the assets), made to live in git. unpack builds a document
of the workspace back from such a folder.

options:
  -workspace DIR   documents directory (default: same as 'serve')
  -doc ID|NAME     pack: the document, by id or exact name (may be omitted if it is the only one)
  -force           unpack: replace the document if its id already exists in the workspace
`

func runPack(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("pack", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { fmt.Fprint(stderr, packUsage) }
	workspace := fs.String("workspace", defaultWorkspace(), "documents workspace dir")
	docRef := fs.String("doc", "", "document id or exact name")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		fs.Usage()
		return 2
	}
	doc, err := openOffline(*workspace, *docRef)
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}
	assets := filepath.Join(*workspace, doc.GetId()+".opendesigner", "assets")
	if err := pack.Pack(doc, assets, fs.Arg(0)); err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}
	fmt.Fprintf(stdout, "%q packed into %s (%d nodes)\n", doc.GetName(), fs.Arg(0), len(doc.GetNodes()))
	return 0
}

func runUnpack(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("unpack", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { fmt.Fprint(stderr, packUsage) }
	workspace := fs.String("workspace", defaultWorkspace(), "documents workspace dir")
	force := fs.Bool("force", false, "replace a document with the same id")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		fs.Usage()
		return 2
	}
	doc, assets, err := pack.Unpack(fs.Arg(0))
	if err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}
	if store.Exists(*workspace, doc.GetId()) {
		if !*force {
			fmt.Fprintf(stderr, "error: document %s already exists in %s (use -force to replace it)\n", doc.GetId(), *workspace)
			return 2
		}
		if err := store.Trash(*workspace, doc.GetId()); err != nil {
			fmt.Fprintln(stderr, "error:", err)
			return 2
		}
	}
	if err := os.MkdirAll(*workspace, 0o755); err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}
	if err := store.Import(*workspace, doc, assets); err != nil {
		fmt.Fprintln(stderr, "error:", err)
		return 2
	}
	fmt.Fprintf(stdout, "%q unpacked into %s (%d nodes)\n", doc.GetName(), *workspace, len(doc.GetNodes()))
	return 0
}
