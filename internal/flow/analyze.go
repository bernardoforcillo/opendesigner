package flow

import (
	"fmt"
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Analyze analizza i flussi del documento: flowID "" = tutti, in ordine di id.
// Per ogni flusso riporta i problemi del grafo (vedi le costanti Issue*) e i
// percorsi dall'ingresso alle schermate finali o ai cicli. L'ordine di problemi
// e percorsi è deterministico.
func Analyze(doc *opendesignerv1.Document, flowID string) []*opendesignerv1.FlowReport {
	var out []*opendesignerv1.FlowReport
	for _, id := range flowIDs(doc, flowID) {
		out = append(out, analyzeFlow(buildGraph(doc, id), id))
	}
	return out
}

func analyzeFlow(g *graph, id string) *opendesignerv1.FlowReport {
	r := &opendesignerv1.FlowReport{
		FlowId:      id,
		Screens:     uint32(len(g.screens)),
		Transitions: uint32(len(g.trans)),
	}
	issue := func(kind, node, trans, msg string) {
		r.Issues = append(r.Issues, &opendesignerv1.FlowIssue{
			Kind: kind, FlowId: id, NodeId: node, TransitionId: trans, Message: msg,
		})
	}
	fname := g.flow.GetName()
	if fname == "" {
		fname = id
	}

	if len(g.trans) == 0 {
		issue(IssueEmpty, "", "", fmt.Sprintf("Il flusso %q non ha transizioni.", fname))
		return r
	}
	start := g.flow.GetStartId()
	if start == "" {
		issue(IssueNoStart, "", "", fmt.Sprintf("Il flusso %q ha transizioni ma nessuna schermata iniziale.", fname))
	} else {
		reach := g.reachable()
		for _, s := range g.screens {
			if !reach[s] {
				issue(IssueUnreachable, s, "", fmt.Sprintf("La schermata %q non è raggiungibile dalla schermata iniziale %q.", nodeName(g.doc, s), nodeName(g.doc, start)))
			}
		}
		for _, s := range g.screens {
			if reach[s] && len(g.out[s]) == 0 && nodeKind(g.doc, s) != KindEnd {
				issue(IssueDeadEnd, s, "", fmt.Sprintf("La schermata %q è un vicolo cieco: nessuna uscita e non è di tipo \"end\".", nodeName(g.doc, s)))
			}
		}
	}

	// Ambiguità: due uscite della stessa schermata con stesso innesco (trigger +
	// elemento) e nessuna condizione che le distingua (entrambe senza guard o con
	// guard identica). Si segnala ogni uscita dopo la prima del gruppo.
	for _, s := range g.screens {
		type key struct{ trigger, element, guard string }
		first := map[key]*opendesignerv1.Transition{}
		for _, t := range sortedByID(g.out[s]) {
			k := key{t.GetTrigger(), t.GetElementId(), t.GetGuard()}
			prev, dup := first[k]
			if !dup {
				first[k] = t
				continue
			}
			what := "senza condizione (guard)"
			if k.guard != "" {
				what = fmt.Sprintf("con la stessa condizione %q", k.guard)
			}
			issue(IssueAmbiguous, s, t.GetId(), fmt.Sprintf(
				"Dalla schermata %q le transizioni %q e %q hanno lo stesso innesco (%s) %s: non è chiaro quale scatti.",
				nodeName(g.doc, s), label(prev), label(t), triggerDesc(k.trigger, k.element, g.doc), what))
		}
	}

	if start != "" {
		r.Paths, r.PathsTruncated = enumeratePaths(g, start)
	}
	return r
}

func sortedByID(ts []*opendesignerv1.Transition) []*opendesignerv1.Transition {
	c := append([]*opendesignerv1.Transition(nil), ts...)
	sort.Slice(c, func(i, j int) bool { return c[i].GetId() < c[j].GetId() })
	return c
}

func label(t *opendesignerv1.Transition) string {
	if t.GetLabel() != "" {
		return t.GetLabel()
	}
	return t.GetId()
}

func triggerDesc(trigger, element string, doc *opendesignerv1.Document) string {
	if trigger == "" {
		trigger = "click"
	}
	if element != "" {
		return fmt.Sprintf("%s su %q", trigger, nodeName(doc, element))
	}
	return trigger
}

// enumeratePaths fa una DFS dall'ingresso elencando i percorsi semplici fino a
// una schermata finale e quelli che si chiudono in un ciclo (un arco verso una
// schermata già nel percorso: il percorso si ferma lì, loops=true). Tetti:
// MaxPaths percorsi e profondità MaxDepth; superarli imposta `truncated`.
func enumeratePaths(g *graph, start string) (paths []*opendesignerv1.FlowPath, truncated bool) {
	var nodes []string
	var trans []string
	onPath := map[string]bool{}

	emit := func(loops bool) {
		paths = append(paths, &opendesignerv1.FlowPath{
			TransitionIds: append([]string(nil), trans...),
			NodeIds:       append([]string(nil), nodes...),
			Loops:         loops,
		})
	}
	var dfs func(n string)
	dfs = func(n string) {
		if truncated {
			return
		}
		if g.terminal(n) {
			// Un ingresso già terminale non ha percorsi: nessun arco da percorrere.
			if len(trans) > 0 {
				if len(paths) >= MaxPaths {
					truncated = true
					return
				}
				emit(false)
			}
			return
		}
		for _, t := range g.out[n] {
			if truncated {
				return
			}
			if len(paths) >= MaxPaths {
				truncated = true
				return
			}
			if len(trans) >= MaxDepth {
				truncated = true
				return
			}
			trans = append(trans, t.GetId())
			nodes = append(nodes, t.GetToId())
			if onPath[t.GetToId()] {
				emit(true)
			} else {
				onPath[t.GetToId()] = true
				dfs(t.GetToId())
				delete(onPath, t.GetToId())
			}
			trans = trans[:len(trans)-1]
			nodes = nodes[:len(nodes)-1]
		}
	}
	nodes = []string{start}
	onPath[start] = true
	dfs(start)
	return paths, truncated
}
