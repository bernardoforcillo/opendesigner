package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// THE AGENT SURFACE: what a model needs to design without knowing the shape of the 180-odd specific tools --
// one generic way to create a node and read one back, the document and its comments as MCP resources, and
// step-by-step prompts that name the exact tools to use. It follows FigCraft's MCP server (docs/mcp.md there),
// whose agents work the same way: a few general tools, resources to read, prompts to start from.

// ---------------------------------------------------------------------------
// create_node, get_node
// ---------------------------------------------------------------------------

type CreateAnyNodeInput struct {
	Type         string          `json:"type" jsonschema:"rectangle | ellipse | frame | text"`
	ParentId     string          `json:"parentId,omitempty" jsonschema:"parent node or page id; defaults to the first page"`
	X            float64         `json:"x,omitempty"`
	Y            float64         `json:"y,omitempty"`
	Width        float64         `json:"width,omitempty"`
	Height       float64         `json:"height,omitempty"`
	Name         string          `json:"name,omitempty"`
	Text         string          `json:"text,omitempty" jsonschema:"the content of a text node"`
	FontSize     *float64        `json:"fontSize,omitempty" jsonschema:"font size of a text node; defaults to 16"`
	ClipsContent bool            `json:"clipsContent,omitempty" jsonschema:"a frame: clip the children to its box"`
	AutoLayout   *AutoLayoutSpec `json:"autoLayout,omitempty" jsonschema:"a frame: lay the children out in a row or column"`
}

// CreateAnyNode creates a rectangle, an ellipse, a frame or a text through the one tool, so an agent can build a
// screen without learning four. Everything else about the node is set afterwards with set_properties.
func (s *Session) CreateAnyNode(ctx context.Context, in CreateAnyNodeInput) (CreateNodeOutput, error) {
	switch strings.ToLower(strings.TrimSpace(in.Type)) {
	case "rectangle", "rect":
		return s.CreateRectangle(ctx, CreateShapeInput{ParentId: in.ParentId, X: in.X, Y: in.Y, Width: in.Width, Height: in.Height, Name: in.Name})
	case "ellipse", "oval", "circle":
		return s.CreateEllipse(ctx, CreateShapeInput{ParentId: in.ParentId, X: in.X, Y: in.Y, Width: in.Width, Height: in.Height, Name: in.Name})
	case "frame":
		return s.CreateFrame(ctx, CreateFrameInput{ParentId: in.ParentId, X: in.X, Y: in.Y, Width: in.Width, Height: in.Height, Name: in.Name, ClipsContent: in.ClipsContent, AutoLayout: in.AutoLayout})
	case "text":
		if in.Text == "" {
			return CreateNodeOutput{}, errors.New("create_node: a text node needs `text`")
		}
		return s.CreateText(ctx, CreateTextInput{ParentId: in.ParentId, X: in.X, Y: in.Y, Width: in.Width, Height: in.Height, Name: in.Name, Content: in.Text, FontSize: in.FontSize})
	default:
		return CreateNodeOutput{}, fmt.Errorf("create_node: unknown type %q (rectangle, ellipse, frame or text)", in.Type)
	}
}

type GetNodeInput struct {
	Id string `json:"id" jsonschema:"the node id"`
}

// GetNode returns one node as it is now.
func (s *Session) GetNode(_ context.Context, in GetNodeInput) (NodeView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n, ok := s.doc.GetNodes()[in.Id]
	if !ok {
		return NodeView{}, fmt.Errorf("get_node: no node %q", in.Id)
	}
	return toNodeView(n), nil
}

// ---------------------------------------------------------------------------
// resources
// ---------------------------------------------------------------------------

const (
	uriDocument = "opendesigner://document"
	uriComments = "opendesigner://comments"
	uriNodeTmpl = "opendesigner://node/{id}"
)

func jsonResource(uri string, v any) (*mcp.ReadResourceResult, error) {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return nil, err
	}
	return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: uri, MIMEType: "application/json", Text: string(b)}}}, nil
}

