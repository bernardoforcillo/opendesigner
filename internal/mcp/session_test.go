package mcp_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1/opendesignerv1connect"
	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
	"github.com/bernardoforcillo/opendesigner/internal/server"
)

// serveInMemory starts the real DocumentService over an httptest server on the
// exact transport `opendesigner serve` runs: cleartext HTTP/1.1 + h2c. It
// returns a base URL that odmcp.NewClient (h2c-only) can drive, so these tests
// exercise the same connect+open+subscribe+submit path as production, minus the
// stdio loop.
func serveInMemory(t *testing.T) string {
	t.Helper()
	svc := server.NewDocumentService(server.NewManager(t.TempDir()))
	path, handler := opendesignerv1connect.NewDocumentServiceHandler(svc)
	mux := http.NewServeMux()
	mux.Handle(path, handler)

	srv := httptest.NewUnstartedServer(mux)
	p := new(http.Protocols)
	p.SetHTTP1(true)
	p.SetUnencryptedHTTP2(true)
	srv.Config.Protocols = p
	srv.Start()
	t.Cleanup(srv.Close)
	return srv.URL
}

// newDoc creates a document on the server and returns its id.
func newDoc(t *testing.T, client opendesignerv1connect.DocumentServiceClient) string {
	t.Helper()
	info, err := client.CreateDocument(context.Background(), connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: "MCP Test"}))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	return info.Msg.GetId()
}

// startSession opens docID and starts its sync loop, tearing it down on cleanup.
func startSession(t *testing.T, url, docID, clientID string) *odmcp.Session {
	t.Helper()
	sess := odmcp.NewSession(odmcp.NewClient(url), docID, clientID, nil)
	if err := sess.Open(context.Background()); err != nil {
		t.Fatalf("Open: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); sess.SyncLoop(ctx) }()
	t.Cleanup(func() { cancel(); <-done })
	return sess
}

// waitFor polls cond until it holds, failing after ~3s. The MCP local doc is
// updated by the async Subscribe loop, so a read after a foreign write must wait
// for the broadcast to arrive.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func nodeByID(doc odmcp.DocumentView, id string) (odmcp.NodeView, bool) {
	for _, n := range doc.Nodes {
		if n.Id == id {
			return n, true
		}
	}
	return odmcp.NodeView{}, false
}

// TestCreateSetGetThroughTools drives the write and read tools end to end: a
// create_rectangle lands in the synced local doc, set_properties moves it, and
// get_document reflects both. Because a write tool waits for its own op to come
// back through the Subscribe stream, the reads need no extra polling.
func TestCreateSetGetThroughTools(t *testing.T) {
	url := serveInMemory(t)
	directClient := odmcp.NewClient(url)
	docID := newDoc(t, directClient)
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	created, err := sess.CreateRectangle(ctx, odmcp.CreateShapeInput{X: 10, Y: 20, Width: 100, Height: 80, Name: "box"})
	if err != nil {
		t.Fatalf("CreateRectangle: %v", err)
	}
	if created.NodeId == "" || created.Seq != 1 {
		t.Fatalf("CreateRectangle out = %+v, want a node id and seq 1", created)
	}

	doc, err := sess.GetDocument(ctx, struct{}{})
	if err != nil {
		t.Fatalf("GetDocument: %v", err)
	}
	n, ok := nodeByID(doc, created.NodeId)
	if !ok {
		t.Fatalf("created node %s not in local doc %+v", created.NodeId, doc.Nodes)
	}
	if n.Kind != "rect" || n.X != 10 || n.Width != 100 {
		t.Fatalf("node = %+v, want rect at x=10 w=100", n)
	}
	if n.ParentId != "page1" {
		t.Fatalf("node parent = %q, want page1 (default)", n.ParentId)
	}

	moveX, moveW := 55.0, 200.0
	if _, err := sess.SetProperties(ctx, odmcp.SetPropertiesInput{Id: created.NodeId, X: &moveX, Width: &moveW}); err != nil {
		t.Fatalf("SetProperties: %v", err)
	}
	doc, _ = sess.GetDocument(ctx, struct{}{})
	n, _ = nodeByID(doc, created.NodeId)
	if n.X != 55 || n.Width != 200 {
		t.Fatalf("after SetProperties node = %+v, want x=55 w=200", n)
	}
	if n.Y != 20 || n.Height != 80 {
		t.Fatalf("SetProperties clobbered untouched fields: %+v", n)
	}
}

// TestWebAndMCPShareTheDocument is the concurrency proof: an op submitted by a
// SEPARATE direct client (standing in for the web client) shows up in the MCP
// session's local doc, and an op the MCP tools submit is visible to the same
// direct client via OpenDocument — both halves edit one shared op-log.
func TestWebAndMCPShareTheDocument(t *testing.T) {
	url := serveInMemory(t)
	directClient := odmcp.NewClient(url) // the "web" client
	docID := newDoc(t, directClient)
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	// The web client creates a node directly against the hub.
	webNodeID := "web-rect"
	webOp := &opendesignerv1.Op{
		OpId: "op-web", DocId: docID,
		Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{
			Node: &opendesignerv1.Node{
				Id: webNodeID, ParentId: "page1", OrderKey: "a0", Visible: true, Opacity: 1,
				X: 5, Y: 5, Width: 30, Height: 30,
				Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}},
			},
		}},
	}
	if _, err := directClient.SubmitOp(ctx, connect.NewRequest(&opendesignerv1.SubmitOpRequest{
		DocId: docID, ClientId: "web", Op: webOp,
	})); err != nil {
		t.Fatalf("web SubmitOp: %v", err)
	}

	// The MCP session's Subscribe loop must fold the web edit into its local doc.
	waitFor(t, "web node to reach MCP local doc", func() bool {
		doc, err := sess.GetDocument(ctx, struct{}{})
		if err != nil {
			return false
		}
		_, ok := nodeByID(doc, webNodeID)
		return ok
	})

	// Now the MCP tools create a node; the web client sees it through OpenDocument.
	created, err := sess.CreateEllipse(ctx, odmcp.CreateShapeInput{X: 1, Y: 2, Width: 10, Height: 10})
	if err != nil {
		t.Fatalf("CreateEllipse: %v", err)
	}
	open, err := directClient.OpenDocument(ctx, connect.NewRequest(&opendesignerv1.OpenRequest{DocId: docID}))
	if err != nil {
		t.Fatalf("web OpenDocument: %v", err)
	}
	if _, ok := open.Msg.GetSnapshot().GetNodes()[created.NodeId]; !ok {
		t.Fatalf("MCP-created node %s not visible to the web client", created.NodeId)
	}
	// And the MCP local doc now holds BOTH nodes.
	doc, _ := sess.GetDocument(ctx, struct{}{})
	if _, ok := nodeByID(doc, webNodeID); !ok {
		t.Fatalf("web node missing from MCP doc after MCP write")
	}
	if _, ok := nodeByID(doc, created.NodeId); !ok {
		t.Fatalf("MCP node missing from MCP doc")
	}
}

// TestTextAndPagesAndComponents covers create_text/set_text, the page tools, and
// the component tools against the synced doc.
func TestTextAndPagesAndComponents(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	// text
	txt, err := sess.CreateText(ctx, odmcp.CreateTextInput{X: 0, Y: 0, Width: 120, Height: 40, Content: "hello"})
	if err != nil {
		t.Fatalf("CreateText: %v", err)
	}
	if _, err := sess.SetText(ctx, odmcp.SetTextInput{Id: txt.NodeId, Content: "world"}); err != nil {
		t.Fatalf("SetText: %v", err)
	}
	doc, _ := sess.GetDocument(ctx, struct{}{})
	n, _ := nodeByID(doc, txt.NodeId)
	if n.Kind != "text" || n.Text != "world" {
		t.Fatalf("text node = %+v, want kind text content world", n)
	}

	// pages
	pg, err := sess.CreatePage(ctx, odmcp.CreatePageInput{Name: "Second"})
	if err != nil {
		t.Fatalf("CreatePage: %v", err)
	}
	if _, err := sess.RenamePage(ctx, odmcp.RenamePageInput{Id: pg.PageId, Name: "Renamed"}); err != nil {
		t.Fatalf("RenamePage: %v", err)
	}
	pages, _ := sess.ListPages(ctx, struct{}{})
	if !hasPage(pages.Pages, pg.PageId, "Renamed") {
		t.Fatalf("pages = %+v, want a page %s named Renamed", pages.Pages, pg.PageId)
	}

	// list_nodes filtered to the default page should include the text node.
	nodes, _ := sess.ListNodes(ctx, odmcp.ListNodesInput{PageId: "page1"})
	if _, ok := nodeByID(odmcp.DocumentView{Nodes: nodes.Nodes}, txt.NodeId); !ok {
		t.Fatalf("list_nodes(page1) missing the text node: %+v", nodes.Nodes)
	}

	// components: register the text node's subtree as a master.
	comp, err := sess.CreateComponent(ctx, odmcp.CreateComponentInput{RootNodeId: txt.NodeId, Name: "TextComp"})
	if err != nil {
		t.Fatalf("CreateComponent: %v", err)
	}
	comps, _ := sess.ListComponents(ctx, struct{}{})
	found := false
	for _, c := range comps.Components {
		if c.Id == comp.ComponentId && c.RootNodeId == txt.NodeId && c.Name == "TextComp" {
			found = true
		}
	}
	if !found {
		t.Fatalf("components = %+v, want %s -> %s", comps.Components, comp.ComponentId, txt.NodeId)
	}
}

// TestMasterPages covers create_page(isMaster) and update_page.
func TestMasterPages(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	m, err := sess.CreatePage(ctx, odmcp.CreatePageInput{Name: "A-Master", IsMaster: true})
	if err != nil {
		t.Fatalf("CreatePage master: %v", err)
	}
	apply := m.PageId
	if _, err := sess.UpdatePage(ctx, odmcp.UpdatePageInput{Id: "page1", MasterId: &apply}); err != nil {
		t.Fatalf("UpdatePage apply: %v", err)
	}
	pages, _ := sess.ListPages(ctx, struct{}{})
	for _, p := range pages.Pages {
		if p.Id == "page1" && p.MasterId != apply {
			t.Fatalf("page1 = %+v, want master %s", p, apply)
		}
		if p.Id == apply && (!p.IsMaster || p.Name != "A-Master") {
			t.Fatalf("master = %+v", p)
		}
	}
	// A master in use cannot be deleted: the hub rejects it.
	if _, err := sess.DeletePage(ctx, odmcp.PageIdInput{Id: apply}); err == nil {
		t.Fatal("deleting a master in use should fail")
	}
	none := ""
	if _, err := sess.UpdatePage(ctx, odmcp.UpdatePageInput{Id: "page1", MasterId: &none}); err != nil {
		t.Fatalf("UpdatePage detach: %v", err)
	}
	if _, err := sess.DeletePage(ctx, odmcp.PageIdInput{Id: apply}); err != nil {
		t.Fatalf("delete of a detached master: %v", err)
	}
}

