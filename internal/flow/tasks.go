package flow

import (
	"fmt"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Tasks produce una checklist Markdown delle lacune, pronta da incollare in un
// issue tracker o da consegnare a un agente: schermate da implementare,
// transizioni da testare e problemi del grafo. cov può essere nil: allora
// compaiono solo i problemi dell'analisi. flowID "" = tutti i flussi.
func Tasks(doc *opendesignerv1.Document, flowID string, cov *CoverageReport) string {
	var b strings.Builder
	title := doc.GetName()
	if title == "" {
		title = doc.GetId()
	}
	fmt.Fprintf(&b, "# Attività dai flussi — %s\n", oneLine(title))

	ids := flowIDs(doc, flowID)
	if len(ids) == 0 {
		b.WriteString("\n_Nessun flusso da lavorare._\n")
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
				lines = append(lines, "- [ ] Implementare la schermata **"+oneLine(s.Name)+"**"+screenHint(s))
			}
			byID := map[string]*opendesignerv1.Transition{}
			for _, t := range g.trans {
				byID[t.GetId()] = t
			}
			for _, tc := range fc.Transitions {
				if tc.Tested {
					continue
				}
				lines = append(lines, fmt.Sprintf("- [ ] Testare la transizione %s: scrivere un test e2e che la percorre e annotarlo con `// flow:%s`",
					transitionLine(doc, byID[tc.ID]), tc.ID))
			}
		}
		for _, is := range rep.GetIssues() {
			lines = append(lines, fmt.Sprintf("- [ ] Correggere il grafo (`%s`): %s", is.GetKind(), is.GetMessage()))
		}
		fmt.Fprintf(&b, "\n## Flusso: %s (`%s`)\n\n", oneLine(name), id)
		if len(lines) == 0 {
			b.WriteString("Nessuna attività: tutto coperto.\n")
			continue
		}
		total += len(lines)
		b.WriteString(strings.Join(lines, "\n") + "\n")
	}
	if total > 0 {
		fmt.Fprintf(&b, "\nTotale attività aperte: %d\n", total)
	}
	return b.String()
}

func screenHint(s ScreenCoverage) string {
	var parts []string
	if s.Route != "" {
		parts = append(parts, "rotta `"+s.Route+"`")
	}
	if s.Component != "" {
		parts = append(parts, "componente `"+s.Component+"`")
	}
	if len(parts) == 0 {
		return " (manca `code.route`/`code.component` nel disegno)"
	}
	return " — " + strings.Join(parts, ", ")
}
