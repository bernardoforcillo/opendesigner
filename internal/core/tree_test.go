package core

import (
	"errors"
	"testing"

	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
)

// childOf costruisce un rettangolo dentro un parent preciso. Il resto dei campi
// non conta per gli invarianti dell'albero: quello che conta è parent_id.
func childOf(id, parentID, orderKey string) *brawtv1.Node {
	return &brawtv1.Node{
		Id: id, ParentId: parentID, OrderKey: orderKey, Name: id, Visible: true, Opacity: 1,
		Width: 10, Height: 10,
		Shape: &brawtv1.Node_Rect{Rect: &brawtv1.RectNode{}},
	}
}

func createOp(n *brawtv1.Node) *brawtv1.Op {
	return &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: n}}}
}

func deleteOp(id string) *brawtv1.Op {
	return &brawtv1.Op{Kind: &brawtv1.Op_DeleteNode{DeleteNode: &brawtv1.DeleteNode{Id: id}}}
}

func reparentOp(id, newParent, orderKey string) *brawtv1.Op {
	return &brawtv1.Op{Kind: &brawtv1.Op_ReparentNode{ReparentNode: &brawtv1.ReparentNode{
		Id: id, NewParentId: newParent, OrderKey: orderKey,
	}}}
}

// mustApply applica una sequenza di op che DEVE passare: è il setup dei test
// sull'albero, non la cosa che stanno provando.
func mustApply(t *testing.T, doc *brawtv1.Document, ops ...*brawtv1.Op) {
	t.Helper()
	for i, op := range ops {
		if err := Apply(doc, op); err != nil {
			t.Fatalf("setup op %d: %v", i, err)
		}
	}
}

// L'albero di prova, tre livelli:
//
//	page1
//	├── g1
//	│   ├── c1
//	│   │   └── d1
//	│   └── c2
//	└── other
func treeDoc(t *testing.T) *brawtv1.Document {
	t.Helper()
	doc := NewDocument("doc1", "Untitled")
	mustApply(t, doc,
		createOp(childOf("g1", "page1", "a1")),
		createOp(childOf("c1", "g1", "a1")),
		createOp(childOf("d1", "c1", "a1")),
		createOp(childOf("c2", "g1", "a2")),
		createOp(childOf("other", "page1", "a2")),
	)
	return doc
}

// --- CreateNode: il parent deve esistere ------------------------------------

func TestApplyCreateRejectsUnknownParent(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	err := Apply(doc, createOp(childOf("n1", "ghost", "a1")))
	if !errors.Is(err, ErrParentNotFound) {
		t.Fatalf("expected ErrParentNotFound, got %v", err)
	}
	if len(doc.Nodes) != 0 {
		t.Fatalf("orphan node landed anyway: %v", doc.Nodes)
	}
}

func TestApplyCreateRejectsEmptyParent(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	// "" non è né una pagina né un nodo: un nodo senza parent non è
	// raggiungibile da nessuna pagina, quindi non è disegnabile né
	// selezionabile -- esiste solo nella mappa.
	if err := Apply(doc, createOp(childOf("n1", "", "a1"))); !errors.Is(err, ErrParentNotFound) {
		t.Fatalf("expected ErrParentNotFound, got %v", err)
	}
}

func TestApplyCreateAcceptsPageAndNodeParents(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	mustApply(t, doc, createOp(childOf("g1", "page1", "a1")))
	// Un nodo esistente è un parent valido quanto una pagina: è tutto il punto
	// dell'annidamento.
	mustApply(t, doc, createOp(childOf("c1", "g1", "a1")))
	if doc.Nodes["c1"].GetParentId() != "g1" {
		t.Fatalf("wrong parent: %q", doc.Nodes["c1"].GetParentId())
	}
}

// --- DeleteNode: cascata ----------------------------------------------------

