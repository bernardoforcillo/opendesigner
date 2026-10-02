package mcp

import (
	"context"
	"errors"
	"fmt"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

// RGBA is a solid colour in 0..1 channels, the JSON shape a tool exchanges for a
// SolidPaint fill. Alpha defaults to 0 (fully transparent) when omitted, so a
// caller that wants an opaque fill must pass a: 1.
type RGBA struct {
	R float64 `json:"r" jsonschema:"red channel, 0..1"`
	G float64 `json:"g" jsonschema:"green channel, 0..1"`
	B float64 `json:"b" jsonschema:"blue channel, 0..1"`
	A float64 `json:"a" jsonschema:"alpha channel, 0..1"`
	// Gradient, when set, turns this entry into a gradient fill and r/g/b/a are
	// ignored. A separate stop type keeps the JSON schema non-recursive.
	Gradient *GradientSpec `json:"gradient,omitempty" jsonschema:"makes this fill a linear or radial gradient instead of a solid colour"`
}

// StopColor is a gradient stop's colour; same channels as RGBA, without the
// gradient field.
type StopColor struct {
	R float64 `json:"r" jsonschema:"red channel, 0..1"`
	G float64 `json:"g" jsonschema:"green channel, 0..1"`
	B float64 `json:"b" jsonschema:"blue channel, 0..1"`
	A float64 `json:"a" jsonschema:"alpha channel, 0..1"`
}

// GradientStopSpec is one colour stop of a gradient.
type GradientStopSpec struct {
	Color    StopColor `json:"color"`
	Position float64   `json:"position" jsonschema:"0..1 along the gradient axis"`
}

// GradientSpec is a gradient in coordinates NORMALISED to the node's box: (0,0)
// is its top-left corner and (1,1) its bottom-right.
type GradientSpec struct {
	Kind  string             `json:"kind" jsonschema:"linear or radial"`
	Stops []GradientStopSpec `json:"stops" jsonschema:"at least two stops, ordered by position"`
	X1    float64            `json:"x1" jsonschema:"linear: axis start x; radial: centre x"`
	Y1    float64            `json:"y1" jsonschema:"linear: axis start y; radial: centre y"`
	X2    float64            `json:"x2" jsonschema:"linear: axis end x; radial: a point on the edge (radius = distance from x1,y1)"`
	Y2    float64            `json:"y2" jsonschema:"linear: axis end y; radial: a point on the edge"`
}

func toGradientPaint(g *GradientSpec) *opendesignerv1.Paint {
	stops := make([]*opendesignerv1.GradientStop, 0, len(g.Stops))
	for _, st := range g.Stops {
		stops = append(stops, &opendesignerv1.GradientStop{
			Color:    &opendesignerv1.Color{R: float32(st.Color.R), G: float32(st.Color.G), B: float32(st.Color.B), A: float32(st.Color.A)},
			Position: st.Position,
		})
	}
	gp := &opendesignerv1.GradientPaint{Stops: stops, X1: g.X1, Y1: g.Y1, X2: g.X2, Y2: g.Y2}
	if g.Kind == "radial" {
		return &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Radial{Radial: gp}}
	}
	return &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Linear{Linear: gp}}
}

// validateFills rejects a gradient the renderer could not draw, so the agent
// gets the reason as a tool error instead of a silently flat fill.
func validateFills(colors []RGBA) error {
	for i, c := range colors {
		g := c.Gradient
		if g == nil {
			continue
		}
		if g.Kind != "linear" && g.Kind != "radial" {
			return fmt.Errorf("fills[%d].gradient.kind must be \"linear\" or \"radial\", got %q", i, g.Kind)
		}
		if len(g.Stops) < 2 {
			return fmt.Errorf("fills[%d].gradient needs at least two stops", i)
		}
		if g.X1 == g.X2 && g.Y1 == g.Y2 {
			return fmt.Errorf("fills[%d].gradient start and end points must differ", i)
		}
	}
	return nil
}

