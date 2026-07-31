package core

import (
	"testing"

	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

func rectNode(id string, x, y float64) *brawtv1.Node {
	return &brawtv1.Node{
		Id: id, ParentId: "page1", OrderKey: "a0", Name: "Rect", Visible: true, Opacity: 1,
		X: x, Y: y, Width: 100, Height: 80,
		Shape: &brawtv1.Node_Rect{Rect: &brawtv1.RectNode{}},
	}
}

func TestApplyCreateNode(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	op := &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: rectNode("n1", 10, 20)}}}
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply create: %v", err)
	}
	got, ok := doc.Nodes["n1"]
	if !ok {
		t.Fatal("node n1 not present after create")
	}
	if got.X != 10 || got.Y != 20 {
		t.Fatalf("wrong pos: %v,%v", got.X, got.Y)
	}
}

func TestApplyCreateDuplicateFails(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: rectNode("n1", 0, 0)}}})
	err := Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: rectNode("n1", 5, 5)}}})
	if err == nil {
		t.Fatal("expected error on duplicate create")
	}
}

func TestApplySetPropertiesMoves(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: rectNode("n1", 0, 0)}}})
	op := &brawtv1.Op{Kind: &brawtv1.Op_SetProps{SetProps: &brawtv1.SetProperties{
		Id:    "n1",
		Patch: &brawtv1.Node{X: 42, Y: 7},
		Mask:  &fieldmaskpb.FieldMask{Paths: []string{"x", "y"}},
	}}}
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply setprops: %v", err)
	}
	if doc.Nodes["n1"].X != 42 || doc.Nodes["n1"].Y != 7 {
		t.Fatalf("move not applied: %+v", doc.Nodes["n1"])
	}
}

func TestApplySetPropertiesMissingNode(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	err := Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_SetProps{SetProps: &brawtv1.SetProperties{
		Id: "ghost", Patch: &brawtv1.Node{X: 1}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"x"}},
	}}})
	if err == nil {
		t.Fatal("expected ErrNodeNotFound")
	}
}

func TestApplySetPropertiesMixedMaskIsAllOrNothing(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: rectNode("n1", 0, 0)}}})
	op := &brawtv1.Op{Kind: &brawtv1.Op_SetProps{SetProps: &brawtv1.SetProperties{
		Id:    "n1",
		Patch: &brawtv1.Node{X: 42, Y: 7},
		Mask:  &fieldmaskpb.FieldMask{Paths: []string{"x", "bogus"}},
	}}}
	if err := Apply(doc, op); err == nil {
		t.Fatal("expected error for unsupported mask path")
	}
	got := doc.Nodes["n1"]
	if got.X != 0 || got.Y != 0 {
		t.Fatalf("partial mutation leaked despite error: %+v", got)
	}
}

func TestApplyDeleteNode(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{Node: rectNode("n1", 0, 0)}}})
	if err := Apply(doc, &brawtv1.Op{Kind: &brawtv1.Op_DeleteNode{DeleteNode: &brawtv1.DeleteNode{Id: "n1"}}}); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, ok := doc.Nodes["n1"]; ok {
		t.Fatal("node still present after delete")
	}
}
