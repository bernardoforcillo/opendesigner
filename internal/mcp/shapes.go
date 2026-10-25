package mcp

import (
	"context"
	"fmt"
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

// The shapes-and-paints tools (docs/shapes.md): polygons and stars, the parametric fields of set_properties
// (corner smoothing, independent radii, ellipse arcs and rings), strokes with arrowheads and per-side weights,
// and the shared paint / effect styles. The model and its validation live in internal/core/shapes.go and
// styles.go; the tools run the authority's validators where they can, so the error says what to fix.

const shapeConventions = " Parametric shapes: a polygon has 3..60 sides and a star 3..60 points with an innerRatio of 0.05..0.95 (both are inscribed in the box, the first vertex at the top); " +
	"an ellipse can be an arc / pie (arcStart in degrees, 0 = 3 o'clock and growing clockwise; arcSweep -360..360, 0 = full) or a ring (innerRatio 0..0.99)."

// ShapeView is the parametric part of a node, omitted for shapes that have none.
type ShapeView struct {
	Sides           int              `json:"sides,omitempty" jsonschema:"polygon"`
	Points          int              `json:"points,omitempty" jsonschema:"star"`
	InnerRatio      float64          `json:"innerRatio,omitempty" jsonschema:"star notch depth, or an ellipse ring's hole"`
	ArcStart        float64          `json:"arcStart,omitempty" jsonschema:"ellipse, degrees"`
	ArcSweep        float64          `json:"arcSweep,omitempty" jsonschema:"ellipse, degrees; absent = full"`
	CornerRadius    float64          `json:"cornerRadius,omitempty" jsonschema:"rectangle"`
	CornerSmoothing float64          `json:"cornerSmoothing,omitempty" jsonschema:"rectangle, 0..1"`
	CornerRadii     *CornerRadiiSpec `json:"cornerRadii,omitempty" jsonschema:"rectangle with independent corners"`
}

// CornerRadiiSpec is the four corner radii of a rectangle.
type CornerRadiiSpec struct {
	TopLeft     float64 `json:"topLeft"`
	TopRight    float64 `json:"topRight"`
	BottomRight float64 `json:"bottomRight"`
	BottomLeft  float64 `json:"bottomLeft"`
}

// shapeViewOf fills NodeView.Shape for the shapes that have parameters.
func shapeViewOf(n *opendesignerv1.Node) *ShapeView {
	switch s := n.GetShape().(type) {
	case *opendesignerv1.Node_Polygon:
		return &ShapeView{Sides: int(s.Polygon.GetSides())}
	case *opendesignerv1.Node_Star:
		return &ShapeView{Points: int(s.Star.GetPoints()), InnerRatio: s.Star.GetInnerRatio()}
	case *opendesignerv1.Node_Ellipse:
		e := s.Ellipse
		if e.GetArcStart() == 0 && e.GetArcSweep() == 0 && e.GetInnerRatio() == 0 {
			return nil
		}
		return &ShapeView{ArcStart: e.GetArcStart(), ArcSweep: e.GetArcSweep(), InnerRatio: e.GetInnerRatio()}
	case *opendesignerv1.Node_Rect:
		r := s.Rect
		if r.GetCornerSmoothing() == 0 && r.GetRadii() == nil {
			return nil
		}
		v := &ShapeView{CornerRadius: r.GetCornerRadius(), CornerSmoothing: r.GetCornerSmoothing()}
		if c := r.GetRadii(); c != nil {
			v.CornerRadii = &CornerRadiiSpec{TopLeft: c.GetTopLeft(), TopRight: c.GetTopRight(), BottomRight: c.GetBottomRight(), BottomLeft: c.GetBottomLeft()}
		}
		return v
	}
	return nil
}

// ---------------------------------------------------------------------------
// create_polygon / create_star
// ---------------------------------------------------------------------------

// CreatePolygonInput is create_polygon: the shape's box plus its side count.
type CreatePolygonInput struct {
	CreateShapeInput
	Sides int `json:"sides,omitempty" jsonschema:"3..60; default 6"`
}

// CreateStarInput is create_star.
type CreateStarInput struct {
	CreateShapeInput
	Points     int     `json:"points,omitempty" jsonschema:"3..60; default 5"`
	InnerRatio float64 `json:"innerRatio,omitempty" jsonschema:"0.05..0.95, the inner vertices' radius as a fraction of the outer; default 0.4"`
}

func (s *Session) CreatePolygon(ctx context.Context, in CreatePolygonInput) (CreateNodeOutput, error) {
	parent := s.resolveParent(in.ParentId)
	if parent == "" {
		return CreateNodeOutput{}, errNoParent
	}
	sides := in.Sides
	if sides == 0 {
		sides = 6
	}
	n := s.newBaseNode(parent, in.Name, in.X, in.Y, in.Width, in.Height)
	n.Shape = &opendesignerv1.Node_Polygon{Polygon: &opendesignerv1.PolygonNode{Sides: uint32(sides)}}
	if sides < core.MinPolygonSides || sides > core.MaxPolygonSides {
		return CreateNodeOutput{}, fmt.Errorf("create_polygon: sides must be %d..%d, got %d", core.MinPolygonSides, core.MaxPolygonSides, in.Sides)
	}
	return s.createNode(ctx, n)
}

func (s *Session) CreateStar(ctx context.Context, in CreateStarInput) (CreateNodeOutput, error) {
	parent := s.resolveParent(in.ParentId)
	if parent == "" {
		return CreateNodeOutput{}, errNoParent
	}
	points, ratio := in.Points, in.InnerRatio
	if points == 0 {
		points = 5
	}
	if ratio == 0 {
		ratio = 0.4
	}
	if points < core.MinPolygonSides || points > core.MaxPolygonSides {
		return CreateNodeOutput{}, fmt.Errorf("create_star: points must be %d..%d, got %d", core.MinPolygonSides, core.MaxPolygonSides, in.Points)
	}
	if ratio < core.MinStarRatio || ratio > core.MaxStarRatio {
		return CreateNodeOutput{}, fmt.Errorf("create_star: innerRatio must be %v..%v, got %v", core.MinStarRatio, core.MaxStarRatio, in.InnerRatio)
	}
	n := s.newBaseNode(parent, in.Name, in.X, in.Y, in.Width, in.Height)
	n.Shape = &opendesignerv1.Node_Star{Star: &opendesignerv1.StarNode{Points: uint32(points), InnerRatio: ratio}}
	return s.createNode(ctx, n)
}

// ---------------------------------------------------------------------------
// the parametric fields of set_properties
// ---------------------------------------------------------------------------

// ShapeFields are the parametric inputs shared by set_properties; each is valid only on the shape that owns it.
type ShapeFields struct {
	CornerSmoothing *float64         `json:"cornerSmoothing,omitempty" jsonschema:"rectangles only, 0..1: 0 = circular corners, 1 = fully smoothed (squircle)"`
	CornerRadii     *CornerRadiiSpec `json:"cornerRadii,omitempty" jsonschema:"rectangles only: independent radii for the four corners (replaces cornerRadius)"`
	UniformCorners  *bool            `json:"uniformCorners,omitempty" jsonschema:"rectangles only: true removes the independent radii"`
	ArcStart        *float64         `json:"arcStart,omitempty" jsonschema:"ellipses only: start angle in degrees (0 = 3 o'clock, clockwise)"`
	ArcSweep        *float64         `json:"arcSweep,omitempty" jsonschema:"ellipses only: sweep in degrees, -360..360; 0 = the full ellipse"`
	InnerRatio      *float64         `json:"innerRatio,omitempty" jsonschema:"ellipses: the ring's hole as a fraction of the radius, 0..0.99; stars: inner/outer radius, 0.05..0.95"`
	Sides           *int             `json:"sides,omitempty" jsonschema:"polygons only, 3..60"`
	Points          *int             `json:"points,omitempty" jsonschema:"stars only, 3..60"`
}

func (f ShapeFields) any() bool {
	return f.CornerSmoothing != nil || f.CornerRadii != nil || f.UniformCorners != nil || f.ArcStart != nil || f.ArcSweep != nil ||
		f.InnerRatio != nil || f.Sides != nil || f.Points != nil
}

// addShapeFields writes the parametric fields into a set_properties patch (and its mask), checking the node's shape.
func (s *Session) addShapeFields(id string, f ShapeFields, patch *opendesignerv1.Node, paths *[]string) error {
	if !f.any() {
		return nil
	}
	s.mu.Lock()
	n, ok := s.doc.GetNodes()[id]
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("set_properties: node %q not found", id)
	}
	wrong := func(field, shape string) error {
		return fmt.Errorf("set_properties: %s only applies to %s, but node %q is a %s", field, shape, id, nodeKind(n))
	}
	switch n.GetShape().(type) {
	case nil, *opendesignerv1.Node_Rect:
		if f.ArcStart != nil || f.ArcSweep != nil || f.Sides != nil || f.Points != nil || f.InnerRatio != nil {
			return wrong("arcStart / arcSweep / innerRatio / sides / points", "ellipses, polygons and stars")
		}
		rect := patch.GetRect()
		if rect == nil {
			rect = &opendesignerv1.RectNode{}
			patch.Shape = &opendesignerv1.Node_Rect{Rect: rect}
		}
		if f.CornerSmoothing != nil {
			rect.CornerSmoothing = *f.CornerSmoothing
			*paths = append(*paths, "corner_smoothing")
		}
		if f.CornerRadii != nil {
			c := f.CornerRadii
			rect.Radii = &opendesignerv1.CornerRadii{TopLeft: c.TopLeft, TopRight: c.TopRight, BottomRight: c.BottomRight, BottomLeft: c.BottomLeft}
			*paths = append(*paths, "radii")
		} else if f.UniformCorners != nil && *f.UniformCorners {
			*paths = append(*paths, "radii")
		}
	case *opendesignerv1.Node_Ellipse:
		if f.CornerSmoothing != nil || f.CornerRadii != nil || f.UniformCorners != nil {
			return wrong("cornerSmoothing / cornerRadii", "rectangles")
		}
		if f.Sides != nil || f.Points != nil {
			return wrong("sides / points", "polygons and stars")
		}
		e := &opendesignerv1.EllipseNode{}
		patch.Shape = &opendesignerv1.Node_Ellipse{Ellipse: e}
		if f.ArcStart != nil {
			e.ArcStart = *f.ArcStart
			*paths = append(*paths, "arc_start")
		}
		if f.ArcSweep != nil {
			e.ArcSweep = *f.ArcSweep
			*paths = append(*paths, "arc_sweep")
		}
		if f.InnerRatio != nil {
			e.InnerRatio = *f.InnerRatio
			*paths = append(*paths, "inner_ratio")
		}
	case *opendesignerv1.Node_Polygon:
		if f.Sides == nil || f.CornerSmoothing != nil || f.CornerRadii != nil || f.ArcStart != nil || f.ArcSweep != nil || f.InnerRatio != nil || f.Points != nil {
			return wrong("anything but sides", "polygons")
		}
		patch.Shape = &opendesignerv1.Node_Polygon{Polygon: &opendesignerv1.PolygonNode{Sides: uint32(*f.Sides)}}
		*paths = append(*paths, "sides")
	case *opendesignerv1.Node_Star:
		if f.CornerSmoothing != nil || f.CornerRadii != nil || f.ArcStart != nil || f.ArcSweep != nil || f.Sides != nil {
			return wrong("anything but points / innerRatio", "stars")
		}
		st := &opendesignerv1.StarNode{}
		patch.Shape = &opendesignerv1.Node_Star{Star: st}
		if f.Points != nil {
			st.Points = uint32(*f.Points)
			*paths = append(*paths, "points")
		}
		if f.InnerRatio != nil {
			st.InnerRatio = *f.InnerRatio
			*paths = append(*paths, "inner_ratio")
		}
	default:
		return wrong("the parametric fields", "rectangles, ellipses, polygons and stars")
	}
	return nil
}

