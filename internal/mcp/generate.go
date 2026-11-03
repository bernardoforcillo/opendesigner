package mcp

import (
	"context"
	"fmt"
	"sort"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/protobuf/proto"
)

// GENERATE A SCREEN FROM THE DOCUMENT'S OWN KIT. The server has no model: the agent reads a description (or looks at a
// screenshot), reads the kit with get_design_kit, and sends one flat spec to generate_screen. The tool builds the
// frame from existing parts only -- components for what they cover, color variables for every color, text styles for
// every text -- and refuses a name the document does not have (listing the ones it has) BEFORE it creates anything,
// so a screen never half-appears with invented values. Docs: docs/generate.md.

type DesignKitComponent struct {
	Id         string                `json:"id"`
	Name       string                `json:"name"`
	Width      float64               `json:"width"`
	Height     float64               `json:"height"`
	SetId      string                `json:"setId,omitempty"`
	Variant    map[string]string     `json:"variant,omitempty"`
	Properties []ComponentPropertyIO `json:"properties,omitempty"`
}

type DesignKitVariable struct {
	Id   string `json:"id"`
	Name string `json:"name"`
	// Color is the value in the collection's default mode, "#rrggbb" ("" when it cannot be resolved).
	Color string `json:"color,omitempty"`
}

type DesignKitTextStyle struct {
	Id         string  `json:"id"`
	Name       string  `json:"name"`
	FontSize   float64 `json:"fontSize"`
	FontWeight string  `json:"fontWeight,omitempty"`
}

type DesignKitOutput struct {
	Components     []DesignKitComponent `json:"components"`
	ColorVariables []DesignKitVariable  `json:"colorVariables"`
	TextStyles     []DesignKitTextStyle `json:"textStyles"`
}

func hexOf(c *opendesignerv1.Color) string {
	b := func(v float32) int {
		x := int(v*255 + 0.5)
		if x < 0 {
			x = 0
		}
		if x > 255 {
			x = 255
		}
		return x
	}
	return fmt.Sprintf("#%02x%02x%02x", b(c.GetR()), b(c.GetG()), b(c.GetB()))
}

func designKit(doc *opendesignerv1.Document) DesignKitOutput {
	out := DesignKitOutput{Components: []DesignKitComponent{}, ColorVariables: []DesignKitVariable{}, TextStyles: []DesignKitTextStyle{}}
	for id, c := range doc.GetComponents() {
		k := DesignKitComponent{Id: id, Name: c.GetName(), SetId: c.GetSetId(), Variant: c.GetVariant(), Properties: propertyViews(c)}
		if root := doc.GetNodes()[c.GetRootNodeId()]; root != nil {
			k.Width, k.Height = root.GetWidth(), root.GetHeight()
		}
		out.Components = append(out.Components, k)
	}
	sort.Slice(out.Components, func(i, j int) bool {
		return out.Components[i].Name+out.Components[i].Id < out.Components[j].Name+out.Components[j].Id
	})
	for id, v := range doc.GetVariables() {
		if v.GetType() != opendesignerv1.VariableType_VARIABLE_TYPE_COLOR {
			continue
		}
		kv := DesignKitVariable{Id: id, Name: v.GetName()}
		if val := core.VariableValueIn(doc, v, ""); val != nil && val.GetColor() != nil {
			kv.Color = hexOf(val.GetColor())
		}
		out.ColorVariables = append(out.ColorVariables, kv)
	}
	sort.Slice(out.ColorVariables, func(i, j int) bool {
		return out.ColorVariables[i].Name+out.ColorVariables[i].Id < out.ColorVariables[j].Name+out.ColorVariables[j].Id
	})
	for id, d := range doc.GetTextStyles() {
		out.TextStyles = append(out.TextStyles, DesignKitTextStyle{Id: id, Name: d.GetName(), FontSize: d.GetStyle().GetFontSize(), FontWeight: d.GetStyle().GetFontWeight()})
	}
	sort.Slice(out.TextStyles, func(i, j int) bool {
		return out.TextStyles[i].Name+out.TextStyles[i].Id < out.TextStyles[j].Name+out.TextStyles[j].Id
	})
	return out
}

// GetDesignKit lists what generate_screen may use.
func (s *Session) GetDesignKit(_ context.Context, _ struct{}) (DesignKitOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return designKit(s.doc), nil
}