// registerAgentResources lets a client READ the document instead of calling a tool for it: the whole document,
// every open comment thread, and one node (a template, `opendesigner://node/<id>`).
func registerAgentResources(srv *mcp.Server, s *Session) {
	srv.AddResource(&mcp.Resource{URI: uriDocument, Name: "document", MIMEType: "application/json",
		Description: "The open document: pages, components, styles and every node (the same as get_document)."},
		func(ctx context.Context, _ *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
			doc, err := s.GetDocument(ctx, struct{}{})
			if err != nil {
				return nil, err
			}
			return jsonResource(uriDocument, doc)
		})
	srv.AddResource(&mcp.Resource{URI: uriComments, Name: "comments", MIMEType: "application/json",
		Description: "Every open comment thread on every page."},
		func(ctx context.Context, _ *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
			out, err := s.ListComments(ctx, ListCommentsInput{})
			if err != nil {
				return nil, err
			}
			return jsonResource(uriComments, out)
		})
	srv.AddResourceTemplate(&mcp.ResourceTemplate{URITemplate: uriNodeTmpl, Name: "node", MIMEType: "application/json",
		Description: "One node, by id."},
		func(ctx context.Context, req *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
			uri := req.Params.URI
			id := strings.TrimPrefix(uri, "opendesigner://node/")
			n, err := s.GetNode(ctx, GetNodeInput{Id: id})
			if err != nil {
				return nil, mcp.ResourceNotFoundError(uri)
			}
			return jsonResource(uri, n)
		})
}

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

type promptDef struct {
	name, desc string
	args       []*mcp.PromptArgument
	// build returns the plan for the arguments the client gave (defaults already applied by arg()).
	build func(arg func(name, def string) string) string
}

func promptArg(name, desc string, required bool) *mcp.PromptArgument {
	return &mcp.PromptArgument{Name: name, Description: desc, Required: required}
}

var agentPrompts = []promptDef{
	{
		name: "mobile_screen", desc: "Design one phone screen: a frame with auto layout, a header, content and a primary action.",
		args: []*mcp.PromptArgument{promptArg("screen", "what the screen is, e.g. \"Sign in\"", true), promptArg("device", "the device frame size (default iPhone 16: 393 x 852)", false), promptArg("brand_color", "the accent colour as hex (default #2563EB)", false)},
		build: func(a func(string, string) string) string {
			return fmt.Sprintf(`Design the "%s" screen for %s with accent %s.

1. get_document, to see the pages and what already exists. Reuse a page; create_page only if there is none.
2. create_frame with width and height of the device, clipsContent true and autoLayout {direction: column} so the children are arranged for you. Name it "%s".
3. Inside it, create_frame for the header, the content and the action area (autoLayout again), then create_text and create_rectangle for what they hold. Prefer editing the layout over the children's x/y, which auto layout overrides.
4. set_properties for fills (accent %s for the primary action), corner radius and text style. Do not leave a node at the default gray.
5. Verify: list_nodes with the page id, check nothing is clipped or overlapping, then export_image of the frame and look at it.`, a("screen", "Home"), a("device", "iPhone 16"), a("brand_color", "#2563EB"), a("screen", "Home"), a("brand_color", "#2563EB"))
		},
	},
	{
		name: "design_system", desc: "Set up a small design system: colour and type variables, shared styles, and a button component.",
		args: []*mcp.PromptArgument{promptArg("name", "the system's name (default Core)", false), promptArg("primary", "the primary colour as hex (default #2563EB)", false)},
		build: func(a func(string, string) string) string {
			return fmt.Sprintf(`Build the "%s" design system with primary colour %s.

1. create_collection "%s" and set_variable for colours (primary, surface, text, border) and numbers (spacing steps, radius).
2. set_paint_style for the colours and set_text_style for Heading, Body and Caption, so shapes and text can share them.
3. Draw a Button with create_frame (autoLayout row, padding, radius) holding create_text, then create_component from it, and create_instance for a primary and a secondary use. Override the label with set_instance_override.
4. bind_variable to tie the button's fill to the primary variable, so changing the variable changes every instance.
5. Verify: list_components, list_variables and list_paint_styles, then export_image of a page that shows every piece.`, a("name", "Core"), a("primary", "#2563EB"), a("name", "Core"))
		},
	},
	{
		name: "landing_page", desc: "Lay out a landing page: hero, features, call to action and footer, in auto layout.",
		args: []*mcp.PromptArgument{promptArg("product", "what is being sold", true), promptArg("width", "page width in px (default 1440)", false), promptArg("accent", "the accent colour as hex (default #2563EB)", false)},
		build: func(a func(string, string) string) string {
			return fmt.Sprintf(`Lay out a landing page for %s, %s px wide, accent %s.

1. create_frame "Landing" of that width with autoLayout {direction: column}; every section below is a frame inside it.
2. Hero: a headline (create_text, large and bold), one line of support copy, a primary button (frame + text) and an image placeholder (create_rectangle).
3. Features: a row of three cards, each a frame with an icon placeholder, a title and two lines of text.
4. Call to action and footer: one more frame each, with the accent as the section background for the call to action.
5. set_properties for fills, text sizes and spacing; keep the type scale to three sizes.
6. Verify: export_image of the whole frame, then preflight and review_design, and fix what they report.`, a("product", "the product"), a("width", "1440"), a("accent", "#2563EB"))
		},
	},
	{
		name: "prototype_flow", desc: "Connect existing screens into a flow with transitions, then check the flow.",
		args: []*mcp.PromptArgument{promptArg("screens", "the screens' names, comma separated, in order", true), promptArg("transition", "the transition between them (default slide)", false)},
		build: func(a func(string, string) string) string {
			return fmt.Sprintf(`Connect these screens into a flow: %s, with %s transitions.

1. list_nodes and find the frame of each screen by name; if one is missing, say so instead of inventing it.
2. create_flow with the first screen as startId.
3. For each button or link that should move on, set_transition from that node to the next screen.
4. analyze_flows: fix dead ends, orphan screens and unreachable screens it reports.
5. Verify with get_flow, and describe the path from the start screen to the last one.`, a("screens", "Home, Detail, Checkout"), a("transition", "slide"))
		},
	},
	{
		name: "fix_comments", desc: "Work through the open comments: make the change each asks for, then reply and resolve.",
		args: []*mcp.PromptArgument{promptArg("page", "the page to look at (default all)", false), promptArg("auto_resolve", "resolve a thread once it is addressed: yes or no (default yes)", false), promptArg("author", "the name to reply as (default AI)", false)},
		build: func(a func(string, string) string) string {
			resolve := "Then resolve_comment it."
			if strings.EqualFold(a("auto_resolve", "yes"), "no") {
				resolve = "Leave it open for its author to resolve."
			}
			return fmt.Sprintf(`Work through the open comments on %s, replying as %s.

1. list_comments for the open threads; read each one with the node it is pinned to (get_node).
2. For each: decide what change it asks for, make it with set_properties, set_text or the matching tool, and check the result.
3. add_comment as a reply on that thread saying what you changed and why. If the request is unclear or outside the design, ask instead of guessing. %s
4. At the end list what you changed and what you left open.`, a("page", "all pages"), a("author", "AI"), resolve)
		},
	},
	{
		name: "watch_comments", desc: "Keep watching for new comments and handle each as it arrives.",
		args: []*mcp.PromptArgument{promptArg("minutes", "how long to keep watching (default 5)", false)},
		build: func(a func(string, string) string) string {
			n, _ := strconv.Atoi(a("minutes", "5"))
			if n <= 0 {
				n = 5
			}
			return fmt.Sprintf(`Watch the document for new comments for %d minutes.

1. list_comments now, to know what is already there; handle none of those unless asked.
2. Then, every 20 seconds or so, list_comments again and look for threads that were not there before.
3. For each new thread follow the fix_comments plan: make the change, reply with add_comment, resolve_comment when it is done.
4. Stop after %d minutes and summarise what arrived and what you did.`, n, n)
		},
	},
}

