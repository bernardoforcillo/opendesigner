// Package samples builds example documents for the code export tests and for
// the pixel-parity script (web/scripts/export-parity.mjs): a gallery that
// covers everything the generator can express in CSS, and a three-screen flow
// with e2e tests.
//
// Documents are built with core.Apply (CreateNode, SetFlow...), not by writing
// the structs by hand: this way auto layout is already laid out by the core and
// the document is valid by construction, like one coming from the server.
package samples

import (
	"fmt"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

// B is a document builder.
type B struct {
	Doc *opendesignerv1.Document
	seq int
}

// New: an empty document with the page "page1".
func New(id, name string) *B { return &B{Doc: core.NewDocument(id, name)} }

func (b *B) must(op *opendesignerv1.Op) {
	if err := core.Apply(b.Doc, op); err != nil {
		panic(fmt.Sprintf("samples: %v", err))
	}
}

// Opt modifies a node before creation.
type Opt func(*opendesignerv1.Node)

// Add creates a node (visible, opacity 1, increasing order_key) and returns it.
func (b *B) Add(id, parent, name string, x, y, w, h float64, opts ...Opt) *opendesignerv1.Node {
	b.seq++
	n := &opendesignerv1.Node{
		Id: id, ParentId: parent, OrderKey: fmt.Sprintf("a%05d", b.seq), Name: name,
		Visible: true, Opacity: 1, X: x, Y: y, Width: w, Height: h,
		Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}},
	}
	for _, o := range opts {
		o(n)
	}
	b.must(&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}})
	return b.Doc.Nodes[id]
}

// Flow and Transition: upsert through the ops.
func (b *B) Flow(id, name, start string) {
	b.must(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetFlow{SetFlow: &opendesignerv1.SetFlow{Flow: &opendesignerv1.Flow{Id: id, Name: name, StartId: start}}}})
}

func (b *B) Transition(t *opendesignerv1.Transition) {
	b.must(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetTransition{SetTransition: &opendesignerv1.SetTransition{Transition: t}}})
}

func (b *B) Component(id, root, name string) {
	b.must(&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateComponent{CreateComponent: &opendesignerv1.CreateComponent{ComponentId: id, RootNodeId: root, Name: name}}})
}

// ---------------------------------------------------------------------------
// colours and paints
// ---------------------------------------------------------------------------

// C: opaque colour; CA: with alpha.
func C(r, g, b float32) *opendesignerv1.Color { return &opendesignerv1.Color{R: r, G: g, B: b, A: 1} }
func CA(r, g, b, a float32) *opendesignerv1.Color {
	return &opendesignerv1.Color{R: r, G: g, B: b, A: a}
}

func Solid(c *opendesignerv1.Color) *opendesignerv1.Paint {
	return &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{Color: c}}}
}

// Stop: a gradient point.
type Stop struct {
	At float64
	C  *opendesignerv1.Color
}

// S: a stop (position 0..1, colour).
func S(at float64, c *opendesignerv1.Color) Stop { return Stop{At: at, C: c} }

func grad(x1, y1, x2, y2 float64, stops []Stop) *opendesignerv1.GradientPaint {
	g := &opendesignerv1.GradientPaint{X1: x1, Y1: y1, X2: x2, Y2: y2}
	for _, s := range stops {
		g.Stops = append(g.Stops, &opendesignerv1.GradientStop{Color: s.C, Position: s.At})
	}
	return g
}

func Linear(x1, y1, x2, y2 float64, stops ...Stop) *opendesignerv1.Paint {
	return &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Linear{Linear: grad(x1, y1, x2, y2, stops)}}
}

func Radial(x1, y1, x2, y2 float64, stops ...Stop) *opendesignerv1.Paint {
	return &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Radial{Radial: grad(x1, y1, x2, y2, stops)}}
}

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

func Fill(ps ...*opendesignerv1.Paint) Opt { return func(n *opendesignerv1.Node) { n.Fills = ps } }
func Rot(deg float64) Opt                  { return func(n *opendesignerv1.Node) { n.Rotation = deg } }
func Opacity(o float64) Opt                { return func(n *opendesignerv1.Node) { n.Opacity = o } }
func Hidden() Opt                          { return func(n *opendesignerv1.Node) { n.Visible = false } }

func Meta(kv ...string) Opt {
	return func(n *opendesignerv1.Node) {
		n.Meta = map[string]string{}
		for i := 0; i+1 < len(kv); i += 2 {
			n.Meta[kv[i]] = kv[i+1]
		}
	}
}

func Rect(radius float64) Opt {
	return func(n *opendesignerv1.Node) {
		n.Shape = &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{CornerRadius: radius}}
	}
}

func Ellipse() Opt {
	return func(n *opendesignerv1.Node) {
		n.Shape = &opendesignerv1.Node_Ellipse{Ellipse: &opendesignerv1.EllipseNode{}}
	}
}

func Group() Opt {
	return func(n *opendesignerv1.Node) {
		n.Shape = &opendesignerv1.Node_Group{Group: &opendesignerv1.GroupNode{}}
	}
}

// Frame: a container; clips = clipping, al = auto layout (nil = none).
func Frame(clips bool, al *opendesignerv1.AutoLayout) Opt {
	return func(n *opendesignerv1.Node) {
		n.Shape = &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{ClipsContent: clips, AutoLayout: al}}
	}
}

// Text: a style with only the fields that matter (family "", weight "", line height 0 = default).
func Text(content string, size float64, weight string, align opendesignerv1.TextAlign) Opt {
	return func(n *opendesignerv1.Node) {
		n.Shape = &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{
			Content: content,
			Style:   &opendesignerv1.TextStyle{FontSize: size, FontWeight: weight, Align: align},
		}}
	}
}

