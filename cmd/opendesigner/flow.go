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

const flowUsage = `uso: opendesigner flow <spec|tests|coverage|check|tasks> [opzioni]

  spec      specifica Markdown dei flussi (per persone e agenti)
  tests     test e2e Playwright (TypeScript) generati dai percorsi
  coverage  schermate implementate e transizioni testate nel repository
  check     problemi del grafo; esce con 1 se ce ne sono (gate per la CI)
  tasks     checklist delle lacune, da incollare in un issue tracker

opzioni:
  -workspace DIR   cartella dei documenti (default: come 'serve')
  -doc ID|NOME     documento, per id o nome esatto (si può omettere se è l'unico)
  -flow ID         un solo flusso (default: tutti)
  -repo DIR        repository da scansionare per coverage/tasks (default: .)
  -out FILE        scrive su file invece che su stdout
  -format md|json  formato di coverage e check (default md)
  -min PCT         coverage: esce con 1 se il totale è sotto PCT
`

// runFlow esegue `opendesigner flow ...` e ritorna il codice d'uscita. Apre il
// documento OFFLINE dal workspace (sola lettura, nessun server necessario):
// per questo serve in CI, dove il documento è un file nel repository.
func runFlow(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 || args[0] == "-h" || args[0] == "-help" || args[0] == "--help" {
		fmt.Fprint(stderr, flowUsage)
		return 2
	}
	sub, args := args[0], args[1:]
	switch sub {
	case "spec", "tests", "coverage", "check", "tasks":
	default:
		fmt.Fprintf(stderr, "sottocomando sconosciuto %q\n\n%s", sub, flowUsage)
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
		fmt.Fprintf(stderr, "-format deve essere md o json, non %q\n", *format)
		return 2
	}

	doc, err := openOffline(*workspace, *docRef)
	if err != nil {
		fmt.Fprintln(stderr, "errore:", err)
		return 2
	}
	if *flowID != "" {
		if _, ok := doc.GetFlows()[*flowID]; !ok {
			fmt.Fprintf(stderr, "errore: il flusso %q non esiste nel documento %q\n", *flowID, doc.GetName())
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
			fmt.Fprintf(stderr, "coverage %.1f%% sotto la soglia %.1f%%\n", cov.Totals.Percent, *min)
			code = 1
		}
	case "check":
		reports := flow.Analyze(doc, *flowID)
		text, code = renderCheck(doc, reports, *format)
	}
	if err != nil {
		fmt.Fprintln(stderr, "errore:", err)
		return 2
	}

	if *out != "" {
		if err := os.WriteFile(*out, []byte(text), 0o644); err != nil {
			fmt.Fprintln(stderr, "errore:", err)
			return 2
		}
		fmt.Fprintf(stderr, "scritto %s\n", *out)
		return code
	}
	fmt.Fprint(stdout, text)
	return code
}

// renderCheck stampa i problemi dei report e ritorna 1 se ce n'è almeno uno.
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
		fmt.Fprintf(&b, "OK: %d flussi senza problemi\n", len(reports))
	} else {
		fmt.Fprintf(&b, "\n%d problemi in %d flussi\n", total, len(reports))
	}
	return b.String(), code
}

// openOffline risolve -doc (id o nome esatto) nel workspace e ne ricostruisce lo
// stato da snapshot e oplog, senza modificare nulla. Senza -doc va bene solo se
// il workspace ha un unico documento.
func openOffline(workspace, ref string) (*opendesignerv1.Document, error) {
	metas, err := store.Scan(workspace)
	if err != nil {
		return nil, err
	}
	if len(metas) == 0 {
		return nil, fmt.Errorf("nessun documento nel workspace %s", workspace)
	}
	var matches []store.Meta
	switch {
	case ref == "" && len(metas) == 1:
		matches = metas
	case ref == "":
		return nil, errors.New("più documenti nel workspace: indica -doc\n" + listMetas(metas))
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
		return nil, fmt.Errorf("documento %q non trovato (cerco per id o nome esatto)\n%s", ref, listMetas(metas))
	case 1:
	default:
		return nil, fmt.Errorf("il nome %q è ambiguo, usa l'id\n%s", ref, listMetas(matches))
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
