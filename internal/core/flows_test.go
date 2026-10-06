package core

import (
	"errors"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

func mustMask(paths ...string) *fieldmaskpb.FieldMask { return &fieldmaskpb.FieldMask{Paths: paths} }

func flowRect(id, parent string) *opendesignerv1.Node {
	return &opendesignerv1.Node{Id: id, ParentId: parent, OrderKey: id, Visible: true, Opacity: 1,
		Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}}}
}

func mustApplyFlow(t *testing.T, doc *opendesignerv1.Document, op *opendesignerv1.Op) {
	t.Helper()
	if err := Apply(doc, op); err != nil {
		t.Fatal(err)
	}
}

func flowCreateOp(n *opendesignerv1.Node) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}}
}

func setFlowOp(f *opendesignerv1.Flow) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetFlow{SetFlow: &opendesignerv1.SetFlow{Flow: f}}}
}

func setTransitionOp(tr *opendesignerv1.Transition) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetTransition{SetTransition: &opendesignerv1.SetTransition{Transition: tr}}}
}

func flowDoc(t *testing.T) *opendesignerv1.Document {
	doc := NewDocument("d", "t")
	for _, id := range []string{"a", "b"} {
		mustApplyFlow(t, doc, flowCreateOp(flowRect(id, "page1")))
	}
	mustApplyFlow(t, doc, setFlowOp(&opendesignerv1.Flow{Id: "f1", Name: "F", StartId: "a"}))
	mustApplyFlow(t, doc, setTransitionOp(&opendesignerv1.Transition{Id: "t1", FlowId: "f1", FromId: "a", ToId: "b"}))
	return doc
}

func TestFlowRejections(t *testing.T) {
	doc := flowDoc(t)
	before := proto.Clone(doc)
	cases := []struct {
		name string
		op   *opendesignerv1.Op
		want error
	}{
		{"flow without id", setFlowOp(&opendesignerv1.Flow{}), ErrNilFlow},
		{"nonexistent start", setFlowOp(&opendesignerv1.Flow{Id: "f2", StartId: "ghost"}), ErrNodeNotFound},
		{"transition without id", setTransitionOp(&opendesignerv1.Transition{FlowId: "f1", FromId: "a", ToId: "b"}), ErrNilTransition},
		{"nonexistent flow", setTransitionOp(&opendesignerv1.Transition{Id: "x", FlowId: "no", FromId: "a", ToId: "b"}), ErrFlowNotFound},
		{"nonexistent destination", setTransitionOp(&opendesignerv1.Transition{Id: "x", FlowId: "f1", FromId: "a", ToId: "ghost"}), ErrNodeNotFound},
		{"nonexistent hotspot", setTransitionOp(&opendesignerv1.Transition{Id: "x", FlowId: "f1", FromId: "a", ToId: "b", ElementId: "ghost"}), ErrNodeNotFound},
		{"delete nonexistent flow", &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteFlow{DeleteFlow: &opendesignerv1.DeleteFlow{Id: "ghost"}}}, ErrFlowNotFound},
		{"delete nonexistent transition", &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteTransition{DeleteTransition: &opendesignerv1.DeleteTransition{Id: "ghost"}}}, ErrTransitionNotFound},
	}
	for _, c := range cases {
		if err := Apply(doc, c.op); !errors.Is(err, c.want) {
			t.Errorf("%s: err = %v, want %v", c.name, err, c.want)
		}
	}
	if !proto.Equal(before, doc) {
		t.Fatal("a rejected op modified the document")
	}
}

// The server's copy-on-write clone shares the nodes but must NOT let the flow
// cascade leak into the previous generation.
func TestCascadeDoesNotMutateSharedTransitions(t *testing.T) {
	doc := flowDoc(t)
	mustApplyFlow(t, doc, setTransitionOp(&opendesignerv1.Transition{Id: "t2", FlowId: "f1", FromId: "a", ToId: "b", ElementId: "a"}))
	prev := doc.Transitions["t2"]
	snapshot := proto.Clone(prev)
	// a "new generation" that shares the transitions' pointers
	next := &opendesignerv1.Document{Id: doc.Id, Pages: doc.Pages, Nodes: doc.Nodes,
		Flows: map[string]*opendesignerv1.Flow{}, Transitions: map[string]*opendesignerv1.Transition{}}
	for k, v := range doc.Flows {
		next.Flows[k] = v
	}
	for k, v := range doc.Transitions {
		next.Transitions[k] = v
	}
	// deleting "a" (the hotspot and the source) removes t1 and t2; the flow loses its start
	cascadeFlows(next, map[string]bool{"a": true})
	if len(next.Transitions) != 0 {
		t.Fatalf("transitions left: %d", len(next.Transitions))
	}
	if next.Flows["f1"].StartId != "" {
		t.Fatal("start not cleared")
	}
	if doc.Flows["f1"].StartId != "a" || !proto.Equal(prev, snapshot) {
		t.Fatal("the cascade mutated objects shared with the previous generation")
	}
}

func TestMetaMask(t *testing.T) {
	doc := flowDoc(t)
	op := &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: "a", Patch: &opendesignerv1.Node{Meta: map[string]string{"code.route": "/x"}},
		Mask: mustMask("meta"),
	}}}
	mustApplyFlow(t, doc, op)
	if doc.Nodes["a"].Meta["code.route"] != "/x" {
		t.Fatal("meta not written")
	}
	clear := &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{Id: "a", Mask: mustMask("meta")}}}
	mustApplyFlow(t, doc, clear)
	if len(doc.Nodes["a"].Meta) != 0 {
		t.Fatal("meta not cleared by a patch without meta")
	}
}
