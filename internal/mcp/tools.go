package mcp

import (
	"context"
	"errors"
	"fmt"
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/protobuf/proto"
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

// EffectSpec is one node effect. Any number of dropShadow and innerShadow effects
// are drawn; the canvas applies the FIRST layerBlur and the FIRST backgroundBlur.
type EffectSpec struct {
	Kind    string    `json:"kind" jsonschema:"dropShadow, innerShadow, layerBlur, backgroundBlur, progressiveBlur, noise, texture or glass"`
	Color   StopColor `json:"color,omitempty" jsonschema:"shadows only; alpha 0..1"`
	OffsetX float64   `json:"offsetX,omitempty" jsonschema:"shadows only, in world units"`
	OffsetY float64   `json:"offsetY,omitempty" jsonschema:"shadows only, in world units"`
	Blur    float64   `json:"blur,omitempty" jsonschema:"shadows only, >= 0, in world units"`
	Radius  float64   `json:"radius,omitempty" jsonschema:"layerBlur and backgroundBlur only, >= 0, in world units"`
	EffectFx
}

// blendModes maps the tool's names (CSS names) to the document's enum.
var blendModes = map[string]opendesignerv1.BlendMode{
	"normal": opendesignerv1.BlendMode_BLEND_MODE_UNSPECIFIED, "multiply": opendesignerv1.BlendMode_BLEND_MODE_MULTIPLY,
	"screen": opendesignerv1.BlendMode_BLEND_MODE_SCREEN, "overlay": opendesignerv1.BlendMode_BLEND_MODE_OVERLAY,
	"darken": opendesignerv1.BlendMode_BLEND_MODE_DARKEN, "lighten": opendesignerv1.BlendMode_BLEND_MODE_LIGHTEN,
	"color-dodge": opendesignerv1.BlendMode_BLEND_MODE_COLOR_DODGE, "color-burn": opendesignerv1.BlendMode_BLEND_MODE_COLOR_BURN,
	"hard-light": opendesignerv1.BlendMode_BLEND_MODE_HARD_LIGHT, "soft-light": opendesignerv1.BlendMode_BLEND_MODE_SOFT_LIGHT,
	"difference": opendesignerv1.BlendMode_BLEND_MODE_DIFFERENCE, "exclusion": opendesignerv1.BlendMode_BLEND_MODE_EXCLUSION,
	"hue": opendesignerv1.BlendMode_BLEND_MODE_HUE, "saturation": opendesignerv1.BlendMode_BLEND_MODE_SATURATION,
	"color": opendesignerv1.BlendMode_BLEND_MODE_COLOR, "luminosity": opendesignerv1.BlendMode_BLEND_MODE_LUMINOSITY,
}

func blendModeName(b opendesignerv1.BlendMode) string {
	for name, v := range blendModes {
		if v == b && name != "normal" {
			return name
		}
	}
	return ""
}

func validateEffects(effects []EffectSpec) error {
	for i, e := range effects {
		switch e.Kind {
		case "dropShadow", "innerShadow":
			if e.Blur < 0 {
				return fmt.Errorf("effects[%d].blur must be >= 0", i)
			}
		case "layerBlur", "backgroundBlur":
			if e.Radius < 0 {
				return fmt.Errorf("effects[%d].radius must be >= 0", i)
			}
		case "progressiveBlur", "noise", "texture", "glass":
			if _, err := e.fxProto(); err != nil {
				return fmt.Errorf("effects[%d] (%s): %w", i, e.Kind, err)
			}
		default:
			return fmt.Errorf("effects[%d].kind must be dropShadow, innerShadow, layerBlur, backgroundBlur, progressiveBlur, noise, texture or glass, got %q", i, e.Kind)
		}
	}
	return nil
}

func toEffects(effects []EffectSpec) []*opendesignerv1.Effect {
	out := make([]*opendesignerv1.Effect, 0, len(effects))
	for _, e := range effects {
		if isFxKind(e.Kind) {
			if fx, err := e.fxProto(); err == nil { // validateEffects has already vetted it
				out = append(out, fx)
			}
			continue
		}
		if e.Kind == "layerBlur" {
			out = append(out, &opendesignerv1.Effect{Kind: &opendesignerv1.Effect_LayerBlur{LayerBlur: &opendesignerv1.LayerBlur{Radius: e.Radius}}})
			continue
		}
		if e.Kind == "backgroundBlur" {
			out = append(out, &opendesignerv1.Effect{Kind: &opendesignerv1.Effect_BackgroundBlur{BackgroundBlur: &opendesignerv1.BackgroundBlur{Radius: e.Radius}}})
			continue
		}
		if e.Kind == "innerShadow" {
			out = append(out, &opendesignerv1.Effect{Kind: &opendesignerv1.Effect_InnerShadow{InnerShadow: &opendesignerv1.InnerShadow{
				Color:   &opendesignerv1.Color{R: float32(e.Color.R), G: float32(e.Color.G), B: float32(e.Color.B), A: float32(e.Color.A)},
				OffsetX: e.OffsetX, OffsetY: e.OffsetY, Blur: e.Blur,
			}}})
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
	Italic     *bool    `json:"italic,omitempty"`
	LineHeight *float64 `json:"lineHeight,omitempty" jsonschema:"multiplier; defaults to 1.2"`
	TextFormat
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
	if in.Italic != nil {
		style.Italic = *in.Italic
	}
	if in.LineHeight != nil {
		style.LineHeight = *in.LineHeight
	}
	if err := in.TextFormat.apply(style); err != nil {
		return CreateNodeOutput{}, fmt.Errorf("create_text: %w", err)
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
	IsMask       *bool        `json:"isMask,omitempty" jsonschema:"rect, ellipse, frame and vector only: the node is not drawn and its outline clips the siblings above it"`
	BlendMode    *string      `json:"blendMode,omitempty" jsonschema:"normal | multiply | screen | overlay | darken | lighten | color-dodge | color-burn | hard-light | soft-light | difference | exclusion | hue | saturation | color | luminosity"`
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
	if in.IsMask != nil {
		patch.IsMask = *in.IsMask
		paths = append(paths, "is_mask")
	}
	if in.BlendMode != nil {
		b, ok := blendModes[*in.BlendMode]
		if !ok {
			return SeqOutput{}, fmt.Errorf("blendMode must be one of the CSS blend mode names or \"normal\", got %q", *in.BlendMode)
		}
		patch.BlendMode = b
		paths = append(paths, "blend_mode")
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
// overlays those fields on the node's style (written with style_present). Omit all
// style fields to keep the node's existing style intact.
type SetTextInput struct {
	Id         string   `json:"id"`
	Content    string   `json:"content"`
	FontSize   *float64 `json:"fontSize,omitempty"`
	FontFamily *string  `json:"fontFamily,omitempty"`
	FontWeight *string  `json:"fontWeight,omitempty"`
	Italic     *bool    `json:"italic,omitempty"`
	LineHeight *float64 `json:"lineHeight,omitempty"`
	TextFormat
}

// SetText rewrites a text node's content (and optionally its style).
func (s *Session) SetText(ctx context.Context, in SetTextInput) (SeqOutput, error) {
	st := &opendesignerv1.SetText{Id: in.Id, Content: in.Content}
	if in.FontSize != nil || in.FontFamily != nil || in.FontWeight != nil || in.Italic != nil || in.LineHeight != nil || in.TextFormat.given() {
		st.StylePresent = true
		style := &opendesignerv1.TextStyle{}
		// Start from the node's current style and overlay what was given, so a
		// format-only edit (case, lists, ...) does not zero the font size.
		s.mu.Lock()
		if cur, ok := s.doc.GetNodes()[in.Id]; ok && cur.GetText().GetStyle() != nil {
			style = proto.Clone(cur.GetText().GetStyle()).(*opendesignerv1.TextStyle)
		}
		s.mu.Unlock()
		if in.FontSize != nil {
			style.FontSize = *in.FontSize
		}
		if in.FontFamily != nil {
			style.FontFamily = *in.FontFamily
		}
		if in.FontWeight != nil {
			style.FontWeight = *in.FontWeight
		}
		if in.Italic != nil {
			style.Italic = *in.Italic
		}
		if in.LineHeight != nil {
			style.LineHeight = *in.LineHeight
		}
		if err := in.TextFormat.apply(style); err != nil {
			return SeqOutput{}, fmt.Errorf("set_text: %w", err)
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

// PageSetup is the sheet of a page: size, margins, columns and bleed, all in world units.
type PageSetup struct {
	Width        *float64 `json:"width,omitempty" jsonschema:"sheet width; 0 = an unbounded canvas page"`
	Height       *float64 `json:"height,omitempty" jsonschema:"sheet height; 0 = unbounded"`
	MarginTop    *float64 `json:"marginTop,omitempty"`
	MarginRight  *float64 `json:"marginRight,omitempty"`
	MarginBottom *float64 `json:"marginBottom,omitempty"`
	MarginLeft   *float64 `json:"marginLeft,omitempty"`
	Columns      *uint32  `json:"columns,omitempty" jsonschema:"text columns inside the margins (0 or 1 = one)"`
	Gutter       *float64 `json:"gutter,omitempty" jsonschema:"space between columns"`
	Bleed        *float64 `json:"bleed,omitempty" jsonschema:"extra area around the sheet that is printed and trimmed"`
	Slug         *float64 `json:"slug,omitempty" jsonschema:"extra area beyond the bleed for printer's marks and notes"`
	// Numbering and structure.
	SectionStart      *bool        `json:"sectionStart,omitempty" jsonschema:"this page starts a numbering section (the first page always does)"`
	NumberStart       *uint32      `json:"numberStart,omitempty" jsonschema:"the number this section starts at (0 = 1)"`
	NumberStyle       *string      `json:"numberStyle,omitempty" jsonschema:"page number style of the section: empty = 1,2,3 | i | I | a | A"`
	LeftMasterId      *string      `json:"leftMasterId,omitempty" jsonschema:"master applied on the left-hand pages of a spread (facing pages); empty = the same as masterId"`
	HiddenMasterItems *[]string    `json:"hiddenMasterItems,omitempty" jsonschema:"ids of master items not drawn on this page"`
	Guides            *[]GuideSpec `json:"guides,omitempty" jsonschema:"ruler guides of the page (a master's guides apply to its pages)"`
}

// GuideSpec is a ruler guide: a vertical one at x = position, else a horizontal one at y = position.
type GuideSpec struct {
	Vertical bool    `json:"vertical,omitempty"`
	Position float64 `json:"position"`
}

// apply writes the fields that are set onto p.
func (s PageSetup) apply(p *opendesignerv1.Page) {
	if s.Width != nil {
		p.Width = *s.Width
	}
	if s.Height != nil {
		p.Height = *s.Height
	}
	if s.MarginTop != nil {
		p.MarginTop = *s.MarginTop
	}
	if s.MarginRight != nil {
		p.MarginRight = *s.MarginRight
	}
	if s.MarginBottom != nil {
		p.MarginBottom = *s.MarginBottom
	}
	if s.MarginLeft != nil {
		p.MarginLeft = *s.MarginLeft
	}
	if s.Columns != nil {
		p.Columns = *s.Columns
	}
	if s.Gutter != nil {
		p.Gutter = *s.Gutter
	}
	if s.Bleed != nil {
		p.Bleed = *s.Bleed
	}
	if s.Slug != nil {
		p.Slug = *s.Slug
	}
	if s.SectionStart != nil {
		p.SectionStart = *s.SectionStart
	}
	if s.NumberStart != nil {
		p.NumberStart = *s.NumberStart
	}
	if s.NumberStyle != nil {
		p.NumberStyle = *s.NumberStyle
	}
	if s.LeftMasterId != nil {
		p.LeftMasterId = *s.LeftMasterId
	}
	if s.HiddenMasterItems != nil {
		p.HiddenMasterItems = append([]string(nil), (*s.HiddenMasterItems)...)
	}
	if s.Guides != nil {
		p.Guides = nil
		for _, g := range *s.Guides {
			p.Guides = append(p.Guides, &opendesignerv1.Guide{Vertical: g.Vertical, Position: g.Position})
		}
	}
}

type CreatePageInput struct {
	Name     string `json:"name,omitempty"`
	IsMaster bool   `json:"isMaster,omitempty" jsonschema:"create a MASTER page (a template drawn behind the pages that apply it)"`
	MasterId string `json:"masterId,omitempty" jsonschema:"id of a master page this page applies (or, for a master, the master it is based on)"`
	PageSetup
}

type CreatePageOutput struct {
	PageId string `json:"pageId"`
	Seq    uint64 `json:"seq"`
}

// CreatePage appends a new page (id auto-generated) and returns its id.
func (s *Session) CreatePage(ctx context.Context, in CreatePageInput) (CreatePageOutput, error) {
	id := uuid.NewString()
	page := &opendesignerv1.Page{Id: id, Name: in.Name, IsMaster: in.IsMaster, MasterId: in.MasterId}
	in.PageSetup.apply(page)
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreatePage{CreatePage: &opendesignerv1.CreatePage{Page: page}}})
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

type UpdatePageInput struct {
	Id       string  `json:"id"`
	Name     *string `json:"name,omitempty"`
	IsMaster *bool   `json:"isMaster,omitempty" jsonschema:"turn the page into a master page (or back into a normal one)"`
	MasterId *string `json:"masterId,omitempty" jsonschema:"master page this page applies; empty string detaches"`
	PageSetup
}

// UpdatePage changes a page's name, master flag and applied master; fields left out keep their value.
func (s *Session) UpdatePage(ctx context.Context, in UpdatePageInput) (SeqOutput, error) {
	s.mu.Lock()
	var cur *opendesignerv1.Page
	for _, p := range s.doc.GetPages() {
		if p.GetId() == in.Id {
			cur = proto.Clone(p).(*opendesignerv1.Page)
		}
	}
	s.mu.Unlock()
	if cur == nil {
		return SeqOutput{}, fmt.Errorf("page %q not found", in.Id)
	}
	if in.Name != nil {
		cur.Name = *in.Name
	}
	if in.IsMaster != nil {
		cur.IsMaster = *in.IsMaster
	}
	if in.MasterId != nil {
		cur.MasterId = *in.MasterId
	}
	in.PageSetup.apply(cur)
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_UpdatePage{UpdatePage: &opendesignerv1.UpdatePage{Page: cur}}})
	if err != nil {
		return SeqOutput{}, err
	}
	return SeqOutput{Seq: seq}, nil
}

type MovePageInput struct {
	Id    string `json:"id"`
	Index uint32 `json:"index" jsonschema:"the position in the page order, 0 = first (masters count too)"`
}

// MovePage moves a page to a position in the page order.
func (s *Session) MovePage(ctx context.Context, in MovePageInput) (SeqOutput, error) {
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_MovePage{MovePage: &opendesignerv1.MovePage{Id: in.Id, Index: in.Index}}})
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
	Id       string `json:"id"`
	Name     string `json:"name"`
	IsMaster bool   `json:"isMaster,omitempty"`
	MasterId string `json:"masterId,omitempty"`
	// Page setup (0 / absent = none): a sized page is a sheet at the origin.
	Width        float64 `json:"width,omitempty"`
	Height       float64 `json:"height,omitempty"`
	MarginTop    float64 `json:"marginTop,omitempty"`
	MarginRight  float64 `json:"marginRight,omitempty"`
	MarginBottom float64 `json:"marginBottom,omitempty"`
	MarginLeft   float64 `json:"marginLeft,omitempty"`
	Columns      uint32  `json:"columns,omitempty"`
	Gutter       float64 `json:"gutter,omitempty"`
	Bleed        float64 `json:"bleed,omitempty"`
	Slug         float64 `json:"slug,omitempty"`
	// Numbering and structure (omitted at their defaults).
	SectionStart      bool        `json:"sectionStart,omitempty"`
	NumberStart       uint32      `json:"numberStart,omitempty"`
	NumberStyle       string      `json:"numberStyle,omitempty"`
	LeftMasterId      string      `json:"leftMasterId,omitempty"`
	HiddenMasterItems []string    `json:"hiddenMasterItems,omitempty"`
	Guides            []GuideSpec `json:"guides,omitempty"`
}

func pageView(p *opendesignerv1.Page) PageView {
	var guides []GuideSpec
	for _, g := range p.GetGuides() {
		guides = append(guides, GuideSpec{Vertical: g.GetVertical(), Position: g.GetPosition()})
	}
	return PageView{
		Slug: p.GetSlug(), SectionStart: p.GetSectionStart(), NumberStart: p.GetNumberStart(), NumberStyle: p.GetNumberStyle(),
		LeftMasterId: p.GetLeftMasterId(), HiddenMasterItems: p.GetHiddenMasterItems(), Guides: guides,
		Id: p.GetId(), Name: p.GetName(), IsMaster: p.GetIsMaster(), MasterId: p.GetMasterId(),
		Width: p.GetWidth(), Height: p.GetHeight(), MarginTop: p.GetMarginTop(), MarginRight: p.GetMarginRight(),
		MarginBottom: p.GetMarginBottom(), MarginLeft: p.GetMarginLeft(), Columns: p.GetColumns(), Gutter: p.GetGutter(), Bleed: p.GetBleed(),
	}
}

type ComponentView struct {
	Id         string `json:"id"`
	RootNodeId string `json:"rootNodeId"`
	Name       string `json:"name"`
	// Variants and properties (see list_component_sets, set_component_def).
	SetId      string                `json:"setId,omitempty"`
	Variant    map[string]string     `json:"variant,omitempty"`
	Properties []ComponentPropertyIO `json:"properties,omitempty"`
}

func componentView(id string, c *opendesignerv1.Component) ComponentView {
	return ComponentView{
		Id: id, RootNodeId: c.GetRootNodeId(), Name: c.GetName(),
		SetId: c.GetSetId(), Variant: c.GetVariant(), Properties: propertyViews(c),
	}
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
	// EffectKinds: the kinds of the node's effects, in order (dropShadow, layerBlur, noise, glass...).
	EffectKinds []string `json:"effectKinds,omitempty" jsonschema:"kinds of the node's effects in order; set them with set_properties effects"`
	// Format: the text node's case / script / list / OpenType / box settings; absent when none is set.
	Format *TextFormat `json:"format,omitempty" jsonschema:"text case, script, list, indent, fontFeatures, verticalAlign and inset of a text node; see set_text"`
	// Rich text of a text node (see format_text).
	ParagraphStyles []string       `json:"paragraphStyles,omitempty" jsonschema:"paragraph style id per paragraph; empty string = the node's own style"`
	Runs            []TextRunInput `json:"runs,omitempty" jsonschema:"character styles over ranges of the content (UTF-16 units)"`
	// AutoLayout is set for a frame that lays out its children. Their x/y and, for
	// a hugging frame, its width/height are already the computed result.
	AutoLayout *AutoLayoutSpec `json:"autoLayout,omitempty"`
	// Meta: the node's free-form metadata (flow.kind, code.route, test.id, status...).
	Meta map[string]string `json:"meta,omitempty" jsonschema:"free-form node metadata; see set_node_meta"`
	// Bindings: property -> variable id (see bind_variable); Modes: collection id -> pinned mode id (see set_node_mode).
	Bindings map[string]string `json:"bindings,omitempty" jsonschema:"properties bound to variables; see bind_variable"`
	Modes    map[string]string `json:"modes,omitempty" jsonschema:"variable modes pinned on this node; see set_node_mode"`
	// TextStyleId: the shared text style a text node applies (see apply_text_style).
	TextStyleId string `json:"textStyleId,omitempty" jsonschema:"shared text style applied to a text node; see apply_text_style"`
	// Constraints / layout sizing (see set_constraints, set_layout_sizing); omitted when default.
	BlendMode     string `json:"blendMode,omitempty" jsonschema:"CSS blend mode name; absent = normal"`
	IsMask        bool   `json:"isMask,omitempty" jsonschema:"true when the node is a mask for the siblings above it"`
	ConstraintX   string `json:"constraintX,omitempty" jsonschema:"how it follows its parent frame's width: max | stretch | center | scale (default min); see set_constraints"`
	ConstraintY   string `json:"constraintY,omitempty"`
	LayoutSizingX string `json:"layoutSizingX,omitempty" jsonschema:"fill when an auto layout parent fills its width; see set_layout_sizing"`
	LayoutSizingY string `json:"layoutSizingY,omitempty"`
	// Size limits and the opt-out of the auto layout flow (see set_layout_limits, set_layout_positioning).
	MinWidth          float64 `json:"minWidth,omitempty"`
	MaxWidth          float64 `json:"maxWidth,omitempty"`
	MinHeight         float64 `json:"minHeight,omitempty"`
	MaxHeight         float64 `json:"maxHeight,omitempty"`
	LayoutPositioning string  `json:"layoutPositioning,omitempty" jsonschema:"absolute when the node is out of its auto layout parent's flow; see set_layout_positioning"`
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
		v.ParagraphStyles = t.GetParagraphStyles()
		for _, r := range t.GetRuns() {
			v.Runs = append(v.Runs, TextRunInput{Start: int(r.GetStart()), End: int(r.GetEnd()), StyleId: r.GetStyleId()})
		}
		if f := formatOf(t.GetStyle()); f.given() {
			v.Format = &f
		}
	}
	v.AutoLayout = autoLayoutView(n.GetFrame().GetAutoLayout())
	if len(n.GetMeta()) > 0 {
		v.Meta = n.GetMeta()
	}
	if len(n.GetBindings()) > 0 {
		v.Bindings = n.GetBindings()
	}
	if len(n.GetModes()) > 0 {
		v.Modes = n.GetModes()
	}
	v.TextStyleId = n.GetTextStyleId()
	v.EffectKinds = effectKinds(n.GetEffects())
	v.BlendMode = blendModeName(n.GetBlendMode())
	v.IsMask = n.GetIsMask()
	v.ConstraintX, v.ConstraintY = constraintNames[n.GetConstraintX()], constraintNames[n.GetConstraintY()]
	if n.GetLayoutSizingX() == opendesignerv1.LayoutSizing_LAYOUT_SIZING_FILL {
		v.LayoutSizingX = "fill"
	}
	if n.GetLayoutSizingY() == opendesignerv1.LayoutSizing_LAYOUT_SIZING_FILL {
		v.LayoutSizingY = "fill"
	}
	v.MinWidth, v.MaxWidth, v.MinHeight, v.MaxHeight = n.GetMinWidth(), n.GetMaxWidth(), n.GetMinHeight(), n.GetMaxHeight()
	if n.GetLayoutPositioning() == opendesignerv1.LayoutPositioning_LAYOUT_POSITIONING_ABSOLUTE {
		v.LayoutPositioning = "absolute"
	}
	return v
}

type DocumentView struct {
	Id         string          `json:"id"`
	Name       string          `json:"name"`
	Seq        uint64          `json:"seq"`
	Pages      []PageView      `json:"pages"`
	Components []ComponentView `json:"components"`
	Clips      []ClipView      `json:"clips"`
	// Variables: the design tokens (collections, modes, values); see list_variables.
	Variables []CollectionView `json:"variables"`
	// Typography: uploaded fonts and shared text styles; see list_fonts / list_text_styles.
	ComponentSets []ComponentSetView `json:"componentSets"`
	Fonts         []FontView         `json:"fonts"`
	TextStyles    []TextStyleView    `json:"textStyles"`
	Nodes         []NodeView         `json:"nodes"`
	// Settings: the vertical and the baseline grid; see set_document_settings.
	Vertical          string  `json:"vertical" jsonschema:"publishing | design | product"`
	BaselineIncrement float64 `json:"baselineIncrement,omitempty"`
	BaselineStart     float64 `json:"baselineStart,omitempty"`
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
	out.Vertical = verticalName(doc.GetSettings().GetVertical())
	out.BaselineIncrement, out.BaselineStart = doc.GetSettings().GetBaselineIncrement(), doc.GetSettings().GetBaselineStart()
	for _, p := range doc.GetPages() {
		out.Pages = append(out.Pages, pageView(p))
	}
	for id, c := range doc.GetComponents() {
		out.Components = append(out.Components, componentView(id, c))
	}
	for _, n := range doc.GetNodes() {
		out.Nodes = append(out.Nodes, toNodeView(n))
	}
	out.Clips = clipViews(doc)
	out.Variables = collectionViews(doc)
	out.ComponentSets = componentSetViews(doc)
	out.Fonts = fontViews(doc)
	out.TextStyles = textStyleViews(doc)
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
		out.Pages = append(out.Pages, pageView(p))
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
		out.Components = append(out.Components, componentView(id, c))
	}
	sort.Slice(out.Components, func(i, j int) bool { return out.Components[i].Id < out.Components[j].Id })
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
	addTool(srv, "set_properties", "Set absolute properties on a node (x/y/width/height/opacity/rotation/name/visible/cornerRadius/fills/effects). Effects (any number of shadows): [{kind:dropShadow|innerShadow,color,offsetX,offsetY,blur}|{kind:layerBlur|backgroundBlur,radius}|{kind:progressiveBlur,startRadius,endRadius,x1,y1,x2,y2,background}|{kind:noise,mode:mono|duo|multi,size,density,opacity,color,color2,seed}|{kind:texture,scale,intensity,seed}|{kind:glass,frost,light,lightAngle,noise}] (progressive blur, noise, texture and glass are described in docs/effects.md; noise, texture and glass draw on rect/ellipse/frame/image). blendMode: normal|multiply|screen|overlay|... (CSS names). isMask: true makes the shape a mask for the siblings above it. A fill is a solid {r,g,b,a} or a {gradient:{kind:linear|radial,stops,x1,y1,x2,y2}} in box-normalised coordinates. Only provided fields change.", s.SetProperties)
	addTool(srv, "set_text", "Set a text node's content, and optionally change its style (only the fields you give change: size, family, weight, italic, lineHeight, textCase, script, list, indent, fontFeatures, verticalAlign, inset).", s.SetText)
	addTool(srv, "delete_node", "Delete a node and its whole subtree.", s.DeleteNode)
	addTool(srv, "reparent_node", "Move a node under a new parent (node or page), with an optional order key.", s.ReparentNode)
	addTool(srv, "create_page", "Create a new page (optionally a master page, or one that applies a master). Returns the new page id.", s.CreatePage)
	addTool(srv, "update_page", "Change a page: turn it into a master page, apply or detach a master (masterId), or rename it. A master page is a template: its content is drawn behind every page that applies it, and a text with the token <#> shows the page number there. A master may be based on another master (a chain, no cycles); leftMasterId gives the left-hand pages of a spread their own master. A master in use cannot be deleted or demoted. Also sets numbering (sectionStart / numberStart / numberStyle), slug, ruler guides and the master items hidden on the page.", s.UpdatePage)
	addTool(srv, "move_page", "Move a page to a position in the page order.", s.MovePage)
	addTool(srv, "delete_page", "Delete a page and every node under it. The last page cannot be deleted.", s.DeletePage)
	addTool(srv, "rename_page", "Rename a page.", s.RenamePage)
	addTool(srv, "create_component", "Register an existing node subtree as a component master. Returns the new component id.", s.CreateComponent)
	addTool(srv, "set_instance_override", "Set, replace, or remove a fill/text override on a component instance.", s.SetInstanceOverride)
	// reads
	addTool(srv, "get_document", "Return the whole document: id, name, seq, pages, components and all nodes.", s.GetDocument)
	addTool(srv, "list_pages", "List the document's pages.", s.ListPages)
	addTool(srv, "list_nodes", "List nodes, optionally filtered to one page's subtree.", s.ListNodes)
	addTool(srv, "set_nickname", "Change the name you show to the other people in the document (1 to 32 characters). You leave and rejoin the room under the new name.", s.SetNickname)
	addTool(srv, "list_peers", "List the other people and agents in the document and the nodes each has selected or just edited. Use it to avoid editing what someone else is working on.", s.ListPeers)
	addTool(srv, "list_components", "List the document's components.", s.ListComponents)
	registerFlowTools(srv, s)
	registerThreadTools(srv, s)
	registerDocSettingsTools(srv, s)
	registerAnimationTools(srv, s)
	registerVariableTools(srv, s)
	registerTypographyTools(srv, s)
	registerCommentTools(srv, s)
	registerReviewTools(srv, s)
	registerBoardTools(srv, s)
	registerVariantTools(srv, s)
	registerConstraintTools(srv, s)
	registerLayoutLimitTools(srv, s)
	registerInstanceTools(srv, s)
	registerCodegenTools(srv, s)
	registerDiagramTools(srv, s)
	registerDevTools(srv, s)
}