// TestPageStructure covers master chains, numbering, guides, facing pages and move_page.
func TestPageStructure(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	base, _ := sess.CreatePage(ctx, odmcp.CreatePageInput{Name: "Base", IsMaster: true})
	left, err := sess.CreatePage(ctx, odmcp.CreatePageInput{Name: "Left", IsMaster: true, MasterId: base.PageId})
	if err != nil {
		t.Fatalf("a master based on a master: %v", err)
	}
	style, start, slug, lm := "i", uint32(3), 9.0, left.PageId
	guides := []odmcp.GuideSpec{{Vertical: true, Position: 40}}
	hidden := []string{"logo"}
	sec := true
	if _, err := sess.UpdatePage(ctx, odmcp.UpdatePageInput{Id: "page1", PageSetup: odmcp.PageSetup{
		NumberStyle: &style, NumberStart: &start, Slug: &slug, LeftMasterId: &lm, Guides: &guides, HiddenMasterItems: &hidden, SectionStart: &sec,
	}}); err != nil {
		t.Fatalf("UpdatePage structure: %v", err)
	}
	pages, _ := sess.ListPages(ctx, struct{}{})
	var p1 odmcp.PageView
	for _, p := range pages.Pages {
		if p.Id == "page1" {
			p1 = p
		}
	}
	if p1.NumberStyle != "i" || p1.NumberStart != 3 || p1.Slug != 9 || p1.LeftMasterId != left.PageId || len(p1.Guides) != 1 || !p1.Guides[0].Vertical || p1.HiddenMasterItems[0] != "logo" || !p1.SectionStart {
		t.Fatalf("page1 = %+v", p1)
	}
	bad := "x"
	if _, err := sess.UpdatePage(ctx, odmcp.UpdatePageInput{Id: "page1", PageSetup: odmcp.PageSetup{NumberStyle: &bad}}); err == nil {
		t.Fatal("an unknown number style should be refused")
	}
	// The base master is in use by the left master.
	if _, err := sess.DeletePage(ctx, odmcp.PageIdInput{Id: base.PageId}); err == nil {
		t.Fatal("a base master in use should not be deleted")
	}
	facing := true
	if _, err := sess.SetDocumentSettings(ctx, odmcp.SetDocumentSettingsInput{FacingPages: &facing}); err != nil {
		t.Fatalf("facing pages: %v", err)
	}
	if _, err := sess.MovePage(ctx, odmcp.MovePageInput{Id: "page1", Index: 2}); err != nil {
		t.Fatalf("MovePage: %v", err)
	}
	pages, _ = sess.ListPages(ctx, struct{}{})
	if pages.Pages[2].Id != "page1" {
		t.Fatalf("order after move: %+v", pages.Pages)
	}
	if _, err := sess.MovePage(ctx, odmcp.MovePageInput{Id: "page1", Index: 9}); err == nil {
		t.Fatal("an index out of range should be refused")
	}
}

// TestTypesettingStyles covers the paragraph and glyph fields of set_text_style.
func TestTypesettingStyles(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	em, err := sess.SetTextStyle(ctx, odmcp.SetTextStyleInput{TextStyleBody: odmcp.TextStyleBody{Name: "Label", Kind: "character", SmallCaps: true, TextFormat: odmcp.TextFormat{Script: "superscript"}, Color: &odmcp.RGBA{R: 1, A: 1}}})
	if err != nil {
		t.Fatalf("character style: %v", err)
	}
	list, err := sess.SetTextStyle(ctx, odmcp.SetTextStyleInput{TextStyleBody: odmcp.TextStyleBody{
		Name: "Item", FontSize: 12, Align: "justify", Hyphenate: true, ListKind: "number", ListMarker: "#)", ListNumberStyle: "a", ListIndent: 20,
		TabStops: []odmcp.TabStopIO{{Position: 100}, {Position: 300, Align: "right", Leader: "."}}, DropCapLines: 3,
		NestedStyles: []odmcp.NestedIO{{StyleId: em.TextStyleId, Delimiter: ":", Count: 1, Inclusive: true}},
	}})
	if err != nil {
		t.Fatalf("paragraph style: %v", err)
	}
	out, _ := sess.ListTextStyles(ctx, struct{}{})
	var got odmcp.TextStyleView
	for _, s := range out.TextStyles {
		if s.Id == list.TextStyleId {
			got = s
		}
	}
	if got.Align != "justify" || !got.Hyphenate || got.ListKind != "number" || got.ListNumberStyle != "a" || len(got.TabStops) != 2 || got.TabStops[1].Align != "right" ||
		got.DropCapLines != 3 || len(got.NestedStyles) != 1 {
		t.Fatalf("style = %+v", got)
	}
	if _, err := sess.SetTextStyle(ctx, odmcp.SetTextStyleInput{TextStyleBody: odmcp.TextStyleBody{Name: "Bad", FontSize: 12, ListKind: "dots"}}); err == nil {
		t.Fatal("an unknown list kind should be refused")
	}
	if _, err := sess.SetTextStyle(ctx, odmcp.SetTextStyleInput{TextStyleBody: odmcp.TextStyleBody{Name: "Bad", FontSize: 12, TabStops: []odmcp.TabStopIO{{Position: 5}, {Position: 5}}}}); err == nil {
		t.Fatal("tab stops that do not ascend should be refused")
	}
}

// TestParagraphLookStyles covers keeps, rules, shading, border and variable axes of set_text_style.
func TestParagraphLookStyles(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	made, err := sess.SetTextStyle(ctx, odmcp.SetTextStyleInput{TextStyleBody: odmcp.TextStyleBody{
		Name: "Pull quote", FontSize: 18, FontVariations: "wght 650", OutlineLevel: 2, KeepWithNext: true, KeepFirstLines: 2, KeepLastLines: 2,
		RuleAbove: &odmcp.RuleIO{Weight: 1, Offset: 4, ColumnWidth: true}, Shading: &odmcp.RGBA{R: 0.9, G: 0.9, B: 0.9, A: 1}, ShadingOffset: 6,
		BorderColor: &odmcp.RGBA{A: 1}, BorderWeight: 1, OpticalMargin: true,
	}})
	if err != nil {
		t.Fatalf("paragraph look: %v", err)
	}
	out, _ := sess.ListTextStyles(ctx, struct{}{})
	var got odmcp.TextStyleView
	for _, s := range out.TextStyles {
		if s.Id == made.TextStyleId {
			got = s
		}
	}
	if !got.KeepWithNext || got.KeepFirstLines != 2 || got.KeepLastLines != 2 || got.RuleAbove == nil || !got.RuleAbove.ColumnWidth || got.Shading == nil ||
		got.BorderWeight != 1 || !got.OpticalMargin || got.FontVariations != "wght 650" || got.OutlineLevel != 2 {
		t.Fatalf("style = %+v", got)
	}
	if _, err := sess.SetTextStyle(ctx, odmcp.SetTextStyleInput{TextStyleBody: odmcp.TextStyleBody{Name: "Bad", FontSize: 12, KeepFirstLines: 9}}); err == nil {
		t.Fatal("more than 6 kept lines should be refused")
	}
	if _, err := sess.SetTextStyle(ctx, odmcp.SetTextStyleInput{TextStyleBody: odmcp.TextStyleBody{Name: "Bad", Kind: "character", FontSize: 12, KeepWithNext: true}}); err == nil {
		t.Fatal("a character style cannot keep with next")
	}
}

// TestThreadTextFrames covers thread_text_frames / unlink_text_frame.
func TestThreadTextFrames(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	mk := func(content string) string {
		o, err := sess.CreateText(ctx, odmcp.CreateTextInput{Width: 100, Height: 40, Content: content})
		if err != nil {
			t.Fatalf("CreateText: %v", err)
		}
		return o.NodeId
	}
	a, b, c := mk("alpha"), mk("beta"), mk("")
	out, err := sess.ThreadTextFrames(ctx, odmcp.ThreadTextFramesInput{Ids: []string{a, b, c}})
	if err != nil || out.Linked != 2 {
		t.Fatalf("ThreadTextFrames = %+v, %v", out, err)
	}
	doc, _ := sess.GetDocument(ctx, struct{}{})
	na, _ := nodeByID(doc, a)
	nb, _ := nodeByID(doc, b)
	if na.Meta["text.next"] != b || nb.Meta["text.next"] != c {
		t.Fatalf("links = %v / %v, want %s / %s", na.Meta, nb.Meta, b, c)
	}
	if na.Text != "alpha\nbeta" || nb.Text != "" {
		t.Fatalf("stories = %q / %q, want the text gathered in the first frame", na.Text, nb.Text)
	}
	// Closing the chain on itself, or linking a frame that is already followed, links nothing.
	if _, err := sess.ThreadTextFrames(ctx, odmcp.ThreadTextFramesInput{Ids: []string{c, a}}); err == nil {
		t.Fatal("a link that closes a cycle should be refused")
	}
	if _, err := sess.UnlinkTextFrame(ctx, odmcp.PageIdInput{Id: a}); err != nil {
		t.Fatalf("UnlinkTextFrame: %v", err)
	}
	doc, _ = sess.GetDocument(ctx, struct{}{})
	if na, _ = nodeByID(doc, a); na.Meta["text.next"] != "" {
		t.Fatalf("link not cut: %v", na.Meta)
	}
	if _, err := sess.UnlinkTextFrame(ctx, odmcp.PageIdInput{Id: a}); err == nil {
		t.Fatal("unlinking a frame without a next should fail")
	}
	if _, err := sess.ThreadTextFrames(ctx, odmcp.ThreadTextFramesInput{Ids: []string{a, "missing"}}); err == nil {
		t.Fatal("a non-text id should fail")
	}
}

// TestRichText covers the paragraph / character styles and format_text.
func TestRichText(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	para, err := sess.SetTextStyle(ctx, odmcp.SetTextStyleInput{TextStyleBody: odmcp.TextStyleBody{Name: "Heading", FontSize: 32, FontWeight: "700", SpaceAfter: 8}})
	if err != nil {
		t.Fatalf("SetTextStyle paragraph: %v", err)
	}
	em, err := sess.SetTextStyle(ctx, odmcp.SetTextStyleInput{TextStyleBody: odmcp.TextStyleBody{Name: "Emphasis", Kind: "character", Italic: true, Underline: true}})
	if err != nil {
		t.Fatalf("SetTextStyle character: %v", err)
	}
	// Tracking and the baseline grid travel through the tools too.
	grid, err := sess.SetTextStyle(ctx, odmcp.SetTextStyleInput{TextStyleBody: odmcp.TextStyleBody{Name: "Gridded", FontSize: 12, LetterSpacing: -0.4, AlignToGrid: true}})
	if err != nil {
		t.Fatalf("SetTextStyle gridded: %v", err)
	}
	styles, _ := sess.ListTextStyles(ctx, struct{}{})
	for _, st := range styles.TextStyles {
		if st.Id == grid.TextStyleId && (st.LetterSpacing != -0.4 || !st.AlignToGrid) {
			t.Fatalf("listed style = %+v", st)
		}
	}
	if _, err := sess.SetTextStyle(ctx, odmcp.SetTextStyleInput{TextStyleBody: odmcp.TextStyleBody{Name: "bad", Kind: "character", AlignToGrid: true}}); err == nil {
		t.Fatal("a character style on the grid should be refused")
	}
	// A character style with paragraph settings, a loop and a missing base are refused with a reason.
	if _, err := sess.SetTextStyle(ctx, odmcp.SetTextStyleInput{TextStyleBody: odmcp.TextStyleBody{Name: "bad", Kind: "character", SpaceAfter: 4}}); err == nil {
		t.Fatal("a character style with spacing should be refused")
	}
	if _, err := sess.SetTextStyle(ctx, odmcp.SetTextStyleInput{TextStyleBody: odmcp.TextStyleBody{Name: "bad", FontSize: 12, BasedOn: "nope"}}); err == nil {
		t.Fatal("a style based on a missing style should be refused")
	}

	txt, err := sess.CreateText(ctx, odmcp.CreateTextInput{Width: 200, Height: 40, Content: "Title\nSome text"})
	if err != nil {
		t.Fatalf("CreateText: %v", err)
	}
	if _, err := sess.FormatText(ctx, odmcp.FormatTextInput{
		NodeId: txt.NodeId, ParagraphStyles: []string{para.TextStyleId},
		Runs: []odmcp.TextRunInput{{Start: 6, End: 10, StyleId: em.TextStyleId}},
	}); err != nil {
		t.Fatalf("FormatText: %v", err)
	}
	doc, _ := sess.GetDocument(ctx, struct{}{})
	n, _ := nodeByID(doc, txt.NodeId)
	if len(n.ParagraphStyles) != 1 || n.ParagraphStyles[0] != para.TextStyleId || len(n.Runs) != 1 || n.Runs[0].End != 10 {
		t.Fatalf("formatting = %v / %v", n.ParagraphStyles, n.Runs)
	}
	// Bad formatting is refused before it is sent.
	if _, err := sess.FormatText(ctx, odmcp.FormatTextInput{NodeId: txt.NodeId, Runs: []odmcp.TextRunInput{{Start: 0, End: 99, StyleId: em.TextStyleId}}}); err == nil {
		t.Fatal("a run past the end should be refused")
	}
	if _, err := sess.FormatText(ctx, odmcp.FormatTextInput{NodeId: txt.NodeId, ParagraphStyles: []string{em.TextStyleId}}); err == nil {
		t.Fatal("a character style as a paragraph style should be refused")
	}
	// Editing the text keeps the formatting attached (clamped to the new content).
	if _, err := sess.SetText(ctx, odmcp.SetTextInput{Id: txt.NodeId, Content: "Title\nSome"}); err != nil {
		t.Fatalf("SetText: %v", err)
	}
	doc, _ = sess.GetDocument(ctx, struct{}{})
	if n, _ = nodeByID(doc, txt.NodeId); len(n.Runs) != 1 || n.Runs[0].End != 10 {
		t.Fatalf("runs after SetText = %v", n.Runs)
	}
}

