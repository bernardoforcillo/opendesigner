package flow

import (
	"fmt"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Tasks produces a Markdown checklist of the gaps, ready to paste into an
// issue tracker or to hand to an agent: screens to implement,
// transitions to test and graph issues. cov may be nil: then
// only the analysis issues appear. flowID "" = all flows.
func Tasks(doc *opendesignerv1.Document, flowID string, cov *CoverageReport) string {
	var b strings.Builder
	title := doc.GetName()
	if title == "" {
		title = doc.GetId()
	}
	fmt.Fprintf(&b, "# Tasks from the flows — %s\n", oneLine(title))

	ids := flowIDs(doc, flowID)
	if len(ids) == 0 {
		b.WriteString("\n_No flow to work on._\n")
		return b.String()
	}
	covByFlow := map[string]*FlowCoverage{}
	if cov != nil {
		for i := range cov.Flows {
			covByFlow[cov.Flows[i].FlowID] = &cov.Flows[i]
		}
	}
	total := 0
	for _, id := range ids {
		g := buildGraph(doc, id)
		rep := analyzeFlow(g, id)
		name := g.flow.GetName()
		if name == "" {
			name = id
		}
		var lines []string
		if fc := covByFlow[id]; fc != nil {
			for _, s := range fc.Screens {
				if s.Implemented() || s.Kind == "note" {
					continue
				}
				lines = append(lines, "- [ ] Implement the screen **"+oneLine(s.Name)+"**"+screenHint(s))
			}
			byID := map[string]*opendesignerv1.Transition{}
			for _, t := range g.trans {
				byID[t.GetId()] = t
			}
			for _, tc := range fc.Transitions {
				if tc.Tested {
					continue
				}
				lines = append(lines, fmt.Sprintf("- [ ] Test the transition %s: write an e2e test that walks it and annotate it with `// flow:%s`",
					transitionLine(doc, byID[tc.ID]), tc.ID))
			}
		}
		for _, is := range rep.GetIssues() {
			lines = append(lines, fmt.Sprintf("- [ ] Fix the graph (`%s`): %s", is.GetKind(), is.GetMessage()))
		}
		fmt.Fprintf(&b, "\n## Flow: %s (`%s`)\n\n", oneLine(name), id)
		if len(lines) == 0 {
			b.WriteString("No tasks: everything covered.\n")
			continue
		}
		total += len(lines)
		b.WriteString(strings.Join(lines, "\n") + "\n")
	}
	if total > 0 {
		fmt.Fprintf(&b, "\nTotal open tasks: %d\n", total)
	}
	return b.String()
}

func screenHint(s ScreenCoverage) string {
	var parts []string
	if s.Route != "" {
		parts = append(parts, "route `"+s.Route+"`")
	}
	if s.Component != "" {
		parts = append(parts, "component `"+s.Component+"`")
	}
	if len(parts) == 0 {
		return " (`code.route`/`code.component` missing in the design)"
	}
	return " — " + strings.Join(parts, ", ")
}