// ---------------------------------------------------------------------------
// set_stroke
// ---------------------------------------------------------------------------

// StrokeSidesSpec is a stroke's per-side weights (rectangles and frames).
type StrokeSidesSpec struct {
	Top    float64 `json:"top"`
	Right  float64 `json:"right"`
	Bottom float64 `json:"bottom"`
	Left   float64 `json:"left"`
}

// StrokeSpec is one stroke of a node.
type StrokeSpec struct {
	Color    RGBA             `json:"color" jsonschema:"a solid {r,g,b,a} or {gradient:{...}} like a fill"`
	Weight   float64          `json:"weight" jsonschema:"non-negative, in world units; with sides it is kept at the widest side"`
	Align    string           `json:"align,omitempty" jsonschema:"center (default) | inside | outside"`
	StartCap string           `json:"startCap,omitempty" jsonschema:"arrowhead at the first end of an open path: none | arrow | triangle | circle | square | diamond"`
	EndCap   string           `json:"endCap,omitempty" jsonschema:"arrowhead at the last end of an open path"`
	Sides    *StrokeSidesSpec `json:"sides,omitempty" jsonschema:"per-side weights, rectangles and frames only (replaces weight on the four sides)"`
	// WidthPreset / WidthProfile: a variable-width stroke on a vector (widthprofile.go).
	WidthPreset  string           `json:"widthPreset,omitempty" jsonschema:"variable width preset: uniform | taper | taper-start | lens | bulge | pinch | brush"`
	WidthProfile []WidthPointSpec `json:"widthProfile,omitempty" jsonschema:"explicit variable-width points (at most 64, positions 0..1 not decreasing); wins over widthPreset"`
}

