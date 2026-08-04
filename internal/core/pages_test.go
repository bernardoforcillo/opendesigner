package core

import (
	"errors"
	"testing"

	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
)

func createPageOp(p *brawtv1.Page) *brawtv1.Op {
	return &brawtv1.Op{Kind: &brawtv1.Op_CreatePage{CreatePage: &brawtv1.CreatePage{Page: p}}}
}

func deletePageOp(id string) *brawtv1.Op {
	return &brawtv1.Op{Kind: &brawtv1.Op_DeletePage{DeletePage: &brawtv1.DeletePage{Id: id}}}
}

func renamePageOp(id, name string) *brawtv1.Op {
	return &brawtv1.Op{Kind: &brawtv1.Op_RenamePage{RenamePage: &brawtv1.RenamePage{Id: id, Name: name}}}
}

func pageIDs(doc *brawtv1.Document) []string {
	out := make([]string, 0, len(doc.GetPages()))
	for _, p := range doc.GetPages() {
		out = append(out, p.GetId())
	}
	return out
}

func TestApplyCreatePage(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	if err := Apply(doc, createPageOp(&brawtv1.Page{Id: "page2", Name: "Page 2"})); err != nil {
		t.Fatalf("Apply createPage: %v", err)
	}
	if got := pageIDs(doc); len(got) != 2 || got[1] != "page2" {
		t.Fatalf("pagina non aggiunta in coda: %v", got)
	}
	// La pagina nuova è un container VALIDO: un nodo può nascerci dentro
	// (parentExists guarda le pagine oltre ai nodi).
	if err := Apply(doc, createOp(childOf("n1", "page2", "a0"))); err != nil {
		t.Fatalf("createNode sotto la pagina nuova: %v", err)
	}
}

func TestApplyCreatePageRejectsEmptyAndDuplicate(t *testing.T) {
	for _, tc := range []struct {
		name string
		page *brawtv1.Page
	}{
		{"nil", nil},
		{"id vuoto", &brawtv1.Page{Name: "senza id"}},
		// Un id già preso da una PAGINA: la seconda renderebbe la prima
		// irraggiungibile e i nodi di entrambe indistinguibili.
		{"id di una pagina esistente", &brawtv1.Page{Id: "page1", Name: "doppione"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			doc := NewDocument("doc1", "Untitled")
			before := len(doc.GetPages())
			if err := Apply(doc, createPageOp(tc.page)); err == nil {
				t.Fatal("createPage accettata: doveva essere rifiutata")
			}
			if len(doc.GetPages()) != before {
				t.Fatalf("pagina aggiunta nonostante il rifiuto: %v", pageIDs(doc))
			}
		})
	}
}

// Un id già preso da un NODO è altrettanto inammissibile: parentExists risponde
// "sì" sia per i nodi sia per le pagine (internal/core/tree.go), quindi due
// container omonimi renderebbero ambiguo il parent di chiunque li nomini -- e
// cancellare il nodo lascerebbe in piedi una pagina con lo stesso id.
func TestApplyCreatePageRejectsNodeIDCollision(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	if err := Apply(doc, createOp(rectNode("n1", 0, 0))); err != nil {
		t.Fatalf("setup: %v", err)
	}
	if err := Apply(doc, createPageOp(&brawtv1.Page{Id: "n1", Name: "collide"})); err == nil {
		t.Fatal("createPage con l'id di un nodo accettata: doveva essere rifiutata")
	}
	if len(doc.GetPages()) != 1 {
		t.Fatalf("pagina aggiunta nonostante il rifiuto: %v", pageIDs(doc))
	}
}

func TestApplyRenamePage(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	if err := Apply(doc, renamePageOp("page1", "Copertina")); err != nil {
		t.Fatalf("Apply renamePage: %v", err)
	}
	if got := doc.GetPages()[0].GetName(); got != "Copertina" {
		t.Fatalf("nome non scritto: %q", got)
	}
}

func TestApplyRenamePageMissing(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	if err := Apply(doc, renamePageOp("ghost", "x")); !errors.Is(err, ErrPageNotFound) {
		t.Fatalf("expected ErrPageNotFound, got %v", err)
	}
}

// La cascata di DeletePage è quella di DeleteNode portata alla radice: la pagina
// se ne va con TUTTO ciò che le pende sotto, a qualunque profondità. Senza,
// resterebbero nodi con un parent_id che non esiste più -- gli stessi orfani che
// applyCreate rifiuta di creare.
func TestApplyDeletePageCascadesOverItsNodes(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	mustApply(t, doc, createPageOp(&brawtv1.Page{Id: "page2", Name: "Page 2"}))
	mustApply(t, doc, createOp(groupNode("g1")))                // page1
	mustApply(t, doc, createOp(childOf("c1", "g1", "a1")))      // page1 > g1
	mustApply(t, doc, createOp(childOf("d1", "c1", "a1")))      // page1 > g1 > c1
	mustApply(t, doc, createOp(childOf("keep", "page2", "a1"))) // page2

	if err := Apply(doc, deletePageOp("page1")); err != nil {
		t.Fatalf("Apply deletePage: %v", err)
	}
	if got := pageIDs(doc); len(got) != 1 || got[0] != "page2" {
		t.Fatalf("pagina non rimossa: %v", got)
	}
	for _, id := range []string{"g1", "c1", "d1"} {
		if _, ok := doc.Nodes[id]; ok {
			t.Fatalf("nodo %s sopravvissuto alla cancellazione della sua pagina", id)
		}
	}
	if _, ok := doc.Nodes["keep"]; !ok {
		t.Fatal("la cascata ha portato via un nodo di un'ALTRA pagina")
	}
}

// L'ULTIMA pagina non si cancella: un documento senza pagine non ha nessun posto
// in cui creare un nodo (applyCreate rifiuterebbe ogni parent), quindi sarebbe
// un documento in cui non si può più disegnare -- e nessun op potrebbe più
// ripararlo se non un createPage, che l'utente non ha modo di chiedere quando il
// selettore è vuoto.
func TestApplyDeletePageRefusesTheLastOne(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	mustApply(t, doc, createOp(rectNode("n1", 0, 0)))
	if err := Apply(doc, deletePageOp("page1")); !errors.Is(err, ErrLastPage) {
		t.Fatalf("expected ErrLastPage, got %v", err)
	}
	if len(doc.GetPages()) != 1 {
		t.Fatal("pagina rimossa nonostante il rifiuto")
	}
	if _, ok := doc.Nodes["n1"]; !ok {
		t.Fatal("cascata eseguita nonostante il rifiuto")
	}
}

func TestApplyDeletePageMissing(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	mustApply(t, doc, createPageOp(&brawtv1.Page{Id: "page2", Name: "Page 2"}))
	if err := Apply(doc, deletePageOp("ghost")); !errors.Is(err, ErrPageNotFound) {
		t.Fatalf("expected ErrPageNotFound, got %v", err)
	}
	if len(doc.GetPages()) != 2 {
		t.Fatalf("pagine toccate da un op rifiutato: %v", pageIDs(doc))
	}
}
