package server

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

func TestRenderBoard(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()
	res, err := c.RenderBoard(ctx, connect.NewRequest(&opendesignerv1.RenderBoardRequest{Kind: "table", Rows: 2, Columns: 2, Items: []string{"A", "B"}}))
	if err != nil {
		t.Fatal(err)
	}
	// A group, then 2x2 cells with their texts.
	if len(res.Msg.GetNodes()) != 1+4*2 || res.Msg.GetWidth() != 280 || res.Msg.GetNodes()[0].GetGroup() == nil {
		t.Fatalf("table = %d nodes %gx%g", len(res.Msg.GetNodes()), res.Msg.GetWidth(), res.Msg.GetHeight())
	}
	_, err = c.RenderBoard(ctx, connect.NewRequest(&opendesignerv1.RenderBoardRequest{Kind: "nope"}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("unknown kind: %v", err)
	}
}