// registerAgentPrompts installs the starting points: each returns a plan that names the exact tools to use and
// how to verify the result.
func registerAgentPrompts(srv *mcp.Server) {
	for _, p := range agentPrompts {
		p := p
		srv.AddPrompt(&mcp.Prompt{Name: p.name, Description: p.desc, Arguments: p.args},
			func(_ context.Context, req *mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
				given := map[string]string{}
				if req.Params != nil {
					given = req.Params.Arguments
				}
				for _, a := range p.args {
					if a.Required && strings.TrimSpace(given[a.Name]) == "" {
						return nil, fmt.Errorf("prompt %s: %q is required", p.name, a.Name)
					}
				}
				arg := func(name, def string) string {
					if v := strings.TrimSpace(given[name]); v != "" {
						return v
					}
					return def
				}
				return &mcp.GetPromptResult{
					Description: p.desc,
					Messages:    []*mcp.PromptMessage{{Role: "user", Content: &mcp.TextContent{Text: p.build(arg)}}},
				}, nil
			})
	}
}

// RegisterAgentSurface installs the generic tools, the resources and the prompts next to the specific tools.
func RegisterAgentSurface(srv *mcp.Server, s *Session) {
	addTool(srv, "create_node", "Create a node of any basic type -- rectangle, ellipse, frame or text -- in one call. Frames take clipsContent and autoLayout; a text node needs `text`. Returns the new node id; set the rest (fills, strokes, radius, effects) with set_properties.", s.CreateAnyNode)
	addTool(srv, "get_node", "One node as it is now: geometry, fills, strokes, text, parent and order.", s.GetNode)
	addTool(srv, "inspect_document", "The whole document: pages, components, styles and every node (the same as get_document).", s.GetDocument)
	registerAgentResources(srv, s)
	registerAgentPrompts(srv)
}
