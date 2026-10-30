package mcp_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// agentClient serves the whole agent surface (specific tools, generic tools, resources, prompts) over the
// protocol channel and returns a connected client.
func agentClient(t *testing.T) *mcp.ClientSession {
	t.Helper()
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()
	srv := mcp.NewServer(&mcp.Implementation{Name: "opendesigner", Version: "test"}, nil)
	odmcp.RegisterTools(srv, s)
	odmcp.RegisterAgentSurface(srv, s)
	ct, st := mcp.NewInMemoryTransports()
	if _, err := srv.Connect(ctx, st, nil); err != nil {
		t.Fatal(err)
	}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil).Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cs.Close() })
	return cs
}

func call(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any) *mcp.CallToolResult {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return res
}

func errText(res *mcp.CallToolResult) string {
	var parts []string
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			parts = append(parts, tc.Text)
		}
	}
	return strings.Join(parts, " ")
}

func nodeID(t *testing.T, res *mcp.CallToolResult) string {
	t.Helper()
	if res.IsError {
		t.Fatalf("tool error: %s", errText(res))
	}
	b, _ := json.Marshal(res.StructuredContent)
	var out struct {
		NodeId string `json:"nodeId"`
	}
	if err := json.Unmarshal(b, &out); err != nil || out.NodeId == "" {
		t.Fatalf("no nodeId in %s", b)
	}
	return out.NodeId
}

func TestCreateNodeAndGetNode(t *testing.T) {
	cs := agentClient(t)
	frame := nodeID(t, call(t, cs, "create_node", map[string]any{"type": "frame", "x": 10, "y": 20, "width": 300, "height": 200, "name": "Card", "clipsContent": true}))
	text := nodeID(t, call(t, cs, "create_node", map[string]any{"type": "text", "parentId": frame, "text": "Hello", "x": 8, "y": 8, "width": 100, "height": 20, "fontSize": 18}))
	rect := nodeID(t, call(t, cs, "create_node", map[string]any{"type": "rectangle", "parentId": frame, "width": 50, "height": 50}))
	ell := nodeID(t, call(t, cs, "create_node", map[string]any{"type": "ellipse", "width": 40, "height": 40}))
	if text == rect || rect == ell {
		t.Fatal("each call must create a node")
	}

	res := call(t, cs, "get_node", map[string]any{"id": frame})
	if res.IsError {
		t.Fatalf("get_node: %+v", res.Content)
	}
	b, _ := json.Marshal(res.StructuredContent)
	if !strings.Contains(string(b), `"name":"Card"`) || !strings.Contains(string(b), `"width":300`) {
		t.Errorf("get_node = %s", b)
	}
	txt := call(t, cs, "get_node", map[string]any{"id": text})
	b, _ = json.Marshal(txt.StructuredContent)
	if !strings.Contains(string(b), "Hello") || !strings.Contains(string(b), frame) {
		t.Errorf("the text node must read back with its content and parent: %s", b)
	}
}

func TestCreateNodeRefusesWhatItCannotDo(t *testing.T) {
	cs := agentClient(t)
	if res := call(t, cs, "create_node", map[string]any{"type": "hexagon", "width": 1, "height": 1}); !res.IsError {
		t.Error("an unknown type must be a tool error")
	}
	if res := call(t, cs, "create_node", map[string]any{"type": "text", "x": 0, "y": 0}); !res.IsError {
		t.Error("a text node without text must be a tool error")
	}
	if res := call(t, cs, "get_node", map[string]any{"id": "nope"}); !res.IsError {
		t.Error("an unknown node must be a tool error")
	}
}

func TestInspectDocumentIsTheDocument(t *testing.T) {
	cs := agentClient(t)
	id := nodeID(t, call(t, cs, "create_node", map[string]any{"type": "rectangle", "width": 5, "height": 5, "name": "Seen"}))
	res := call(t, cs, "inspect_document", map[string]any{})
	b, _ := json.Marshal(res.StructuredContent)
	if res.IsError || !strings.Contains(string(b), id) {
		t.Errorf("inspect_document must list the new node: %s", b)
	}
}