func hasPage(pages []odmcp.PageView, id, name string) bool {
	for _, p := range pages {
		if p.Id == id && p.Name == name {
			return true
		}
	}
	return false
}

// TestDeleteNodeCascades checks delete_node removes the node from the synced doc.
func TestDeleteNodeCascades(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	r, err := sess.CreateRectangle(ctx, odmcp.CreateShapeInput{Width: 10, Height: 10})
	if err != nil {
		t.Fatalf("CreateRectangle: %v", err)
	}
	if _, err := sess.DeleteNode(ctx, odmcp.NodeIdInput{Id: r.NodeId}); err != nil {
		t.Fatalf("DeleteNode: %v", err)
	}
	doc, _ := sess.GetDocument(ctx, struct{}{})
	if _, ok := nodeByID(doc, r.NodeId); ok {
		t.Fatalf("node %s still present after delete", r.NodeId)
	}
}

// TestGradientFillThroughTools: an agent can write a gradient fill, it reaches
// the shared document as a real GradientPaint (what the web renderer draws), and
// a gradient the renderer could not draw is refused with a reason.
func TestGradientFillThroughTools(t *testing.T) {
	url := serveInMemory(t)
	direct := odmcp.NewClient(url)
	docID := newDoc(t, direct)
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	created, err := sess.CreateRectangle(ctx, odmcp.CreateShapeInput{Width: 100, Height: 50})
	if err != nil {
		t.Fatalf("CreateRectangle: %v", err)
	}
	grad := odmcp.RGBA{Gradient: &odmcp.GradientSpec{
		Kind: "linear", X1: 0, Y1: 0, X2: 1, Y2: 0,
		Stops: []odmcp.GradientStopSpec{
			{Color: odmcp.StopColor{R: 1, A: 1}, Position: 0},
			{Color: odmcp.StopColor{B: 1, A: 1}, Position: 1},
		},
	}}
	if _, err := sess.SetProperties(ctx, odmcp.SetPropertiesInput{Id: created.NodeId, Fills: []odmcp.RGBA{grad}}); err != nil {
		t.Fatalf("SetProperties gradient: %v", err)
	}

	open, err := direct.OpenDocument(ctx, connect.NewRequest(&opendesignerv1.OpenRequest{DocId: docID}))
	if err != nil {
		t.Fatalf("OpenDocument: %v", err)
	}
	var got *opendesignerv1.Paint
	for _, n := range open.Msg.GetSnapshot().GetNodes() {
		if n.GetId() == created.NodeId && len(n.GetFills()) == 1 {
			got = n.GetFills()[0]
		}
	}
	lin := got.GetLinear()
	if lin == nil || len(lin.GetStops()) != 2 || lin.GetX2() != 1 || lin.GetStops()[1].GetColor().GetB() != 1 {
		t.Fatalf("fill = %v, want a linear gradient with 2 stops ending blue", got)
	}

	// Angular and diamond gradients are accepted and stored as their own paint kinds.
	for _, kind := range []string{"angular", "diamond"} {
		g := odmcp.RGBA{Gradient: &odmcp.GradientSpec{Kind: kind, X1: 0.5, Y1: 0.5, X2: 1, Y2: 0.5, Stops: grad.Gradient.Stops}}
		if _, err := sess.SetProperties(ctx, odmcp.SetPropertiesInput{Id: created.NodeId, Fills: []odmcp.RGBA{g}}); err != nil {
			t.Fatalf("SetProperties %s gradient: %v", kind, err)
		}
		open, err := direct.OpenDocument(ctx, connect.NewRequest(&opendesignerv1.OpenRequest{DocId: docID}))
		if err != nil {
			t.Fatalf("OpenDocument: %v", err)
		}
		var p *opendesignerv1.Paint
		for _, n := range open.Msg.GetSnapshot().GetNodes() {
			if n.GetId() == created.NodeId && len(n.GetFills()) == 1 {
				p = n.GetFills()[0]
			}
		}
		if (kind == "angular" && p.GetAngular() == nil) || (kind == "diamond" && p.GetDiamond() == nil) {
			t.Errorf("%s gradient stored as %v", kind, p)
		}
	}

	bad := []odmcp.RGBA{
		{Gradient: &odmcp.GradientSpec{Kind: "sweep", X2: 1, Stops: grad.Gradient.Stops}},
		{Gradient: &odmcp.GradientSpec{Kind: "linear", X2: 1, Stops: grad.Gradient.Stops[:1]}},
		{Gradient: &odmcp.GradientSpec{Kind: "radial", Stops: grad.Gradient.Stops}},
	}
	for i, b := range bad {
		if _, err := sess.SetProperties(ctx, odmcp.SetPropertiesInput{Id: created.NodeId, Fills: []odmcp.RGBA{b}}); err == nil {
			t.Errorf("bad gradient %d accepted, want an error", i)
		}
	}
}

// TestAgentAppearsInPresence: the agent joins the room under its nickname and,
// after each write, points at the node it touched -- which is what lets the web
// show "Claude" outlining the rectangle it just made.
func TestAgentAppearsInPresence(t *testing.T) {
	url := serveInMemory(t)
	direct := odmcp.NewClient(url)
	docID := newDoc(t, direct)
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	// A "web client" watching the room.
	wctx, cancelWatch := context.WithCancel(ctx)
	defer cancelWatch()
	watch, err := direct.WatchPresence(wctx, connect.NewRequest(&opendesignerv1.WatchPresenceRequest{
		DocId: docID, ClientId: "web", Nickname: "Ada",
	}))
	if err != nil {
		t.Fatalf("WatchPresence: %v", err)
	}
	events := make(chan *opendesignerv1.PresenceState, 16)
	left := make(chan string, 4)
	go func() {
		for watch.Receive() {
			switch k := watch.Msg().GetKind().(type) {
			case *opendesignerv1.PresenceEvent_Update:
				events <- k.Update
			case *opendesignerv1.PresenceEvent_LeftClientId:
				left <- k.LeftClientId
			}
		}
	}()
	next := func() *opendesignerv1.PresenceState {
		t.Helper()
		select {
		case st := <-events:
			return st
		case <-time.After(3 * time.Second):
			t.Fatal("timed out waiting for a presence update")
			return nil
		}
	}

	pctx, stopAgent := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { defer close(done); sess.PresenceLoop(pctx, "") }()

	if got := next(); got.GetNickname() != odmcp.DefaultNickname || got.GetClientId() != sess.ClientID() {
		t.Fatalf("joined as %v, want %q / %s", got, odmcp.DefaultNickname, sess.ClientID())
	}
	waitFor(t, "agent to be in the room", sess.PresenceJoined)

	created, err := sess.CreateRectangle(ctx, odmcp.CreateShapeInput{Width: 10, Height: 10})
	if err != nil {
		t.Fatalf("CreateRectangle: %v", err)
	}
	got := next()
	if len(got.GetSelection()) != 1 || got.GetSelection()[0] != created.NodeId || got.GetPageId() != "page1" {
		t.Fatalf("after create: %v, want selection [%s] on page1", got, created.NodeId)
	}

	if _, err := sess.DeleteNode(ctx, odmcp.NodeIdInput{Id: created.NodeId}); err != nil {
		t.Fatalf("DeleteNode: %v", err)
	}
	if got := next(); len(got.GetSelection()) != 0 {
		t.Fatalf("after delete selection = %v, want it cleared", got.GetSelection())
	}

	stopAgent()
	<-done
	select {
	case id := <-left:
		if id != sess.ClientID() {
			t.Fatalf("left = %q, want the agent", id)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the agent never left the room")
	}
}

// TestSetNicknameRenamesTheAgentInTheRoom: the agent leaves and rejoins under the new name, and a bad
// name is refused without disturbing the old one.
func TestSetNicknameRenamesTheAgentInTheRoom(t *testing.T) {
	url := serveInMemory(t)
	direct := odmcp.NewClient(url)
	docID := newDoc(t, direct)
	sess := startSession(t, url, docID, "")
	ctx := context.Background()
	pctx, stop := context.WithCancel(ctx)
	defer stop()
	go sess.PresenceLoop(pctx, "Ada")
	waitFor(t, "agent to be in the room", sess.PresenceJoined)

	// The roster the agent sees is the OTHER people; watch the room as a person does.
	watch, err := direct.WatchPresence(ctx, connect.NewRequest(&opendesignerv1.WatchPresenceRequest{DocId: docID, ClientId: "web-1", Nickname: "Bea"}))
	if err != nil {
		t.Fatal(err)
	}
	defer watch.Close()
	seen := make(chan string, 16)
	go func() {
		for watch.Receive() {
			if u := watch.Msg().GetUpdate(); u != nil && u.GetClientId() == sess.ClientID() {
				seen <- u.GetNickname()
			}
		}
	}()
	waitName := func(want string) {
		t.Helper()
		deadline := time.After(4 * time.Second)
		for {
			select {
			case n := <-seen:
				if n == want {
					return
				}
			case <-deadline:
				t.Fatalf("never saw the agent as %q", want)
			}
		}
	}
	waitName("Ada")

	for _, bad := range []string{"", "   ", strings.Repeat("x", 33)} {
		if _, err := sess.SetNickname(ctx, odmcp.SetNicknameInput{Nickname: bad}); err == nil {
			t.Fatalf("%q must be refused", bad)
		}
	}
	out, err := sess.SetNickname(ctx, odmcp.SetNicknameInput{Nickname: "  Grace  "})
	if err != nil || out.Nickname != "Grace" {
		t.Fatalf("SetNickname = %v, %v", out, err)
	}
	waitName("Grace")
	waitFor(t, "agent to be back in the room", sess.PresenceJoined)
}

// TestTwoAgentsShareOneDocument: two MCP sessions on the same document each see
// the other's edits, both appear in the room under their own names, and writes
// racing on different nodes all land.
func TestTwoAgentsShareOneDocument(t *testing.T) {
	url := serveInMemory(t)
	direct := odmcp.NewClient(url)
	docID := newDoc(t, direct)
	a := startSession(t, url, docID, "agent-a")
	b := startSession(t, url, docID, "agent-b")
	ctx := context.Background()

	for _, x := range []struct {
		s    *odmcp.Session
		name string
	}{{a, "Agente A"}, {b, "Agente B"}} {
		pctx, stop := context.WithCancel(ctx)
		t.Cleanup(stop)
		go x.s.PresenceLoop(pctx, x.name)
	}
	waitFor(t, "both agents in the room", func() bool { return a.PresenceJoined() && b.PresenceJoined() })

	// Each writes 10 nodes at the same time.
	ids := make(chan string, 20)
	var wg sync.WaitGroup
	for _, s := range []*odmcp.Session{a, b} {
		wg.Add(1)
		go func(s *odmcp.Session) {
			defer wg.Done()
			for i := 0; i < 10; i++ {
				out, err := s.CreateRectangle(ctx, odmcp.CreateShapeInput{Width: 5, Height: 5})
				if err != nil {
					t.Errorf("CreateRectangle: %v", err)
					return
				}
				ids <- out.NodeId
			}
		}(s)
	}
	wg.Wait()
	close(ids)

	var all []string
	for id := range ids {
		all = append(all, id)
	}
	if len(all) != 20 {
		t.Fatalf("created %d nodes, want 20", len(all))
	}
	for name, s := range map[string]*odmcp.Session{"a": a, "b": b} {
		waitFor(t, "session "+name+" to see all 20 nodes", func() bool {
			doc, _ := s.GetDocument(ctx, struct{}{})
			n := 0
			for _, id := range all {
				if _, ok := nodeByID(doc, id); ok {
					n++
				}
			}
			return n == 20
		})
	}

	// B edits a node A created: it lands, and A sees it.
	w := 77.0
	if _, err := b.SetProperties(ctx, odmcp.SetPropertiesInput{Id: all[0], Width: &w}); err != nil {
		t.Fatalf("B editing A's node: %v", err)
	}
	waitFor(t, "A to see B's edit", func() bool {
		doc, _ := a.GetDocument(ctx, struct{}{})
		n, ok := nodeByID(doc, all[0])
		return ok && n.Width == 77
	})
}

// TestListPeersShowsPeopleAndOtherAgents: an agent can see who else is in the
// document and what they have selected, telling people from agents.
func TestListPeersShowsPeopleAndOtherAgents(t *testing.T) {
	url := serveInMemory(t)
	direct := odmcp.NewClient(url)
	docID := newDoc(t, direct)
	a := startSession(t, url, docID, "mcp-a")
	b := startSession(t, url, docID, "mcp-b")
	ctx := context.Background()

	for _, x := range []struct {
		s    *odmcp.Session
		name string
	}{{a, "A"}, {b, "B"}} {
		pctx, stop := context.WithCancel(ctx)
		t.Cleanup(stop)
		go x.s.PresenceLoop(pctx, x.name)
	}
	waitFor(t, "agents in the room", func() bool { return a.PresenceJoined() && b.PresenceJoined() })

	// A person in the browser joins and selects a node.
	wctx, cancel := context.WithCancel(ctx)
	defer cancel()
	watch, err := direct.WatchPresence(wctx, connect.NewRequest(&opendesignerv1.WatchPresenceRequest{DocId: docID, ClientId: "web-1", Nickname: "Ada"}))
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for watch.Receive() {
		}
	}()
	waitFor(t, "web client in the room", func() bool {
		_, err := direct.UpdatePresence(ctx, connect.NewRequest(&opendesignerv1.UpdatePresenceRequest{
			DocId: docID, State: &opendesignerv1.PresenceState{ClientId: "web-1", PageId: "page1", Selection: []string{"n-web"}},
		}))
		if err != nil {
			return false
		}
		out, _ := a.ListPeers(ctx, struct{}{})
		for _, p := range out.Peers {
			if p.ClientId == "web-1" && len(p.Selection) == 1 {
				return true
			}
		}
		return false
	})

	created, err := b.CreateRectangle(ctx, odmcp.CreateShapeInput{Width: 5, Height: 5})
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "A to see B's selection", func() bool {
		out, _ := a.ListPeers(ctx, struct{}{})
		for _, p := range out.Peers {
			if p.ClientId == "mcp-b" {
				return len(p.Selection) == 1 && p.Selection[0] == created.NodeId
			}
		}
		return false
	})

	out, _ := a.ListPeers(ctx, struct{}{})
	byID := map[string]odmcp.PeerView{}
	for _, p := range out.Peers {
		byID[p.ClientId] = p
	}
	if len(byID) != 2 {
		t.Fatalf("A sees %d peers, want 2 (the person and B, never itself): %+v", len(byID), out.Peers)
	}
	if byID["web-1"].IsAgent || byID["web-1"].Nickname != "Ada" || byID["web-1"].Selection[0] != "n-web" {
		t.Errorf("person = %+v", byID["web-1"])
	}
	if !byID["mcp-b"].IsAgent || byID["mcp-b"].Nickname != "B" {
		t.Errorf("agent = %+v", byID["mcp-b"])
	}

	// The person leaves: gone from the list.
	cancel()
	waitFor(t, "the person to leave the list", func() bool {
		out, _ := a.ListPeers(ctx, struct{}{})
		for _, p := range out.Peers {
			if p.ClientId == "web-1" {
				return false
			}
		}
		return true
	})
}

