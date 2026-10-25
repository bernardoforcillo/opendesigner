package core

import (
	"errors"
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
)

func annotateOp(a *opendesignerv1.Annotation) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetAnnotation{SetAnnotation: &opendesignerv1.SetAnnotation{Annotation: a}}}
}

func markOp(r *opendesignerv1.ReadyForDev) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetReadyForDev{SetReadyForDev: &opendesignerv1.SetReadyForDev{Ready: r}}}
}

// devDoc: a frame "f" with a rectangle "r" inside, and a loose rectangle "x".
func devDoc(t *testing.T) *opendesignerv1.Document {
	doc := NewDocument("d", "t")
	mustApplyFlow(t, doc, flowCreateOp(frameNode("f", false)))
	f := doc.Nodes["f"]
	f.ParentId = "page1"
	mustApplyFlow(t, doc, flowCreateOp(flowRect("r", "f")))
	mustApplyFlow(t, doc, flowCreateOp(flowRect("x", "page1")))
	return doc
}

func TestAnnotationRoundTripAndRejections(t *testing.T) {
	doc := devDoc(t)
	ok := &opendesignerv1.Annotation{Id: "a1", NodeId: "r", Category: "interaction", Text: "Opens the cart", Author: "Ana", CreatedAt: 10}
	mustApplyFlow(t, doc, annotateOp(ok))
	if got := doc.GetAnnotations()["a1"]; !proto.Equal(got, ok) {
		t.Fatalf("stored %v, want %v", got, ok)
	}
	// An upsert replaces it.
	edited := proto.Clone(ok).(*opendesignerv1.Annotation)
	edited.Text = "Opens the cart as a sheet"
	mustApplyFlow(t, doc, annotateOp(edited))
	if doc.Annotations["a1"].GetText() != edited.Text || len(doc.Annotations) != 1 {
		t.Errorf("an upsert must replace the annotation: %v", doc.Annotations)
	}

	before := proto.Clone(doc)
	cases := []struct {
		name string
		op   *opendesignerv1.Op
		want error
	}{
		{"no id", annotateOp(&opendesignerv1.Annotation{NodeId: "r", Category: "note", Text: "x"}), ErrAnnotation},
		{"unknown category", annotateOp(&opendesignerv1.Annotation{Id: "b", NodeId: "r", Category: "loud", Text: "x"}), ErrAnnotation},
		{"empty text", annotateOp(&opendesignerv1.Annotation{Id: "b", NodeId: "r", Category: "note"}), ErrAnnotation},
		{"long text", annotateOp(&opendesignerv1.Annotation{Id: "b", NodeId: "r", Category: "note", Text: strings.Repeat("x", MaxAnnotationRunes+1)}), ErrAnnotation},
		{"long author", annotateOp(&opendesignerv1.Annotation{Id: "b", NodeId: "r", Category: "note", Text: "x", Author: strings.Repeat("x", MaxDevAuthorRunes+1)}), ErrAnnotation},
		{"missing node", annotateOp(&opendesignerv1.Annotation{Id: "b", NodeId: "ghost", Category: "note", Text: "x"}), ErrNodeNotFound},
		{"delete unknown", &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteAnnotation{DeleteAnnotation: &opendesignerv1.DeleteAnnotation{Id: "ghost"}}}, ErrAnnotationNotFound},
	}
	for _, c := range cases {
		if err := Apply(doc, c.op); !errors.Is(err, c.want) {
			t.Errorf("%s: err = %v, want %v", c.name, err, c.want)
		}
	}
	if !proto.Equal(before, doc) {
		t.Error("a rejected op must leave the document untouched")
	}
	mustApplyFlow(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteAnnotation{DeleteAnnotation: &opendesignerv1.DeleteAnnotation{Id: "a1"}}})
	if len(doc.Annotations) != 0 {
		t.Error("delete must remove the annotation")
	}
}

func TestAnnotationsSurviveTheirNodeBeingDeleted(t *testing.T) {
	doc := devDoc(t)
	mustApplyFlow(t, doc, annotateOp(&opendesignerv1.Annotation{Id: "a1", NodeId: "x", Category: "note", Text: "keep"}))
	mustApplyFlow(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteNode{DeleteNode: &opendesignerv1.DeleteNode{Id: "x"}}})
	if doc.Annotations["a1"] == nil {
		t.Error("deleting a node must leave its annotations (undoing the deletion brings the node back)")
	}
}

