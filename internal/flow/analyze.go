package flow

import (
	"fmt"
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Analyze analyzes the document's flows: flowID "" = all, in id order.
// For each flow it reports the graph's issues (see the Issue* constants) and the
// paths from the entry to the final screens or to cycles. The order of issues
// and paths is deterministic.
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
		issue(IssueEmpty, "", "", fmt.Sprintf("Flow %q has no transitions.", fname))
		return r
	}
	start := g.flow.GetStartId()
	if start == "" {
		issue(IssueNoStart, "", "", fmt.Sprintf("Flow %q has transitions but no start screen.", fname))
	} else {
		reach := g.reachable()
		for _, s := range g.screens {
			if !reach[s] {
				issue(IssueUnreachable, s, "", fmt.Sprintf("Screen %q is not reachable from the start screen %q.", nodeName(g.doc, s), nodeName(g.doc, start)))
			}
		}
		for _, s := range g.screens {
			if reach[s] && len(g.out[s]) == 0 && nodeKind(g.doc, s) != KindEnd {
				issue(IssueDeadEnd, s, "", fmt.Sprintf("Screen %q is a dead end: no exit and it is not of type \"end\".", nodeName(g.doc, s)))
			}
		}
	}

	// Ambiguity: two exits of the same screen with the same trigger (trigger +
	// element) and no condition that tells them apart (both without a guard or with
	// an identical guard). Every exit after the first of the group is reported.
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
			if prev.GetOrder() > 0 && t.GetOrder() > 0 && prev.GetOrder() != t.GetOrder() {
				continue // in an ordered chain the earlier one wins: reported below as a shadowed branch
			}
			what := "without a condition (guard)"
			if k.guard != "" {
				what = fmt.Sprintf("with the same condition %q", k.guard)
			}
			issue(IssueAmbiguous, s, t.GetId(), fmt.Sprintf(
				"From screen %q, transitions %q and %q have the same trigger (%s) %s: it is unclear which one fires.",
				nodeName(g.doc, s), label(prev), label(t), triggerDesc(k.trigger, k.element, g.doc), what))
		}
	}

	chainIssues(g, issue)

	if start != "" {
		r.Paths, r.PathsTruncated = enumeratePaths(g, start)
	}
	return r
}

// chainIssues checks the if / else if / else shape of every hotspot (the exits of one screen that
// share a trigger and an element). The player reads the transitions like this: an `else` guard holds
// when no other transition of the hotspot does; the transitions with `order > 0` form a chain
// evaluated in order, the first whose guard holds applying. Reported:
//
//   - else_orphan: an `else` with no other transition on its hotspot, so nothing to be the else of;
//   - shadowed: a chain member that can never fire because an earlier one has no condition (it always
//     holds) or the very same condition;
//   - ambiguous: two chain members with the same position, so the order does not tell them apart.
func chainIssues(g *graph, issue func(kind, node, trans, msg string)) {
	type hotspot struct{ trigger, element string }
	for _, s := range g.screens {
		groups := map[hotspot][]*opendesignerv1.Transition{}
		var keys []hotspot
		for _, t := range sortedByID(g.out[s]) {
			k := hotspot{t.GetTrigger(), t.GetElementId()}
			if _, ok := groups[k]; !ok {
				keys = append(keys, k)
			}
			groups[k] = append(groups[k], t)
		}
		for _, k := range keys {
			ts := groups[k]
			where := triggerDesc(k.trigger, k.element, g.doc)
			ifs := 0
			for _, t := range ts {
				if !IsElseGuard(t.GetGuard()) {
					ifs++
				}
			}
			for _, t := range ts {
				if IsElseGuard(t.GetGuard()) && ifs == 0 {
					issue(IssueElseOrphan, s, t.GetId(), fmt.Sprintf(
						"From screen %q, transition %q is an else (%s) but no other transition has that trigger, so there is nothing for it to be the else of.",
						nodeName(g.doc, s), label(t), where))
				}
			}
			var chain []*opendesignerv1.Transition
			for _, t := range ts {
				if t.GetOrder() > 0 {
					chain = append(chain, t)
				}
			}
			sort.SliceStable(chain, func(i, j int) bool { return chain[i].GetOrder() < chain[j].GetOrder() })
			var always *opendesignerv1.Transition // the first member with no condition
			seen := map[string]*opendesignerv1.Transition{}
			for i, t := range chain {
				if i > 0 && chain[i-1].GetOrder() == t.GetOrder() {
					issue(IssueAmbiguous, s, t.GetId(), fmt.Sprintf(
						"From screen %q, transitions %q and %q have the same position %d in the if / else if chain of %s: the order does not tell them apart.",
						nodeName(g.doc, s), label(chain[i-1]), label(t), t.GetOrder(), where))
					continue
				}
				guard := t.GetGuard()
				switch {
				case always != nil:
					issue(IssueShadowed, s, t.GetId(), fmt.Sprintf(
						"From screen %q, transition %q can never fire: the earlier branch %q of the chain (%s) has no condition, so it always applies.",
						nodeName(g.doc, s), label(t), label(always), where))
				case seen[guard] != nil && guard != "" && !IsElseGuard(guard):
					issue(IssueShadowed, s, t.GetId(), fmt.Sprintf(
						"From screen %q, transition %q can never fire: the earlier branch %q of the chain (%s) has the same condition %q.",
						nodeName(g.doc, s), label(t), label(seen[guard]), where, guard))
				}
				if guard == "" && always == nil {
					always = t
				}
				if seen[guard] == nil {
					seen[guard] = t
				}
			}
		}
	}
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
		return fmt.Sprintf("%s on %q", trigger, nodeName(doc, element))
	}
	return trigger
}

// enumeratePaths does a DFS from the entry listing the simple paths up to
// a final screen and those that close in a cycle (an edge to a
// screen already in the path: the path stops there, loops=true). Caps:
// MaxPaths paths and depth MaxDepth; exceeding them sets `truncated`.
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
			// An entry that is already terminal has no paths: no edge to walk.
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