// EffectSpec is one node effect. The canvas draws the FIRST dropShadow and the
// FIRST layerBlur of a node; extra ones are kept in the document but not drawn.
type EffectSpec struct {
	Kind    string    `json:"kind" jsonschema:"dropShadow or layerBlur"`
	Color   StopColor `json:"color,omitempty" jsonschema:"dropShadow only; alpha 0..1"`
	OffsetX float64   `json:"offsetX,omitempty" jsonschema:"dropShadow only, in world units"`
	OffsetY float64   `json:"offsetY,omitempty" jsonschema:"dropShadow only, in world units"`
	Blur    float64   `json:"blur,omitempty" jsonschema:"dropShadow only, >= 0, in world units"`
	Radius  float64   `json:"radius,omitempty" jsonschema:"layerBlur only, >= 0, in world units"`
}

func validateEffects(effects []EffectSpec) error {
	for i, e := range effects {
		switch e.Kind {
		case "dropShadow":
			if e.Blur < 0 {
				return fmt.Errorf("effects[%d].blur must be >= 0", i)
			}
		case "layerBlur":
			if e.Radius < 0 {
				return fmt.Errorf("effects[%d].radius must be >= 0", i)
			}
		default:
			return fmt.Errorf("effects[%d].kind must be \"dropShadow\" or \"layerBlur\", got %q", i, e.Kind)
		}
	}
	return nil
}

func toEffects(effects []EffectSpec) []*opendesignerv1.Effect {
	out := make([]*opendesignerv1.Effect, 0, len(effects))
	for _, e := range effects {
		if e.Kind == "layerBlur" {
			out = append(out, &opendesignerv1.Effect{Kind: &opendesignerv1.Effect_LayerBlur{LayerBlur: &opendesignerv1.LayerBlur{Radius: e.Radius}}})
			continue
		}
		out = append(out, &opendesignerv1.Effect{Kind: &opendesignerv1.Effect_DropShadow{DropShadow: &opendesignerv1.DropShadow{
			Color:   &opendesignerv1.Color{R: float32(e.Color.R), G: float32(e.Color.G), B: float32(e.Color.B), A: float32(e.Color.A)},
			OffsetX: e.OffsetX, OffsetY: e.OffsetY, Blur: e.Blur,
		}}})
	}
	return out
}

func toPaints(colors []RGBA) []*opendesignerv1.Paint {
	if colors == nil {
		return nil
	}
	out := make([]*opendesignerv1.Paint, 0, len(colors))
	for _, c := range colors {
		if c.Gradient != nil {
			out = append(out, toGradientPaint(c.Gradient))
			continue
		}
		out = append(out, &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{
			Color: &opendesignerv1.Color{R: float32(c.R), G: float32(c.G), B: float32(c.B), A: float32(c.A)},
		}}})
	}
	return out
}

// SeqOutput is the common write result: the op's assigned seq in the op-log.
type SeqOutput struct {
	Seq uint64 `json:"seq" jsonschema:"the op-log sequence number the op was assigned"`
}

// CreateNodeOutput is what the three create-shape tools return.
type CreateNodeOutput struct {
	NodeId string `json:"nodeId" jsonschema:"id of the created node"`
	Seq    uint64 `json:"seq"`
}

// ---------------------------------------------------------------------------
// Create shapes
// ---------------------------------------------------------------------------

