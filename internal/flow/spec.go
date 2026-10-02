package flow

import (
	"fmt"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Spec produce la specifica Markdown dei flussi (flowID "" = tutti), pensata per
// essere letta da persone e consegnata a un agente AI come requisito: per ogni
// flusso titolo e descrizione, tabella delle schermate, transizioni numerate,
// percorsi come scenari Given/When/Then e problemi dell'analisi.
// L'output è stabile: stesso documento, stessi byte.
func Spec(doc *opendesignerv1.Document, flowID string) string {
	var b strings.Builder
	title := doc.GetName()
	if title == "" {
		title = doc.GetId()
	}
	fmt.Fprintf(&b, "# Specifica dei flussi — %s\n", oneLine(title))
	ids := flowIDs(doc, flowID)
	if len(ids) == 0 {
		if flowID != "" {
			fmt.Fprintf(&b, "\n_Flusso `%s` non trovato nel documento._\n", flowID)
		} else {
			b.WriteString("\n_Nessun flusso definito nel documento._\n")
		}
		return b.String()
	}
	for _, id := range ids {
		g := buildGraph(doc, id)
		rep := analyzeFlow(g, id)
		writeFlowSpec(&b, g, rep)
	}
	return b.String()
}

func writeFlowSpec(b *strings.Builder, g *graph, rep *opendesignerv1.FlowReport) {
	f := g.flow
	name := f.GetName()
	if name == "" {
		name = f.GetId()
	}
	fmt.Fprintf(b, "\n## Flusso: %s (`%s`)\n", oneLine(name), f.GetId())
	if d := strings.TrimSpace(f.GetDescription()); d != "" {
		fmt.Fprintf(b, "\n%s\n", d)
	}
	if s := f.GetStartId(); s != "" {
		fmt.Fprintf(b, "\nSchermata iniziale: **%s**\n", oneLine(nodeName(g.doc, s)))
	}

	b.WriteString("\n### Schermate\n\n")
	if len(g.screens) == 0 {
		b.WriteString("_Nessuna schermata._\n")
	} else {
		b.WriteString("| Nome | Tipo | Rotta | Componente | Stato |\n|---|---|---|---|---|\n")
		for _, s := range g.screens {
			fmt.Fprintf(b, "| %s | %s | %s | %s | %s |\n",
				cell(nodeName(g.doc, s)), nodeKind(g.doc, s),
				codeCell(nodeMeta(g.doc, s, MetaRoute)), codeCell(nodeMeta(g.doc, s, MetaComponent)),
				nodeStatus(g.doc, s))
		}
	}

	b.WriteString("\n### Transizioni\n\n")
	if len(g.trans) == 0 {
		b.WriteString("_Nessuna transizione._\n")
	}
	for i, t := range g.trans {
		fmt.Fprintf(b, "%d. %s", i+1, transitionLine(g.doc, t))
		var extra []string
		if t.GetGuard() != "" {
			extra = append(extra, "guard: "+oneLine(t.GetGuard()))
		}
		if t.GetEffect() != "" {
			extra = append(extra, "effect: "+oneLine(t.GetEffect()))
		}
		if len(extra) > 0 {
			fmt.Fprintf(b, " (%s)", strings.Join(extra, "; "))
		}
		fmt.Fprintf(b, " `flow:%s`\n", t.GetId())
	}

	b.WriteString("\n### Scenari\n\n")
	if len(rep.GetPaths()) == 0 {
		b.WriteString("_Nessun percorso: manca la schermata iniziale o le transizioni._\n")
	}
	byID := map[string]*opendesignerv1.Transition{}
	for _, t := range g.trans {
		byID[t.GetId()] = t
	}
	for i, p := range rep.GetPaths() {
		writeScenario(b, g, byID, i+1, p)
	}
	if rep.GetPathsTruncated() {
		fmt.Fprintf(b, "_Elenco troncato: oltre %d percorsi o profondità %d._\n\n", MaxPaths, MaxDepth)
	}

	b.WriteString("### Problemi\n\n")
	if len(rep.GetIssues()) == 0 {
		b.WriteString("Nessun problema rilevato.\n")
	}
	for _, is := range rep.GetIssues() {
		fmt.Fprintf(b, "- `%s` — %s\n", is.GetKind(), is.GetMessage())
	}
}

func writeScenario(b *strings.Builder, g *graph, byID map[string]*opendesignerv1.Transition, n int, p *opendesignerv1.FlowPath) {
	names := make([]string, len(p.GetNodeIds()))
	for i, id := range p.GetNodeIds() {
		names[i] = nodeName(g.doc, id)
	}
	suffix := ""
	if p.GetLoops() {
		suffix = " (si chiude in un ciclo)"
	}
	fmt.Fprintf(b, "#### Scenario %d: %s%s\n\n", n, oneLine(strings.Join(names, " → ")), suffix)
	fmt.Fprintf(b, "- **Given** l'utente è sulla schermata %s\n", screenRef(g.doc, p.GetNodeIds()[0]))
	for i, tid := range p.GetTransitionIds() {
		t := byID[tid]
		fmt.Fprintf(b, "- **When** %s", actionText(g.doc, t))
		if t.GetGuard() != "" {
			fmt.Fprintf(b, " (se %s)", oneLine(t.GetGuard()))
		}
		b.WriteString("\n")
		fmt.Fprintf(b, "- **Then** vede la schermata %s", screenRef(g.doc, p.GetNodeIds()[i+1]))
		if t.GetEffect() != "" {
			fmt.Fprintf(b, " e: %s", oneLine(t.GetEffect()))
		}
		b.WriteString("\n")
	}
	b.WriteString("\n")
}

func screenRef(doc *opendesignerv1.Document, id string) string {
	s := "**" + oneLine(nodeName(doc, id)) + "**"
	if r := nodeMeta(doc, id, MetaRoute); r != "" {
		s += " (`" + r + "`)"
	}
	return s
}

// transitionLine: `from --[trigger: label]--> to`.
func transitionLine(doc *opendesignerv1.Document, t *opendesignerv1.Transition) string {
	trig := t.GetTrigger()
	if trig == "" {
		trig = "click"
	}
	arrow := trig
	if t.GetLabel() != "" {
		arrow += ": " + oneLine(t.GetLabel())
	}
	return fmt.Sprintf("**%s** --[%s]--> **%s**",
		oneLine(nodeName(doc, t.GetFromId())), arrow, oneLine(nodeName(doc, t.GetToId())))
}

// actionText: la frase "When" di una transizione.
func actionText(doc *opendesignerv1.Document, t *opendesignerv1.Transition) string {
	lab := ""
	if t.GetLabel() != "" {
		lab = fmt.Sprintf(" %q", t.GetLabel())
	}
	el := ""
	if e := t.GetElementId(); e != "" {
		el = fmt.Sprintf(" (elemento **%s**)", oneLine(nodeName(doc, e)))
	}
	switch trig := t.GetTrigger(); trig {
	case "", "click":
		return "l'utente fa click su" + lab + el
	case "submit":
		return "l'utente invia" + lab + el
	case "key":
		return "l'utente preme" + lab + el
	case "auto":
		return "il sistema passa automaticamente oltre" + lab
	case "back":
		return "l'utente torna indietro"
	default:
		return fmt.Sprintf("l'utente esegue %q%s%s", trig, lab, el)
	}
}

func oneLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// cell rende sicuro un testo per una cella di tabella Markdown.
func cell(s string) string {
	return strings.ReplaceAll(oneLine(s), "|", `\|`)
}

func codeCell(s string) string {
	if s == "" {
		return "—"
	}
	return "`" + strings.ReplaceAll(oneLine(s), "|", `\|`) + "`"
}
