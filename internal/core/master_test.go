package core

import (
	"errors"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

func updatePageOp(p *opendesignerv1.Page) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_UpdatePage{UpdatePage: &opendesignerv1.UpdatePage{Page: p}}}
}

func TestMasterPagesLifecycle(t *testing.T) {
	doc := NewDocument("doc1", "Book")
	mustApply(t, doc,
		createPageOp(&opendesignerv1.Page{Id: "m1", Name: "A-Master", IsMaster: true}),
		createPageOp(&opendesignerv1.Page{Id: "p2", Name: "Page 2", MasterId: "m1"}),
		updatePageOp(&opendesignerv1.Page{Id: "page1", Name: "Page 1", MasterId: "m1"}),
	)
	if got := doc.Pages[0].GetMasterId(); got != "m1" {
		t.Fatalf("master not applied: %q", got)
	}
	// A master that pages still apply cannot be deleted or demoted.
	if err := Apply(doc, deletePageOp("m1")); !errors.Is(err, ErrMasterInUse) {
		t.Fatalf("delete of a master in use: %v", err)
	}
	if err := Apply(doc, updatePageOp(&opendesignerv1.Page{Id: "m1", Name: "A-Master"})); !errors.Is(err, ErrMasterInUse) {
		t.Fatalf("demote of a master in use: %v", err)
	}
	// Detached, it can go.
	mustApply(t, doc,
		updatePageOp(&opendesignerv1.Page{Id: "page1", Name: "Page 1"}),
		updatePageOp(&opendesignerv1.Page{Id: "p2", Name: "Page 2"}),
		deletePageOp("m1"),
	)
	if got := pageIDs(doc); len(got) != 2 {
		t.Fatalf("pages after deleting the master: %v", got)
	}
}

func TestMasterPageRules(t *testing.T) {
	doc := NewDocument("doc1", "Book")
	mustApply(t, doc, createPageOp(&opendesignerv1.Page{Id: "m1", Name: "M", IsMaster: true}))

	cases := map[string]struct {
		op   *opendesignerv1.Op
		want error
	}{
		"master applying a master":   {createPageOp(&opendesignerv1.Page{Id: "m2", IsMaster: true, MasterId: "m1"}), ErrBadMaster},
		"master_id of a normal page": {createPageOp(&opendesignerv1.Page{Id: "p2", MasterId: "page1"}), ErrBadMaster},
		"master_id that is missing":  {updatePageOp(&opendesignerv1.Page{Id: "page1", MasterId: "nope"}), ErrBadMaster},
		"update of a missing page":   {updatePageOp(&opendesignerv1.Page{Id: "nope"}), ErrPageNotFound},
		"the last regular page":      {updatePageOp(&opendesignerv1.Page{Id: "page1", Name: "x", IsMaster: true}), ErrLastPage},
	}
	for name, c := range cases {
		if err := Apply(doc, c.op); !errors.Is(err, c.want) {
			t.Errorf("%s: got %v, want %v", name, err, c.want)
		}
	}
	// Deleting the only regular page is refused even though a master remains.
	if err := Apply(doc, deletePageOp("page1")); !errors.Is(err, ErrLastPage) {
		t.Errorf("delete of the last regular page: %v", err)
	}
}