func TestApplyDeleteCascadesToDescendants(t *testing.T) {
	doc := treeDoc(t)
	if err := Apply(doc, deleteOp("g1")); err != nil {
		t.Fatalf("delete: %v", err)
	}
	for _, id := range []string{"g1", "c1", "c2", "d1"} {
		if _, ok := doc.Nodes[id]; ok {
			t.Fatalf("%s survived a cascading delete", id)
		}
	}
	// Il resto del documento non si tocca.
	if _, ok := doc.Nodes["other"]; !ok {
		t.Fatal("cascade ate a node outside the subtree")
	}
}

func TestApplyDeleteLeafLeavesSiblings(t *testing.T) {
	doc := treeDoc(t)
	if err := Apply(doc, deleteOp("c2")); err != nil {
		t.Fatalf("delete: %v", err)
	}
	for _, id := range []string{"g1", "c1", "d1", "other"} {
		if _, ok := doc.Nodes[id]; !ok {
			t.Fatalf("%s disappeared deleting a leaf", id)
		}
	}
}

func TestApplyDeleteMissingNodeStillFails(t *testing.T) {
	doc := treeDoc(t)
	if err := Apply(doc, deleteOp("ghost")); !errors.Is(err, ErrNodeNotFound) {
		t.Fatalf("expected ErrNodeNotFound, got %v", err)
	}
	if len(doc.Nodes) != 5 {
		t.Fatalf("rejected delete touched the document: %d nodes left", len(doc.Nodes))
	}
}

// --- ReparentNode -----------------------------------------------------------

func TestApplyReparentMovesUnderNewParent(t *testing.T) {
	doc := treeDoc(t)
	if err := Apply(doc, reparentOp("c1", "other", "a9")); err != nil {
		t.Fatalf("reparent: %v", err)
	}
	if got := doc.Nodes["c1"].GetParentId(); got != "other" {
		t.Fatalf("parent not changed: %q", got)
	}
	if got := doc.Nodes["c1"].GetOrderKey(); got != "a9" {
		t.Fatalf("order key not written: %q", got)
	}
	// Il sottoalbero segue il nodo senza che nessuno lo riscriva: i figli
	// puntano al nodo, non al nonno.
	if got := doc.Nodes["d1"].GetParentId(); got != "c1" {
		t.Fatalf("descendant re-pointed: %q", got)
	}
}

func TestApplyReparentToPageIsValid(t *testing.T) {
	doc := treeDoc(t)
	if err := Apply(doc, reparentOp("d1", "page1", "a3")); err != nil {
		t.Fatalf("reparent to page: %v", err)
	}
	if got := doc.Nodes["d1"].GetParentId(); got != "page1" {
		t.Fatalf("parent not changed: %q", got)
	}
}

func TestApplyReparentRejectsCycle(t *testing.T) {
	for _, tc := range []struct{ name, id, parent string }{
		{"self", "g1", "g1"},
		{"direct child", "g1", "c1"},
		{"deep descendant", "g1", "d1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			doc := treeDoc(t)
			err := Apply(doc, reparentOp(tc.id, tc.parent, "a9"))
			if !errors.Is(err, ErrCycle) {
				t.Fatalf("expected ErrCycle, got %v", err)
			}
			// Rifiuto in BLOCCO: nemmeno la order key si muove.
			if got := doc.Nodes[tc.id].GetParentId(); got != "page1" {
				t.Fatalf("parent mutated by a rejected reparent: %q", got)
			}
			if got := doc.Nodes[tc.id].GetOrderKey(); got != "a1" {
				t.Fatalf("order key mutated by a rejected reparent: %q", got)
			}
		})
	}
}

func TestApplyReparentRejectsUnknownParent(t *testing.T) {
	doc := treeDoc(t)
	if err := Apply(doc, reparentOp("c1", "ghost", "a9")); !errors.Is(err, ErrParentNotFound) {
		t.Fatalf("expected ErrParentNotFound, got %v", err)
	}
	if got := doc.Nodes["c1"].GetParentId(); got != "g1" {
		t.Fatalf("parent mutated by a rejected reparent: %q", got)
	}
}

