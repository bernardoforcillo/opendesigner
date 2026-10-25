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
		"master chain cycle":         {updatePageOp(&opendesignerv1.Page{Id: "m1", IsMaster: true, MasterId: "m1"}), ErrBadMaster},
		"left master not a master":   {createPageOp(&opendesignerv1.Page{Id: "p3", LeftMasterId: "page1"}), ErrBadMaster},
		"master with a left master":  {createPageOp(&opendesignerv1.Page{Id: "m3", IsMaster: true, LeftMasterId: "m1"}), ErrBadMaster},
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

func TestMasterChainsAndStructure(t *testing.T) {
	doc := NewDocument("doc1", "Book")
	mustApply(t, doc,
		createPageOp(&opendesignerv1.Page{Id: "m1", IsMaster: true}),
		createPageOp(&opendesignerv1.Page{Id: "m2", IsMaster: true, MasterId: "m1"}),
		createPageOp(&opendesignerv1.Page{Id: "p2", MasterId: "m2", LeftMasterId: "m1", NumberStyle: "i", NumberStart: 3,
			Slug: 12, Guides: []*opendesignerv1.Guide{{Vertical: true, Position: 40}}, HiddenMasterItems: []string{"x"}}),
	)
	// m1 is the base of m2 and the left master of p2; m2 is applied by p2.
	if err := Apply(doc, deletePageOp("m1")); !errors.Is(err, ErrMasterInUse) {
		t.Fatalf("base master delete: %v", err)
	}
	// A cycle m1 -> m2 -> m1 is refused.
	if err := Apply(doc, updatePageOp(&opendesignerv1.Page{Id: "m1", IsMaster: true, MasterId: "m2"})); !errors.Is(err, ErrBadMaster) {
		t.Fatalf("cycle: %v", err)
	}
	bad := []*opendesignerv1.Page{
		{Id: "p4", NumberStyle: "x"},
		{Id: "p4", Slug: -1},
		{Id: "p4", HiddenMasterItems: []string{""}},
		{Id: "p4", Guides: []*opendesignerv1.Guide{{Position: 1e12}}},
	}
	for i, p := range bad {
		if err := Apply(doc, createPageOp(p)); !errors.Is(err, ErrBadPageSetup) {
			t.Errorf("bad structure %d: %v", i, err)
		}
	}
}

func TestMovePage(t *testing.T) {
	doc := NewDocument("doc1", "Book")
	mustApply(t, doc,
		createPageOp(&opendesignerv1.Page{Id: "b"}),
		createPageOp(&opendesignerv1.Page{Id: "c"}),
	)
	mv := func(id string, i uint32) *opendesignerv1.Op {
		return &opendesignerv1.Op{Kind: &opendesignerv1.Op_MovePage{MovePage: &opendesignerv1.MovePage{Id: id, Index: i}}}
	}
	mustApply(t, doc, mv("c", 0))
	if got := pageIDs(doc); got[0] != "c" || got[1] != "page1" || got[2] != "b" {
		t.Fatalf("order after move: %v", got)
	}
	mustApply(t, doc, mv("c", 2))
	if got := pageIDs(doc); got[2] != "c" {
		t.Fatalf("order after move back: %v", got)
	}
	if err := Apply(doc, mv("c", 3)); !errors.Is(err, ErrBadPageSetup) {
		t.Fatalf("index out of range: %v", err)
	}
	if err := Apply(doc, mv("zz", 0)); !errors.Is(err, ErrPageNotFound) {
		t.Fatalf("missing page: %v", err)
	}
}