func TestReadyForDevTakesTheSnapshotOnTheServer(t *testing.T) {
	doc := devDoc(t)
	// A client-supplied snapshot is ignored: the baseline is the document's own state.
	forged := &opendesignerv1.ReadyForDev{NodeId: "f", Note: "ship it", MarkedBy: "Ana", MarkedAt: 5,
		Snapshot: []*opendesignerv1.Node{{Id: "forged"}}}
	mustApplyFlow(t, doc, markOp(forged))
	r := doc.GetReadyForDev()["f"]
	if r == nil || r.GetNote() != "ship it" || r.GetMarkedBy() != "Ana" || r.GetMarkedAt() != 5 {
		t.Fatalf("entry = %v", r)
	}
	var ids []string
	for _, n := range r.GetSnapshot() {
		ids = append(ids, n.GetId())
	}
	if strings.Join(ids, ",") != "f,r" {
		t.Errorf("snapshot = %v, want the frame and its descendants, parents first", ids)
	}
	// The snapshot is a copy: later edits do not reach it.
	doc.Nodes["r"].X = 99
	if r.GetSnapshot()[1].GetX() == 99 {
		t.Error("the snapshot must not alias the live nodes")
	}

	// Marking again takes a new baseline.
	doc.Nodes["r"].X = 7
	mustApplyFlow(t, doc, markOp(&opendesignerv1.ReadyForDev{NodeId: "f"}))
	if got := doc.ReadyForDev["f"].GetSnapshot()[1].GetX(); got != 7 {
		t.Errorf("re-marking must re-snapshot, x = %v", got)
	}

	mustApplyFlow(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_ClearReadyForDev{ClearReadyForDev: &opendesignerv1.ClearReadyForDev{NodeId: "f"}}})
	if len(doc.ReadyForDev) != 0 {
		t.Error("clear must remove the entry")
	}
}

func TestReadyForDevRejections(t *testing.T) {
	doc := devDoc(t)
	before := proto.Clone(doc)
	cases := []struct {
		name string
		op   *opendesignerv1.Op
		want error
	}{
		{"no node", markOp(&opendesignerv1.ReadyForDev{}), ErrReadyForDev},
		{"missing node", markOp(&opendesignerv1.ReadyForDev{NodeId: "ghost"}), ErrNodeNotFound},
		{"not a frame", markOp(&opendesignerv1.ReadyForDev{NodeId: "x"}), ErrReadyForDev},
		{"long note", markOp(&opendesignerv1.ReadyForDev{NodeId: "f", Note: strings.Repeat("x", MaxReadyNoteRunes+1)}), ErrReadyForDev},
		{"clear unmarked", &opendesignerv1.Op{Kind: &opendesignerv1.Op_ClearReadyForDev{ClearReadyForDev: &opendesignerv1.ClearReadyForDev{NodeId: "f"}}}, ErrReadyNotFound},
	}
	for _, c := range cases {
		if err := Apply(doc, c.op); !errors.Is(err, c.want) {
			t.Errorf("%s: err = %v, want %v", c.name, err, c.want)
		}
	}
	if !proto.Equal(before, doc) {
		t.Error("a rejected op must leave the document untouched")
	}
}

func TestReadyFramesAreSortedByMarkingTime(t *testing.T) {
	doc := devDoc(t)
	mustApplyFlow(t, doc, flowCreateOp(frameNode("g", false)))
	doc.Nodes["g"].ParentId = "page1"
	mustApplyFlow(t, doc, markOp(&opendesignerv1.ReadyForDev{NodeId: "g", MarkedAt: 1}))
	mustApplyFlow(t, doc, markOp(&opendesignerv1.ReadyForDev{NodeId: "f", MarkedAt: 2}))
	if got := strings.Join(ReadyFrames(doc), ","); got != "g,f" {
		t.Errorf("ReadyFrames = %s, want g,f", got)
	}
}