// GenNode is one part of the screen. The list is FLAT (a node names its parent by ref) so the tool's schema is not
// recursive; a parent must come before its children.
type GenNode struct {
	Ref        string            `json:"ref,omitempty" jsonschema:"a name other nodes use as their parent; unique in the list"`
	Parent     string            `json:"parent,omitempty" jsonschema:"ref of an EARLIER frame node; empty = directly in the screen"`
	Kind       string            `json:"kind" jsonschema:"frame | text | rectangle | instance"`
	Name       string            `json:"name,omitempty"`
	X          float64           `json:"x,omitempty" jsonschema:"inside a parent without auto layout"`
	Y          float64           `json:"y,omitempty"`
	Width      float64           `json:"width,omitempty" jsonschema:"frame, rectangle, text; an instance has its component's size. Default: the parent's inner width"`
	Height     float64           `json:"height,omitempty"`
	AutoLayout *AutoLayoutSpec   `json:"autoLayout,omitempty" jsonschema:"frame: lay its children out; with no height the frame hugs its content"`
	Fill       string            `json:"fill,omitempty" jsonschema:"frame, rectangle: a COLOR VARIABLE of the document, by name or id (get_design_kit). Never a literal color"`
	Content    string            `json:"content,omitempty" jsonschema:"text: the words"`
	TextStyle  string            `json:"textStyle,omitempty" jsonschema:"text: a text style of the document, by name or id; empty = the default 16px"`
	Color      string            `json:"color,omitempty" jsonschema:"text: a COLOR VARIABLE, by name or id"`
	Component  string            `json:"component,omitempty" jsonschema:"instance: a component of the document, by name or id"`
	Variant    map[string]string `json:"variant,omitempty" jsonschema:"instance: axis -> option"`
	Properties map[string]string `json:"properties,omitempty" jsonschema:"instance: property name -> value (e.g. the label)"`
}

type GenerateScreenInput struct {
	Name       string          `json:"name" jsonschema:"the screen's name"`
	Width      float64         `json:"width" jsonschema:"e.g. 393 for a phone"`
	Height     float64         `json:"height,omitempty" jsonschema:"omit with autoLayout to hug the content"`
	ParentId   string          `json:"parentId,omitempty" jsonschema:"page or frame to put the screen in; defaults to the first page"`
	X          float64         `json:"x,omitempty"`
	Y          float64         `json:"y,omitempty"`
	AutoLayout *AutoLayoutSpec `json:"autoLayout,omitempty" jsonschema:"the screen's own layout (usually vertical)"`
	Fill       string          `json:"fill,omitempty" jsonschema:"background: a COLOR VARIABLE by name or id"`
	Nodes      []GenNode       `json:"nodes" jsonschema:"the parts, parents before children"`
}

type GenerateScreenOutput struct {
	ScreenId string            `json:"screenId"`
	Refs     map[string]string `json:"refs" jsonschema:"ref -> node id of every node that had a ref"`
	Created  int               `json:"created" jsonschema:"nodes created, the screen included"`
	Seq      uint64            `json:"seq"`
}

const maxGenNodes = 500

func lookupName[T any](m map[string]T, ref string, name func(T) string) (string, bool) {
	if _, ok := m[ref]; ok {
		return ref, true
	}
	var hits []string
	for id, v := range m {
		if name(v) == ref {
			hits = append(hits, id)
		}
	}
	sort.Strings(hits)
	if len(hits) == 0 {
		return "", false
	}
	return hits[0], true
}

func names[T any](m map[string]T, name func(T) string) string {
	var out []string
	for _, v := range m {
		out = append(out, fmt.Sprintf("%q", name(v)))
	}
	sort.Strings(out)
	if len(out) == 0 {
		return "none defined"
	}
	return strings.Join(out, ", ")
}

type genFrame struct {
	w, h   float64
	inner  float64 // width available to a child
	hasLay bool
}

// plan is one validated node, ready to be created.
type genPlan struct {
	spec   GenNode
	node   *opendesignerv1.Node
	parent string // ref, "" = the screen
}

