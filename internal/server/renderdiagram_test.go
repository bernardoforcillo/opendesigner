package server

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// TestRenderDiagram: l'RPC è pura (nessun documento) e distingue un testo
// illeggibile (InvalidArgument, con il messaggio da mostrare) da un diagramma.
func TestRenderDiagram(t *testing.T) {
	c, _ := newTestClientWithManager(t, t.TempDir())
	ctx := context.Background()

	res, err := c.RenderDiagram(ctx, connect.NewRequest(&opendesignerv1.RenderDiagramRequest{Source: "sequenceDiagram\nA->>B: ciao"}))
	if err != nil {
		t.Fatal(err)
	}
	if res.Msg.GetKind() != "sequence" || res.Msg.GetWidth() <= 0 || len(res.Msg.GetNodes()) < 5 {
		t.Fatalf("risposta = kind %q %vx%v, %d nodi", res.Msg.GetKind(), res.Msg.GetWidth(), res.Msg.GetHeight(), len(res.Msg.GetNodes()))
	}
	if root := res.Msg.GetNodes()[0]; root.GetGroup() == nil || root.GetMeta()["diagram.source"] == "" {
		t.Errorf("la radice deve essere un gruppo col sorgente: %+v", root)
	}

	_, err = c.RenderDiagram(ctx, connect.NewRequest(&opendesignerv1.RenderDiagramRequest{Source: "gantt\ntitle x"}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("codice = %v, atteso InvalidArgument (%v)", connect.CodeOf(err), err)
	}
}
