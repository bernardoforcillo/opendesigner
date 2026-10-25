package server

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1/opendesignerv1connect"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

// TestDevModeThroughTheServer: a frame is marked ready for dev, annotated and edited through
// SubmitOp; CompareReady reports the edit; the marks survive later ops (the hub copies the document
// on every op) and a restart of the server.
func TestDevModeThroughTheServer(t *testing.T) {
	ws := t.TempDir()
	c, _ := newTestClientWithManager(t, ws)
	ctx := context.Background()
	info, err := c.CreateDocument(ctx, connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: "Dev"}))
	if err != nil {
		t.Fatal(err)
	}
	docID := info.Msg.GetId()
	n := 0
	send := func(op *opendesignerv1.Op) error {
		t.Helper()
		n++
		op.OpId = "op-" + string(rune('a'+n))
		op.DocId = docID
		_, err := c.SubmitOp(ctx, connect.NewRequest(&opendesignerv1.SubmitOpRequest{DocId: docID, ClientId: "t", Op: op}))
		return err
	}
	must := func(op *opendesignerv1.Op) {
		t.Helper()
		if err := send(op); err != nil {
			t.Fatalf("op %d: %v", n, err)
		}
	}
	must(&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: &opendesignerv1.Node{
		Id: "home", ParentId: "page1", OrderKey: "a1", Name: "Home", Visible: true, Opacity: 1, Width: 200, Height: 200,
		Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}}}}})
	must(&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: &opendesignerv1.Node{
		Id: "btn", ParentId: "home", OrderKey: "a1", Name: "Buy", Visible: true, Opacity: 1, Width: 100, Height: 40,
		Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}}}}}})
	must(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetReadyForDev{SetReadyForDev: &opendesignerv1.SetReadyForDev{
		Ready: &opendesignerv1.ReadyForDev{NodeId: "home", Note: "go", MarkedBy: "Ana", MarkedAt: 42}}}})
	must(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetAnnotation{SetAnnotation: &opendesignerv1.SetAnnotation{
		Annotation: &opendesignerv1.Annotation{Id: "a1", NodeId: "btn", Category: "interaction", Text: "Opens the cart"}}}})
	// A rejected op reaches the caller as an error.
	if err := send(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetAnnotation{SetAnnotation: &opendesignerv1.SetAnnotation{
		Annotation: &opendesignerv1.Annotation{Id: "a2", NodeId: "btn", Category: "loud", Text: "x"}}}}); err == nil {
		t.Error("an annotation with an unknown category must be rejected")
	}
	// Later ops (every one copies the document) must not lose the dev mode data.
	must(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: "btn", Patch: &opendesignerv1.Node{Width: 160}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"width"}}}}})

	cmp, err := c.CompareReady(ctx, connect.NewRequest(&opendesignerv1.CompareReadyRequest{DocId: docID, NodeId: "home"}))
	if err != nil {
		t.Fatal(err)
	}
	if cmp.Msg.GetMarkedAt() != 42 || len(cmp.Msg.GetChanges()) != 1 {
		t.Fatalf("comparison = %v", cmp.Msg)
	}
	ch := cmp.Msg.GetChanges()[0]
	if ch.GetNodeId() != "btn" || ch.GetProperty() != "width" || ch.GetBefore() != "100" || ch.GetAfter() != "160" || ch.GetKind() != "changed" {
		t.Errorf("change = %v", ch)
	}
	if _, err := c.CompareReady(ctx, connect.NewRequest(&opendesignerv1.CompareReadyRequest{DocId: docID, NodeId: "btn"})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("a frame that was never marked: %v", err)
	}

	check := func(c opendesignerv1connect.DocumentServiceClient, label string) {
		t.Helper()
		open, err := c.OpenDocument(ctx, connect.NewRequest(&opendesignerv1.OpenRequest{DocId: docID}))
		if err != nil {
			t.Fatal(err)
		}
		doc := open.Msg.GetSnapshot()
		if r := doc.GetReadyForDev()["home"]; r == nil || r.GetNote() != "go" || len(r.GetSnapshot()) != 2 {
			t.Errorf("%s: ready entry = %v", label, r)
		}
		if a := doc.GetAnnotations()["a1"]; a == nil || a.GetText() != "Opens the cart" {
			t.Errorf("%s: annotation = %v", label, a)
		}
	}
	check(c, "live")

	// A fresh server over the same workspace (the document is read back from disk).
	c2, _ := newTestClientWithManager(t, ws)
	check(c2, "after restart")
}