func TestApplyReparentRejectsUnknownNode(t *testing.T) {
	doc := treeDoc(t)
	if err := Apply(doc, reparentOp("ghost", "page1", "a9")); !errors.Is(err, ErrNodeNotFound) {
		t.Fatalf("expected ErrNodeNotFound, got %v", err)
	}
}

// Riordinare fra i pari SENZA cambiare parent è un reparent legittimo (stesso
// parent, nuova chiave): il pannello livelli lo usa per il drag di riordino.
func TestApplyReparentSameParentReorders(t *testing.T) {
	doc := treeDoc(t)
	if err := Apply(doc, reparentOp("c1", "g1", "a3")); err != nil {
		t.Fatalf("reparent: %v", err)
	}
	if got := doc.Nodes["c1"].GetOrderKey(); got != "a3" {
		t.Fatalf("order key not written: %q", got)
	}
}

// --- attraversamento --------------------------------------------------------

func ids(nodes []*brawtv1.Node) []string {
	out := make([]string, len(nodes))
	for i, n := range nodes {
		out[i] = n.GetId()
	}
	return out
}

func equalIDs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestChildrenOfIsOrderedByOrderKey(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	mustApply(t, doc,
		createOp(childOf("g1", "page1", "a1")),
		createOp(childOf("z", "g1", "a3")),
		createOp(childOf("a", "g1", "a1")),
		createOp(childOf("m", "g1", "a2")),
	)
	if got := ids(ChildrenOf(doc, "g1")); !equalIDs(got, []string{"a", "m", "z"}) {
		t.Fatalf("children out of order: %v", got)
	}
	// A parità di chiave l'ordine deve restare DETERMINISTICO (l'iterazione di
	// una mappa Go non lo è): l'id fa da spareggio.
	mustApply(t, doc, createOp(childOf("b", "g1", "a1")))
	if got := ids(ChildrenOf(doc, "g1")); !equalIDs(got, []string{"a", "b", "m", "z"}) {
		t.Fatalf("tie not broken by id: %v", got)
	}
}

func TestSubtreeOfIsParentsBeforeChildren(t *testing.T) {
	doc := treeDoc(t)
	got := ids(SubtreeOf(doc, "g1"))
	if !equalIDs(got, []string{"g1", "c1", "d1", "c2"}) {
		t.Fatalf("wrong subtree order: %v", got)
	}
	// La proprietà che serve all'undo: ogni nodo compare DOPO il suo parent,
	// quindi ricrearli in quest'ordine soddisfa l'invariante parent-esiste.
	seen := map[string]bool{"page1": true}
	for _, n := range SubtreeOf(doc, "g1") {
		if !seen[n.GetParentId()] && n.GetId() != "g1" {
			t.Fatalf("%s comes before its parent %s", n.GetId(), n.GetParentId())
		}
		seen[n.GetId()] = true
	}
}

func TestIsAncestorOf(t *testing.T) {
	doc := treeDoc(t)
	if !IsAncestorOf(doc, "g1", "d1") {
		t.Fatal("g1 should be an ancestor of d1")
	}
	if IsAncestorOf(doc, "d1", "g1") {
		t.Fatal("d1 is not an ancestor of g1")
	}
	if IsAncestorOf(doc, "other", "c1") {
		t.Fatal("a sibling subtree is not an ancestor")
	}
	// Un nodo non è antenato di se stesso (la relazione è stretta); il rifiuto
	// del reparent su se stesso lo tratta a parte.
	if IsAncestorOf(doc, "g1", "g1") {
		t.Fatal("IsAncestorOf must be strict")
	}
}

// Un documento MALFORMATO (ciclo già presente, es. da un op-log scritto da una
// versione senza queste invarianti) non deve mandare in loop l'attraversamento:
// vale sia per la cascata sia per il controllo dei cicli.
func TestTraversalSurvivesACorruptedCycle(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	doc.Nodes["a"] = childOf("a", "b", "a1")
	doc.Nodes["b"] = childOf("b", "a", "a1")
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = SubtreeOf(doc, "a")
		_ = IsAncestorOf(doc, "a", "b")
		_ = Apply(doc, deleteOp("a"))
	}()
	<-done
}