// CreateShapeInput is shared by create_rectangle and create_ellipse.
type CreateShapeInput struct {
	ParentId string  `json:"parentId,omitempty" jsonschema:"parent node or page id; defaults to the first page"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	Width    float64 `json:"width"`
	Height   float64 `json:"height"`
	Name     string  `json:"name,omitempty"`
}

// CreateTextInput adds the text content and an optional style.
type CreateTextInput struct {
	ParentId   string   `json:"parentId,omitempty" jsonschema:"parent node or page id; defaults to the first page"`
	X          float64  `json:"x"`
	Y          float64  `json:"y"`
	Width      float64  `json:"width"`
	Height     float64  `json:"height"`
	Name       string   `json:"name,omitempty"`
	Content    string   `json:"content" jsonschema:"the text to display"`
	FontSize   *float64 `json:"fontSize,omitempty" jsonschema:"font size in world px; defaults to 16"`
	FontFamily *string  `json:"fontFamily,omitempty"`
	FontWeight *string  `json:"fontWeight,omitempty" jsonschema:"e.g. 400 or 700"`
}

// newBaseNode builds the common Node scaffold for a created shape.
func (s *Session) newBaseNode(parentID, name string, x, y, w, h float64) *opendesignerv1.Node {
	return &opendesignerv1.Node{
		Id:       uuid.NewString(),
		ParentId: parentID,
		OrderKey: s.nextOrderKey(),
		Name:     name,
		Visible:  true,
		Opacity:  1,
		X:        x, Y: y, Width: w, Height: h,
	}
}

func (s *Session) createNode(ctx context.Context, node *opendesignerv1.Node) (CreateNodeOutput, error) {
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: node}}})
	if err != nil {
		return CreateNodeOutput{}, err
	}
	return CreateNodeOutput{NodeId: node.GetId(), Seq: seq}, nil
}

// CreateRectangle creates a rectangle under parentId (or the first page).
func (s *Session) CreateRectangle(ctx context.Context, in CreateShapeInput) (CreateNodeOutput, error) {
	parent := s.resolveParent(in.ParentId)
	if parent == "" {
		return CreateNodeOutput{}, errNoParent
	}
	n := s.newBaseNode(parent, in.Name, in.X, in.Y, in.Width, in.Height)
	n.Shape = &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}}
	return s.createNode(ctx, n)
}

// CreateEllipse creates an ellipse under parentId (or the first page).
func (s *Session) CreateEllipse(ctx context.Context, in CreateShapeInput) (CreateNodeOutput, error) {
	parent := s.resolveParent(in.ParentId)
	if parent == "" {
		return CreateNodeOutput{}, errNoParent
	}
	n := s.newBaseNode(parent, in.Name, in.X, in.Y, in.Width, in.Height)
	n.Shape = &opendesignerv1.Node_Ellipse{Ellipse: &opendesignerv1.EllipseNode{}}
	return s.createNode(ctx, n)
}

// CreateText creates a text node under parentId (or the first page).
func (s *Session) CreateText(ctx context.Context, in CreateTextInput) (CreateNodeOutput, error) {
	parent := s.resolveParent(in.ParentId)
	if parent == "" {
		return CreateNodeOutput{}, errNoParent
	}
	n := s.newBaseNode(parent, in.Name, in.X, in.Y, in.Width, in.Height)
	// A created text node always carries a style so it renders; a zero font_size
	// would make it invisible (see core.applySetText's style_present rationale).
	style := &opendesignerv1.TextStyle{FontSize: 16}
	if in.FontSize != nil {
		style.FontSize = *in.FontSize
	}
	if in.FontFamily != nil {
		style.FontFamily = *in.FontFamily
	}
	if in.FontWeight != nil {
		style.FontWeight = *in.FontWeight
	}
	n.Shape = &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{Content: in.Content, Style: style}}
	return s.createNode(ctx, n)
}

var errNoParent = errors.New("no parent given and the document has no pages")

func (s *Session) resolveParent(parentID string) string {
	if parentID != "" {
		return parentID
	}
	return s.firstPageID()
}

// ---------------------------------------------------------------------------
// set_properties
// ---------------------------------------------------------------------------

// SetPropertiesInput carries only the fields to change; each provided one is
// added to the SetProperties FieldMask (absent fields are left untouched). fills
// is a whole-list replacement -- pass [] to clear, omit to keep.
type SetPropertiesInput struct {
	Id           string       `json:"id"`
	X            *float64     `json:"x,omitempty"`
	Y            *float64     `json:"y,omitempty"`
	Width        *float64     `json:"width,omitempty"`
	Height       *float64     `json:"height,omitempty"`
	Opacity      *float64     `json:"opacity,omitempty" jsonschema:"0..1"`
	Rotation     *float64     `json:"rotation,omitempty"`
	Name         *string      `json:"name,omitempty"`
	Visible      *bool        `json:"visible,omitempty"`
	CornerRadius *float64     `json:"cornerRadius,omitempty" jsonschema:"rectangles only"`
	Fills        []RGBA       `json:"fills,omitempty" jsonschema:"replaces the whole fill list; [] clears it"`
	Effects      []EffectSpec `json:"effects,omitempty" jsonschema:"replaces the whole effect list; [] clears it"`
}

// SetProperties applies an absolute field patch to a node via SetProperties.
func (s *Session) SetProperties(ctx context.Context, in SetPropertiesInput) (SeqOutput, error) {
	patch := &opendesignerv1.Node{}
	var paths []string
	if in.X != nil {
		patch.X = *in.X
		paths = append(paths, "x")
	}
	if in.Y != nil {
		patch.Y = *in.Y
		paths = append(paths, "y")
	}
	if in.Width != nil {
		patch.Width = *in.Width
		paths = append(paths, "width")
	}
	if in.Height != nil {
		patch.Height = *in.Height
		paths = append(paths, "height")
	}
	if in.Opacity != nil {
		patch.Opacity = *in.Opacity
		paths = append(paths, "opacity")
	}
	if in.Rotation != nil {
		patch.Rotation = *in.Rotation
		paths = append(paths, "rotation")
	}
	if in.Name != nil {
		patch.Name = *in.Name
		paths = append(paths, "name")
	}
	if in.Visible != nil {
		patch.Visible = *in.Visible
		paths = append(paths, "visible")
	}
	if in.Effects != nil {
		if err := validateEffects(in.Effects); err != nil {
			return SeqOutput{}, err
		}
		patch.Effects = toEffects(in.Effects)
		paths = append(paths, "effects")
	}
	if in.Fills != nil {
		if err := validateFills(in.Fills); err != nil {
			return SeqOutput{}, err
		}
		patch.Fills = toPaints(in.Fills)
		paths = append(paths, "fills")
	}
	if in.CornerRadius != nil {
		patch.Shape = &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{CornerRadius: *in.CornerRadius}}
		paths = append(paths, "corner_radius")
	}
	if len(paths) == 0 {
		return SeqOutput{}, errors.New("set_properties: no properties given")
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: in.Id, Patch: patch, Mask: &fieldmaskpb.FieldMask{Paths: paths},
	}}})
	if err != nil {
		return SeqOutput{}, err
	}
	return SeqOutput{Seq: seq}, nil
}

// ---------------------------------------------------------------------------
// set_text
// ---------------------------------------------------------------------------

// SetTextInput sets a text node's content and, if any style field is given,
// REPLACES its whole style (style_present). Omit all style fields to keep the
// node's existing style intact.
type SetTextInput struct {
	Id         string   `json:"id"`
	Content    string   `json:"content"`
	FontSize   *float64 `json:"fontSize,omitempty"`
	FontFamily *string  `json:"fontFamily,omitempty"`
	FontWeight *string  `json:"fontWeight,omitempty"`
}

// SetText rewrites a text node's content (and optionally its style).
func (s *Session) SetText(ctx context.Context, in SetTextInput) (SeqOutput, error) {
	st := &opendesignerv1.SetText{Id: in.Id, Content: in.Content}
	if in.FontSize != nil || in.FontFamily != nil || in.FontWeight != nil {
		st.StylePresent = true
		style := &opendesignerv1.TextStyle{}
		if in.FontSize != nil {
			style.FontSize = *in.FontSize
		}
		if in.FontFamily != nil {
			style.FontFamily = *in.FontFamily
		}
		if in.FontWeight != nil {
			style.FontWeight = *in.FontWeight
		}
		st.Style = style
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetText{SetText: st}})
	if err != nil {
		return SeqOutput{}, err
	}
	return SeqOutput{Seq: seq}, nil
}

// ---------------------------------------------------------------------------
// delete / reparent
// ---------------------------------------------------------------------------

type NodeIdInput struct {
	Id string `json:"id"`
}

// DeleteNode deletes a node and its whole subtree (cascade, per core.applyDelete).
func (s *Session) DeleteNode(ctx context.Context, in NodeIdInput) (SeqOutput, error) {
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteNode{DeleteNode: &opendesignerv1.DeleteNode{Id: in.Id}}})
	if err != nil {
		return SeqOutput{}, err
	}
	return SeqOutput{Seq: seq}, nil
}

// ReparentNodeInput moves a node under a new parent (node or page). orderKey is
// optional; a fresh increasing key is minted when it is omitted.
type ReparentNodeInput struct {
	Id          string `json:"id"`
	NewParentId string `json:"newParentId" jsonschema:"a node id or a page id"`
	OrderKey    string `json:"orderKey,omitempty" jsonschema:"fractional index among the new siblings; auto-generated if omitted"`
}

// ReparentNode moves a node under newParentId with a new order key.
func (s *Session) ReparentNode(ctx context.Context, in ReparentNodeInput) (SeqOutput, error) {
	orderKey := in.OrderKey
	if orderKey == "" {
		orderKey = s.nextOrderKey()
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_ReparentNode{ReparentNode: &opendesignerv1.ReparentNode{
		Id: in.Id, NewParentId: in.NewParentId, OrderKey: orderKey,
	}}})
	if err != nil {
		return SeqOutput{}, err
	}
	return SeqOutput{Seq: seq}, nil
}

// ---------------------------------------------------------------------------
// pages
// ---------------------------------------------------------------------------

type CreatePageInput struct {
	Name string `json:"name,omitempty"`
}

type CreatePageOutput struct {
	PageId string `json:"pageId"`
	Seq    uint64 `json:"seq"`
}

// CreatePage appends a new page (id auto-generated) and returns its id.
func (s *Session) CreatePage(ctx context.Context, in CreatePageInput) (CreatePageOutput, error) {
	id := uuid.NewString()
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreatePage{CreatePage: &opendesignerv1.CreatePage{
		Page: &opendesignerv1.Page{Id: id, Name: in.Name},
	}}})
	if err != nil {
		return CreatePageOutput{}, err
	}
	return CreatePageOutput{PageId: id, Seq: seq}, nil
}

type PageIdInput struct {
	Id string `json:"id"`
}

// DeletePage deletes a page and every node under it (cascade). The hub rejects
// deleting the last page.
func (s *Session) DeletePage(ctx context.Context, in PageIdInput) (SeqOutput, error) {
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeletePage{DeletePage: &opendesignerv1.DeletePage{Id: in.Id}}})
	if err != nil {
		return SeqOutput{}, err
	}
	return SeqOutput{Seq: seq}, nil
}

type RenamePageInput struct {
	Id   string `json:"id"`
	Name string `json:"name"`
}

// RenamePage sets a page's name.
func (s *Session) RenamePage(ctx context.Context, in RenamePageInput) (SeqOutput, error) {
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_RenamePage{RenamePage: &opendesignerv1.RenamePage{Id: in.Id, Name: in.Name}}})
	if err != nil {
		return SeqOutput{}, err
	}
	return SeqOutput{Seq: seq}, nil
}

// ---------------------------------------------------------------------------
// components
// ---------------------------------------------------------------------------

type CreateComponentInput struct {
	RootNodeId string `json:"rootNodeId" jsonschema:"id of an existing node to register as the master"`
	Name       string `json:"name,omitempty"`
}

type CreateComponentOutput struct {
	ComponentId string `json:"componentId"`
	Seq         uint64 `json:"seq"`
}

// CreateComponent registers an existing subtree as a component master.
func (s *Session) CreateComponent(ctx context.Context, in CreateComponentInput) (CreateComponentOutput, error) {
	id := uuid.NewString()
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateComponent{CreateComponent: &opendesignerv1.CreateComponent{
		ComponentId: id, RootNodeId: in.RootNodeId, Name: in.Name,
	}}})
	if err != nil {
		return CreateComponentOutput{}, err
	}
	return CreateComponentOutput{ComponentId: id, Seq: seq}, nil
}

// SetInstanceOverrideInput sets (or removes) one instance override on a master
// node. fills and text are each optional and independently "present": omit both
// to REMOVE the override for masterNodeId, pass [] fills to clear the fill.
type SetInstanceOverrideInput struct {
	InstanceId   string  `json:"instanceId"`
	MasterNodeId string  `json:"masterNodeId" jsonschema:"the master node this override targets"`
	Fills        []RGBA  `json:"fills,omitempty" jsonschema:"replaces the inherited fill; [] clears it"`
	Text         *string `json:"text,omitempty" jsonschema:"replaces the inherited text"`
}

// SetInstanceOverride sets, replaces, or removes an instance override.
func (s *Session) SetInstanceOverride(ctx context.Context, in SetInstanceOverrideInput) (SeqOutput, error) {
	ov := &opendesignerv1.InstanceOverride{MasterNodeId: in.MasterNodeId}
	if in.Fills != nil {
		if err := validateFills(in.Fills); err != nil {
			return SeqOutput{}, err
		}
		ov.Fills = toPaints(in.Fills)
		ov.FillsPresent = true
	}
	if in.Text != nil {
		ov.Text = *in.Text
		ov.TextPresent = true
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstanceOverride{SetInstanceOverride: &opendesignerv1.SetInstanceOverride{
		InstanceId: in.InstanceId, Override: ov,
	}}})
	if err != nil {
		return SeqOutput{}, err
	}
	return SeqOutput{Seq: seq}, nil
}

// ---------------------------------------------------------------------------
// read tools (served off the synced local doc)
// ---------------------------------------------------------------------------

type PageView struct {
	Id   string `json:"id"`
	Name string `json:"name"`
}

type ComponentView struct {
	Id         string `json:"id"`
	RootNodeId string `json:"rootNodeId"`
	Name       string `json:"name"`
}

type NodeView struct {
	Id       string  `json:"id"`
	ParentId string  `json:"parentId"`
	OrderKey string  `json:"orderKey"`
	Name     string  `json:"name,omitempty"`
	Kind     string  `json:"kind"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	Width    float64 `json:"width"`
	Height   float64 `json:"height"`
	Visible  bool    `json:"visible"`
	Text     string  `json:"text,omitempty" jsonschema:"content, for text nodes"`
	// AutoLayout is set for a frame that lays out its children. Their x/y and, for
	// a hugging frame, its width/height are already the computed result.
	AutoLayout *AutoLayoutSpec `json:"autoLayout,omitempty"`
	// Meta: i metadati liberi del nodo (flow.kind, code.route, test.id, status...).
	Meta map[string]string `json:"meta,omitempty" jsonschema:"metadati liberi del nodo; vedi set_node_meta"`
}

