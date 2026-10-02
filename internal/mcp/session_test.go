package mcp_test

import (
	"context"
	"net/http"
	"net/http/httptest"
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

	bad := []odmcp.RGBA{
		{Gradient: &odmcp.GradientSpec{Kind: "conic", X2: 1, Stops: grad.Gradient.Stops}},
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