// TextStyled: the full style.
func TextStyled(content string, st *opendesignerv1.TextStyle) Opt {
	return func(n *opendesignerv1.Node) {
		n.Shape = &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{Content: content, Style: st}}
	}
}

func Image(hash string) Opt {
	return func(n *opendesignerv1.Node) {
		n.Shape = &opendesignerv1.Node_Image{Image: &opendesignerv1.ImageNode{AssetHash: hash}}
	}
}

// Vector: outlines given as a list of (closed, anchors...). An anchor is
// {x, y, inX, inY, outX, outY}.
type Anchor = opendesignerv1.Anchor

func Vector(subs ...*opendesignerv1.SubPath) Opt {
	return func(n *opendesignerv1.Node) {
		n.Shape = &opendesignerv1.Node_Vector{Vector: &opendesignerv1.VectorNode{Subpaths: subs}}
	}
}

func Sub(closed bool, anchors ...*opendesignerv1.Anchor) *opendesignerv1.SubPath {
	return &opendesignerv1.SubPath{Closed: closed, Anchors: anchors}
}

// Pt: an anchor with relative handles.
func Pt(x, y, inX, inY, outX, outY float64) *opendesignerv1.Anchor {
	return &opendesignerv1.Anchor{X: x, Y: y, InX: inX, InY: inY, OutX: outX, OutY: outY}
}

func Instance(componentID string, overrides ...*opendesignerv1.InstanceOverride) Opt {
	return func(n *opendesignerv1.Node) {
		n.Shape = &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: componentID, Overrides: overrides}}
	}
}

func OverrideFill(masterID string, p *opendesignerv1.Paint) *opendesignerv1.InstanceOverride {
	return &opendesignerv1.InstanceOverride{MasterNodeId: masterID, Fills: []*opendesignerv1.Paint{p}, FillsPresent: true}
}

func OverrideText(masterID, text string) *opendesignerv1.InstanceOverride {
	return &opendesignerv1.InstanceOverride{MasterNodeId: masterID, Text: text, TextPresent: true}
}

// StrokeOpt adds a stroke (more than one can be added).
func StrokeOpt(weight float64, align opendesignerv1.StrokeAlign, p *opendesignerv1.Paint) Opt {
	return func(n *opendesignerv1.Node) {
		n.Strokes = append(n.Strokes, &opendesignerv1.Stroke{Paint: p, Weight: weight, Align: align})
	}
}

const (
	Center  = opendesignerv1.StrokeAlign_STROKE_ALIGN_CENTER
	Inside  = opendesignerv1.StrokeAlign_STROKE_ALIGN_INSIDE
	Outside = opendesignerv1.StrokeAlign_STROKE_ALIGN_OUTSIDE

	AlignLeft   = opendesignerv1.TextAlign_TEXT_ALIGN_LEFT
	AlignCenter = opendesignerv1.TextAlign_TEXT_ALIGN_CENTER
	AlignRight  = opendesignerv1.TextAlign_TEXT_ALIGN_RIGHT
)

// Shadow and Blur add effects (they can be combined).
func Shadow(c *opendesignerv1.Color, dx, dy, blur float64) Opt {
	return func(n *opendesignerv1.Node) {
		n.Effects = append(n.Effects, &opendesignerv1.Effect{Kind: &opendesignerv1.Effect_DropShadow{DropShadow: &opendesignerv1.DropShadow{Color: c, OffsetX: dx, OffsetY: dy, Blur: blur}}})
	}
}

func Blur(radius float64) Opt {
	return func(n *opendesignerv1.Node) {
		n.Effects = append(n.Effects, &opendesignerv1.Effect{Kind: &opendesignerv1.Effect_LayerBlur{LayerBlur: &opendesignerv1.LayerBlur{Radius: radius}}})
	}
}

// Layout: an AutoLayout on one line.
func Layout(vertical bool, spacing, pl, pt, pr, pb float64, main, cross opendesignerv1.LayoutAlign, hugW, hugH bool) *opendesignerv1.AutoLayout {
	d := opendesignerv1.LayoutDirection_LAYOUT_DIRECTION_HORIZONTAL
	if vertical {
		d = opendesignerv1.LayoutDirection_LAYOUT_DIRECTION_VERTICAL
	}
	return &opendesignerv1.AutoLayout{
		Direction: d, Spacing: spacing, PaddingLeft: pl, PaddingTop: pt, PaddingRight: pr, PaddingBottom: pb,
		MainAlign: main, CrossAlign: cross, HugWidth: hugW, HugHeight: hugH,
	}
}

const (
	AStart   = opendesignerv1.LayoutAlign_LAYOUT_ALIGN_START
	ACenter  = opendesignerv1.LayoutAlign_LAYOUT_ALIGN_CENTER
	AEnd     = opendesignerv1.LayoutAlign_LAYOUT_ALIGN_END
	ABetween = opendesignerv1.LayoutAlign_LAYOUT_ALIGN_SPACE_BETWEEN
)

// Clip registers an animation clip (SetClip goes through the core: it also
// validates here that the references exist).
func (b *B) Clip(c *opendesignerv1.Clip) {
	b.must(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetClip{SetClip: &opendesignerv1.SetClip{Clip: c}}})
}

// KF: a keyframe (time in ms, value, easing).
func KF(t, v float64, easing string) *opendesignerv1.Keyframe {
	return &opendesignerv1.Keyframe{Time: t, Value: v, Easing: easing}
}

// Tr: a track (node, property) with its keyframes.
func Tr(node, prop string, kfs ...*opendesignerv1.Keyframe) *opendesignerv1.Track {
	return &opendesignerv1.Track{NodeId: node, Prop: prop, Keyframes: kfs}
}