func TestResources(t *testing.T) {
	cs := agentClient(t)
	ctx := context.Background()
	id := nodeID(t, call(t, cs, "create_node", map[string]any{"type": "rectangle", "width": 5, "height": 5, "name": "ViaResource"}))

	list, err := cs.ListResources(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	uris := map[string]bool{}
	for _, r := range list.Resources {
		uris[r.URI] = true
	}
	if !uris["opendesigner://document"] || !uris["opendesigner://comments"] {
		t.Errorf("resources = %v", uris)
	}
	tmpl, err := cs.ListResourceTemplates(ctx, nil)
	if err != nil || len(tmpl.ResourceTemplates) != 1 || tmpl.ResourceTemplates[0].URITemplate != "opendesigner://node/{id}" {
		t.Errorf("templates = %+v, %v", tmpl, err)
	}

	doc, err := cs.ReadResource(ctx, &mcp.ReadResourceParams{URI: "opendesigner://document"})
	if err != nil || len(doc.Contents) != 1 || !strings.Contains(doc.Contents[0].Text, id) {
		t.Fatalf("document resource: %+v, %v", doc, err)
	}
	node, err := cs.ReadResource(ctx, &mcp.ReadResourceParams{URI: "opendesigner://node/" + id})
	if err != nil || !strings.Contains(node.Contents[0].Text, "ViaResource") {
		t.Fatalf("node resource: %+v, %v", node, err)
	}
	if _, err := cs.ReadResource(ctx, &mcp.ReadResourceParams{URI: "opendesigner://node/nope"}); err == nil {
		t.Error("an unknown node must be a resource-not-found error")
	}
	if _, err := cs.ReadResource(ctx, &mcp.ReadResourceParams{URI: "opendesigner://comments"}); err != nil {
		t.Errorf("comments resource: %v", err)
	}
}

func TestPrompts(t *testing.T) {
	cs := agentClient(t)
	ctx := context.Background()
	list, err := cs.ListPrompts(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	have := map[string]bool{}
	for _, p := range list.Prompts {
		have[p.Name] = true
	}
	for _, name := range []string{"mobile_screen", "design_system", "landing_page", "prototype_flow", "fix_comments", "watch_comments"} {
		if !have[name] {
			t.Errorf("prompt %s not registered", name)
		}
	}

	get := func(name string, args map[string]string) (string, error) {
		r, err := cs.GetPrompt(ctx, &mcp.GetPromptParams{Name: name, Arguments: args})
		if err != nil {
			return "", err
		}
		return r.Messages[0].Content.(*mcp.TextContent).Text, nil
	}
	text, err := get("mobile_screen", map[string]string{"screen": "Sign in", "brand_color": "#FF0000"})
	if err != nil || !strings.Contains(text, `"Sign in"`) || !strings.Contains(text, "#FF0000") || !strings.Contains(text, "iPhone 16") {
		t.Errorf("mobile_screen = %q, %v", text, err)
	}
	if _, err := get("landing_page", nil); err == nil {
		t.Error("a missing required argument must be an error")
	}
	if text, _ := get("fix_comments", map[string]string{"auto_resolve": "no"}); !strings.Contains(text, "Leave it open") || strings.Contains(text, "Then resolve_comment") {
		t.Errorf("auto_resolve no must not resolve: %q", text)
	}
	if text, _ := get("watch_comments", map[string]string{"minutes": "9"}); !strings.Contains(text, "9 minutes") {
		t.Errorf("watch_comments = %q", text)
	}
}

// Every tool a prompt names must exist: a plan that sends an agent to a missing tool is worse than none.
func TestPromptsNameRealTools(t *testing.T) {
	cs := agentClient(t)
	ctx := context.Background()
	tools, err := cs.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	have := map[string]bool{}
	for _, tl := range tools.Tools {
		have[tl.Name] = true
	}
	prompts, _ := cs.ListPrompts(ctx, nil)
	for _, p := range prompts.Prompts {
		args := map[string]string{}
		for _, a := range p.Arguments {
			if a.Required {
				args[a.Name] = "x"
			}
		}
		r, err := cs.GetPrompt(ctx, &mcp.GetPromptParams{Name: p.Name, Arguments: args})
		if err != nil {
			t.Fatal(err)
		}
		text := r.Messages[0].Content.(*mcp.TextContent).Text
		for _, word := range strings.FieldsFunc(text, func(r rune) bool { return !(r == '_' || (r >= 'a' && r <= 'z')) }) {
			if strings.Contains(word, "_") && !have[word] && isToolLike(word) {
				t.Errorf("prompt %s names %q, which is not a registered tool", p.Name, word)
			}
		}
	}
}

// isToolLike filters snake_case words that are prose or arguments, not tool names.
func isToolLike(w string) bool {
	switch w {
	case "brand_color", "auto_resolve", "get_started", "fix_comments", "watch_comments", "mobile_screen", "design_system", "landing_page", "prototype_flow":
		return false
	}
	return true
}

func TestConsistencyAndTokenUsageTools(t *testing.T) {
	cs := agentClient(t)
	frame := nodeID(t, call(t, cs, "create_node", map[string]any{"type": "frame", "width": 300, "height": 200}))
	for i := 0; i < 2; i++ {
		nodeID(t, call(t, cs, "create_node", map[string]any{"type": "text", "parentId": frame, "text": "Body", "fontSize": 16, "width": 100, "height": 20}))
	}
	nodeID(t, call(t, cs, "create_node", map[string]any{"type": "text", "parentId": frame, "text": "Body", "fontSize": 15, "width": 100, "height": 20}))

	res := call(t, cs, "review_consistency", nil)
	if res.IsError {
		t.Fatal(errText(res))
	}
	b, _ := json.Marshal(res.StructuredContent)
	if !strings.Contains(string(b), `"near-size"`) {
		t.Errorf("the 15px text should be one step from 16: %s", b)
	}

	res = call(t, cs, "token_usage", nil)
	if res.IsError {
		t.Fatal(errText(res))
	}
	b, _ = json.Marshal(res.StructuredContent)
	for _, key := range []string{`"variables"`, `"unused"`, `"candidates"`} {
		if !strings.Contains(string(b), key) {
			t.Errorf("token_usage has no %s: %s", key, b)
		}
	}
}