// SetStrokeInput replaces a node's whole stroke list.
type SetStrokeInput struct {
	Id      string       `json:"id"`
	Strokes []StrokeSpec `json:"strokes" jsonschema:"replaces the whole stroke list; [] removes the strokes"`
}

var arrowHeads = map[string]opendesignerv1.ArrowHead{
	"": opendesignerv1.ArrowHead_ARROW_HEAD_NONE, "none": opendesignerv1.ArrowHead_ARROW_HEAD_NONE,
	"arrow": opendesignerv1.ArrowHead_ARROW_HEAD_ARROW, "triangle": opendesignerv1.ArrowHead_ARROW_HEAD_TRIANGLE,
	"circle": opendesignerv1.ArrowHead_ARROW_HEAD_CIRCLE, "square": opendesignerv1.ArrowHead_ARROW_HEAD_SQUARE,
	"diamond": opendesignerv1.ArrowHead_ARROW_HEAD_DIAMOND,
}

func arrowHeadName(h opendesignerv1.ArrowHead) string {
	for name, v := range arrowHeads {
		if v == h && name != "" && name != "none" {
			return name
		}
	}
	return ""
}

func toStrokes(specs []StrokeSpec) ([]*opendesignerv1.Stroke, error) {
	out := make([]*opendesignerv1.Stroke, 0, len(specs))
	for i, sp := range specs {
		if err := validateFills([]RGBA{sp.Color}); err != nil {
			return nil, fmt.Errorf("strokes[%d]: %w", i, err)
		}
		if !(sp.Weight >= 0) {
			return nil, fmt.Errorf("strokes[%d].weight must be >= 0", i)
		}
		align := opendesignerv1.StrokeAlign_STROKE_ALIGN_CENTER
		switch sp.Align {
		case "", "center":
		case "inside":
			align = opendesignerv1.StrokeAlign_STROKE_ALIGN_INSIDE
		case "outside":
			align = opendesignerv1.StrokeAlign_STROKE_ALIGN_OUTSIDE
		default:
			return nil, fmt.Errorf("strokes[%d].align must be center, inside or outside, got %q", i, sp.Align)
		}
		start, okS := arrowHeads[sp.StartCap]
		end, okE := arrowHeads[sp.EndCap]
		if !okS || !okE {
			return nil, fmt.Errorf("strokes[%d]: startCap / endCap must be none, arrow, triangle, circle, square or diamond", i)
		}
		st := &opendesignerv1.Stroke{Paint: toPaints([]RGBA{sp.Color})[0], Weight: sp.Weight, Align: align, StartCap: start, EndCap: end}
		if sp.Sides != nil {
			st.Sides = &opendesignerv1.StrokeSides{Top: sp.Sides.Top, Right: sp.Sides.Right, Bottom: sp.Sides.Bottom, Left: sp.Sides.Left}
			if m := maxFloat(sp.Sides.Top, sp.Sides.Right, sp.Sides.Bottom, sp.Sides.Left); sp.Weight < m {
				st.Weight = m // the weight follows the widest side, so everything that only checks `weight > 0` still sees the stroke
			}
		}
		profile, err := widthProfileOf(sp)
		if err != nil {
			return nil, fmt.Errorf("strokes[%d]: %w", i, err)
		}
		st.WidthProfile = profile
		out = append(out, st)
	}
	if err := core.ValidateStrokes(out); err != nil {
		return nil, err
	}
	return out, nil
}