// TestEffectsThroughTools: an agent can give a node a shadow and a blur, they
// reach the shared document as real Effects, [] clears them, and an invalid
// effect is refused with a reason.
func TestEffectsThroughTools(t *testing.T) {
	url := serveInMemory(t)
	direct := odmcp.NewClient(url)
	docID := newDoc(t, direct)
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	created, err := sess.CreateRectangle(ctx, odmcp.CreateShapeInput{Width: 100, Height: 50})
	if err != nil {
		t.Fatal(err)
	}
	fx := []odmcp.EffectSpec{
		{Kind: "dropShadow", Color: odmcp.StopColor{A: 0.4}, OffsetX: 1, OffsetY: 6, Blur: 12},
		{Kind: "layerBlur", Radius: 3},
	}
	if _, err := sess.SetProperties(ctx, odmcp.SetPropertiesInput{Id: created.NodeId, Effects: fx}); err != nil {
		t.Fatalf("SetProperties effects: %v", err)
	}
	effectsOf := func() []*opendesignerv1.Effect {
		open, err := direct.OpenDocument(ctx, connect.NewRequest(&opendesignerv1.OpenRequest{DocId: docID}))
		if err != nil {
			t.Fatal(err)
		}
		for _, n := range open.Msg.GetSnapshot().GetNodes() {
			if n.GetId() == created.NodeId {
				return n.GetEffects()
			}
		}
		return nil
	}
	got := effectsOf()
	if len(got) != 2 || got[0].GetDropShadow().GetOffsetY() != 6 || got[0].GetDropShadow().GetBlur() != 12 ||
		got[0].GetDropShadow().GetColor().GetA() != float32(0.4) || got[1].GetLayerBlur().GetRadius() != 3 {
		t.Fatalf("effects = %v", got)
	}

	// An empty list clears them.
	if _, err := sess.SetProperties(ctx, odmcp.SetPropertiesInput{Id: created.NodeId, Effects: []odmcp.EffectSpec{}}); err != nil {
		t.Fatal(err)
	}
	if got := effectsOf(); len(got) != 0 {
		t.Fatalf("after [] effects = %v, want none", got)
	}

	for i, bad := range []odmcp.EffectSpec{
		{Kind: "glow"}, {Kind: "dropShadow", Blur: -1}, {Kind: "layerBlur", Radius: -2}, {},
	} {
		if _, err := sess.SetProperties(ctx, odmcp.SetPropertiesInput{Id: created.NodeId, Effects: []odmcp.EffectSpec{bad}}); err == nil {
			t.Errorf("bad effect %d accepted", i)
		}
	}
}

// TestAutoLayoutThroughTools: an agent makes a frame with auto layout, drops
// children into it at nonsense positions, and the SERVER arranges them; changing
// the layout rearranges them, and turning it off leaves them where they were.
func TestAutoLayoutThroughTools(t *testing.T) {
	url := serveInMemory(t)
	direct := odmcp.NewClient(url)
	docID := newDoc(t, direct)
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	frame, err := sess.CreateFrame(ctx, odmcp.CreateFrameInput{
		Width: 200, Height: 100, Name: "row", ClipsContent: true,
		AutoLayout: &odmcp.AutoLayoutSpec{Direction: "horizontal", Spacing: 10, PaddingLeft: 5, PaddingTop: 7, PaddingRight: 5, PaddingBottom: 7},
	})
	if err != nil {
		t.Fatalf("CreateFrame: %v", err)
	}
	var kids []string
	for i := 0; i < 3; i++ {
		out, err := sess.CreateRectangle(ctx, odmcp.CreateShapeInput{ParentId: frame.NodeId, X: 999, Y: 999, Width: 20, Height: 10})
		if err != nil {
			t.Fatal(err)
		}
		kids = append(kids, out.NodeId)
	}
	at := func(id string) (float64, float64) {
		doc, _ := sess.GetDocument(ctx, struct{}{})
		n, ok := nodeByID(doc, id)
		if !ok {
			t.Fatalf("node %s missing", id)
		}
		return n.X, n.Y
	}
	for i, want := range []float64{5, 35, 65} {
		if x, y := at(kids[i]); x != want || y != 7 {
			t.Errorf("child %d at (%v,%v), want (%v,7)", i, x, y, want)
		}
	}
	doc, _ := sess.GetDocument(ctx, struct{}{})
	if n, _ := nodeByID(doc, frame.NodeId); n.AutoLayout == nil || n.AutoLayout.Direction != "horizontal" || n.AutoLayout.Spacing != 10 {
		t.Errorf("get_document hides the layout: %+v", n.AutoLayout)
	}

	// Change direction: the server rearranges.
	if _, err := sess.SetAutoLayout(ctx, odmcp.SetAutoLayoutInput{Id: frame.NodeId, AutoLayout: &odmcp.AutoLayoutSpec{
		Direction: "vertical", Spacing: 4, MainAlign: "start", CrossAlign: "end",
	}}); err != nil {
		t.Fatalf("SetAutoLayout: %v", err)
	}
	// vertical, no padding, cross end: x = 200 - 20 = 180, y = 0, 14, 28.
	for i, wantY := range []float64{0, 14, 28} {
		if x, y := at(kids[i]); x != 180 || y != wantY {
			t.Errorf("after vertical, child %d at (%v,%v), want (180,%v)", i, x, y, wantY)
		}
	}

	// Off: positions stay, and the layout is gone from the view.
	if _, err := sess.SetAutoLayout(ctx, odmcp.SetAutoLayoutInput{Id: frame.NodeId}); err != nil {
		t.Fatal(err)
	}
	if x, y := at(kids[2]); x != 180 || y != 28 {
		t.Errorf("turning layout off moved a child to (%v,%v)", x, y)
	}
	doc, _ = sess.GetDocument(ctx, struct{}{})
	if n, _ := nodeByID(doc, frame.NodeId); n.AutoLayout != nil {
		t.Errorf("layout still reported after turning it off: %+v", n.AutoLayout)
	}

	// Bad input is refused with a reason; a non-frame is refused by the server.
	for i, bad := range []odmcp.AutoLayoutSpec{
		{Direction: "diagonal"}, {Direction: "vertical", MainAlign: "middle"},
		{Direction: "vertical", CrossAlign: "space-between"}, {Direction: "vertical", Spacing: -1},
	} {
		bad := bad
		if _, err := sess.SetAutoLayout(ctx, odmcp.SetAutoLayoutInput{Id: frame.NodeId, AutoLayout: &bad}); err == nil {
			t.Errorf("bad layout %d accepted", i)
		}
	}
	if _, err := sess.SetAutoLayout(ctx, odmcp.SetAutoLayoutInput{Id: kids[0], AutoLayout: &odmcp.AutoLayoutSpec{Direction: "vertical"}}); err == nil {
		t.Error("auto layout on a rectangle was accepted")
	}
}

