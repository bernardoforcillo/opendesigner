package server

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// TestRenderDiagram: the RPC is pure (no document) and tells unreadable text
// (InvalidArgument, with the message to show) apart from a diagram.
func TestRenderDiagram(t *testing.T) {
	c, _ := newTestClientWithManager(t, t.TempDir())
	ctx := context.Background()

	res, err := c.RenderDiagram(ctx, connect.NewRequest(&opendesignerv1.RenderDiagramRequest{Source: "sequenceDiagram\nA->>B: hello"}))
	if err != nil {
		t.Fatal(err)
	}
	if res.Msg.GetKind() != "sequence" || res.Msg.GetWidth() <= 0 || len(res.Msg.GetNodes()) < 5 {
		t.Fatalf("response = kind %q %vx%v, %d nodes", res.Msg.GetKind(), res.Msg.GetWidth(), res.Msg.GetHeight(), len(res.Msg.GetNodes()))
	}
	if root := res.Msg.GetNodes()[0]; root.GetGroup() == nil || root.GetMeta()["diagram.source"] == "" {
		t.Errorf("the root must be a group with the source: %+v", root)
	}

	_, err = c.RenderDiagram(ctx, connect.NewRequest(&opendesignerv1.RenderDiagramRequest{Source: "gantt\ntitle x"}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("code = %v, want InvalidArgument (%v)", connect.CodeOf(err), err)
	}
}
