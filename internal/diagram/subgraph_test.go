package diagram

import (
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

func byName(res *Result, prefix string) []*opendesignerv1.Node {
	var out []*opendesignerv1.Node
	for _, n := range res.Nodes {
		if strings.HasPrefix(n.GetName(), prefix) {
			out = append(out, n)
		}
	}
	return out
}

func contains(outer, inner *opendesignerv1.Node) bool {
	return inner.GetX() >= outer.GetX() && inner.GetY() >= outer.GetY() &&
		inner.GetX()+inner.GetWidth() <= outer.GetX()+outer.GetWidth() &&
		inner.GetY()+inner.GetHeight() <= outer.GetY()+outer.GetHeight()
}

func TestParseSubgraphs(t *testing.T) {
	fc, err := parseFlowchart(`flowchart TD
  A --> B
  subgraph one [First group]
    B --> C
    subgraph inner["Inner"]
      D
    end
  end
  C --> E`)
	if err != nil {
		t.Fatal(err)
	}
	if len(fc.Groups) != 2 {
		t.Fatalf("groups = %+v", fc.Groups)
	}
	one, inner := fc.Groups[0], fc.Groups[1]
	if one.ID != "one" || one.Title != "First group" || one.Parent != -1 {
		t.Errorf("one = %+v", one)
	}
	if inner.ID != "inner" || inner.Title != "Inner" || inner.Parent != 0 {
		t.Errorf("inner = %+v", inner)
	}
	// B first appeared outside; C inside `one`; D inside `inner`; E after the block.
	names := func(g flowGroup) string {
		var s []string
		for _, i := range g.Members {
			s = append(s, fc.Nodes[i].ID)
		}
		return strings.Join(s, ",")
	}
	if names(one) != "C" || names(inner) != "D" {
		t.Errorf("members: one=%s inner=%s", names(one), names(inner))
	}
}

func TestSubgraphHeads(t *testing.T) {
	for _, c := range []struct{ in, id, title string }{
		{"one", "one", "one"},
		{`one [My title]`, "one", "My title"},
		{`one["Quoted"]`, "one", "Quoted"},
		{`"Only a title"`, "Only a title", "Only a title"},
	} {
		if id, title := parseSubgraphHead(c.in); id != c.id || title != c.title {
			t.Errorf("%q -> %q, %q; want %q, %q", c.in, id, title, c.id, c.title)
		}
	}
}

func TestSubgraphErrors(t *testing.T) {
	if _, err := parseFlowchart("flowchart TD\n  A --> B\n  end"); err == nil || !strings.Contains(err.Error(), "end") {
		t.Errorf("a stray end: %v", err)
	}
	if _, err := parseFlowchart("flowchart TD\n  subgraph s\n  A --> B"); err == nil || !strings.Contains(err.Error(), "not closed") {
		t.Errorf("an unclosed subgraph: %v", err)
	}
}

func TestSubgraphIsDrawnAroundItsNodes(t *testing.T) {
	res, err := Render(`flowchart LR
  A --> B
  subgraph s [Group]
    B --> C
    subgraph t [Deep]
      C2[Inner node]
    end
  end
  C --> C2`)
	if err != nil {
		t.Fatal(err)
	}
	groups := byName(res, "Subgraph ")
	if len(groups) != 2 {
		t.Fatalf("want 2 subgraph boxes, got %d: %v", len(groups), names(res))
	}
	var outer, inner *opendesignerv1.Node
	for _, g := range groups {
		if strings.Contains(g.GetName(), "Group") {
			outer = g
		} else {
			inner = g
		}
	}
	if outer == nil || inner == nil || !contains(outer, inner) {
		t.Fatal("the inner subgraph must sit inside the outer one")
	}
	for _, label := range []string{"C", "Inner node"} {
		nodes := byName(res, "Node "+label)
		if len(nodes) != 1 || !contains(outer, nodes[0]) {
			t.Errorf("node %q must be inside the outer box", label)
		}
	}
	if nodes := byName(res, "Node A"); len(nodes) != 1 || contains(outer, nodes[0]) {
		t.Error("a node outside the subgraph must stay outside its box")
	}
	// A title is drawn, and the boxes come before what they hold (z-order).
	if len(byName(res, "Group title")) != 2 {
		t.Error("each subgraph has a title")
	}
	posOf := func(n *opendesignerv1.Node) int {
		for i, x := range res.Nodes {
			if x == n {
				return i
			}
		}
		return -1
	}
	if c := byName(res, "Node C"); posOf(outer) > posOf(c[0]) {
		t.Error("the box is drawn behind its nodes")
	}
}

func TestEmptySubgraphDrawsNothing(t *testing.T) {
	res, err := Render("flowchart TD\n  subgraph empty\n  end\n  A --> B")
	if err != nil {
		t.Fatal(err)
	}
	if len(byName(res, "Subgraph ")) != 0 {
		t.Error("a subgraph without nodes has no box")
	}
}

func names(res *Result) []string {
	var out []string
	for _, n := range res.Nodes {
		out = append(out, n.GetName())
	}
	return out
}
