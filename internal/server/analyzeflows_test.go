package server

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// TestAnalyzeFlows: l'RPC analizza lo snapshot corrente dell'hub -- un flusso
// con una schermata irraggiungibile e un vicolo cieco -- e filtra per flow_id.
func TestAnalyzeFlows(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()
	info, err := c.CreateDocument(ctx, connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: "Flussi"}))
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
			Id: id, ParentId: "page1", OrderKey: "a" + id, Name: "Schermata " + id, Visible: true, Opacity: 1, Width: 10, Height: 10,
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
		t.Fatalf("report = %v, want f1 e f2 in ordine", reps)
	}
	kinds := map[string]string{}
	for _, is := range reps[0].GetIssues() {
		kinds[is.GetKind()] = is.GetNodeId()
	}
	if kinds["unreachable"] != "x" || kinds["dead_end"] != "b" {
		t.Errorf("issue di f1 = %v", reps[0].GetIssues())
	}
	if len(reps[1].GetIssues()) != 1 || reps[1].GetIssues()[0].GetKind() != "empty" {
		t.Errorf("issue di f2 = %v", reps[1].GetIssues())
	}
	if len(reps[0].GetPaths()) != 1 || len(reps[0].GetPaths()[0].GetTransitionIds()) != 1 {
		t.Errorf("percorsi di f1 = %v", reps[0].GetPaths())
	}

	one, err := c.AnalyzeFlows(ctx, connect.NewRequest(&opendesignerv1.AnalyzeFlowsRequest{DocId: docID, FlowId: "f2"}))
	if err != nil || len(one.Msg.GetReports()) != 1 {
		t.Fatalf("filtro: %v %v", one, err)
	}
	none, err := c.AnalyzeFlows(ctx, connect.NewRequest(&opendesignerv1.AnalyzeFlowsRequest{DocId: docID, FlowId: "boh"}))
	if err != nil || len(none.Msg.GetReports()) != 0 {
		t.Fatalf("flusso inesistente: %v %v", none, err)
	}
	if _, err := c.AnalyzeFlows(ctx, connect.NewRequest(&opendesignerv1.AnalyzeFlowsRequest{DocId: "non-un-uuid"})); err == nil {
		t.Fatal("doc_id non valido deve dare errore")
	}
}