// nodeKind derives the compact kind label from the shape oneof. A node with no
// shape is a rectangle for every reader of the document (see core.applySetProps).
func nodeKind(n *opendesignerv1.Node) string {
	switch n.GetShape().(type) {
	case nil, *opendesignerv1.Node_Rect:
		return "rect"
	case *opendesignerv1.Node_Ellipse:
		return "ellipse"
	case *opendesignerv1.Node_Text:
		return "text"
	case *opendesignerv1.Node_Group:
		return "group"
	case *opendesignerv1.Node_Frame:
		return "frame"
	case *opendesignerv1.Node_Image:
		return "image"
	case *opendesignerv1.Node_Vector:
		return "vector"
	case *opendesignerv1.Node_Instance:
		return "instance"
	default:
		return fmt.Sprintf("%T", n.GetShape())
	}
}

func toNodeView(n *opendesignerv1.Node) NodeView {
	v := NodeView{
		Id: n.GetId(), ParentId: n.GetParentId(), OrderKey: n.GetOrderKey(),
		Name: n.GetName(), Kind: nodeKind(n),
		X: n.GetX(), Y: n.GetY(), Width: n.GetWidth(), Height: n.GetHeight(),
		Visible: n.GetVisible(),
	}
	if t := n.GetText(); t != nil {
		v.Text = t.GetContent()
	}
	v.AutoLayout = autoLayoutView(n.GetFrame().GetAutoLayout())
	if len(n.GetMeta()) > 0 {
		v.Meta = n.GetMeta()
	}
	return v
}