func maxFloat(first float64, rest ...float64) float64 {
	m := first
	for _, v := range rest {
		if v > m {
			m = v
		}
	}
	return m
}

// SetStroke replaces a node's strokes.
func (s *Session) SetStroke(ctx context.Context, in SetStrokeInput) (SeqOutput, error) {
	strokes, err := toStrokes(in.Strokes)
	if err != nil {
		return SeqOutput{}, fmt.Errorf("set_stroke: %w", err)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: in.Id, Patch: &opendesignerv1.Node{Strokes: strokes}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"strokes"}},
	}}})
	if err != nil {
		return SeqOutput{}, err
	}
	return SeqOutput{Seq: seq}, nil
}

// ---------------------------------------------------------------------------
// paint and effect styles
// ---------------------------------------------------------------------------

const styleConventions = " Shared styles: a PAINT STYLE is a named list of paints (a fills list) and an EFFECT STYLE a named list of effects. A node that applies one is drawn with the style's values " +
	"(its own fills / strokes / effects stay as the fallback); editing a style changes every node that uses it; deleting one detaches the nodes. A stroke that uses a paint style takes the paint at its own index and keeps its weight and alignment."

// PaintStyleBody is a paint style's content.
type PaintStyleBody struct {
	Name   string `json:"name" jsonschema:"e.g. Brand / Primary"`
	Paints []RGBA `json:"paints" jsonschema:"at least one solid or gradient, like a fills list"`
}

