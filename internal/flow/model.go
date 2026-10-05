// Package flow turns the flow graph drawn in the editor into tools
// for development: analysis (issues and paths), a Markdown spec for
// people and agents, generated Playwright e2e tests, coverage against the code and
// a task list.
//
// They are all PURE functions on the `*opendesignerv1.Document` (the only I/O is the
// repository scan in Coverage) and their output is DETERMINISTIC: every
// document map is read in an explicit order, never with a direct `range`,
// because the same graph must produce identical bytes (golden files, PR diffs,
// CI comparisons).
//
// Conventions on node metadata (Node.meta), not enforced by the model:
//
//	flow.kind       screen (default) | decision | action | start | end | note
//	code.route      the app route that implements the screen
//	code.component  the component that implements it
//	test.id         the data-testid a test uses to find an element
//	test.text       the accessible text it uses to find it
//	status          planned (default) | implemented | tested
package flow

import (
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Metadata keys (see the package doc).
const (
	MetaKind      = "flow.kind"
	MetaRoute     = "code.route"
	MetaComponent = "code.component"
	MetaTestID    = "test.id"
	MetaTestText  = "test.text"
	MetaStatus    = "status"
)

// Recognized screen kinds and statuses.
const (
	KindScreen = "screen"
	KindEnd    = "end"

	StatusPlanned     = "planned"
	StatusImplemented = "implemented"
	StatusTested      = "tested"
)

// Issue kinds reported by Analyze.
const (
	IssueEmpty       = "empty"
	IssueNoStart     = "no_start"
	IssueUnreachable = "unreachable"
	IssueDeadEnd     = "dead_end"
	IssueAmbiguous   = "ambiguous"
)

// Limits of the path enumeration: beyond them, the report is `paths_truncated`.
const (
	MaxPaths = 200
	MaxDepth = 50
)

func nodeMeta(doc *opendesignerv1.Document, id, key string) string {
	return doc.GetNodes()[id].GetMeta()[key]
}

// nodeName is a node's readable name; if missing (node without a name or unknown
// id) it falls back to the id, so messages never have holes.
func nodeName(doc *opendesignerv1.Document, id string) string {
	if n := doc.GetNodes()[id].GetName(); n != "" {
		return n
	}
	return id
}

// nodeKind: the node's `flow.kind`, "screen" if absent.
func nodeKind(doc *opendesignerv1.Document, id string) string {
	if k := nodeMeta(doc, id, MetaKind); k != "" {
		return k
	}
	return KindScreen
}

// nodeStatus: the manually declared `status`, "planned" if absent.
func nodeStatus(doc *opendesignerv1.Document, id string) string {
	if s := nodeMeta(doc, id, MetaStatus); s != "" {
		return s
	}
	return StatusPlanned
}

// flowIDs resolves the filter: "" = all flows sorted by id, otherwise only the
// requested flow (empty if it does not exist).
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

// graph is the view of a flow on which all the functions work.
type graph struct {
	doc   *opendesignerv1.Document
	flow  *opendesignerv1.Flow
	trans []*opendesignerv1.Transition            // sorted by id
	out   map[string][]*opendesignerv1.Transition // outgoing edges, sorted by (label, id)
	// screens: entry + every from/to, sorted by (name, id).
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

// terminal: a screen where the path ends -- with no exits or of
// kind `end` (an `end` with outgoing edges stays reachable but the path does not continue).
func (g *graph) terminal(id string) bool {
	return len(g.out[id]) == 0 || nodeKind(g.doc, id) == KindEnd
}

// reachable: the screens reachable from the entry (empty set without an entry).
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