// GenerateScreen validates the whole spec against the document, then builds the screen.
func (s *Session) GenerateScreen(ctx context.Context, in GenerateScreenInput) (GenerateScreenOutput, error) {
	parent := s.resolveParent(in.ParentId) // takes the lock itself
	s.mu.Lock()
	plans, root, err := s.planScreen(in, parent)
	s.mu.Unlock()
	if err != nil {
		return GenerateScreenOutput{}, err
	}
	out := GenerateScreenOutput{Refs: map[string]string{}}
	res, err := s.createNode(ctx, root)
	if err != nil {
		return out, err
	}
	out.ScreenId, out.Seq, out.Created = root.GetId(), res.Seq, 1
	ids := map[string]string{"": root.GetId()}
	for _, p := range plans {
		p.node.ParentId = ids[p.parent]
		res, err := s.createNode(ctx, p.node)
		if err != nil {
			return out, fmt.Errorf("generate_screen: created %d of %d nodes, then: %w (the screen %s holds what was made)", out.Created, len(plans)+1, err, out.ScreenId)
		}
		out.Seq = res.Seq
		out.Created++
		if p.spec.Ref != "" {
			ids[p.spec.Ref] = p.node.GetId()
			out.Refs[p.spec.Ref] = p.node.GetId()
		}
	}
	return out, nil
}