type DocumentView struct {
	Id         string          `json:"id"`
	Name       string          `json:"name"`
	Seq        uint64          `json:"seq"`
	Pages      []PageView      `json:"pages"`
	Components []ComponentView `json:"components"`
	Nodes      []NodeView      `json:"nodes"`
}

// GetDocument returns the whole synced document: pages, components and every
// node (summarised but complete enough to edit). It reflects edits from BOTH
// this session's tools and the web client, because it reads the local doc the
// Subscribe stream keeps current.
func (s *Session) GetDocument(ctx context.Context, _ struct{}) (DocumentView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	doc := s.doc
	out := DocumentView{Id: doc.GetId(), Name: doc.GetName(), Seq: s.seq}
	for _, p := range doc.GetPages() {
		out.Pages = append(out.Pages, PageView{Id: p.GetId(), Name: p.GetName()})
	}
	for id, c := range doc.GetComponents() {
		out.Components = append(out.Components, ComponentView{Id: id, RootNodeId: c.GetRootNodeId(), Name: c.GetName()})
	}
	for _, n := range doc.GetNodes() {
		out.Nodes = append(out.Nodes, toNodeView(n))
	}
	return out, nil
}

type ListPagesOutput struct {
	Pages []PageView `json:"pages"`
}

// ListPages lists the document's pages.
func (s *Session) ListPages(ctx context.Context, _ struct{}) (ListPagesOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out ListPagesOutput
	for _, p := range s.doc.GetPages() {
		out.Pages = append(out.Pages, PageView{Id: p.GetId(), Name: p.GetName()})
	}
	return out, nil
}