// TestDocumentSettingsAndPageSetup covers set_document_settings and the page setup fields.
func TestDocumentSettingsAndPageSetup(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	doc, _ := sess.GetDocument(ctx, struct{}{})
	if doc.Vertical != "product" {
		t.Fatalf("default vertical = %q, want product", doc.Vertical)
	}
	v, inc := "publishing", 14.0
	if _, err := sess.SetDocumentSettings(ctx, odmcp.SetDocumentSettingsInput{Vertical: &v, BaselineIncrement: &inc}); err != nil {
		t.Fatalf("SetDocumentSettings: %v", err)
	}
	doc, _ = sess.GetDocument(ctx, struct{}{})
	if doc.Vertical != "publishing" || doc.BaselineIncrement != 14 {
		t.Fatalf("settings = %q / %v", doc.Vertical, doc.BaselineIncrement)
	}
	// A field left out keeps its value; "product" goes back to the default.
	prod := "product"
	if _, err := sess.SetDocumentSettings(ctx, odmcp.SetDocumentSettingsInput{Vertical: &prod}); err != nil {
		t.Fatal(err)
	}
	doc, _ = sess.GetDocument(ctx, struct{}{})
	if doc.Vertical != "product" || doc.BaselineIncrement != 14 {
		t.Fatalf("after going back to product: %q / %v", doc.Vertical, doc.BaselineIncrement)
	}
	bad := "cinema"
	if _, err := sess.SetDocumentSettings(ctx, odmcp.SetDocumentSettingsInput{Vertical: &bad}); err == nil {
		t.Fatal("an unknown vertical should be refused")
	}

	// The Present device frame: generic by default, set per document, other fields untouched.
	if doc.PresentDevice != "generic" {
		t.Fatalf("default device = %q, want generic", doc.PresentDevice)
	}
	phone := "phone"
	if _, err := sess.SetDocumentSettings(ctx, odmcp.SetDocumentSettingsInput{PresentDevice: &phone}); err != nil {
		t.Fatal(err)
	}
	doc, _ = sess.GetDocument(ctx, struct{}{})
	if doc.PresentDevice != "phone" || doc.BaselineIncrement != 14 {
		t.Fatalf("after setting the device: %q / %v", doc.PresentDevice, doc.BaselineIncrement)
	}
	watch := "watch"
	if _, err := sess.SetDocumentSettings(ctx, odmcp.SetDocumentSettingsInput{PresentDevice: &watch}); err == nil {
		t.Fatal("an unknown device should be refused")
	}
	generic := "generic"
	if _, err := sess.SetDocumentSettings(ctx, odmcp.SetDocumentSettingsInput{PresentDevice: &generic}); err != nil {
		t.Fatal(err)
	}
	if doc, _ = sess.GetDocument(ctx, struct{}{}); doc.PresentDevice != "generic" {
		t.Fatalf("device after going back to generic = %q", doc.PresentDevice)
	}

	w, h, mt, cols, gut := 420.0, 595.0, 40.0, uint32(2), 18.0
	pg, err := sess.CreatePage(ctx, odmcp.CreatePageInput{Name: "A5", PageSetup: odmcp.PageSetup{Width: &w, Height: &h, MarginTop: &mt, Columns: &cols, Gutter: &gut}})
	if err != nil {
		t.Fatalf("CreatePage with a setup: %v", err)
	}
	bleed := 9.0
	if _, err := sess.UpdatePage(ctx, odmcp.UpdatePageInput{Id: pg.PageId, PageSetup: odmcp.PageSetup{Bleed: &bleed}}); err != nil {
		t.Fatalf("UpdatePage: %v", err)
	}
	pages, _ := sess.ListPages(ctx, struct{}{})
	for _, p := range pages.Pages {
		if p.Id == pg.PageId && (p.Width != 420 || p.Height != 595 || p.MarginTop != 40 || p.Columns != 2 || p.Gutter != 18 || p.Bleed != 9) {
			t.Fatalf("page = %+v", p)
		}
	}
	// A setup the document refuses is refused by the hub (margins larger than the sheet).
	big := 500.0
	if _, err := sess.UpdatePage(ctx, odmcp.UpdatePageInput{Id: pg.PageId, PageSetup: odmcp.PageSetup{MarginLeft: &big}}); err == nil {
		t.Fatal("margins larger than the sheet should be refused")
	}
}

// TestGraphicsTools covers object styles, layers and swatches.
func TestGraphicsTools(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	rect, err := sess.CreateRectangle(ctx, odmcp.CreateShapeInput{Width: 100, Height: 50, Name: "card"})
	if err != nil {
		t.Fatalf("CreateRect: %v", err)
	}
	// Object styles: from a node, applied, listed, deleted.
	st, err := sess.SetObjectStyle(ctx, odmcp.SetObjectStyleInput{Name: "Card", Sets: []string{"fills", "opacity"}, FromNodeId: rect.NodeId})
	if err != nil {
		t.Fatalf("SetObjectStyle: %v", err)
	}
	if _, err := sess.SetObjectStyle(ctx, odmcp.SetObjectStyleInput{Name: "Bad", Sets: []string{"width"}}); err == nil {
		t.Fatal("an unknown property should be refused")
	}
	if out, err := sess.ApplyObjectStyle(ctx, odmcp.ApplyObjectStyleInput{NodeIds: []string{rect.NodeId}, ObjectStyleId: st.ObjectStyleId}); err != nil || out.Changed != 1 {
		t.Fatalf("ApplyObjectStyle = %+v, %v", out, err)
	}
	if _, err := sess.ApplyObjectStyle(ctx, odmcp.ApplyObjectStyleInput{NodeIds: []string{rect.NodeId}, ObjectStyleId: "nope"}); err == nil {
		t.Fatal("a missing style should be refused")
	}
	styles, _ := sess.ListObjectStyles(ctx, struct{}{})
	if len(styles.ObjectStyles) != 1 || styles.ObjectStyles[0].Name != "Card" || styles.ObjectStyles[0].Opacity != 1 {
		t.Fatalf("styles = %+v", styles)
	}
	if _, err := sess.DeleteObjectStyle(ctx, odmcp.IdInput{Id: st.ObjectStyleId}); err != nil {
		t.Fatalf("DeleteObjectStyle: %v", err)
	}

	// Layers.
	art, err := sess.SetLayer(ctx, odmcp.SetLayerInput{Name: "Art"})
	if err != nil {
		t.Fatalf("SetLayer: %v", err)
	}
	notes, _ := sess.SetLayer(ctx, odmcp.SetLayerInput{Name: "Notes", Locked: true, Position: 1})
	if _, err := sess.AssignLayer(ctx, odmcp.AssignLayerInput{NodeIds: []string{rect.NodeId}, LayerId: art.LayerId}); err != nil {
		t.Fatalf("AssignLayer: %v", err)
	}
	layers, _ := sess.ListLayers(ctx, struct{}{})
	if len(layers.Layers) != 2 || layers.Layers[0].Id != notes.LayerId || !layers.Layers[0].Locked || layers.Layers[1].Nodes != 1 {
		t.Fatalf("layers = %+v", layers)
	}
	if _, err := sess.AssignLayer(ctx, odmcp.AssignLayerInput{NodeIds: []string{rect.NodeId}, LayerId: "nope"}); err == nil {
		t.Fatal("a missing layer should be refused")
	}
	if _, err := sess.DeleteLayer(ctx, odmcp.IdInput{Id: art.LayerId}); err != nil {
		t.Fatalf("DeleteLayer: %v", err)
	}

	// Swatches and colour mode.
	red, err := sess.SetSwatch(ctx, odmcp.SetSwatchInput{Name: "Red", Cmyk: &odmcp.CmykIO{M: 100, Y: 100}})
	if err != nil {
		t.Fatalf("SetSwatch: %v", err)
	}
	if _, err := sess.SetSwatch(ctx, odmcp.SetSwatchInput{Name: "Red 50", TintOf: red.SwatchId, Tint: 50}); err != nil {
		t.Fatalf("tint: %v", err)
	}
	if _, err := sess.SetSwatch(ctx, odmcp.SetSwatchInput{Name: "x", TintOf: "nope", Tint: 50}); err == nil {
		t.Fatal("a tint of nothing should be refused")
	}
	mode, profile := "cmyk", "FOGRA39"
	if _, err := sess.SetDocumentSettings(ctx, odmcp.SetDocumentSettingsInput{ColorMode: &mode, IccProfile: &profile}); err != nil {
		t.Fatalf("colour mode: %v", err)
	}
	bad := "lab"
	if _, err := sess.SetDocumentSettings(ctx, odmcp.SetDocumentSettingsInput{ColorMode: &bad}); err == nil {
		t.Fatal("an unknown colour mode should be refused")
	}
	sw, _ := sess.ListSwatches(ctx, struct{}{})
	if len(sw.Swatches) != 2 || sw.ColorMode != "cmyk" || sw.Profile != "FOGRA39" || sw.Swatches[0].Name != "Red" || sw.Swatches[0].Cmyk == nil || sw.Swatches[1].Tint != 50 {
		t.Fatalf("swatches = %+v", sw)
	}
	if sw.Swatches[1].Color.G < 0.49 || sw.Swatches[1].Color.G > 0.51 {
		t.Fatalf("tint colour = %+v", sw.Swatches[1].Color)
	}
	// A swatch used by a node can be deleted: the node is detached.
	if _, err := sess.DeleteSwatch(ctx, odmcp.IdInput{Id: red.SwatchId}); err != nil {
		t.Fatalf("DeleteSwatch: %v", err)
	}
	sw, _ = sess.ListSwatches(ctx, struct{}{})
	if len(sw.Swatches) != 1 || sw.Swatches[0].TintOf != "" {
		t.Fatalf("after delete = %+v", sw)
	}
}

// TestBookMetadata covers the book record of set_document_settings.
func TestBookMetadata(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	_, err := sess.SetDocumentSettings(ctx, odmcp.SetDocumentSettingsInput{Book: &odmcp.BookIO{
		Isbn13: "9788804668237", Title: "Il nome della rosa", Language: "ita", PublicationDate: "20240229",
		Contributors: []odmcp.ContributorIO{{Role: "A01", PersonName: "Umberto Eco"}}, Prices: []odmcp.PriceIO{{PriceType: "02", Amount: "9.99", Currency: "EUR"}},
	}})
	if err != nil {
		t.Fatalf("book: %v", err)
	}
	if _, err := sess.SetDocumentSettings(ctx, odmcp.SetDocumentSettingsInput{Book: &odmcp.BookIO{Isbn13: "9788804668238"}}); err == nil {
		t.Fatal("a wrong ISBN check digit should be refused")
	}
	if _, err := sess.SetDocumentSettings(ctx, odmcp.SetDocumentSettingsInput{Book: &odmcp.BookIO{}}); err != nil {
		t.Fatalf("an empty book clears the record: %v", err)
	}
}

// fakeEditor plays an editor that has the document open: it answers each job with answer(job).
func fakeEditor(t *testing.T, url, docID string, answer func(job *opendesignerv1.EditorJob) *opendesignerv1.CompleteJobRequest) {
	t.Helper()
	client := odmcp.NewClient(url)
	stream, err := client.WatchJobs(context.Background(), connect.NewRequest(&opendesignerv1.WatchJobsRequest{DocId: docID, ClientId: "fake-editor"}))
	if err != nil {
		t.Fatal(err)
	}
	if !stream.Receive() { // the server's "ready"
		t.Fatalf("watch_jobs: %v", stream.Err())
	}
	go func() {
		for stream.Receive() {
			job := stream.Msg()
			done := answer(job)
			done.DocId, done.JobId, done.ClientId = docID, job.GetJobId(), "fake-editor"
			_, _ = client.CompleteJob(context.Background(), connect.NewRequest(done))
		}
	}()
	t.Cleanup(func() { _ = stream.Close() })
}