// planScreen resolves every name and builds every node without touching the document. The lock is held.
func (s *Session) planScreen(in GenerateScreenInput, parent string) ([]genPlan, *opendesignerv1.Node, error) {
	doc := s.doc
	var problems []string
	bad := func(format string, a ...any) { problems = append(problems, fmt.Sprintf(format, a...)) }

	if in.Width <= 0 {
		bad("width must be > 0")
	}
	if len(in.Nodes) == 0 {
		bad("nodes is empty: a screen needs at least one part")
	}
	if len(in.Nodes) > maxGenNodes {
		bad("at most %d nodes, got %d", maxGenNodes, len(in.Nodes))
	}
	if parent == "" {
		return nil, nil, errNoParent
	}
	isPage := false
	for _, p := range doc.GetPages() {
		isPage = isPage || p.GetId() == parent
	}
	if in.ParentId != "" && doc.GetNodes()[parent] == nil && !isPage {
		bad("parentId %q is not a page or a node (list_nodes)", in.ParentId)
	}

	colorVar := func(where, ref string) string {
		if ref == "" {
			return ""
		}
		id, ok := lookupName(doc.GetVariables(), ref, (*opendesignerv1.Variable).GetName)
		if ok && doc.GetVariables()[id].GetType() != opendesignerv1.VariableType_VARIABLE_TYPE_COLOR {
			ok = false
		}
		if !ok {
			var colors = map[string]*opendesignerv1.Variable{}
			for k, v := range doc.GetVariables() {
				if v.GetType() == opendesignerv1.VariableType_VARIABLE_TYPE_COLOR {
					colors[k] = v
				}
			}
			bad("%s: no color variable %q (have: %s)", where, ref, names(colors, (*opendesignerv1.Variable).GetName))
			return ""
		}
		return id
	}
	paint := func(varID string) ([]*opendesignerv1.Paint, map[string]string) {
		if varID == "" {
			return nil, nil
		}
		c := &opendesignerv1.Color{A: 1}
		if val := core.VariableValueIn(doc, doc.GetVariables()[varID], ""); val != nil && val.GetColor() != nil {
			c = val.GetColor()
		}
		return []*opendesignerv1.Paint{{Kind: &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{Color: proto.Clone(c).(*opendesignerv1.Color)}}}}, map[string]string{"fills.0": varID}
	}
	layoutOf := func(where string, a *AutoLayoutSpec, hasW, hasH bool) *opendesignerv1.AutoLayout {
		if a == nil {
			return nil
		}
		c := *a
		if !hasW {
			c.HugWidth = true
		}
		if !hasH {
			c.HugHeight = true
		}
		if err := c.validate(); err != nil {
			bad("%s: %v", where, err)
			return nil
		}
		return c.toProto()
	}

	root := s.newBaseNode(parent, in.Name, in.X, in.Y, in.Width, in.Height)
	rootLayout := layoutOf("screen", in.AutoLayout, true, in.Height > 0)
	root.Shape = &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{ClipsContent: true, AutoLayout: rootLayout}}
	root.Fills, root.Bindings = paint(colorVar("screen.fill", in.Fill))
	frames := map[string]genFrame{"": {w: in.Width, h: in.Height, inner: in.Width - padSum(rootLayout), hasLay: rootLayout != nil}}

	var plans []genPlan
	seen := map[string]bool{}
	for i, g := range in.Nodes {
		where := fmt.Sprintf("nodes[%d]", i)
		if g.Ref != "" {
			where += " (" + g.Ref + ")"
			if seen[g.Ref] {
				bad("%s: ref %q is used twice", where, g.Ref)
			}
		}
		pf, ok := frames[g.Parent]
		if !ok {
			bad("%s: parent %q is not the ref of an earlier frame", where, g.Parent)
			continue
		}
		if g.Ref != "" {
			seen[g.Ref] = true
		}
		w := g.Width
		if w <= 0 {
			w = pf.inner
		}
		if w <= 0 {
			w = 100
		}
		n := s.newBaseNode("", g.Name, g.X, g.Y, w, g.Height)
		switch strings.ToLower(g.Kind) {
		case "frame":
			lay := layoutOf(where, g.AutoLayout, true, g.Height > 0)
			if g.Height <= 0 && lay == nil {
				n.Height = 100
			}
			n.Shape = &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{AutoLayout: lay}}
			n.Fills, n.Bindings = paint(colorVar(where+".fill", g.Fill))
			if g.Ref != "" {
				frames[g.Ref] = genFrame{w: w, h: n.Height, inner: w - padSum(lay), hasLay: lay != nil}
			}
		case "rectangle", "rect":
			if g.Height <= 0 {
				n.Height = 100
			}
			n.Shape = &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}}
			n.Fills, n.Bindings = paint(colorVar(where+".fill", g.Fill))
		case "text":
			if g.Content == "" {
				bad("%s: a text needs content", where)
			}
			style := &opendesignerv1.TextStyle{FontSize: 16}
			if g.TextStyle != "" {
				if id, ok := lookupName(doc.GetTextStyles(), g.TextStyle, (*opendesignerv1.TextStyleDef).GetName); ok {
					n.TextStyleId = id
					style = proto.Clone(doc.GetTextStyles()[id].GetStyle()).(*opendesignerv1.TextStyle)
				} else {
					bad("%s: no text style %q (have: %s)", where, g.TextStyle, names(doc.GetTextStyles(), (*opendesignerv1.TextStyleDef).GetName))
				}
			}
			lh := style.GetLineHeight()
			if lh <= 0 {
				lh = 1.2
			}
			if g.Height <= 0 {
				n.Height = float64(int(style.GetFontSize()*lh) + 1)
			}
			n.Shape = &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{Content: g.Content, Style: style}}
			cf, cb := paint(colorVar(where+".color", g.Color))
			n.Fills, n.Bindings = cf, cb
		case "instance":
			id, ok := lookupName(doc.GetComponents(), g.Component, (*opendesignerv1.Component).GetName)
			if !ok {
				bad("%s: no component %q (have: %s)", where, g.Component, names(doc.GetComponents(), (*opendesignerv1.Component).GetName))
				break
			}
			inst := &opendesignerv1.InstanceNode{ComponentId: id, PropertyValues: g.Properties, VariantProps: g.Variant}
			if err := core.ValidateInstanceProps(doc, inst, g.Properties, g.Variant); err != nil {
				bad("%s: %v (properties %v, variant %v; get_design_kit lists the component's own)", where, err, g.Properties, g.Variant)
			}
			if root := doc.GetNodes()[doc.GetComponents()[id].GetRootNodeId()]; root != nil {
				n.Width, n.Height = root.GetWidth(), root.GetHeight()
				if g.Width > 0 {
					n.Width = g.Width
				}
				if g.Height > 0 {
					n.Height = g.Height
				}
			}
			n.Shape = &opendesignerv1.Node_Instance{Instance: inst}
		default:
			bad("%s: kind must be frame, text, rectangle or instance, got %q", where, g.Kind)
		}
		plans = append(plans, genPlan{spec: g, node: n, parent: g.Parent})
	}
	if len(problems) > 0 {
		return nil, nil, fmt.Errorf("generate_screen: nothing was created. %s", strings.Join(problems, "; "))
	}
	return plans, root, nil
}

func padSum(a *opendesignerv1.AutoLayout) float64 {
	if a == nil {
		return 0
	}
	return a.GetPaddingLeft() + a.GetPaddingRight()
}

const generateConventions = " Build a screen ONLY from the document's kit: get_design_kit lists its components, color variables and text styles. " +
	"Every color is a color variable (fill, color) and every text takes a text style; a component is placed as an instance, with its variant and property values. A name the document does not have is refused with the names it has, and nothing is created."

func registerGenerateTools(srv *mcp.Server, s *Session) {
	addTool(srv, "get_design_kit", "List what a generated screen may use: the document's components (with size, variants and properties), color variables (with their default-mode color) and text styles."+generateConventions, s.GetDesignKit)
	addTool(srv, "generate_screen", "Create a screen (a frame) from a flat list of parts: frames with auto layout, texts, rectangles and component instances, parents before children."+generateConventions+" The screen is built top-down in one go; check it afterwards with review_design.", s.GenerateScreen)
}