type ListNodesInput struct {
	PageId string `json:"pageId,omitempty" jsonschema:"if set, only nodes in this page's subtree; otherwise all nodes"`
}

type ListNodesOutput struct {
	Nodes []NodeView `json:"nodes"`
}

// ListNodes lists nodes, optionally filtered to one page's subtree (pre-order:
// each node after its parent, siblings by order_key).
func (s *Session) ListNodes(ctx context.Context, in ListNodesInput) (ListNodesOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out ListNodesOutput
	if in.PageId == "" {
		for _, n := range s.doc.GetNodes() {
			out.Nodes = append(out.Nodes, toNodeView(n))
		}
		return out, nil
	}
	for _, root := range core.ChildrenOf(s.doc, in.PageId) {
		for _, n := range core.SubtreeOf(s.doc, root.GetId()) {
			out.Nodes = append(out.Nodes, toNodeView(n))
		}
	}
	return out, nil
}

type ListComponentsOutput struct {
	Components []ComponentView `json:"components"`
}

// ListComponents lists the document's components.
func (s *Session) ListComponents(ctx context.Context, _ struct{}) (ListComponentsOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out ListComponentsOutput
	for id, c := range s.doc.GetComponents() {
		out.Components = append(out.Components, ComponentView{Id: id, RootNodeId: c.GetRootNodeId(), Name: c.GetName()})
	}
	return out, nil
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

// addTool wraps a Session method (typed in/out, returns the structured out) into
// the SDK's ToolHandlerFor signature: on error return it (the SDK marks the
// result IsError), otherwise return the structured out and let the SDK fill the
// result Content from it.
func addTool[In, Out any](srv *mcp.Server, name, desc string, fn func(context.Context, In) (Out, error)) {
	mcp.AddTool(srv, &mcp.Tool{Name: name, Description: desc},
		func(ctx context.Context, _ *mcp.CallToolRequest, in In) (*mcp.CallToolResult, Out, error) {
			out, err := fn(ctx, in)
			if err != nil {
				var zero Out
				return nil, zero, err
			}
			return nil, out, nil
		})
}

// RegisterTools installs every opendesigner tool on srv, backed by s.
func RegisterTools(srv *mcp.Server, s *Session) {
	// writes
	addTool(srv, "create_rectangle", "Create a rectangle node. parentId defaults to the first page. Returns the new node id.", s.CreateRectangle)
	addTool(srv, "create_ellipse", "Create an ellipse node. parentId defaults to the first page. Returns the new node id.", s.CreateEllipse)
	addTool(srv, "create_frame", "Create a frame: a container with its own box. Optionally clipsContent, and autoLayout to have the server arrange its children in a row or column (the children's x/y are then computed for you). parentId defaults to the first page.", s.CreateFrame)
	addTool(srv, "set_auto_layout", "Turn auto layout on, change it, or (autoLayout omitted) off for a frame. After every change the server repositions the frame's children; reposition by editing the layout, not the children's x/y, which it overrides.", s.SetAutoLayout)
	addTool(srv, "create_text", "Create a text node with the given content. parentId defaults to the first page. Returns the new node id.", s.CreateText)
	addTool(srv, "set_properties", "Set absolute properties on a node (x/y/width/height/opacity/rotation/name/visible/cornerRadius/fills/effects). Effects: [{kind:dropShadow,color,offsetX,offsetY,blur}|{kind:layerBlur,radius}]. A fill is a solid {r,g,b,a} or a {gradient:{kind:linear|radial,stops,x1,y1,x2,y2}} in box-normalised coordinates. Only provided fields change.", s.SetProperties)
	addTool(srv, "set_text", "Set a text node's content, and optionally replace its style.", s.SetText)
	addTool(srv, "delete_node", "Delete a node and its whole subtree.", s.DeleteNode)
	addTool(srv, "reparent_node", "Move a node under a new parent (node or page), with an optional order key.", s.ReparentNode)
	addTool(srv, "create_page", "Create a new page. Returns the new page id.", s.CreatePage)
	addTool(srv, "delete_page", "Delete a page and every node under it. The last page cannot be deleted.", s.DeletePage)
	addTool(srv, "rename_page", "Rename a page.", s.RenamePage)
	addTool(srv, "create_component", "Register an existing node subtree as a component master. Returns the new component id.", s.CreateComponent)
	addTool(srv, "set_instance_override", "Set, replace, or remove a fill/text override on a component instance.", s.SetInstanceOverride)
	// reads
	addTool(srv, "get_document", "Return the whole document: id, name, seq, pages, components and all nodes.", s.GetDocument)
	addTool(srv, "list_pages", "List the document's pages.", s.ListPages)
	addTool(srv, "list_nodes", "List nodes, optionally filtered to one page's subtree.", s.ListNodes)
	addTool(srv, "list_peers", "List the other people and agents in the document and the nodes each has selected or just edited. Use it to avoid editing what someone else is working on.", s.ListPeers)
	addTool(srv, "list_components", "List the document's components.", s.ListComponents)
	registerFlowTools(srv, s)
}