// TestEditorMadeOutputs covers export_pdf, export_epub, export_image and preflight, which an editor produces.
func TestEditorMadeOutputs(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	if _, err := sess.ExportPdf(ctx, odmcp.ExportPdfInput{}); err == nil || !strings.Contains(err.Error(), "no editor has this document open") {
		t.Fatalf("with no editor: %v", err)
	}

	var seen []string
	fakeEditor(t, url, docID, func(job *opendesignerv1.EditorJob) *opendesignerv1.CompleteJobRequest {
		seen = append(seen, job.GetKind()+" "+job.GetOptionsJson())
		switch job.GetKind() {
		case "preflight":
			return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"issues":[{"severity":"warning","code":"no-bleed","message":"Page has no bleed"}],"errors":0,"warnings":1}`}
		case "export_epub_reflow":
			return &opendesignerv1.CompleteJobRequest{Ok: false, Message: "nothing to export: no text or images to flow"}
		case "export_png":
			return &opendesignerv1.CompleteJobRequest{Ok: true, Filename: "page.png", ContentType: "image/png", Data: []byte("PNG")}
		}
		return &opendesignerv1.CompleteJobRequest{Ok: true, Message: "PDF written with warnings", Filename: "Book.pdf", ContentType: "application/pdf", Data: []byte("%PDF-fake")}
	})

	dir := t.TempDir()
	yes := true
	out, err := sess.ExportPdf(ctx, odmcp.ExportPdfInput{OutPath: dir, PrintOptionsIn: odmcp.PrintOptionsIn{Standard: "x4", Marks: &yes}})
	if err != nil {
		t.Fatalf("export_pdf: %v", err)
	}
	if out.Path != filepath.Join(dir, "Book.pdf") || out.Size != 9 || out.Note != "PDF written with warnings" || !strings.HasPrefix(out.DownloadPath, "/export-api/"+docID+"/") {
		t.Fatalf("out = %+v", out)
	}
	if b, _ := os.ReadFile(out.Path); string(b) != "%PDF-fake" {
		t.Fatalf("file = %q", b)
	}
	if seen[0] != `export_pdf {"marks":true,"standard":"x4"}` {
		t.Fatalf("job = %q", seen[0])
	}

	// An explicit file name wins over the editor's.
	exact := filepath.Join(dir, "sub", "mine.pdf")
	if out, err = sess.ExportPdf(ctx, odmcp.ExportPdfInput{OutPath: exact}); err != nil || out.Path != exact {
		t.Fatalf("exact: %+v %v", out, err)
	}
	// No outPath: nothing written, a download path returned.
	if out, _ = sess.ExportPackage(ctx, odmcp.ExportPdfInput{}); out.Path != "" || out.DownloadPath == "" {
		t.Fatalf("no outPath: %+v", out)
	}

	if _, err := sess.ExportEpub(ctx, odmcp.ExportEpubInput{Mode: "reflowable"}); err == nil || !strings.Contains(err.Error(), "nothing to export") {
		t.Fatalf("editor failure should surface: %v", err)
	}
	if _, err := sess.ExportEpub(ctx, odmcp.ExportEpubInput{Mode: "weird"}); err == nil {
		t.Fatal("an unknown mode should be refused")
	}
	img, err := sess.ExportImage(ctx, odmcp.ExportImageInput{OutPath: dir, PageId: "page1", Scale: 2})
	if err != nil || img.Path != filepath.Join(dir, "page.png") {
		t.Fatalf("image: %+v %v", img, err)
	}
	if _, err := sess.ExportImage(ctx, odmcp.ExportImageInput{Format: "gif"}); err == nil {
		t.Fatal("an unknown format should be refused")
	}

	pf, err := sess.Preflight(ctx, odmcp.PreflightInput{})
	if err != nil || pf.Warnings != 1 || len(pf.Issues) != 1 || pf.Issues[0].Code != "no-bleed" {
		t.Fatalf("preflight: %+v %v", pf, err)
	}
}

// TestExportOnix covers export_onix, which the server makes by itself.
func TestExportOnix(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	if _, err := sess.ExportOnix(ctx, odmcp.ExportOnixInput{}); err == nil || !strings.Contains(err.Error(), "No ISBN-13") {
		t.Fatalf("without a record: %v", err)
	}
	if _, err := sess.SetDocumentSettings(ctx, odmcp.SetDocumentSettingsInput{Book: &odmcp.BookIO{Isbn13: "9788804668237", Title: "Rosa", PublisherName: "Bompiani"}}); err != nil {
		t.Fatal(err)
	}
	out, err := sess.ExportOnix(ctx, odmcp.ExportOnixInput{})
	if err != nil || !strings.Contains(out.Xml, `<ONIXMessage release="3.1"`) || !strings.Contains(out.Xml, "<IDValue>9788804668237</IDValue>") || len(out.Problems) == 0 {
		t.Fatalf("out = %+v err = %v", out, err)
	}
	dir := t.TempDir()
	out, err = sess.ExportOnix(ctx, odmcp.ExportOnixInput{OutPath: dir, Release: "3.0"})
	if err != nil || out.Path != filepath.Join(dir, "9788804668237.onix.xml") || out.Xml != "" {
		t.Fatalf("out = %+v err = %v", out, err)
	}
	if b, _ := os.ReadFile(out.Path); !strings.Contains(string(b), `release="3.0"`) {
		t.Fatalf("file = %s", b)
	}
	if _, err := sess.ExportOnix(ctx, odmcp.ExportOnixInput{Release: "2.1"}); err == nil {
		t.Fatal("an unknown release should be refused")
	}
}

// TestDuplicatePageAndDataMerge covers duplicate_page and data_merge.
func TestDuplicatePageAndDataMerge(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	pages, _ := sess.ListPages(ctx, struct{}{})
	first := pages.Pages[0].Id
	_, err := sess.CreateText(ctx, odmcp.CreateTextInput{ParentId: first, Width: 200, Height: 30, Name: "greeting", Content: "Dear {{Name}}, welcome"})
	if err != nil {
		t.Fatal(err)
	}
	link, _ := sess.CreateRectangle(ctx, odmcp.CreateShapeInput{ParentId: first, Width: 10, Height: 10, Name: "link"})
	if _, err := sess.SetNodeMeta(ctx, odmcp.SetNodeMetaInput{Id: link.NodeId, Meta: map[string]string{"link.url": "https://x.test/{{Id}}"}}); err != nil {
		t.Fatal(err)
	}

	dup, err := sess.DuplicatePage(ctx, odmcp.DuplicatePageInput{Id: first, Copies: 2, Name: "Copy"})
	if err != nil || len(dup.PageIds) != 2 {
		t.Fatalf("duplicate: %+v %v", dup, err)
	}
	list, _ := sess.ListPages(ctx, struct{}{})
	if len(list.Pages) != 3 || list.Pages[1].Name != "Copy 1" || list.Pages[2].Name != "Copy 2" || list.Pages[1].Id != dup.PageIds[0] {
		t.Fatalf("pages after duplicate = %+v", list.Pages)
	}
	if _, err := sess.DuplicatePage(ctx, odmcp.DuplicatePageInput{Id: "nope"}); err == nil {
		t.Fatal("an unknown page should be refused")
	}
	if _, err := sess.DuplicatePage(ctx, odmcp.DuplicatePageInput{Id: first, Copies: 99}); err == nil {
		t.Fatal("too many copies should be refused")
	}

	merged, err := sess.DataMerge(ctx, odmcp.DataMergeInput{PageId: first, Table: "Name;Id;Extra\nAda;7;x\n\"Grace Hopper\";8;y"})
	if err != nil || len(merged.PageIds) != 2 || len(merged.MissingFields) != 0 || len(merged.UnusedFields) != 1 || merged.UnusedFields[0] != "Extra" {
		t.Fatalf("merge: %+v %v", merged, err)
	}
	nodes, _ := sess.ListNodes(ctx, odmcp.ListNodesInput{PageId: merged.PageIds[1]})
	var texts, urls []string
	for _, n := range nodes.Nodes {
		if n.Kind == "text" {
			texts = append(texts, n.Text)
		}
		if u := n.Meta["link.url"]; u != "" {
			urls = append(urls, u)
		}
	}
	if len(texts) != 1 || texts[0] != "Dear Grace Hopper, welcome" || len(urls) != 1 || urls[0] != "https://x.test/8" {
		t.Fatalf("texts=%v urls=%v", texts, urls)
	}
	// The template is untouched and the merged pages sit right after it.
	list, _ = sess.ListPages(ctx, struct{}{})
	if list.Pages[0].Id != first || list.Pages[1].Id != merged.PageIds[0] || list.Pages[2].Id != merged.PageIds[1] {
		t.Fatalf("order = %+v", list.Pages)
	}
	if _, err := sess.DataMerge(ctx, odmcp.DataMergeInput{PageId: first, Table: "Name"}); err == nil {
		t.Fatal("a table with no records should be refused")
	}
	miss, err := sess.DataMerge(ctx, odmcp.DataMergeInput{PageId: first, Table: "Other\n1"})
	if err != nil || len(miss.MissingFields) != 2 {
		t.Fatalf("missing: %+v %v", miss, err)
	}
}

// TestEditorCommands covers the tools whose work the editor does: contents, tables, find and change, master overrides.
func TestEditorCommands(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	var cmds []map[string]any
	fakeEditor(t, url, docID, func(job *opendesignerv1.EditorJob) *opendesignerv1.CompleteJobRequest {
		var o map[string]any
		_ = json.Unmarshal([]byte(job.GetOptionsJson()), &o)
		cmds = append(cmds, o)
		if job.GetKind() != "command" {
			return &opendesignerv1.CompleteJobRequest{Ok: false, Message: "unexpected kind " + job.GetKind()}
		}
		switch o["name"] {
		case "generate_contents":
			return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"lines":4,"nodeIds":["toc1"]}`}
		case "insert_table":
			return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"tableId":"tbl","cells":6}`}
		case "find_change":
			if o["replace"] != nil {
				return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"replaced":3}`}
			}
			return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"count":1,"matches":[{"nodeId":"n","pageId":"p","start":2,"end":5,"text":"abc","context":"xxabcxx"}]}`}
		case "edit_table":
			return &opendesignerv1.CompleteJobRequest{Ok: false, Message: "nothing to do (index out of range)"}
		}
		return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"copiedNodeIds":["a","b"]}`}
	})

	gc, err := sess.GenerateContents(ctx, odmcp.GenerateContentsInput{Kind: "toc", MaxLevel: 2})
	if err != nil || gc.Lines != 4 || gc.NodeIds[0] != "toc1" {
		t.Fatalf("contents: %+v %v", gc, err)
	}
	if cmds[0]["name"] != "generate_contents" || cmds[0]["kind"] != "toc" || cmds[0]["maxLevel"] != float64(2) {
		t.Fatalf("sent %v", cmds[0])
	}
	hdr := 0
	tb, err := sess.InsertTable(ctx, odmcp.InsertTableInput{Rows: 3, Cols: 2, CellWidth: 90, HeaderRows: &hdr})
	if err != nil || tb.TableId != "tbl" || tb.Cells != 6 || cmds[1]["headerRows"] != float64(0) || cmds[1]["cellWidth"] != float64(90) {
		t.Fatalf("table: %+v %v sent %v", tb, err, cmds[1])
	}
	if _, err := sess.EditTable(ctx, odmcp.EditTableInput{TableId: "tbl", Action: "delete_row", Index: 9}); err == nil || !strings.Contains(err.Error(), "nothing to do") {
		t.Fatalf("an editor refusal should surface: %v", err)
	}
	list, err := sess.FindChange(ctx, odmcp.FindChangeInput{Query: "abc", Regex: true})
	if err != nil || list.Count != 1 || list.Matches[0].Context != "xxabcxx" {
		t.Fatalf("find: %+v %v", list, err)
	}
	repl := "x"
	ch, err := sess.FindChange(ctx, odmcp.FindChangeInput{Query: "abc", Replace: &repl})
	if err != nil || ch.Replaced != 3 {
		t.Fatalf("change: %+v %v", ch, err)
	}
	ov, err := sess.OverrideMasterItem(ctx, odmcp.OverrideMasterItemInput{PageId: "p", MasterNodeId: "m"})
	if err != nil || len(ov.CopiedNodeIds) != 2 {
		t.Fatalf("override: %+v %v", ov, err)
	}
}

