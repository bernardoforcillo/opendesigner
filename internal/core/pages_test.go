package core

import (
	"errors"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

func createPageOp(p *opendesignerv1.Page) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreatePage{CreatePage: &opendesignerv1.CreatePage{Page: p}}}
}

func deletePageOp(id string) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeletePage{DeletePage: &opendesignerv1.DeletePage{Id: id}}}
}

func renamePageOp(id, name string) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_RenamePage{RenamePage: &opendesignerv1.RenamePage{Id: id, Name: name}}}
}

func pageIDs(doc *opendesignerv1.Document) []string {
	out := make([]string, 0, len(doc.GetPages()))
	for _, p := range doc.GetPages() {
		out = append(out, p.GetId())
	}
	return out
}

func TestApplyCreatePage(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	if err := Apply(doc, createPageOp(&opendesignerv1.Page{Id: "page2", Name: "Page 2"})); err != nil {
		t.Fatalf("Apply createPage: %v", err)
	}
	if got := pageIDs(doc); len(got) != 2 || got[1] != "page2" {
		t.Fatalf("page not appended at the end: %v", got)
	}
	// The new page is a VALID container: a node can be born inside it
	// (parentExists looks at pages as well as nodes).
	if err := Apply(doc, createOp(childOf("n1", "page2", "a0"))); err != nil {
		t.Fatalf("createNode under the new page: %v", err)
	}
}

func TestApplyCreatePageRejectsEmptyAndDuplicate(t *testing.T) {
	for _, tc := range []struct {
		name string
		page *opendesignerv1.Page
	}{
		{"nil", nil},
		{"empty id", &opendesignerv1.Page{Name: "no id"}},
		// An id already taken by a PAGE: the second would make the first
		// unreachable and the nodes of both indistinguishable.
		{"id of an existing page", &opendesignerv1.Page{Id: "page1", Name: "duplicate"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			doc := NewDocument("doc1", "Untitled")
			before := len(doc.GetPages())
			if err := Apply(doc, createPageOp(tc.page)); err == nil {
				t.Fatal("createPage accepted: it should have been rejected")
			}
			if len(doc.GetPages()) != before {
				t.Fatalf("page added despite the rejection: %v", pageIDs(doc))
			}
		})
	}
}

// An id already taken by a NODE is just as inadmissible: parentExists answers
// "yes" for both nodes and pages (internal/core/tree.go), so two
// containers with the same id would make the parent of anyone naming them
// ambiguous -- and deleting the node would leave a page with the same id standing.
func TestApplyCreatePageRejectsNodeIDCollision(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	if err := Apply(doc, createOp(rectNode("n1", 0, 0))); err != nil {
		t.Fatalf("setup: %v", err)
	}
	if err := Apply(doc, createPageOp(&opendesignerv1.Page{Id: "n1", Name: "collide"})); err == nil {
		t.Fatal("createPage with a node's id accepted: it should have been rejected")
	}
	if len(doc.GetPages()) != 1 {
		t.Fatalf("page added despite the rejection: %v", pageIDs(doc))
	}
}

func TestApplyRenamePage(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	if err := Apply(doc, renamePageOp("page1", "Cover")); err != nil {
		t.Fatalf("Apply renamePage: %v", err)
	}
	if got := doc.GetPages()[0].GetName(); got != "Cover" {
		t.Fatalf("name not written: %q", got)
	}
}

func TestApplyRenamePageMissing(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	if err := Apply(doc, renamePageOp("ghost", "x")); !errors.Is(err, ErrPageNotFound) {
		t.Fatalf("expected ErrPageNotFound, got %v", err)
	}
}

// DeletePage's cascade is DeleteNode's carried to the root: the page
// goes away with EVERYTHING hanging under it, at any depth. Without it,
// nodes would remain with a parent_id that no longer exists -- the same
// orphans applyCreate refuses to create.
func TestApplyDeletePageCascadesOverItsNodes(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	mustApply(t, doc, createPageOp(&opendesignerv1.Page{Id: "page2", Name: "Page 2"}))
	mustApply(t, doc, createOp(groupNode("g1")))                // page1
	mustApply(t, doc, createOp(childOf("c1", "g1", "a1")))      // page1 > g1
	mustApply(t, doc, createOp(childOf("d1", "c1", "a1")))      // page1 > g1 > c1
	mustApply(t, doc, createOp(childOf("keep", "page2", "a1"))) // page2

	if err := Apply(doc, deletePageOp("page1")); err != nil {
		t.Fatalf("Apply deletePage: %v", err)
	}
	if got := pageIDs(doc); len(got) != 1 || got[0] != "page2" {
		t.Fatalf("page not removed: %v", got)
	}
	for _, id := range []string{"g1", "c1", "d1"} {
		if _, ok := doc.Nodes[id]; ok {
			t.Fatalf("node %s survived the deletion of its page", id)
		}
	}
	if _, ok := doc.Nodes["keep"]; !ok {
		t.Fatal("the cascade took away a node of ANOTHER page")
	}
}

// The LAST page is not deleted: a document without pages has nowhere to
// create a node (applyCreate would reject every parent), so it would be
// a document in which you can no longer draw -- and no op could repair
// it except a createPage, which the user has no way to ask for when the
// selector is empty.
func TestApplyDeletePageRefusesTheLastOne(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	mustApply(t, doc, createOp(rectNode("n1", 0, 0)))
	if err := Apply(doc, deletePageOp("page1")); !errors.Is(err, ErrLastPage) {
		t.Fatalf("expected ErrLastPage, got %v", err)
	}
	if len(doc.GetPages()) != 1 {
		t.Fatal("page removed despite the rejection")
	}
	if _, ok := doc.Nodes["n1"]; !ok {
		t.Fatal("cascade performed despite the rejection")
	}
}

func TestApplyDeletePageMissing(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	mustApply(t, doc, createPageOp(&opendesignerv1.Page{Id: "page2", Name: "Page 2"}))
	if err := Apply(doc, deletePageOp("ghost")); !errors.Is(err, ErrPageNotFound) {
		t.Fatalf("expected ErrPageNotFound, got %v", err)
	}
	if len(doc.GetPages()) != 2 {
		t.Fatalf("pages touched by a rejected op: %v", pageIDs(doc))
	}
}
