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

// Limits of the repository scan.
const maxScanFileSize = 1 << 20 // beyond 1 MiB a file is not hand-written code

// skipDirs: folders never scanned (dependencies, build, generated code).
var skipDirs = map[string]bool{
	"node_modules": true, ".git": true, "dist": true, "vendor": true, "gen": true,
}

// sourceExts: the extensions considered source code.
var sourceExts = map[string]bool{
	".go": true, ".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true,
	".vue": true, ".svelte": true, ".astro": true, ".html": true, ".py": true, ".rb": true,
	".java": true, ".kt": true, ".swift": true, ".dart": true, ".php": true, ".rs": true, ".cs": true,
}

// flowAnnotation recognizes `flow:<id>` in test comments.
var flowAnnotation = regexp.MustCompile(`flow:([A-Za-z0-9_.\-]+)`)

// ScreenCoverage is the status of a screen of a flow.
type ScreenCoverage struct {
	NodeID    string `json:"nodeId"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Route     string `json:"route,omitempty"`
	Component string `json:"component,omitempty"`
	// Status: planned | implemented | tested. "implemented" if declared by the
	// `status` meta or if route/component appear in the code; "tested" only
	// from the `status` meta.
	Status string `json:"status"`
	// Source says why it is implemented: "meta", "code" or empty.
	Source string   `json:"source,omitempty"`
	Files  []string `json:"files,omitempty"`
}

// Implemented: the screen exists in the code (or is declared to).
func (s ScreenCoverage) Implemented() bool {
	return s.Status == StatusImplemented || s.Status == StatusTested
}

// TransitionCoverage is the status of a transition: tested if a file in the
// repository annotates it with `flow:<id>`.
type TransitionCoverage struct {
	ID     string   `json:"id"`
	FlowID string   `json:"flowId"`
	From   string   `json:"from"`
	To     string   `json:"to"`
	Label  string   `json:"label,omitempty"`
	Tested bool     `json:"tested"`
	Files  []string `json:"files,omitempty"`
}

// FlowCoverage groups a flow's coverage.
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

// Totals sums the flows, counting shared screens only once.
type Totals struct {
	ScreensImplemented int     `json:"screensImplemented"`
	ScreensTotal       int     `json:"screensTotal"`
	TransitionsTested  int     `json:"transitionsTested"`
	TransitionsTotal   int     `json:"transitionsTotal"`
	ScreensPercent     float64 `json:"screensPercent"`
	TransitionsPercent float64 `json:"transitionsPercent"`
	// Percent: (implemented screens + tested transitions) / (screens +
	// transitions). 100 if there is nothing to cover.
	Percent float64 `json:"percent"`
}

// CoverageReport is the result of Coverage, serializable to JSON.
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

// Coverage compares the graph with the code in repoDir.
//
//   - tested transition: a source file (tests included, even generated) contains
//     `flow:<id>`;
//   - implemented screen: its `code.route` or `code.component` appears in a
//     source file that is NOT generated and not a test; or `status` declares it
//     implemented/tested (manual override).
//
// It skips node_modules, .git, dist, vendor, gen, binary files and those over 1 MiB.
func Coverage(doc *opendesignerv1.Document, flowID, repoDir string) (*CoverageReport, error) {
	if repoDir == "" {
		return nil, errors.New("coverage: repoDir missing")
	}
	if st, err := os.Stat(repoDir); err != nil {
		return nil, fmt.Errorf("coverage: %w", err)
	} else if !st.IsDir() {
		return nil, fmt.Errorf("coverage: %s is not a directory", repoDir)
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

	// Patterns to search for, one per screen (deduplicated across flows).
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

	// Totals: unique screens across flows (same node in several flows = once).
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

// containsRoute: the route appears in the text. A one-character route
// ("/") would be everywhere, so in that case it is only accepted as a
// quoted string.
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

// Markdown renders the report for people (or for a PR).
func (r *CoverageReport) Markdown() string {
	var b strings.Builder
	title := r.DocName
	if title == "" {
		title = r.DocID
	}
	fmt.Fprintf(&b, "# Flow coverage — %s\n\n", oneLine(title))
	t := r.Totals
	fmt.Fprintf(&b, "**Total: %.1f%%** — screens implemented %d/%d (%.1f%%), transitions tested %d/%d (%.1f%%)\n",
		t.Percent, t.ScreensImplemented, t.ScreensTotal, t.ScreensPercent, t.TransitionsTested, t.TransitionsTotal, t.TransitionsPercent)
	for _, f := range r.Flows {
		name := f.Name
		if name == "" {
			name = f.FlowID
		}
		fmt.Fprintf(&b, "\n## Flow: %s (`%s`) — %.1f%%\n\n", oneLine(name), f.FlowID, f.Percent)
		b.WriteString("| Screen | Status | Route | Component | File |\n|---|---|---|---|---|\n")
		for _, s := range f.Screens {
			fmt.Fprintf(&b, "| %s | %s | %s | %s | %s |\n", cell(s.Name), s.Status, codeCell(s.Route), codeCell(s.Component), filesCell(s.Files, s.Source))
		}
		b.WriteString("\n| Transition | Tested | File |\n|---|---|---|\n")
		for _, tr := range f.Transitions {
			mark := "no"
			if tr.Tested {
				mark = "yes"
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
			return "(declared in `status`)"
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
