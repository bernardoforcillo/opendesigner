package mcp_test

import (
	"context"
	"strings"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func ptr[T any](v T) *T { return &v }

// frame creates a screen (frame) and returns its id.
func frame(t *testing.T, s *odmcp.Session, name string) string {
	t.Helper()
	out, err := s.CreateFrame(context.Background(), odmcp.CreateFrameInput{Width: 100, Height: 100, Name: name})
	if err != nil {
		t.Fatalf("CreateFrame(%s): %v", name, err)
	}
	return out.NodeId
}

// TestFlowToolsEndToEnd drives the whole flows workflow through the tools:
// creates screens and a flow, links the transitions, writes the metadata,
// analyses, reads the spec, and checks the validations.
func TestFlowToolsEndToEnd(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	home, login, fine := frame(t, s, "Home"), frame(t, s, "Login"), frame(t, s, "End")
	btn := frame(t, s, "Button")

	// --- meta: merge, not replace ---
	if _, err := s.SetNodeMeta(ctx, odmcp.SetNodeMetaInput{Id: home, Meta: map[string]string{"code.route": "/", "status": "planned"}}); err != nil {
		t.Fatal(err)
	}
	out, err := s.SetNodeMeta(ctx, odmcp.SetNodeMetaInput{Id: home, Meta: map[string]string{"code.component": "HomePage", "status": "implemented"}})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"code.route": "/", "code.component": "HomePage", "status": "implemented"}
	if len(out.Meta) != 3 || out.Meta["code.route"] != "/" || out.Meta["status"] != "implemented" {
		t.Fatalf("meta = %v, want %v", out.Meta, want)
	}
	if _, err := s.SetNodeMeta(ctx, odmcp.SetNodeMetaInput{Id: home, Unset: []string{"code.component"}}); err != nil {
		t.Fatal(err)
	}
	doc, _ := s.GetDocument(ctx, struct{}{})
	if n, _ := nodeByID(doc, home); len(n.Meta) != 2 || n.Meta["code.component"] != "" {
		t.Fatalf("after unset: %v", n.Meta)
	}
	if _, err := s.SetNodeMeta(ctx, odmcp.SetNodeMetaInput{Id: btn, Meta: map[string]string{"test.id": "go-login"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetNodeMeta(ctx, odmcp.SetNodeMetaInput{Id: login, Meta: map[string]string{"code.route": "/login"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetNodeMeta(ctx, odmcp.SetNodeMetaInput{Id: fine, Meta: map[string]string{"flow.kind": "end"}}); err != nil {
		t.Fatal(err)
	}

	// --- flow and transitions ---
	created, err := s.CreateFlow(ctx, odmcp.CreateFlowInput{Name: "Access", Description: "Enter the app", StartId: home})
	if err != nil || created.FlowId == "" {
		t.Fatalf("CreateFlow: %+v %v", created, err)
	}
	t1, err := s.SetTransition(ctx, odmcp.SetTransitionInput{FlowId: created.FlowId, FromId: home, ToId: login, Label: ptr("Sign in"), ElementId: ptr(btn)})
	if err != nil || !t1.Created || t1.TransitionId == "" {
		t.Fatalf("SetTransition create: %+v %v", t1, err)
	}
	// Partial update: the default trigger stays, the guard is added.
	upd, err := s.SetTransition(ctx, odmcp.SetTransitionInput{Id: t1.TransitionId, Guard: ptr("anonymous user")})
	if err != nil || upd.Created {
		t.Fatalf("SetTransition update: %+v %v", upd, err)
	}
	if _, err := s.SetTransition(ctx, odmcp.SetTransitionInput{FlowId: created.FlowId, FromId: login, ToId: fine, Label: ptr("Enter"), Trigger: ptr("submit")}); err != nil {
		t.Fatal(err)
	}

	got, err := s.GetFlow(ctx, odmcp.GetFlowInput{Id: created.FlowId})
	if err != nil {
		t.Fatal(err)
	}
	if got.StartId != home || len(got.Screens) != 3 || len(got.Transitions) != 2 {
		t.Fatalf("GetFlow = %+v", got)
	}
	var tr1 odmcp.TransitionView
	for _, tv := range got.Transitions {
		if tv.Id == t1.TransitionId {
			tr1 = tv
		}
	}
	if tr1.Label != "Sign in" || tr1.Trigger != "click" || tr1.Guard != "anonymous user" || tr1.ElementId != btn || tr1.FromName != "Home" || tr1.ToName != "Login" {
		t.Errorf("transition = %+v", tr1)
	}
	var homeView odmcp.ScreenView
	for _, sv := range got.Screens {
		if sv.NodeId == home {
			homeView = sv
		}
	}
	if homeView.Route != "/" || homeView.Status != "implemented" || homeView.Kind != "screen" {
		t.Errorf("screen = %+v", homeView)
	}

	list, _ := s.ListFlows(ctx, struct{}{})
	if len(list.Flows) != 1 || list.Flows[0].Screens != 3 || list.Flows[0].Transitions != 2 {
		t.Errorf("ListFlows = %+v", list)
	}

	// --- analysis and spec ---
	an, err := s.AnalyzeFlows(ctx, odmcp.AnalyzeFlowsInput{})
	if err != nil || an.Issues != 0 || len(an.Reports) != 1 || len(an.Reports[0].Paths) != 1 {
		t.Fatalf("AnalyzeFlows = %+v %v", an, err)
	}
	if p := an.Reports[0].Paths[0]; strings.Join(p.Screens, ">") != "Home>Login>End" {
		t.Errorf("path = %v", p.Screens)
	}
	spec, err := s.GetFlowSpec(ctx, odmcp.AnalyzeFlowsInput{FlowId: created.FlowId})
	if err != nil || !strings.Contains(spec.Markdown, "**Home** --[click: Sign in]--> **Login**") {
		t.Fatalf("spec = %q %v", spec.Markdown, err)
	}

	// A transition that creates an ambiguity is reported.
	if _, err := s.SetTransition(ctx, odmcp.SetTransitionInput{FlowId: created.FlowId, FromId: login, ToId: home, Label: ptr("Enter"), Trigger: ptr("submit")}); err != nil {
		t.Fatal(err)
	}
	an, _ = s.AnalyzeFlows(ctx, odmcp.AnalyzeFlowsInput{FlowId: created.FlowId})
	if an.Issues != 1 || an.Reports[0].Issues[0].Kind != "ambiguous" {
		t.Errorf("ambiguity: %+v", an)
	}

	// --- deletions ---
	if _, err := s.DeleteTransition(ctx, odmcp.NodeIdInput{Id: t1.TransitionId}); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetFlow(ctx, odmcp.GetFlowInput{Id: created.FlowId}); len(got.Transitions) != 2 {
		t.Errorf("after delete_transition: %d transitions", len(got.Transitions))
	}
	if _, err := s.DeleteFlow(ctx, odmcp.GetFlowInput{Id: created.FlowId}); err != nil {
		t.Fatal(err)
	}
	if list, _ := s.ListFlows(ctx, struct{}{}); len(list.Flows) != 0 {
		t.Errorf("flows after delete_flow: %+v", list)
	}
}

func TestFlowToolValidation(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()
	a, b := frame(t, s, "A"), frame(t, s, "B")
	f, err := s.CreateFlow(ctx, odmcp.CreateFlowInput{Name: "F"})
	if err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name string
		call func() error
		want string
	}{
		{"flow without a name", func() error { _, err := s.CreateFlow(ctx, odmcp.CreateFlowInput{}); return err }, "name is required"},
		{"nonexistent start", func() error { _, err := s.CreateFlow(ctx, odmcp.CreateFlowInput{Name: "x", StartId: "zz"}); return err }, "startId"},
		{"transition without a flow", func() error {
			_, err := s.SetTransition(ctx, odmcp.SetTransitionInput{FromId: a, ToId: b})
			return err
		}, "flowId is required"},
		{"nonexistent flow", func() error {
			_, err := s.SetTransition(ctx, odmcp.SetTransitionInput{FlowId: "zz", FromId: a, ToId: b})
			return err
		}, "does not exist"},
		{"nonexistent from", func() error {
			_, err := s.SetTransition(ctx, odmcp.SetTransitionInput{FlowId: f.FlowId, FromId: "zz", ToId: b})
			return err
		}, "fromId"},
		{"nonexistent to", func() error {
			_, err := s.SetTransition(ctx, odmcp.SetTransitionInput{FlowId: f.FlowId, FromId: a, ToId: "zz"})
			return err
		}, "toId"},
		{"missing to", func() error {
			_, err := s.SetTransition(ctx, odmcp.SetTransitionInput{FlowId: f.FlowId, FromId: a})
			return err
		}, "are required"},
		{"nonexistent element", func() error {
			_, err := s.SetTransition(ctx, odmcp.SetTransitionInput{FlowId: f.FlowId, FromId: a, ToId: b, ElementId: ptr("zz")})
			return err
		}, "elementId"},
		{"update of an unknown id", func() error {
			_, err := s.SetTransition(ctx, odmcp.SetTransitionInput{Id: "zz", Label: ptr("x")})
			return err
		}, "not found"},
		{"delete unknown transition", func() error { _, err := s.DeleteTransition(ctx, odmcp.NodeIdInput{Id: "zz"}); return err }, "not found"},
		{"delete unknown flow", func() error { _, err := s.DeleteFlow(ctx, odmcp.GetFlowInput{Id: "zz"}); return err }, "not found"},
		{"get unknown flow", func() error { _, err := s.GetFlow(ctx, odmcp.GetFlowInput{Id: "zz"}); return err }, "not found"},
		{"analyse unknown flow", func() error { _, err := s.AnalyzeFlows(ctx, odmcp.AnalyzeFlowsInput{FlowId: "zz"}); return err }, "not found"},
		{"spec of unknown flow", func() error { _, err := s.GetFlowSpec(ctx, odmcp.AnalyzeFlowsInput{FlowId: "zz"}); return err }, "not found"},
		{"empty meta", func() error { _, err := s.SetNodeMeta(ctx, odmcp.SetNodeMetaInput{Id: a}); return err }, "nothing to do"},
		{"meta of unknown node", func() error {
			_, err := s.SetNodeMeta(ctx, odmcp.SetNodeMetaInput{Id: "zz", Meta: map[string]string{"k": "v"}})
			return err
		}, "not found"},
		{"invalid flow.kind", func() error {
			_, err := s.SetNodeMeta(ctx, odmcp.SetNodeMetaInput{Id: a, Meta: map[string]string{"flow.kind": "page"}})
			return err
		}, "flow.kind"},
		{"invalid status", func() error {
			_, err := s.SetNodeMeta(ctx, odmcp.SetNodeMetaInput{Id: a, Meta: map[string]string{"status": "done"}})
			return err
		}, "status"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.call()
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("err = %v, want one containing %q", err, tc.want)
			}
		})
	}
}

// TestFlowToolsRegisteredOverMCP: the nine tools appear on the MCP server and
// really respond over the protocol channel.
func TestFlowToolsRegisteredOverMCP(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	srv := mcp.NewServer(&mcp.Implementation{Name: "opendesigner", Version: "test"}, nil)
	odmcp.RegisterTools(srv, s)
	ct, st := mcp.NewInMemoryTransports()
	if _, err := srv.Connect(ctx, st, nil); err != nil {
		t.Fatal(err)
	}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil).Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()

	tools, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	have := map[string]string{}
	for _, tl := range tools.Tools {
		have[tl.Name] = tl.Description
	}
	for _, name := range []string{"list_flows", "get_flow", "create_flow", "delete_flow", "set_transition", "delete_transition", "set_node_meta", "analyze_flows", "get_flow_spec"} {
		d, ok := have[name]
		if !ok {
			t.Errorf("tool %s not registered", name)
		}
		_ = d
	}
	if !strings.Contains(have["set_node_meta"], "code.route") || !strings.Contains(have["set_transition"], "guard") {
		t.Error("the descriptions must explain the conventions")
	}

	res, err := cs.CallTool(ctx, &mcp.CallToolParams{Name: "create_flow", Arguments: map[string]any{"name": "Via MCP"}})
	if err != nil || res.IsError {
		t.Fatalf("create_flow: %v %+v", err, res)
	}
	res, err = cs.CallTool(ctx, &mcp.CallToolParams{Name: "get_flow", Arguments: map[string]any{"id": "nope"}})
	if err != nil || !res.IsError {
		t.Fatalf("get_flow on an unknown id must be a tool error: %v %+v", err, res)
	}
	res, err = cs.CallTool(ctx, &mcp.CallToolParams{Name: "analyze_flows", Arguments: map[string]any{}})
	if err != nil || res.IsError {
		t.Fatalf("analyze_flows: %v %+v", err, res)
	}
}
