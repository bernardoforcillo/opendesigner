package store

import (
	"testing"

	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func rec(seq uint64, op *brawtv1.Op) *brawtv1.OpRecord {
	return &brawtv1.OpRecord{Seq: seq, Ts: timestamppb.New(timeZero()), ClientId: "c1", Op: op}
}

func createOp(id string, x float64) *brawtv1.Op {
	return &brawtv1.Op{OpId: "op-" + id, DocId: "doc1", Kind: &brawtv1.Op_CreateNode{CreateNode: &brawtv1.CreateNode{
		Node: &brawtv1.Node{Id: id, ParentId: "page1", OrderKey: "a0", Visible: true, Opacity: 1, X: x,
			Shape: &brawtv1.Node_Rect{Rect: &brawtv1.RectNode{}}},
	}}}
}

func TestAppendReplay(t *testing.T) {
	dir := t.TempDir()
	b, err := Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Append(rec(1, createOp("n1", 5))); err != nil {
		t.Fatal(err)
	}
	if err := b.Append(rec(2, createOp("n2", 9))); err != nil {
		t.Fatal(err)
	}
	// riapri da zero: deve ricostruire dallo snapshot(vuoto)+oplog
	b2, err := Open(dir, "doc1", "Untitled")
	if err != nil {
		t.Fatal(err)
	}
	doc, seq, err := b2.Load()
	if err != nil {
		t.Fatal(err)
	}
	if seq != 2 {
		t.Fatalf("seq = %d, want 2", seq)
	}
	if len(doc.Nodes) != 2 {
		t.Fatalf("nodes = %d, want 2", len(doc.Nodes))
	}
}

func TestSnapshotTruncatesOplog(t *testing.T) {
	dir := t.TempDir()
	b, _ := Open(dir, "doc1", "Untitled")
	_ = b.Append(rec(1, createOp("n1", 5)))
	doc, seq, _ := b.Load()
	if err := b.Snapshot(doc, seq); err != nil {
		t.Fatal(err)
	}
	// dopo lo snapshot, un nuovo op continua da seq+1
	_ = b.Append(rec(2, &brawtv1.Op{OpId: "m", DocId: "doc1", Kind: &brawtv1.Op_SetProps{SetProps: &brawtv1.SetProperties{
		Id: "n1", Patch: &brawtv1.Node{X: 99}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"x"}}}}}))
	b2, _ := Open(dir, "doc1", "Untitled")
	doc2, seq2, _ := b2.Load()
	if seq2 != 2 || doc2.Nodes["n1"].X != 99 {
		t.Fatalf("post-snapshot replay wrong: seq=%d x=%v", seq2, doc2.Nodes["n1"].X)
	}
}
