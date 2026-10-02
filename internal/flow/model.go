// Package flow trasforma il grafo dei flussi disegnato nell'editor in strumenti
// per lo sviluppo: analisi (problemi e percorsi), specifica in Markdown per
// persone e agenti, test e2e Playwright generati, coverage rispetto al codice e
// lista di attività.
//
// Sono tutte funzioni PURE sul `*opendesignerv1.Document` (l'unico I/O è la
// scansione del repository in Coverage) e il loro output è DETERMINISTICO: ogni
// mappa del documento viene letta in ordine esplicito, mai con `range` diretto,
// perché lo stesso grafo deve produrre byte identici (golden file, diff nei PR,
// CI che confronta).
//
// Convenzioni sui metadati dei nodi (Node.meta), non imposte dal modello:
//
//	flow.kind       screen (default) | decision | action | start | end | note
//	code.route      la rotta dell'app che realizza la schermata
//	code.component  il componente che la realizza
//	test.id         il data-testid con cui un test trova un elemento
//	test.text       il testo accessibile con cui lo trova
//	status          planned (default) | implemented | tested
package flow

import (
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Chiavi dei metadati (vedi la doc del package).
const (
	MetaKind      = "flow.kind"
	MetaRoute     = "code.route"
	MetaComponent = "code.component"
	MetaTestID    = "test.id"
	MetaTestText  = "test.text"
	MetaStatus    = "status"
)

// Tipi di schermata e stati riconosciuti.
const (
	KindScreen = "screen"
	KindEnd    = "end"

	StatusPlanned     = "planned"
	StatusImplemented = "implemented"
	StatusTested      = "tested"
)

// Tipi di problema riportati da Analyze.
const (
	IssueEmpty       = "empty"
	IssueNoStart     = "no_start"
	IssueUnreachable = "unreachable"
	IssueDeadEnd     = "dead_end"
	IssueAmbiguous   = "ambiguous"
)

// Limiti dell'enumerazione dei percorsi: oltre, il report è `paths_truncated`.
const (
	MaxPaths = 200
	MaxDepth = 50
)

func nodeMeta(doc *opendesignerv1.Document, id, key string) string {
	return doc.GetNodes()[id].GetMeta()[key]
}

// nodeName è il nome leggibile di un nodo; se manca (nodo senza nome o id
// sconosciuto) ripiega sull'id, così i messaggi non hanno mai buchi.
func nodeName(doc *opendesignerv1.Document, id string) string {
	if n := doc.GetNodes()[id].GetName(); n != "" {
		return n
	}
	return id
}

// nodeKind: il `flow.kind` del nodo, "screen" se assente.
func nodeKind(doc *opendesignerv1.Document, id string) string {
	if k := nodeMeta(doc, id, MetaKind); k != "" {
		return k
	}
	return KindScreen
}

// nodeStatus: lo `status` dichiarato a mano, "planned" se assente.
func nodeStatus(doc *opendesignerv1.Document, id string) string {
	if s := nodeMeta(doc, id, MetaStatus); s != "" {
		return s
	}
	return StatusPlanned
}

// flowIDs risolve il filtro: "" = tutti i flussi ordinati per id, altrimenti il
// solo flusso richiesto (vuoto se non esiste).
func flowIDs(doc *opendesignerv1.Document, flowID string) []string {
	if flowID != "" {
		if _, ok := doc.GetFlows()[flowID]; ok {
			return []string{flowID}
		}
		return nil
	}
	ids := make([]string, 0, len(doc.GetFlows()))
	for id := range doc.GetFlows() {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// graph è la vista di un flusso su cui lavorano tutte le funzioni.
type graph struct {
	doc   *opendesignerv1.Document
	flow  *opendesignerv1.Flow
	trans []*opendesignerv1.Transition            // ordinate per id
	out   map[string][]*opendesignerv1.Transition // archi uscenti, ordinati per (label, id)
	// screens: ingresso + ogni from/to, ordinate per (nome, id).
	screens []string
}

func buildGraph(doc *opendesignerv1.Document, flowID string) *graph {
	g := &graph{doc: doc, flow: doc.GetFlows()[flowID], out: map[string][]*opendesignerv1.Transition{}}
	for _, t := range doc.GetTransitions() {
		if t.GetFlowId() == flowID {
			g.trans = append(g.trans, t)
		}
	}
	sort.Slice(g.trans, func(i, j int) bool { return g.trans[i].GetId() < g.trans[j].GetId() })
	set := map[string]bool{}
	if s := g.flow.GetStartId(); s != "" {
		set[s] = true
	}
	for _, t := range g.trans {
		g.out[t.GetFromId()] = append(g.out[t.GetFromId()], t)
		set[t.GetFromId()] = true
		set[t.GetToId()] = true
	}
	for _, ts := range g.out {
		sort.Slice(ts, func(i, j int) bool {
			if ts[i].GetLabel() != ts[j].GetLabel() {
				return ts[i].GetLabel() < ts[j].GetLabel()
			}
			return ts[i].GetId() < ts[j].GetId()
		})
	}
	for id := range set {
		g.screens = append(g.screens, id)
	}
	sort.Slice(g.screens, func(i, j int) bool {
		ni, nj := nodeName(doc, g.screens[i]), nodeName(doc, g.screens[j])
		if ni != nj {
			return ni < nj
		}
		return g.screens[i] < g.screens[j]
	})
	return g
}

// terminal: una schermata dove il percorso finisce -- senza uscite oppure di
// tipo `end` (un `end` con archi uscenti resta raggiungibile ma non si prosegue).
func (g *graph) terminal(id string) bool {
	return len(g.out[id]) == 0 || nodeKind(g.doc, id) == KindEnd
}

// reachable: le schermate raggiungibili dall'ingresso (insieme vuoto senza ingresso).
func (g *graph) reachable() map[string]bool {
	seen := map[string]bool{}
	start := g.flow.GetStartId()
	if start == "" {
		return seen
	}
	stack := []string{start}
	seen[start] = true
	for len(stack) > 0 {
		n := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, t := range g.out[n] {
			if !seen[t.GetToId()] {
				seen[t.GetToId()] = true
				stack = append(stack, t.GetToId())
			}
		}
	}
	return seen
}
