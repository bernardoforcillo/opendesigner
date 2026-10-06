package server

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// TestExportCode: the RPC exports the hub's current snapshot, with the
// workspace's assets copied into the project, and distinguishes input errors.
func TestExportCode(t *testing.T) {
	ws := t.TempDir()
	c, m := newTestClientWithManager(t, ws)
	ctx := context.Background()
	info, err := c.CreateDocument(ctx, connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: "Export"}))
	if err != nil {
		t.Fatal(err)
	}
	docID := info.Msg.GetId()

	// A real asset in the workspace: a minimal PNG valid for the allowlist.
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
	create(&opendesignerv1.Node{Id: "img", ParentId: "home", OrderKey: "a1", Name: "Photo", Visible: true, Opacity: 1, Width: 100, Height: 80,
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
			t.Errorf("file %q missing: %d files", p, len(got))
		}
	}
	if !bytes.Equal(got["public/assets/"+ref.Hash+".png"], png) {
		t.Error("the exported asset does not have the workspace's bytes")
	}
	if !strings.Contains(string(got["src/screens/Home.tsx"]), "/assets/"+ref.Hash+".png") {
		t.Error("the screen does not reference the asset")
	}

	// html: the same document as a file per screen; flow_id filters.
	resp, err = c.ExportCode(ctx, connect.NewRequest(&opendesignerv1.ExportCodeRequest{DocId: docID, Target: "html", FlowId: "f"}))
	if err != nil {
		t.Fatal(err)
	}
	var hasIndex bool
	for _, f := range resp.Msg.GetFiles() {
		hasIndex = hasIndex || f.GetPath() == "index.html"
	}
	if !hasIndex {
		t.Error("html: index.html missing (the flow's start screen)")
	}

	// Errors: unknown target and unknown flow are input errors; a
	// document that does not exist is NotFound.
	for _, req := range []*opendesignerv1.ExportCodeRequest{
		{DocId: docID, Target: "vue"},
		{DocId: docID, FlowId: "nope"},
	} {
		_, err := c.ExportCode(ctx, connect.NewRequest(req))
		if connect.CodeOf(err) != connect.CodeInvalidArgument {
			t.Errorf("%v: code = %v, want InvalidArgument (%v)", req, connect.CodeOf(err), err)
		}
	}
	_, err = c.ExportCode(ctx, connect.NewRequest(&opendesignerv1.ExportCodeRequest{DocId: "../outside"}))
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("unknown document: code = %v, want NotFound (%v)", connect.CodeOf(err), err)
	}
}