// TestEditorCommandsWithFiles covers the tools that send a file from disk to the editor.
func TestEditorCommandsWithFiles(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	var got struct {
		name    string
		payload string
		opts    map[string]any
	}
	fakeEditor(t, url, docID, func(job *opendesignerv1.EditorJob) *opendesignerv1.CompleteJobRequest {
		got.name, got.payload = job.GetPayloadName(), string(job.GetPayload())
		got.opts = nil
		_ = json.Unmarshal([]byte(job.GetOptionsJson()), &got.opts)
		switch got.opts["name"] {
		case "import_pdf":
			return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"pages":3,"message":"Imported 3 pages"}`}
		case "upload_font":
			return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"fontId":"f1","assetHash":"` + strings.Repeat("a", 64) + `"}`}
		}
		return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"nodeId":"n1","message":"ok"}`}
	})

	dir := t.TempDir()
	file := filepath.Join(dir, "logo.png")
	if err := os.WriteFile(file, []byte("PNGDATA"), 0o644); err != nil {
		t.Fatal(err)
	}
	pl, err := sess.PlaceImage(ctx, odmcp.FileAtInput{Path: file, PageId: "p1", X: 50, Y: 60})
	if err != nil || pl.NodeId != "n1" {
		t.Fatalf("place: %+v %v", pl, err)
	}
	if got.name != "logo.png" || got.payload != "PNGDATA" || got.opts["name"] != "place_image" || got.opts["pageId"] != "p1" || got.opts["x"] != float64(50) {
		t.Fatalf("editor saw %+v", got)
	}
	pdf := filepath.Join(dir, "a.pdf")
	_ = os.WriteFile(pdf, []byte("%PDF"), 0o644)
	ip, err := sess.ImportPdf(ctx, odmcp.ImportPdfInput{Path: pdf, Mode: "image"})
	if err != nil || ip.Pages != 3 || got.opts["mode"] != "image" {
		t.Fatalf("pdf: %+v %v %v", ip, err, got.opts)
	}
	font := filepath.Join(dir, "acme.ttf")
	_ = os.WriteFile(font, []byte("TTF"), 0o644)
	uf, err := sess.UploadFont(ctx, odmcp.UploadFontInput{Path: font, Family: "Acme", Weight: "700", Italic: true})
	if err != nil || uf.FontId != "f1" || got.opts["family"] != "Acme" || got.opts["weight"] != "700" || got.opts["italic"] != true {
		t.Fatalf("font: %+v %v %v", uf, err, got.opts)
	}
	if _, err := sess.PlaceImage(ctx, odmcp.FileAtInput{Path: filepath.Join(dir, "missing.png")}); err == nil {
		t.Fatal("a missing file should be refused before asking the editor")
	}
	if _, err := sess.PlaceImage(ctx, odmcp.FileAtInput{Path: dir}); err == nil {
		t.Fatal("a directory should be refused")
	}
	if _, err := sess.RelinkImage(ctx, odmcp.RelinkImageInput{NodeId: "img", Path: file}); err != nil || got.opts["nodeId"] != "img" {
		t.Fatalf("relink: %v %v", err, got.opts)
	}
}

// TestDocumentsVersionsAndBranches covers the document-level tools.
func TestDocumentsVersionsAndBranches(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	made, err := sess.CreateDocument(ctx, odmcp.CreateDocumentInput{Name: "Brochure", Vertical: "publishing"})
	if err != nil || made.Vertical != "publishing" || made.Id == "" {
		t.Fatalf("create: %+v %v", made, err)
	}
	if _, err := sess.RenameDocument(ctx, odmcp.RenameDocumentInput{DocId: made.Id, Name: "Brochure 2"}); err != nil {
		t.Fatal(err)
	}
	list, _ := sess.ListDocuments(ctx, struct{}{})
	names := map[string]bool{}
	for _, d := range list.Documents {
		names[d.Name] = true
	}
	if !names["Brochure 2"] || len(list.Documents) < 2 {
		t.Fatalf("documents = %+v", list.Documents)
	}
	if _, err := sess.DeleteDocument(ctx, odmcp.DeleteDocumentInput{DocId: made.Id}); err == nil {
		t.Fatal("a delete without confirm must be refused")
	}
	if _, err := sess.DeleteDocument(ctx, odmcp.DeleteDocumentInput{Confirm: true}); err == nil {
		t.Fatal("a delete without a docId must be refused (never the session's own)")
	}
	if _, err := sess.DeleteDocument(ctx, odmcp.DeleteDocumentInput{DocId: made.Id, Confirm: true}); err != nil {
		t.Fatalf("delete: %v", err)
	}

	v, err := sess.CreateVersion(ctx, odmcp.CreateVersionInput{Name: "v1"})
	if err != nil || v.Name != "v1" {
		t.Fatalf("version: %+v %v", v, err)
	}
	vs, _ := sess.ListVersions(ctx, struct{}{})
	if len(vs.Versions) != 1 || vs.Versions[0].Id != v.Id {
		t.Fatalf("versions = %+v", vs)
	}

	branch, err := sess.BranchDocument(ctx, odmcp.BranchInput{VersionId: v.Id, Name: "Branch"})
	if err != nil || branch.Name != "Branch" {
		t.Fatalf("branch: %+v %v", branch, err)
	}
	bs := startSession(t, url, branch.Id, "branch")
	if o, _ := bs.GetBranchOrigin(ctx, struct{}{}); !o.IsBranch || o.SourceDocId != docID || !o.SourceExists {
		t.Fatalf("origin = %+v", o)
	}
	if o, _ := sess.GetBranchOrigin(ctx, struct{}{}); o.IsBranch {
		t.Fatalf("the original is not a branch: %+v", o)
	}
	if _, err := bs.CreatePage(ctx, odmcp.CreatePageInput{Name: "Added on the branch"}); err != nil {
		t.Fatal(err)
	}
	rev, err := bs.ReviewMerge(ctx, struct{}{})
	if err != nil || rev.SourceDocId != docID || len(rev.Changes) == 0 {
		t.Fatalf("review: %+v %v", rev, err)
	}
	merged, err := bs.MergeBranch(ctx, odmcp.MergeBranchInput{})
	if err != nil || merged.Applied == 0 {
		t.Fatalf("merge: %+v %v", merged, err)
	}
	if _, err := sess.DeleteVersion(ctx, odmcp.DeleteVersionInput{VersionId: v.Id}); err != nil {
		t.Fatal(err)
	}
	acc, err := sess.GetAccess(ctx, struct{}{})
	if err != nil || acc.Protected || acc.Role != "open" {
		t.Fatalf("access = %+v %v", acc, err)
	}
}

// TestStrokesAndLayoutGrids covers the strokes and layoutGrids of set_properties, and the structure commands' wiring.
func TestStrokesAndLayoutGrids(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	fr, err := sess.CreateFrame(ctx, odmcp.CreateFrameInput{Width: 200, Height: 100})
	if err != nil {
		t.Fatal(err)
	}
	three := int32(3)
	_ = three
	_, err = sess.SetProperties(ctx, odmcp.SetPropertiesInput{Id: fr.NodeId,
		Strokes:     []odmcp.StrokeSpec{{Color: odmcp.RGBA{R: 1, A: 1}, Weight: 2, Align: "inside"}},
		LayoutGrids: []odmcp.GridSpec{{Kind: "columns", Count: 3, Gutter: 8, Margin: 4}, {Kind: "grid", Size: 8}},
	})
	if err != nil {
		t.Fatalf("set: %v", err)
	}
	nodes, _ := sess.ListNodes(ctx, odmcp.ListNodesInput{})
	var found bool
	for _, n := range nodes.Nodes {
		if n.Id == fr.NodeId {
			found = true
		}
	}
	if !found {
		t.Fatal("frame missing")
	}
	if _, err := sess.SetProperties(ctx, odmcp.SetPropertiesInput{Id: fr.NodeId, Strokes: []odmcp.StrokeSpec{{Weight: -1}}}); err == nil {
		t.Fatal("a negative weight should be refused")
	}
	if _, err := sess.SetProperties(ctx, odmcp.SetPropertiesInput{Id: fr.NodeId, Strokes: []odmcp.StrokeSpec{{Weight: 1, Align: "around"}}}); err == nil {
		t.Fatal("an unknown align should be refused")
	}
	if _, err := sess.SetProperties(ctx, odmcp.SetPropertiesInput{Id: fr.NodeId, LayoutGrids: []odmcp.GridSpec{{Kind: "hexagons"}}}); err == nil {
		t.Fatal("an unknown grid kind should be refused")
	}
	if _, err := sess.SetProperties(ctx, odmcp.SetPropertiesInput{Id: fr.NodeId, LayoutGrids: []odmcp.GridSpec{{Kind: "columns", Count: 0}}}); err == nil {
		t.Fatal("zero columns should be refused by the document")
	}
	if _, err := sess.SetProperties(ctx, odmcp.SetPropertiesInput{Id: fr.NodeId, Strokes: []odmcp.StrokeSpec{}, LayoutGrids: []odmcp.GridSpec{}}); err != nil {
		t.Fatalf("empty lists clear: %v", err)
	}
}

// TestStructureAndVectorCommandsAreWired checks the names and arguments the structure and vector tools send.
func TestStructureAndVectorCommandsAreWired(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	var last map[string]any
	fakeEditor(t, url, docID, func(job *opendesignerv1.EditorJob) *opendesignerv1.CompleteJobRequest {
		last = nil
		_ = json.Unmarshal([]byte(job.GetOptionsJson()), &last)
		text := `{"nodeId":"v","groupId":"g","nodeIds":["c"],"selection":["s"],"width":60,"moved":true}`
		if last["name"] == "align_nodes" {
			text = `{"moved":2}`
		}
		return &opendesignerv1.CompleteJobRequest{Ok: true, Text: text}
	})
	check := func(name string, want map[string]any) {
		t.Helper()
		if last["name"] != name {
			t.Fatalf("command = %v, want %s", last["name"], name)
		}
		for k, v := range want {
			if !reflect.DeepEqual(last[k], v) {
				t.Fatalf("%s: %s = %#v, want %#v", name, k, last[k], v)
			}
		}
	}
	if a, err := sess.AlignNodes(ctx, odmcp.AlignNodesInput{NodeIds: []string{"a", "b"}, Command: "hcenter"}); err != nil || a.Moved != 2 {
		t.Fatalf("align: %+v %v", a, err)
	}
	check("align_nodes", map[string]any{"command": "hcenter"})
	if g, err := sess.BooleanOperation(ctx, odmcp.BooleanInput{NodeIds: []string{"a", "b"}, Op: "subtract"}); err != nil || g.GroupId != "g" {
		t.Fatalf("boolean: %+v %v", g, err)
	}
	check("boolean_operation", map[string]any{"op": "subtract"})
	if _, err := sess.FlattenBoolean(ctx, odmcp.FlattenInput{GroupId: "g"}); err != nil {
		t.Fatal(err)
	}
	check("flatten_boolean", map[string]any{"groupId": "g"})
	if _, err := sess.OutlineStroke(ctx, odmcp.OutlineStrokeInput{NodeId: "n"}); err != nil {
		t.Fatal(err)
	}
	check("outline_stroke", map[string]any{"nodeId": "n"})
	if _, err := sess.ReorderNode(ctx, odmcp.ReorderInput{NodeId: "a", To: "front"}); err != nil {
		t.Fatal(err)
	}
	check("reorder_node", map[string]any{"to": "front"})
	v, err := sess.CreateVector(ctx, odmcp.CreateVectorInput{
		Name:  "Tri",
		Paths: []odmcp.PathIO{{Closed: true, Anchors: []odmcp.AnchorIO{{X: 0, Y: 0}, {X: 60, Y: 0, OutY: 5}, {X: 30, Y: 60}}}},
		Fill:  &odmcp.RGBA{R: 1, A: 1}, Stroke: &odmcp.StrokeIO{Color: odmcp.RGBA{A: 1}, Weight: 2},
	})
	if err != nil || v.NodeId != "v" || v.Width != 60 {
		t.Fatalf("vector: %+v %v", v, err)
	}
	check("create_vector", map[string]any{"nodeName": "Tri"})
	paths := last["paths"].([]any)[0].(map[string]any)
	if paths["closed"] != true || len(paths["anchors"].([]any)) != 3 {
		t.Fatalf("paths sent = %v", paths)
	}
	if _, err := sess.SetVectorPath(ctx, odmcp.SetVectorPathInput{NodeId: "v", Paths: []odmcp.PathIO{{Anchors: []odmcp.AnchorIO{{X: 1, Y: 1}}}}}); err != nil {
		t.Fatal(err)
	}
	check("set_vector_path", map[string]any{"nodeId": "v"})
}

// TestLongDocumentSettingsAndCommands covers conditions and table styles in set_document_settings and the three long-document commands.
func TestLongDocumentSettingsAndCommands(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	conds := []odmcp.ConditionIO{{Name: "Print", Visible: true}, {Name: "Web only"}}
	styles := []odmcp.TableStyleIO{{Id: "ts1", Name: "Report", HeaderObjectStyleId: "os1", BodyTextStyleId: "tx1"}}
	if _, err := sess.SetDocumentSettings(ctx, odmcp.SetDocumentSettingsInput{Conditions: &conds, TableStyles: &styles}); err != nil {
		t.Fatalf("settings: %v", err)
	}
	dup := []odmcp.ConditionIO{{Name: "A"}, {Name: "A"}}
	if _, err := sess.SetDocumentSettings(ctx, odmcp.SetDocumentSettingsInput{Conditions: &dup}); err == nil {
		t.Fatal("a repeated condition should be refused")
	}
	badStyle := []odmcp.TableStyleIO{{Id: "has space", Name: "x"}}
	if _, err := sess.SetDocumentSettings(ctx, odmcp.SetDocumentSettingsInput{TableStyles: &badStyle}); err == nil {
		t.Fatal("a table style id with a space should be refused")
	}
	empty := []odmcp.ConditionIO{}
	if _, err := sess.SetDocumentSettings(ctx, odmcp.SetDocumentSettingsInput{Conditions: &empty}); err != nil {
		t.Fatalf("an empty list clears: %v", err)
	}

	var last map[string]any
	fakeEditor(t, url, docID, func(job *opendesignerv1.EditorJob) *opendesignerv1.CompleteJobRequest {
		last = nil
		_ = json.Unmarshal([]byte(job.GetOptionsJson()), &last)
		switch last["name"] {
		case "apply_table_style":
			return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"tableId":"tbl","changed":7}`}
		case "check_text":
			return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"count":1,"issues":[{"code":"double-space","nodeId":"n","pageId":"p","start":3,"end":5,"text":"  ","message":"More than one space in a row."}]}`}
		}
		return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"notes":[{"nodeId":"n","pageId":"p","at":9,"text":"fix","context":"the words"}]}`}
	})
	ts, err := sess.ApplyTableStyle(ctx, odmcp.ApplyTableStyleInput{TableId: "tbl", StyleId: "ts1"})
	if err != nil || ts.Changed != 7 || last["styleId"] != "ts1" {
		t.Fatalf("table style: %+v %v %v", ts, err, last)
	}
	ck, err := sess.CheckText(ctx, odmcp.CheckTextInput{Checks: []string{"double-space"}, Limit: 5})
	if err != nil || ck.Count != 1 || ck.Issues[0].Code != "double-space" || last["limit"] != float64(5) {
		t.Fatalf("check: %+v %v %v", ck, err, last)
	}
	nt, err := sess.ListEditorialNotes(ctx, struct{}{})
	if err != nil || len(nt.Notes) != 1 || nt.Notes[0].Text != "fix" {
		t.Fatalf("notes: %+v %v", nt, err)
	}
}