// PaintStyleView is a listed paint style.
type PaintStyleView struct {
	Id string `json:"id"`
	PaintStyleBody
}

// EffectStyleBody is an effect style's content.
type EffectStyleBody struct {
	Name    string       `json:"name"`
	Effects []EffectSpec `json:"effects"`
}

// EffectStyleView is a listed effect style.
type EffectStyleView struct {
	Id string `json:"id"`
	EffectStyleBody
}

type ListPaintStylesOutput struct {
	PaintStyles []PaintStyleView `json:"paintStyles"`
}

type ListEffectStylesOutput struct {
	EffectStyles []EffectStyleView `json:"effectStyles"`
}

func colorSpec(c *opendesignerv1.Color) StopColor {
	return StopColor{R: float64(c.GetR()), G: float64(c.GetG()), B: float64(c.GetB()), A: float64(c.GetA())}
}

func gradientSpec(kind string, g *opendesignerv1.GradientPaint) *GradientSpec {
	spec := &GradientSpec{Kind: kind, X1: g.GetX1(), Y1: g.GetY1(), X2: g.GetX2(), Y2: g.GetY2()}
	for _, st := range g.GetStops() {
		spec.Stops = append(spec.Stops, GradientStopSpec{Color: colorSpec(st.GetColor()), Position: st.GetPosition()})
	}
	return spec
}

// paintSpecs is the reverse of toPaints for the paints a tool can write (solid and gradients); image and mesh
// paints are left out of the listing (they are made in the editor).
func paintSpecs(paints []*opendesignerv1.Paint) []RGBA {
	out := make([]RGBA, 0, len(paints))
	for _, p := range paints {
		switch k := p.GetKind().(type) {
		case *opendesignerv1.Paint_Solid:
			c := colorSpec(k.Solid.GetColor())
			out = append(out, RGBA{R: c.R, G: c.G, B: c.B, A: c.A})
		case *opendesignerv1.Paint_Linear:
			out = append(out, RGBA{Gradient: gradientSpec("linear", k.Linear)})
		case *opendesignerv1.Paint_Radial:
			out = append(out, RGBA{Gradient: gradientSpec("radial", k.Radial)})
		case *opendesignerv1.Paint_Angular:
			out = append(out, RGBA{Gradient: gradientSpec("angular", k.Angular)})
		case *opendesignerv1.Paint_Diamond:
			out = append(out, RGBA{Gradient: gradientSpec("diamond", k.Diamond)})
		}
	}
	return out
}

