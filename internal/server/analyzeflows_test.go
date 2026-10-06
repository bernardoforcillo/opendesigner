package server

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// TestAnalyzeFlows: the RPC analyses the hub's current snapshot -- a flow
// with an unreachable screen and a dead end -- and filters by flow_id.
func TestAnalyzeFlows(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()
	info, err := c.CreateDocument(ctx, connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: "Flows"}))
	if err != nil {
		t.Fatal(err)
	}
	docID := info.Msg.GetId()
	n := 0
	send := func(op *opendesignerv1.Op) {
		t.Helper()
		n++
		op.OpId = "op-" + string(rune('a'+n))
		op.DocId = docID
		if _, err := c.SubmitOp(ctx, connect.NewRequest(&opendesignerv1.SubmitOpRequest{DocId: docID, ClientId: "t", Op: op})); err != nil {
			t.Fatalf("SubmitOp %d: %v", n, err)
		}
	}
	for _, id := range []string{"a", "b", "x"} {
		send(&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: &opendesignerv1.Node{
			Id: id, ParentId: "page1", OrderKey: "a" + id, Name: "Screen " + id, Visible: true, Opacity: 1, Width: 10, Height: 10,
		}}}})
	}
	send(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetFlow{SetFlow: &opendesignerv1.SetFlow{Flow: &opendesignerv1.Flow{Id: "f1", Name: "F1", StartId: "a"}}}})
	send(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetFlow{SetFlow: &opendesignerv1.SetFlow{Flow: &opendesignerv1.Flow{Id: "f2", Name: "F2"}}}})
	send(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetTransition{SetTransition: &opendesignerv1.SetTransition{Transition: &opendesignerv1.Transition{
		Id: "t1", FlowId: "f1", FromId: "a", ToId: "b", Trigger: "click",
	}}}})
	send(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetTransition{SetTransition: &opendesignerv1.SetTransition{Transition: &opendesignerv1.Transition{
		Id: "t2", FlowId: "f1", FromId: "x", ToId: "b", Trigger: "click",
	}}}})

	all, err := c.AnalyzeFlows(ctx, connect.NewRequest(&opendesignerv1.AnalyzeFlowsRequest{DocId: docID}))
	if err != nil {
		t.Fatal(err)
	}
	reps := all.Msg.GetReports()
	if len(reps) != 2 || reps[0].GetFlowId() != "f1" || reps[1].GetFlowId() != "f2" {
		t.Fatalf("reports = %v, want f1 and f2 in order", reps)
	}
	kinds := map[string]string{}
	for _, is := range reps[0].GetIssues() {
		kinds[is.GetKind()] = is.GetNodeId()
	}
	if kinds["unreachable"] != "x" || kinds["dead_end"] != "b" {
		t.Errorf("issues of f1 = %v", reps[0].GetIssues())
	}
	if len(reps[1].GetIssues()) != 1 || reps[1].GetIssues()[0].GetKind() != "empty" {
		t.Errorf("issues of f2 = %v", reps[1].GetIssues())
	}
	if len(reps[0].GetPaths()) != 1 || len(reps[0].GetPaths()[0].GetTransitionIds()) != 1 {
		t.Errorf("paths of f1 = %v", reps[0].GetPaths())
	}

	one, err := c.AnalyzeFlows(ctx, connect.NewRequest(&opendesignerv1.AnalyzeFlowsRequest{DocId: docID, FlowId: "f2"}))
	if err != nil || len(one.Msg.GetReports()) != 1 {
		t.Fatalf("filter: %v %v", one, err)
	}
	none, err := c.AnalyzeFlows(ctx, connect.NewRequest(&opendesignerv1.AnalyzeFlowsRequest{DocId: docID, FlowId: "dunno"}))
	if err != nil || len(none.Msg.GetReports()) != 0 {
		t.Fatalf("nonexistent flow: %v %v", none, err)
	}
	if _, err := c.AnalyzeFlows(ctx, connect.NewRequest(&opendesignerv1.AnalyzeFlowsRequest{DocId: "not-a-uuid"})); err == nil {
		t.Fatal("an invalid doc_id must give an error")
	}
}
