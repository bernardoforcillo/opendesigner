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

const exportUsage = `uso: opendesigner export [opzioni]

Esporta il design come codice (React + Tailwind oppure HTML), con i flussi
cablati e i test Playwright dei percorsi.

opzioni:
  -workspace DIR   cartella dei documenti (default: come 'serve')
  -doc ID|NOME     documento, per id o nome esatto (si può omettere se è l'unico)
  -json FILE       invece del workspace: un Document in protojson
  -assets DIR      con -json: cartella degli asset (file chiamati come l'hash)
  -target react|html   cosa generare (default react)
  -out DIR         cartella di destinazione (default ./export)
  -flow ID         cabla (e testa) un solo flusso (default: tutti)
  -force           ammette una cartella di destinazione non vuota
`

// runExport esegue `opendesigner export ...` e ritorna il codice d'uscita.
// Come `flow`, apre il documento OFFLINE (sola lettura): serve in CI e nei
// repository, dove il documento è un file.
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
		fmt.Fprintln(stderr, "errore:", err)
		return 2
	}

	res, err := codegen.Generate(doc, codegen.Options{Target: codegen.Target(*target), FlowID: *flowID}, assets)
	if err != nil {
		fmt.Fprintln(stderr, "errore:", err)
		return 2
	}
	written, err := codegen.WriteFiles(res, *out, *force)
	if err != nil {
		fmt.Fprintln(stderr, "errore:", err)
		return 2
	}
	for _, w := range res.Warnings {
		fmt.Fprintln(stderr, "attenzione:", w)
	}
	fmt.Fprintf(stdout, "%d file scritti in %s:\n", len(written), *out)
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