func effectSpecs(effects []*opendesignerv1.Effect) []EffectSpec {
	out := make([]EffectSpec, 0, len(effects))
	for _, e := range effects {
		switch k := e.GetKind().(type) {
		case *opendesignerv1.Effect_DropShadow:
			d := k.DropShadow
			out = append(out, EffectSpec{Kind: "dropShadow", Color: colorSpec(d.GetColor()), OffsetX: d.GetOffsetX(), OffsetY: d.GetOffsetY(), Blur: d.GetBlur()})
		case *opendesignerv1.Effect_InnerShadow:
			d := k.InnerShadow
			out = append(out, EffectSpec{Kind: "innerShadow", Color: colorSpec(d.GetColor()), OffsetX: d.GetOffsetX(), OffsetY: d.GetOffsetY(), Blur: d.GetBlur()})
		case *opendesignerv1.Effect_LayerBlur:
			out = append(out, EffectSpec{Kind: "layerBlur", Radius: k.LayerBlur.GetRadius()})
		case *opendesignerv1.Effect_BackgroundBlur:
			out = append(out, EffectSpec{Kind: "backgroundBlur", Radius: k.BackgroundBlur.GetRadius()})
		}
	}
	return out
}

func (s *Session) ListPaintStyles(_ context.Context, _ struct{}) (ListPaintStylesOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := ListPaintStylesOutput{PaintStyles: []PaintStyleView{}}
	for id, d := range s.doc.GetPaintStyles() {
		out.PaintStyles = append(out.PaintStyles, PaintStyleView{Id: id, PaintStyleBody: PaintStyleBody{Name: d.GetName(), Paints: paintSpecs(d.GetPaints())}})
	}
	sort.Slice(out.PaintStyles, func(i, j int) bool {
		a, b := out.PaintStyles[i], out.PaintStyles[j]
		return a.Name < b.Name || (a.Name == b.Name && a.Id < b.Id)
	})
	return out, nil
}

func (s *Session) ListEffectStyles(_ context.Context, _ struct{}) (ListEffectStylesOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := ListEffectStylesOutput{EffectStyles: []EffectStyleView{}}
	for id, d := range s.doc.GetEffectStyles() {
		out.EffectStyles = append(out.EffectStyles, EffectStyleView{Id: id, EffectStyleBody: EffectStyleBody{Name: d.GetName(), Effects: effectSpecs(d.GetEffects())}})
	}
	sort.Slice(out.EffectStyles, func(i, j int) bool {
		a, b := out.EffectStyles[i], out.EffectStyles[j]
		return a.Name < b.Name || (a.Name == b.Name && a.Id < b.Id)
	})
	return out, nil
}

// SetPaintStyleInput creates a paint style (omit id) or replaces one.
type SetPaintStyleInput struct {
	Id string `json:"id,omitempty" jsonschema:"id of an existing paint style to REPLACE; omit to create a new one"`
	PaintStyleBody
}

// StyleOutput is the result of set_paint_style / set_effect_style.
type StyleOutput struct {
	StyleId string `json:"styleId"`
	Seq     uint64 `json:"seq"`
}

func (s *Session) SetPaintStyle(ctx context.Context, in SetPaintStyleInput) (StyleOutput, error) {
	id := in.Id
	s.mu.Lock()
	if id == "" {
		id = uuid.NewString()
	} else if _, ok := s.doc.GetPaintStyles()[id]; !ok {
		s.mu.Unlock()
		return StyleOutput{}, fmt.Errorf("set_paint_style: paint style %q not found (omit id to create one; list_paint_styles for the ids)", id)
	}
	s.mu.Unlock()
	if err := validateFills(in.Paints); err != nil {
		return StyleOutput{}, fmt.Errorf("set_paint_style: %w", err)
	}
	def := &opendesignerv1.PaintStyleDef{Id: id, Name: in.Name, Paints: toPaints(in.Paints)}
	if err := core.ValidatePaintStyleDef(def); err != nil {
		return StyleOutput{}, fmt.Errorf("set_paint_style: %w", err)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetPaintStyleDef{SetPaintStyleDef: &opendesignerv1.SetPaintStyleDef{PaintStyle: def}}})
	if err != nil {
		return StyleOutput{}, err
	}
	return StyleOutput{StyleId: id, Seq: seq}, nil
}