// TestObjectToolCommands covers the object-tool commands: each sends its arguments to the editor and reads the answer back.
func TestObjectToolCommands(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	var last map[string]any
	fakeEditor(t, url, docID, func(job *opendesignerv1.EditorJob) *opendesignerv1.CompleteJobRequest {
		last = nil
		_ = json.Unmarshal([]byte(job.GetOptionsJson()), &last)
		switch last["name"] {
		case "step_and_repeat", "place_snippet":
			return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"nodeIds":["a","b"]}`}
		case "set_gap":
			return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"moved":2}`}
		case "fit_frame":
			return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"changed":1}`}
		case "clip_with_shape", "create_qr_code":
			return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"groupId":"grp"}`}
		case "find_objects":
			return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"count":1,"nodes":[{"id":"n1","name":"Logo","kind":"rect"}]}`}
		case "change_objects":
			return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"matched":3,"changed":3}`}
		}
		return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"snippet":"{}"}`}
	})
	if r, err := sess.StepAndRepeat(ctx, odmcp.StepAndRepeatInput{NodeIds: []string{"n"}, Count: 3, Dx: 10, Dy: 0}); err != nil || len(r.NodeIds) != 2 || last["count"] != float64(3) || last["dx"] != float64(10) {
		t.Fatalf("step: %+v %v %v", r, err, last)
	}
	if r, err := sess.SetGap(ctx, odmcp.SetGapInput{NodeIds: []string{"a", "b"}, Axis: "x", Gap: 4}); err != nil || r.Moved != 2 || last["axis"] != "x" {
		t.Fatalf("gap: %+v %v", r, err)
	}
	if r, err := sess.FitFrame(ctx, odmcp.FitFrameInput{NodeId: "n", Mode: "fit"}); err != nil || r.Changed != 1 || last["mode"] != "fit" {
		t.Fatalf("fit: %+v %v", r, err)
	}
	if r, err := sess.ClipWithShape(ctx, odmcp.ClipWithShapeInput{ShapeId: "s", ContentIds: []string{"c"}}); err != nil || r.GroupId != "grp" || last["contentIds"] == nil {
		t.Fatalf("clip: %+v %v %v", r, err, last)
	}
	if _, err := sess.ClipWithShape(ctx, odmcp.ClipWithShapeInput{ShapeId: "s", Release: true}); err != nil || last["release"] != true || last["contentIds"] != nil {
		t.Fatalf("release: %v %v", err, last)
	}
	dark := &odmcp.RGBA{R: 0, G: 0, B: 0.5, A: 1}
	if r, err := sess.CreateQRCode(ctx, odmcp.CreateQRCodeInput{Text: "hi", Level: "Q", Size: 80, Dark: dark}); err != nil || r.GroupId != "grp" || last["level"] != "Q" || last["dark"] == nil {
		t.Fatalf("qr: %+v %v %v", r, err, last)
	}
	if r, err := sess.FindObjects(ctx, odmcp.ObjectQueryInput{Kind: "rect", NameMatches: "^L"}); err != nil || r.Count != 1 || r.Nodes[0].Name != "Logo" || last["nameMatches"] != "^L" {
		t.Fatalf("find: %+v %v", r, err)
	}
	op := 0.5
	if r, err := sess.ChangeObjects(ctx, odmcp.ChangeObjectsInput{ObjectQueryInput: odmcp.ObjectQueryInput{Kind: "rect"}, Change: odmcp.ObjectChangeIO{Opacity: &op}}); err != nil || r.Changed != 3 || last["change"].(map[string]any)["opacity"] != 0.5 {
		t.Fatalf("change: %+v %v %v", r, err, last)
	}
	if r, err := sess.ExportSnippet(ctx, odmcp.NodeIdsInput{NodeIds: []string{"n"}}); err != nil || r.Snippet != "{}" {
		t.Fatalf("export: %+v %v", r, err)
	}
	if r, err := sess.PlaceSnippet(ctx, odmcp.PlaceSnippetInput{Snippet: "{}", X: 5, Y: 6}); err != nil || len(r.NodeIds) != 2 || last["x"] != float64(5) {
		t.Fatalf("place: %+v %v", r, err)
	}
}

// TestFormatJobs covers the HTML, PowerPoint and IDML exports, IDML import and placing Word/RTF/Excel files.
func TestFormatJobs(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	var kinds []string
	var last map[string]any
	fakeEditor(t, url, docID, func(job *opendesignerv1.EditorJob) *opendesignerv1.CompleteJobRequest {
		kinds = append(kinds, job.GetKind())
		last = nil
		_ = json.Unmarshal([]byte(job.GetOptionsJson()), &last)
		switch last["name"] {
		case "import_idml":
			return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"pages":2,"nodes":7,"message":"Imported"}`}
		case "place_document":
			return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"nodeId":"n","kind":"text","paragraphs":4}`}
		}
		return &opendesignerv1.CompleteJobRequest{Ok: true, Filename: "Book.out", ContentType: "application/octet-stream", Data: []byte("DATA")}
	})
	dir := t.TempDir()
	for _, tc := range []struct {
		kind string
		call func() (odmcp.JobOutput, error)
	}{
		{"export_html", func() (odmcp.JobOutput, error) { return sess.ExportHtml(ctx, odmcp.ExportFileInput{OutPath: dir}) }},
		{"export_pptx", func() (odmcp.JobOutput, error) { return sess.ExportPptx(ctx, odmcp.ExportFileInput{OutPath: dir}) }},
		{"export_idml", func() (odmcp.JobOutput, error) { return sess.ExportIdml(ctx, odmcp.ExportFileInput{OutPath: dir}) }},
	} {
		out, err := tc.call()
		if err != nil || out.Size != 4 || kinds[len(kinds)-1] != tc.kind {
			t.Fatalf("%s: %+v %v %v", tc.kind, out, err, kinds)
		}
	}

	src := filepath.Join(dir, "in.idml")
	if err := os.WriteFile(src, []byte("PK"), 0o644); err != nil {
		t.Fatal(err)
	}
	im, err := sess.ImportIdml(ctx, odmcp.ImportIdmlInput{Path: src})
	if err != nil || im.Pages != 2 || im.Nodes != 7 || last["name"] != "import_idml" {
		t.Fatalf("idml: %+v %v %v", im, err, last)
	}
	doc := filepath.Join(dir, "in.docx")
	if err := os.WriteFile(doc, []byte("PK"), 0o644); err != nil {
		t.Fatal(err)
	}
	pd, err := sess.PlaceDocument(ctx, odmcp.PlaceDocumentInput{FileAtInput: odmcp.FileAtInput{Path: doc, X: 5}, Width: 300})
	if err != nil || pd.Kind != "text" || pd.Paragraphs != 4 || last["width"] != float64(300) || last["x"] != float64(5) {
		t.Fatalf("place: %+v %v %v", pd, err, last)
	}
}

// TestInkAndBatchCommands covers the ink manager, overprint and batch tools.
func TestInkAndBatchCommands(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	sess := startSession(t, url, docID, "mcp")
	ctx := context.Background()

	var last map[string]any
	fakeEditor(t, url, docID, func(job *opendesignerv1.EditorJob) *opendesignerv1.CompleteJobRequest {
		last = nil
		_ = json.Unmarshal([]byte(job.GetOptionsJson()), &last)
		switch last["name"] {
		case "ink_report":
			return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"process":{"swatches":2,"objects":5},"spots":[{"name":"PANTONE 871 C","swatches":["Gold"],"objects":3,"alt":{"c":0.1,"m":0.3,"y":0.9,"k":0}}],"overprint":1,"overLimit":[{"swatch":"Rich black","total":310}]}`}
		case "convert_spots_to_process":
			return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"converted":2}`}
		case "merge_spot_inks":
			return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"swatches":1}`}
		case "set_overprint":
			return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"changed":2}`}
		case "batch":
			return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"results":[{"changed":1},null]}`}
		}
		return &opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"commands":["a","b"],"fileCommands":["place_image"]}`}
	})
	r, err := sess.InkReport(ctx, odmcp.InkReportInput{Limit: 280})
	if err != nil || r.Process.Objects != 5 || r.Spots[0].Name != "PANTONE 871 C" || r.Spots[0].Alt.Y != 0.9 || r.OverLimit[0].Total != 310 || last["limit"] != float64(280) {
		t.Fatalf("report: %+v %v %v", r, err, last)
	}
	if c, err := sess.ConvertSpotsToProcess(ctx, odmcp.ConvertSpotsInput{Inks: []string{"x"}}); err != nil || c.Converted != 2 || last["inks"] == nil {
		t.Fatalf("convert: %+v %v", c, err)
	}
	if m, err := sess.MergeSpotInks(ctx, odmcp.MergeSpotInksInput{From: "a", To: "b"}); err != nil || m.Swatches != 1 || last["to"] != "b" {
		t.Fatalf("merge: %+v %v", m, err)
	}
	if o, err := sess.SetOverprint(ctx, odmcp.SetOverprintInput{NodeIds: []string{"n"}, Mode: "both"}); err != nil || o.Changed != 2 || last["mode"] != "both" {
		t.Fatalf("overprint: %+v %v", o, err)
	}
	b, err := sess.Batch(ctx, odmcp.BatchInput{Commands: []map[string]any{{"name": "set_overprint", "nodeIds": []string{"n"}, "mode": "fill"}, {"name": "ink_report"}}})
	if err != nil || len(b.Results) != 2 || len(last["commands"].([]any)) != 2 {
		t.Fatalf("batch: %+v %v %v", b, err, last)
	}
	l, err := sess.ListEditorCommands(ctx, struct{}{})
	if err != nil || len(l.Commands) != 2 || l.FileCommands[0] != "place_image" || last["name"] != "list_commands" {
		t.Fatalf("list: %+v %v %v", l, err, last)
	}
}
