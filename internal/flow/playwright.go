package flow

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// GeneratedMarker compare nell'intestazione dei file generati: Coverage lo usa
// per non contare un test generato (che cita rotte e componenti) come
// implementazione delle schermate.
const GeneratedMarker = "File generato da opendesigner"

// PlaywrightOptions regola la generazione.
type PlaywrightOptions struct {
	// BaseURL, se non vuoto, precede le rotte in `page.goto`. Di norma resta
	// vuoto e si configura `use.baseURL` in playwright.config.
	BaseURL string
}

// PlaywrightTests genera un file TypeScript per `@playwright/test` con un
// `test()` per ogni percorso dei flussi (flowID "" = tutti). Ogni transizione è
// preceduta da `// flow:<id>`, l'annotazione che Coverage cerca nel repository
// per dire che l'arco è testato.
//
// Il locator del trigger si risolve nell'ordine: `test.id` dell'elemento ->
// `getByTestId`; `test.text` -> `getByText`; altrimenti l'etichetta della
// transizione -> `getByRole('button', { name })` (`getByText` se il trigger non
// è click/submit). Se non c'è modo di trovare l'elemento, o manca `code.route`
// della schermata iniziale, il test emette un `// TODO` e `test.fixme`.
// Dopo ogni passo, se la destinazione ha `code.route`, si asserisce l'URL.
func PlaywrightTests(doc *opendesignerv1.Document, flowID string, opts PlaywrightOptions) (string, error) {
	ids := flowIDs(doc, flowID)
	if len(ids) == 0 {
		if flowID != "" {
			return "", fmt.Errorf("flusso %q non trovato nel documento", flowID)
		}
		return "", errors.New("il documento non ha flussi")
	}

	var body strings.Builder
	usesExpect := false
	for _, id := range ids {
		g := buildGraph(doc, id)
		rep := analyzeFlow(g, id)
		writeFlowTests(&body, g, rep, opts, &usesExpect)
	}

	var b strings.Builder
	fmt.Fprintf(&b, "// %s (opendesigner flow tests): NON modificare a mano,\n", GeneratedMarker)
	b.WriteString("// rigenerare dal grafo dei flussi.\n")
	fmt.Fprintf(&b, "// Documento: %s (%s)\n", oneLine(doc.GetName()), doc.GetId())
	if flowID != "" {
		fmt.Fprintf(&b, "// Flusso: %s (%s)\n", oneLine(g0name(doc, flowID)), flowID)
	} else {
		b.WriteString("// Flussi: tutti\n")
	}
	if usesExpect {
		b.WriteString("import { expect, test } from '@playwright/test';\n")
	} else {
		b.WriteString("import { test } from '@playwright/test';\n")
	}
	b.WriteString(body.String())
	return b.String(), nil
}

func g0name(doc *opendesignerv1.Document, flowID string) string {
	if n := doc.GetFlows()[flowID].GetName(); n != "" {
		return n
	}
	return flowID
}

func writeFlowTests(b *strings.Builder, g *graph, rep *opendesignerv1.FlowReport, opts PlaywrightOptions, usesExpect *bool) {
	b.WriteString("\n")
	fmt.Fprintf(b, "test.describe(%s, () => {\n", tsString("Flusso: "+oneLine(g0name(g.doc, g.flow.GetId()))))
	if len(rep.GetPaths()) == 0 {
		b.WriteString("  // Nessun percorso: manca la schermata iniziale o le transizioni.\n")
	}
	byID := map[string]*opendesignerv1.Transition{}
	for _, t := range g.trans {
		byID[t.GetId()] = t
	}
	for i, p := range rep.GetPaths() {
		names := make([]string, len(p.GetNodeIds()))
		for j, id := range p.GetNodeIds() {
			names[j] = nodeName(g.doc, id)
		}
		title := fmt.Sprintf("percorso %d: %s", i+1, strings.Join(names, " → "))
		if p.GetLoops() {
			title += " (ciclo)"
		}
		writeTest(b, g, byID, p, oneLine(title), opts, usesExpect)
	}
	b.WriteString("});\n")
}

func writeTest(b *strings.Builder, g *graph, byID map[string]*opendesignerv1.Transition, p *opendesignerv1.FlowPath, title string, opts PlaywrightOptions, usesExpect *bool) {
	var steps strings.Builder
	var todos []string
	start := p.GetNodeIds()[0]
	if route := nodeMeta(g.doc, start, MetaRoute); route != "" {
		fmt.Fprintf(&steps, "    await page.goto(%s);\n", tsString(opts.BaseURL+route))
	} else {
		msg := fmt.Sprintf("manca code.route su %q", oneLine(nodeName(g.doc, start)))
		fmt.Fprintf(&steps, "    // TODO: %s\n", msg)
		todos = append(todos, msg)
	}

	for i, tid := range p.GetTransitionIds() {
		t := byID[tid]
		to := p.GetNodeIds()[i+1]
		fmt.Fprintf(&steps, "\n    // flow:%s\n", t.GetId())
		fmt.Fprintf(&steps, "    // %s -> %s\n", oneLine(nodeName(g.doc, t.GetFromId())), oneLine(nodeName(g.doc, t.GetToId())))
		if t.GetGuard() != "" {
			fmt.Fprintf(&steps, "    // guard: %s\n", oneLine(t.GetGuard()))
		}
		if t.GetEffect() != "" {
			fmt.Fprintf(&steps, "    // effect: %s\n", oneLine(t.GetEffect()))
		}
		if msg := writeAction(&steps, g.doc, t, usesExpect); msg != "" {
			todos = append(todos, msg)
		}
		if route := nodeMeta(g.doc, to, MetaRoute); route != "" {
			*usesExpect = true
			fmt.Fprintf(&steps, "    await expect(page).toHaveURL(new RegExp(%s));\n", tsString(routePattern(route)))
		}
	}

	fmt.Fprintf(b, "  test(%s, async ({ page }) => {\n", tsString(title))
	if len(todos) > 0 {
		fmt.Fprintf(b, "    test.fixme(true, %s);\n", tsString(strings.Join(todos, "; ")))
	}
	b.WriteString(steps.String())
	b.WriteString("  });\n")
}