// SetEffectStyleInput creates an effect style (omit id) or replaces one.
type SetEffectStyleInput struct {
	Id string `json:"id,omitempty" jsonschema:"id of an existing effect style to REPLACE; omit to create a new one"`
	EffectStyleBody
}

func (s *Session) SetEffectStyle(ctx context.Context, in SetEffectStyleInput) (StyleOutput, error) {
	id := in.Id
	s.mu.Lock()
	if id == "" {
		id = uuid.NewString()
	} else if _, ok := s.doc.GetEffectStyles()[id]; !ok {
		s.mu.Unlock()
		return StyleOutput{}, fmt.Errorf("set_effect_style: effect style %q not found (omit id to create one; list_effect_styles for the ids)", id)
	}
	s.mu.Unlock()
	if err := validateEffects(in.Effects); err != nil {
		return StyleOutput{}, fmt.Errorf("set_effect_style: %w", err)
	}
	def := &opendesignerv1.EffectStyleDef{Id: id, Name: in.Name, Effects: toEffects(in.Effects)}
	if err := core.ValidateEffectStyleDef(def); err != nil {
		return StyleOutput{}, fmt.Errorf("set_effect_style: %w", err)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetEffectStyleDef{SetEffectStyleDef: &opendesignerv1.SetEffectStyleDef{EffectStyle: def}}})
	if err != nil {
		return StyleOutput{}, err
	}
	return StyleOutput{StyleId: id, Seq: seq}, nil
}

func (s *Session) DeletePaintStyle(ctx context.Context, in IdInput) (SeqOutput, error) {
	s.mu.Lock()
	_, ok := s.doc.GetPaintStyles()[in.Id]
	s.mu.Unlock()
	if !ok {
		return SeqOutput{}, fmt.Errorf("delete_paint_style: paint style %q not found (list_paint_styles for the ids)", in.Id)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeletePaintStyleDef{DeletePaintStyleDef: &opendesignerv1.DeletePaintStyleDef{Id: in.Id}}})
	return SeqOutput{Seq: seq}, err
}

func (s *Session) DeleteEffectStyle(ctx context.Context, in IdInput) (SeqOutput, error) {
	s.mu.Lock()
	_, ok := s.doc.GetEffectStyles()[in.Id]
	s.mu.Unlock()
	if !ok {
		return SeqOutput{}, fmt.Errorf("delete_effect_style: effect style %q not found (list_effect_styles for the ids)", in.Id)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteEffectStyleDef{DeleteEffectStyleDef: &opendesignerv1.DeleteEffectStyleDef{Id: in.Id}}})
	return SeqOutput{Seq: seq}, err
}

// ApplyPaintStyleInput applies a paint style to the fills or the strokes of nodes.
type ApplyPaintStyleInput struct {
	NodeIds []string `json:"nodeIds"`
	Target  string   `json:"target" jsonschema:"fill | stroke"`
	StyleId string   `json:"styleId,omitempty" jsonschema:"the paint style to apply; empty detaches (the node falls back to its own paints)"`
}

func (s *Session) ApplyPaintStyle(ctx context.Context, in ApplyPaintStyleInput) (NodesOutput, error) {
	path := ""
	switch in.Target {
	case "fill":
		path = "fill_style_id"
	case "stroke":
		path = "stroke_style_id"
	default:
		return NodesOutput{}, fmt.Errorf("apply_paint_style: target must be fill or stroke, got %q", in.Target)
	}
	return s.applyStyleID(ctx, "apply_paint_style", in.NodeIds, path, in.StyleId, func(doc *opendesignerv1.Document) bool {
		_, ok := doc.GetPaintStyles()[in.StyleId]
		return ok
	})
}

// ApplyEffectStyleInput applies an effect style to nodes.
type ApplyEffectStyleInput struct {
	NodeIds []string `json:"nodeIds"`
	StyleId string   `json:"styleId,omitempty" jsonschema:"the effect style to apply; empty detaches (the node falls back to its own effects)"`
}

func (s *Session) ApplyEffectStyle(ctx context.Context, in ApplyEffectStyleInput) (NodesOutput, error) {
	return s.applyStyleID(ctx, "apply_effect_style", in.NodeIds, "effect_style_id", in.StyleId, func(doc *opendesignerv1.Document) bool {
		_, ok := doc.GetEffectStyles()[in.StyleId]
		return ok
	})
}

