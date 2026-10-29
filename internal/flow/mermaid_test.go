package flow

import (
	"strings"
	"testing"

	"github.com/bernardoforcillo/opendesigner/internal/diagram"
)

func shopDoc() *tdoc {
	d := newTDoc().
		node("home", "Home", MetaKind, "start").
		node("list", `Product "list"`).
		node("ok", "In stock?", MetaKind, "decision").
		node("pay", "Pay", MetaKind, "action").
		node("done", "Done", MetaKind, KindEnd).
		flow("f1", "Purchase", "home")
	d.tr("t1", "f1", "home", "list", "Shop", "click")
	d.tr("t2", "f1", "list", "ok", "", "submit")
	d.tr("t3", "f1", "ok", "pay", "yes", "click").Guard = "stock > 0"
	d.tr("t4", "f1", "pay", "done", "", "auto")
	return d
}

func TestMermaidOneFlow(t *testing.T) {
	got := Mermaid(shopDoc().Document, "f1")
	for _, want := range []string{"flowchart LR", `{"In stock?"}`, `("Pay")`, `["Product 'list'"]`, "|Shop|", "|submit|", "|yes [stock > 0]|", "-.->"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	if strings.Contains(got, "subgraph") {
		t.Error("a single flow is not wrapped in a subgraph")
	}
	if again := Mermaid(shopDoc().Document, "f1"); again != got {
		t.Error("the output must be stable")
	}
}

func TestMermaidReadsBackAsADiagram(t *testing.T) {
	res, err := diagram.Render(Mermaid(shopDoc().Document, ""))
	if err != nil {
		t.Fatalf("the export must be valid Mermaid: %v", err)
	}
	if res.Kind != diagram.KindFlowchart {
		t.Errorf("kind = %q", res.Kind)
	}
	seen := map[string]bool{}
	for _, n := range res.Nodes {
		if c := n.GetText().GetContent(); c != "" {
			seen[c] = true
		}
	}
	for _, name := range []string{"Home", "In stock?", "Pay", "Done", "Product 'list'"} {
		if !seen[name] {
			t.Errorf("the drawing must show %q (has %v)", name, seen)
		}
	}
}

func TestMermaidSeveralFlowsAreSubgraphs(t *testing.T) {
	d := shopDoc()
	d.node("a", "Login").node("b", "Account").flow("f2", "Sign in", "a")
	d.tr("t9", "f2", "a", "b", "go", "click")
	got := Mermaid(d.Document, "")
	if strings.Count(got, "subgraph") != 2 || !strings.Contains(got, "[Purchase]") || !strings.Contains(got, "[Sign in]") {
		t.Errorf("one subgraph per flow:\n%s", got)
	}
	res, err := diagram.Render(got)
	if err != nil {
		t.Fatal(err)
	}
	groups := 0
	for _, n := range res.Nodes {
		if strings.HasPrefix(n.GetName(), "Subgraph ") {
			groups++
		}
	}
	if groups != 2 {
		t.Errorf("both flows must draw a box, got %d", groups)
	}
}

func TestMermaidNoFlow(t *testing.T) {
	got := Mermaid(newTDoc().Document, "")
	if !strings.Contains(got, "no flow") {
		t.Errorf("got %q", got)
	}
	if got := Mermaid(shopDoc().Document, "missing"); !strings.Contains(got, "no flow") {
		t.Errorf("an unknown flow: %q", got)
	}
}
