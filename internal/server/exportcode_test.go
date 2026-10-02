package server

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// TestExportCode: l'RPC esporta lo snapshot corrente dell'hub, con gli asset
// del workspace copiati nel progetto, e distingue gli errori di input.
func TestExportCode(t *testing.T) {
	ws := t.TempDir()
	c, m := newTestClientWithManager(t, ws)
	ctx := context.Background()
	info, err := c.CreateDocument(ctx, connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: "Export"}))
	if err != nil {
		t.Fatal(err)
	}
	docID := info.Msg.GetId()

	// Un asset vero nel workspace: un PNG minimo valido per la allowlist.
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 32)...)
	ref, err := m.Assets(docID).Put(bytes.NewReader(png))
	if err != nil {
		t.Fatal(err)
	}

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
	create := func(n *opendesignerv1.Node) {
		send(&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}})
	}
	create(&opendesignerv1.Node{Id: "home", ParentId: "page1", OrderKey: "a1", Name: "Home", Visible: true, Opacity: 1, Width: 200, Height: 200,
		Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}})
	create(&opendesignerv1.Node{Id: "img", ParentId: "home", OrderKey: "a1", Name: "Foto", Visible: true, Opacity: 1, Width: 100, Height: 80,
		Shape: &opendesignerv1.Node_Image{Image: &opendesignerv1.ImageNode{AssetHash: ref.Hash}}})
	send(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetFlow{SetFlow: &opendesignerv1.SetFlow{Flow: &opendesignerv1.Flow{Id: "f", Name: "F", StartId: "home"}}}})

	resp, err := c.ExportCode(ctx, connect.NewRequest(&opendesignerv1.ExportCodeRequest{DocId: docID, Target: "react"}))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string][]byte{}
	for _, f := range resp.Msg.GetFiles() {
		got[f.GetPath()] = f.GetContent()
	}
	for _, p := range []string{"package.json", "src/App.tsx", "src/screens/Home.tsx", "tests/flows.spec.ts", "public/assets/" + ref.Hash + ".png"} {
		if _, ok := got[p]; !ok {
			t.Errorf("file %q mancante: %d file", p, len(got))
		}
	}
	if !bytes.Equal(got["public/assets/"+ref.Hash+".png"], png) {
		t.Error("l'asset esportato non ha i byte del workspace")
	}
	if !strings.Contains(string(got["src/screens/Home.tsx"]), "/assets/"+ref.Hash+".png") {
		t.Error("la schermata non referenzia l'asset")
	}

	// html: lo stesso documento come file per schermata; flow_id filtra.
	resp, err = c.ExportCode(ctx, connect.NewRequest(&opendesignerv1.ExportCodeRequest{DocId: docID, Target: "html", FlowId: "f"}))
	if err != nil {
		t.Fatal(err)
	}
	var hasIndex bool
	for _, f := range resp.Msg.GetFiles() {
		hasIndex = hasIndex || f.GetPath() == "index.html"
	}
	if !hasIndex {
		t.Error("html: manca index.html (la schermata iniziale del flusso)")
	}

	// Errori: target sconosciuto e flusso sconosciuto sono dell'input; il
	// documento che non esiste è NotFound.
	for _, req := range []*opendesignerv1.ExportCodeRequest{
		{DocId: docID, Target: "vue"},
		{DocId: docID, FlowId: "nope"},
	} {
		_, err := c.ExportCode(ctx, connect.NewRequest(req))
		if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("%v: code = %v, want InvalidArgument (%v)", req, connect.CodeOf(err), err)
		}
	}
	_, err = c.ExportCode(ctx, connect.NewRequest(&opendesignerv1.ExportCodeRequest{DocId: "../fuori"}))
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("documento sconosciuto: code = %v, want NotFound (%v)", connect.CodeOf(err), err)
	}
}