// applyStyleID writes one of the three style-id mask paths on every node that does not already have it.
func (s *Session) applyStyleID(ctx context.Context, tool string, nodeIDs []string, path, styleID string, exists func(*opendesignerv1.Document) bool) (NodesOutput, error) {
	if len(nodeIDs) == 0 {
		return NodesOutput{}, fmt.Errorf("%s: nodeIds is empty", tool)
	}
	patch := &opendesignerv1.Node{}
	has := func(n *opendesignerv1.Node) bool { return false }
	switch path {
	case "fill_style_id":
		patch.FillStyleId = styleID
		has = func(n *opendesignerv1.Node) bool { return n.GetFillStyleId() == styleID }
	case "stroke_style_id":
		patch.StrokeStyleId = styleID
		has = func(n *opendesignerv1.Node) bool { return n.GetStrokeStyleId() == styleID }
	default:
		patch.EffectStyleId = styleID
		has = func(n *opendesignerv1.Node) bool { return n.GetEffectStyleId() == styleID }
	}
	s.mu.Lock()
	for _, id := range nodeIDs {
		if _, ok := s.doc.GetNodes()[id]; !ok {
			s.mu.Unlock()
			return NodesOutput{}, fmt.Errorf("%s: node %q not found (list_nodes for the ids)", tool, id)
		}
	}
	if styleID != "" && !exists(s.doc) {
		s.mu.Unlock()
		return NodesOutput{}, fmt.Errorf("%s: style %q not found (list the styles for the ids)", tool, styleID)
	}
	var todo []string
	for _, id := range nodeIDs {
		if !has(s.doc.GetNodes()[id]) {
			todo = append(todo, id)
		}
	}
	s.mu.Unlock()
	out := NodesOutput{}
	for _, id := range todo {
		seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
			Id: id, Patch: patch, Mask: &fieldmaskpb.FieldMask{Paths: []string{path}},
		}}})
		if err != nil {
			return out, err
		}
		out.Changed++
		out.Seq = seq
	}
	return out, nil
}

func registerShapeTools(srv *mcp.Server, s *Session) {
	addTool(srv, "create_polygon", "Create a regular polygon node (3..60 sides; default 6). parentId defaults to the first page. Returns the new node id."+shapeConventions, s.CreatePolygon)
	addTool(srv, "create_star", "Create a star node (3..60 points, innerRatio 0.05..0.95). parentId defaults to the first page. Returns the new node id."+shapeConventions, s.CreateStar)
	addTool(srv, "set_stroke", "Replace a node's strokes. Each stroke: color (solid or gradient), weight, align (center|inside|outside), startCap / endCap arrowheads (none|arrow|triangle|circle|square|diamond; open vector paths only, the tip sits on the end point), and sides for per-side weights {top,right,bottom,left} on rectangles and frames, and widthPreset (taper|taper-start|lens|bulge|pinch|brush) or widthProfile [{position,left,right}] for a variable-width stroke on a vector (left / right are half-widths as multiples of weight/2).", s.SetStroke)
	addTool(srv, "list_paint_styles", "List the document's shared paint styles."+styleConventions, s.ListPaintStyles)
	addTool(srv, "set_paint_style", "Create a paint style (omit id) or REPLACE one entirely (read it with list_paint_styles, edit, send it all back)."+styleConventions, s.SetPaintStyle)
	addTool(srv, "delete_paint_style", "Delete a paint style; the nodes that used it keep their own paints.", s.DeletePaintStyle)
	addTool(srv, "apply_paint_style", "Apply a shared paint style to the fills or the strokes of nodes, or detach it (empty styleId)."+styleConventions, s.ApplyPaintStyle)
	addTool(srv, "list_effect_styles", "List the document's shared effect styles."+styleConventions, s.ListEffectStyles)
	addTool(srv, "set_effect_style", "Create an effect style (omit id) or REPLACE one entirely."+styleConventions, s.SetEffectStyle)
	addTool(srv, "delete_effect_style", "Delete an effect style; the nodes that used it keep their own effects.", s.DeleteEffectStyle)
	addTool(srv, "apply_effect_style", "Apply a shared effect style to nodes, or detach it (empty styleId)."+styleConventions, s.ApplyEffectStyle)
}