// writeAction emette l'azione del trigger; se non sa come trovare l'elemento
// emette un TODO e ritorna il motivo (il test diventa fixme).
func writeAction(b *strings.Builder, doc *opendesignerv1.Document, t *opendesignerv1.Transition, usesExpect *bool) string {
	trig := t.GetTrigger()
	switch trig {
	case "auto":
		b.WriteString("    // trigger auto: nessuna azione, la transizione scatta da sola\n")
		return ""
	case "back":
		b.WriteString("    await page.goBack();\n")
		return ""
	case "key":
		if t.GetLabel() == "" {
			msg := fmt.Sprintf("transizione %s: trigger key senza etichetta (il tasto da premere)", t.GetId())
			fmt.Fprintf(b, "    // TODO: %s\n", msg)
			return msg
		}
		fmt.Fprintf(b, "    await page.keyboard.press(%s);\n", tsString(t.GetLabel()))
		return ""
	}

	clickLike := trig == "" || trig == "click" || trig == "submit"
	loc := ""
	switch {
	case t.GetElementId() != "" && nodeMeta(doc, t.GetElementId(), MetaTestID) != "":
		loc = fmt.Sprintf("page.getByTestId(%s)", tsString(nodeMeta(doc, t.GetElementId(), MetaTestID)))
	case t.GetElementId() != "" && nodeMeta(doc, t.GetElementId(), MetaTestText) != "":
		loc = fmt.Sprintf("page.getByText(%s)", tsString(nodeMeta(doc, t.GetElementId(), MetaTestText)))
	case t.GetLabel() != "" && clickLike:
		loc = fmt.Sprintf("page.getByRole('button', { name: %s })", tsString(t.GetLabel()))
	case t.GetLabel() != "":
		loc = fmt.Sprintf("page.getByText(%s)", tsString(t.GetLabel()))
	}
	if loc == "" {
		msg := fmt.Sprintf("transizione %s: nessun test.id/test.text sull'elemento né etichetta per trovare il trigger", t.GetId())
		fmt.Fprintf(b, "    // TODO: %s\n", msg)
		return msg
	}
	if clickLike {
		fmt.Fprintf(b, "    await %s.click();\n", loc)
		return ""
	}
	// Trigger a testo libero (hover, long press...): non si sa simularlo, ma si
	// verifica almeno che l'elemento ci sia.
	*usesExpect = true
	msg := fmt.Sprintf("transizione %s: trigger %q da simulare a mano", t.GetId(), trig)
	fmt.Fprintf(b, "    // TODO: %s\n", msg)
	fmt.Fprintf(b, "    await expect(%s).toBeVisible();\n", loc)
	return msg
}

var jsRegexSpecial = regexp.MustCompile(`[.*+?^${}()|\[\]\\/]`)

var paramSegment = regexp.MustCompile(`^(?::[A-Za-z_][\w-]*|\[[^\]]+\])$`)

// routePattern costruisce la sorgente di una RegExp che riconosce l'URL della
// rotta: ancorata a schema+host, tollera slash finale, query e hash. I segmenti
// parametrici (`:id`, `[id]`) diventano `[^/]+`; il resto è escapato.
func routePattern(route string) string {
	route = strings.TrimRight(route, "/")
	if route != "" && !strings.HasPrefix(route, "/") {
		route = "/" + route
	}
	var sb strings.Builder
	sb.WriteString(`^[a-z]+://[^/]+`)
	for _, seg := range strings.Split(strings.TrimPrefix(route, "/"), "/") {
		if seg == "" {
			continue
		}
		sb.WriteString("/")
		if paramSegment.MatchString(seg) {
			sb.WriteString(`[^/]+`)
		} else {
			sb.WriteString(jsRegexSpecial.ReplaceAllString(seg, `\$0`))
		}
	}
	sb.WriteString(`/?(?:[?#].*)?$`)
	return sb.String()
}

// tsString cita una stringa come literal TypeScript valido (escape JSON), senza
// l'escaping HTML che json.Marshal applicherebbe di default.
func tsString(s string) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return strings.TrimRight(buf.String(), "\n")
}
