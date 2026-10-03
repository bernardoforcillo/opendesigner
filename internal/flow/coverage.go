package flow

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Limiti della scansione del repository.
const maxScanFileSize = 1 << 20 // oltre 1 MiB un file non è codice scritto a mano

// skipDirs: cartelle mai scansionate (dipendenze, build, codice generato).
var skipDirs = map[string]bool{
	"node_modules": true, ".git": true, "dist": true, "vendor": true, "gen": true,
}

// sourceExts: le estensioni considerate codice sorgente.
var sourceExts = map[string]bool{
	".go": true, ".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true,
	".vue": true, ".svelte": true, ".astro": true, ".html": true, ".py": true, ".rb": true,
	".java": true, ".kt": true, ".swift": true, ".dart": true, ".php": true, ".rs": true, ".cs": true,
}

// flowAnnotation riconosce `flow:<id>` nei commenti dei test.
var flowAnnotation = regexp.MustCompile(`flow:([A-Za-z0-9_.\-]+)`)

// ScreenCoverage è lo stato di una schermata di un flusso.
type ScreenCoverage struct {
	NodeID    string `json:"nodeId"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Route     string `json:"route,omitempty"`
	Component string `json:"component,omitempty"`
	// Status: planned | implemented | tested. "implemented" se lo dichiara il
	// meta `status` o se rotta/componente compaiono nel codice; "tested" solo
	// dal meta `status`.
	Status string `json:"status"`
	// Source dice perché è implementata: "meta", "code" o vuoto.
	Source string   `json:"source,omitempty"`
	Files  []string `json:"files,omitempty"`
}

// Implemented: la schermata esiste nel codice (o è dichiarata tale).
func (s ScreenCoverage) Implemented() bool {
	return s.Status == StatusImplemented || s.Status == StatusTested
}

// TransitionCoverage è lo stato di una transizione: testata se un file del
// repository la annota con `flow:<id>`.
type TransitionCoverage struct {
	ID     string   `json:"id"`
	FlowID string   `json:"flowId"`
	From   string   `json:"from"`
	To     string   `json:"to"`
	Label  string   `json:"label,omitempty"`
	Tested bool     `json:"tested"`
	Files  []string `json:"files,omitempty"`
}

// FlowCoverage raggruppa la coverage di un flusso.
type FlowCoverage struct {
	FlowID             string               `json:"flowId"`
	Name               string               `json:"name"`
	Screens            []ScreenCoverage     `json:"screens"`
	Transitions        []TransitionCoverage `json:"transitions"`
	ScreensImplemented int                  `json:"screensImplemented"`
	ScreensTotal       int                  `json:"screensTotal"`
	TransitionsTested  int                  `json:"transitionsTested"`
	TransitionsTotal   int                  `json:"transitionsTotal"`
	Percent            float64              `json:"percent"`
}

// Totals somma i flussi contando una volta sola le schermate condivise.
type Totals struct {
	ScreensImplemented int     `json:"screensImplemented"`
	ScreensTotal       int     `json:"screensTotal"`
	TransitionsTested  int     `json:"transitionsTested"`
	TransitionsTotal   int     `json:"transitionsTotal"`
	ScreensPercent     float64 `json:"screensPercent"`
	TransitionsPercent float64 `json:"transitionsPercent"`
	// Percent: (schermate implementate + transizioni testate) / (schermate +
	// transizioni). 100 se non c'è nulla da coprire.
	Percent float64 `json:"percent"`
}

// CoverageReport è il risultato di Coverage, serializzabile in JSON.
type CoverageReport struct {
	DocID   string         `json:"docId"`
	DocName string         `json:"docName"`
	Flows   []FlowCoverage `json:"flows"`
	Totals  Totals         `json:"totals"`
}

func pct(n, total int) float64 {
	if total == 0 {
		return 100
	}
	return float64(int(float64(n)*1000/float64(total)+0.5)) / 10
}

type screenPattern struct {
	id        string
	route     string
	component *regexp.Regexp
}

// Coverage confronta il grafo con il codice in repoDir.
//
//   - transizione testata: un file sorgente (test compresi, anche generati) contiene
//     `flow:<id>`;
//   - schermata implementata: la sua `code.route` o `code.component` compare in un
//     file sorgente NON generato e non di test; oppure `status` la dichiara
//     implemented/tested (override manuale).
//
// Salta node_modules, .git, dist, vendor, gen, i file binari e quelli oltre 1 MiB.
func Coverage(doc *opendesignerv1.Document, flowID, repoDir string) (*CoverageReport, error) {
	if repoDir == "" {
		return nil, errors.New("coverage: repoDir mancante")
	}
	if st, err := os.Stat(repoDir); err != nil {
		return nil, fmt.Errorf("coverage: %w", err)
	} else if !st.IsDir() {
		return nil, fmt.Errorf("coverage: %s non è una cartella", repoDir)
	}

	ids := flowIDs(doc, flowID)
	graphs := make([]*graph, len(ids))
	screenSet := map[string]bool{}
	transSet := map[string]bool{}
	for i, id := range ids {
		graphs[i] = buildGraph(doc, id)
		for _, s := range graphs[i].screens {
			screenSet[s] = true
		}
		for _, t := range graphs[i].trans {
			transSet[t.GetId()] = true
		}
	}

	// Pattern da cercare, uno per schermata (deduplicati fra flussi).
	var patterns []screenPattern
	for _, s := range sortedKeys(screenSet) {
		p := screenPattern{id: s, route: nodeMeta(doc, s, MetaRoute)}
		if c := nodeMeta(doc, s, MetaComponent); c != "" {
			p.component = regexp.MustCompile(`\b` + regexp.QuoteMeta(c) + `\b`)
		}
		if p.route != "" || p.component != nil {
			patterns = append(patterns, p)
		}
	}
	screenFiles := map[string][]string{}
	transFiles := map[string][]string{}

	err := filepath.WalkDir(repoDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if path != repoDir && skipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if !sourceExts[strings.ToLower(filepath.Ext(d.Name()))] {
			return nil
		}
		info, err := d.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() > maxScanFileSize {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil || isBinary(data) {
			return nil
		}
		rel, err := filepath.Rel(repoDir, path)
		if err != nil {
			rel = path
		}
		rel = filepath.ToSlash(rel)

		for _, m := range flowAnnotation.FindAllSubmatch(data, -1) {
			id := strings.TrimRight(string(m[1]), ".")
			if transSet[id] {
				transFiles[id] = appendUnique(transFiles[id], rel)
			}
		}
		if isGenerated(data) || isTestFile(d.Name()) {
			return nil
		}
		text := string(data)
		for _, p := range patterns {
			if (p.route != "" && containsRoute(text, p.route)) || (p.component != nil && p.component.MatchString(text)) {
				screenFiles[p.id] = appendUnique(screenFiles[p.id], rel)
			}
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("coverage: %w", err)
	}

	rep := &CoverageReport{DocID: doc.GetId(), DocName: doc.GetName()}
	for i, id := range ids {
		g := graphs[i]
		fc := FlowCoverage{FlowID: id, Name: g.flow.GetName()}
		for _, s := range g.screens {
			sc := ScreenCoverage{
				NodeID: s, Name: nodeName(doc, s), Kind: nodeKind(doc, s),
				Route: nodeMeta(doc, s, MetaRoute), Component: nodeMeta(doc, s, MetaComponent),
				Status: StatusPlanned, Files: sortedCopy(screenFiles[s]),
			}
			switch declared := nodeStatus(doc, s); {
			case declared == StatusTested:
				sc.Status, sc.Source = StatusTested, "meta"
			case declared == StatusImplemented:
				sc.Status, sc.Source = StatusImplemented, "meta"
			case len(sc.Files) > 0:
				sc.Status, sc.Source = StatusImplemented, "code"
			}
			if sc.Implemented() {
				fc.ScreensImplemented++
			}
			fc.Screens = append(fc.Screens, sc)
		}
		for _, t := range g.trans {
			tc := TransitionCoverage{
				ID: t.GetId(), FlowID: id, From: nodeName(doc, t.GetFromId()), To: nodeName(doc, t.GetToId()),
				Label: t.GetLabel(), Files: sortedCopy(transFiles[t.GetId()]),
			}
			tc.Tested = len(tc.Files) > 0
			if tc.Tested {
				fc.TransitionsTested++
			}
			fc.Transitions = append(fc.Transitions, tc)
		}
		fc.ScreensTotal, fc.TransitionsTotal = len(fc.Screens), len(fc.Transitions)
		fc.Percent = pct(fc.ScreensImplemented+fc.TransitionsTested, fc.ScreensTotal+fc.TransitionsTotal)
		rep.Flows = append(rep.Flows, fc)
	}

	// Totali: schermate uniche fra i flussi (stesso nodo in più flussi = una volta).
	seen := map[string]bool{}
	for _, fc := range rep.Flows {
		for _, s := range fc.Screens {
			if seen[s.NodeID] {
				continue
			}
			seen[s.NodeID] = true
			rep.Totals.ScreensTotal++
			if s.Implemented() {
				rep.Totals.ScreensImplemented++
			}
		}
		rep.Totals.TransitionsTotal += fc.TransitionsTotal
		rep.Totals.TransitionsTested += fc.TransitionsTested
	}
	t := &rep.Totals
	t.ScreensPercent = pct(t.ScreensImplemented, t.ScreensTotal)
	t.TransitionsPercent = pct(t.TransitionsTested, t.TransitionsTotal)
	t.Percent = pct(t.ScreensImplemented+t.TransitionsTested, t.ScreensTotal+t.TransitionsTotal)
	return rep, nil
}

// containsRoute: la rotta compare nel testo. Una rotta di un solo carattere
// ("/") sarebbe ovunque, quindi in quel caso si accetta solo come stringa
// quotata.
func containsRoute(text, route string) bool {
	if len(route) > 1 {
		return strings.Contains(text, route)
	}
	for _, q := range []string{`"`, `'`, "`"} {
		if strings.Contains(text, q+route+q) {
			return true
		}
	}
	return false
}

func isBinary(data []byte) bool {
	n := len(data)
	if n > 8000 {
		n = 8000
	}
	return bytes.IndexByte(data[:n], 0) >= 0
}

func isGenerated(data []byte) bool {
	head := data
	if len(head) > 1024 {
		head = head[:1024]
	}
	s := string(head)
	return strings.Contains(s, "Code generated") || strings.Contains(s, "DO NOT EDIT") || strings.Contains(s, GeneratedMarker)
}

func isTestFile(name string) bool {
	return strings.Contains(name, ".spec.") || strings.Contains(name, ".test.") || strings.HasSuffix(name, "_test.go")
}

func appendUnique(list []string, s string) []string {
	for _, x := range list {
		if x == s {
			return list
		}
	}
	return append(list, s)
}

func sortedCopy(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	out := append([]string(nil), in...)
	sort.Strings(out)
	return out
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Markdown rende il report per le persone (o per una PR).
func (r *CoverageReport) Markdown() string {
	var b strings.Builder
	title := r.DocName
	if title == "" {
		title = r.DocID
	}
	fmt.Fprintf(&b, "# Coverage dei flussi — %s\n\n", oneLine(title))
	t := r.Totals
	fmt.Fprintf(&b, "**Totale: %.1f%%** — schermate implementate %d/%d (%.1f%%), transizioni testate %d/%d (%.1f%%)\n",
		t.Percent, t.ScreensImplemented, t.ScreensTotal, t.ScreensPercent, t.TransitionsTested, t.TransitionsTotal, t.TransitionsPercent)
	for _, f := range r.Flows {
		name := f.Name
		if name == "" {
			name = f.FlowID
		}
		fmt.Fprintf(&b, "\n## Flusso: %s (`%s`) — %.1f%%\n\n", oneLine(name), f.FlowID, f.Percent)
		b.WriteString("| Schermata | Stato | Rotta | Componente | File |\n|---|---|---|---|---|\n")
		for _, s := range f.Screens {
			fmt.Fprintf(&b, "| %s | %s | %s | %s | %s |\n", cell(s.Name), s.Status, codeCell(s.Route), codeCell(s.Component), filesCell(s.Files, s.Source))
		}
		b.WriteString("\n| Transizione | Testata | File |\n|---|---|---|\n")
		for _, tr := range f.Transitions {
			mark := "no"
			if tr.Tested {
				mark = "sì"
			}
			fmt.Fprintf(&b, "| `%s` %s → %s%s | %s | %s |\n", tr.ID, cell(tr.From), cell(tr.To), labelSuffix(tr.Label), mark, filesCell(tr.Files, ""))
		}
	}
	return b.String()
}

func labelSuffix(l string) string {
	if l == "" {
		return ""
	}
	return " (" + cell(l) + ")"
}

func filesCell(files []string, source string) string {
	if len(files) == 0 {
		if source == "meta" {
			return "(dichiarato in `status`)"
		}
		return "—"
	}
	shown := files
	more := ""
	if len(shown) > 3 {
		more = fmt.Sprintf(" +%d", len(shown)-3)
		shown = shown[:3]
	}
	parts := make([]string, len(shown))
	for i, f := range shown {
		parts[i] = "`" + strings.ReplaceAll(f, "|", `\|`) + "`"
	}
	return strings.Join(parts, ", ") + more
}
