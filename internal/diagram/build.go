package diagram

import (
	"fmt"
	"math"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/google/uuid"
)

// build translates a Scene into document nodes: a root GROUP and, below it, a
// shape per Box, a text node per Text, a vector per Line and Poly. The
// children's coordinates are relative to the root, which whoever inserts positions.

type builder struct {
	rootID string
	nodes  []*opendesignerv1.Node
	n      int
}

func (b *builder) base(nm string, x, y, w, h float64) *opendesignerv1.Node {
	b.n++
	return &opendesignerv1.Node{
		Id:       uuid.NewString(),
		ParentId: b.rootID,
		OrderKey: fmt.Sprintf("%06d", b.n),
		Name:     nm,
		Visible:  true,
		Opacity:  1,
		X:        r2(x), Y: r2(y), Width: r2(w), Height: r2(h),
	}
}

func color(c RGB) *opendesignerv1.Color {
	return &opendesignerv1.Color{R: float32(c.R), G: float32(c.G), B: float32(c.B), A: 1}
}

func solid(c RGB) *opendesignerv1.Paint {
	return &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{Color: color(c)}}}
}

func stroke(c RGB, w float64) []*opendesignerv1.Stroke {
	return []*opendesignerv1.Stroke{{Paint: solid(c), Weight: w, Align: opendesignerv1.StrokeAlign_STROKE_ALIGN_CENTER}}
}

func fillOf(c *RGB) []*opendesignerv1.Paint {
	if c == nil {
		return nil
	}
	return []*opendesignerv1.Paint{solid(*c)}
}

func strokeOf(c *RGB, w float64) []*opendesignerv1.Stroke {
	if c == nil {
		return nil
	}
	if w <= 0 {
		w = 1.5
	}
	return stroke(*c, w)
}

// vector creates a vector node from the given subpaths in scene coordinates.
// Model rule: anchors are local to the node and the local bbox starts at
// (0,0), so everything is translated onto the minimum.
func (b *builder) vector(nm string, subs [][]Pt, closed bool) *opendesignerv1.Node {
	minX, minY := math.Inf(1), math.Inf(1)
	maxX, maxY := math.Inf(-1), math.Inf(-1)
	for _, s := range subs {
		for _, p := range s {
			minX, minY = math.Min(minX, p.X), math.Min(minY, p.Y)
			maxX, maxY = math.Max(maxX, p.X), math.Max(maxY, p.Y)
		}
	}
	n := b.base(nm, minX, minY, maxX-minX, maxY-minY)
	vn := &opendesignerv1.VectorNode{}
	for _, s := range subs {
		sp := &opendesignerv1.SubPath{Closed: closed}
		for _, p := range s {
			sp.Anchors = append(sp.Anchors, &opendesignerv1.Anchor{X: r2(p.X - minX), Y: r2(p.Y - minY)})
		}
		vn.Subpaths = append(vn.Subpaths, sp)
	}
	n.Shape = &opendesignerv1.Node_Vector{Vector: vn}
	return n
}

func (b *builder) add(n *opendesignerv1.Node) { b.nodes = append(b.nodes, n) }

func (b *builder) box(x Box) {
	switch x.Shape {
	case ShapeEllipse:
		n := b.base(orName(x.Name, "Ellipse"), x.X, x.Y, x.W, x.H)
		n.Shape = &opendesignerv1.Node_Ellipse{Ellipse: &opendesignerv1.EllipseNode{}}
		n.Fills, n.Strokes = fillOf(x.Fill), strokeOf(x.Stroke, x.StrokeW)
		b.add(n)
	case ShapeDiamond:
		cx, cy := x.X+x.W/2, x.Y+x.H/2
		pts := []Pt{{cx, x.Y}, {x.X + x.W, cy}, {cx, x.Y + x.H}, {x.X, cy}}
		n := b.vector(orName(x.Name, "Decision"), [][]Pt{pts}, true)
		n.Fills, n.Strokes = fillOf(x.Fill), strokeOf(x.Stroke, x.StrokeW)
		b.add(n)
	default:
		n := b.base(orName(x.Name, "Shape"), x.X, x.Y, x.W, x.H)
		r := x.Radius
		if x.Shape == ShapeStadium {
			r = x.H / 2
		}
		n.Shape = &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{CornerRadius: r2(r)}}
		n.Fills, n.Strokes = fillOf(x.Fill), strokeOf(x.Stroke, x.StrokeW)
		b.add(n)
	}
}

func orName(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

func (b *builder) text(t Text) {
	n := b.base(orName(t.Name, name("Text", t.Content)), t.X, t.Y, t.W, t.H)
	align := opendesignerv1.TextAlign_TEXT_ALIGN_CENTER
	switch t.Align {
	case "left":
		align = opendesignerv1.TextAlign_TEXT_ALIGN_LEFT
	case "right":
		align = opendesignerv1.TextAlign_TEXT_ALIGN_RIGHT
	}
	weight := "400"
	if t.Bold {
		weight = "700"
	}
	n.Shape = &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{Content: t.Content, Style: &opendesignerv1.TextStyle{
		FontFamily: "Inter", FontSize: t.Size, FontWeight: weight, LineHeight: lineMul, Align: align,
	}}}
	n.Fills = fillOf(rgb(t.Color))
	b.add(n)
}

func (b *builder) poly(p Poly) {
	n := b.vector(orName(p.Name, "Polygon"), [][]Pt{p.Pts}, true)
	n.Fills, n.Strokes = fillOf(p.Fill), strokeOf(p.Stroke, p.W)
	b.add(n)
}

// dashes splits a polyline into strokes of `dash` separated by `gap`, keeping the
// corners: the model has no dashing, so it is drawn by hand.
func dashes(pts []Pt, dash, gap float64) [][]Pt {
	var out [][]Pt
	var cur []Pt
	on := true
	left := dash
	for i := 1; i < len(pts); i++ {
		a, c := pts[i-1], pts[i]
		seg := math.Hypot(c.X-a.X, c.Y-a.Y)
		if seg == 0 {
			continue
		}
		pos := 0.0
		for pos < seg {
			step := math.Min(left, seg-pos)
			p0 := Pt{a.X + (c.X-a.X)*pos/seg, a.Y + (c.Y-a.Y)*pos/seg}
			p1 := Pt{a.X + (c.X-a.X)*(pos+step)/seg, a.Y + (c.Y-a.Y)*(pos+step)/seg}
			if on {
				if len(cur) == 0 {
					cur = append(cur, p0)
				}
				cur = append(cur, p1)
			}
			pos += step
			left -= step
			if left <= 1e-9 {
				if on && len(cur) > 1 {
					out = append(out, cur)
				}
				cur = nil
				on = !on
				if on {
					left = dash
				} else {
					left = gap
				}
			}
		}
	}
	if on && len(cur) > 1 {
		out = append(out, cur)
	}
	return out
}

// head computes the decoration at `tip` with travel direction `dir` (unit,
// toward the tip): how much to shorten the line, the open subpaths to
// add to the line and the closed polygon (if any) with its fill.
func head(kind HeadKind, tip Pt, dir Pt, weight float64) (shorten float64, open [][]Pt, closed []Pt, filled bool) {
	n := Pt{-dir.Y, dir.X}
	at := func(back, side float64) Pt {
		return Pt{tip.X - dir.X*back + n.X*side, tip.Y - dir.Y*back + n.Y*side}
	}
	k := 1.0
	if weight >= 3 {
		k = 1.3
	}
	switch kind {
	case HeadArrow:
		return 9 * k, nil, []Pt{tip, at(10*k, 4.6*k), at(10*k, -4.6*k)}, true
	case HeadOpen:
		return 0, [][]Pt{{at(10*k, 5*k), tip, at(10*k, -5*k)}}, nil, false
	case HeadTriangle:
		return 12, nil, []Pt{tip, at(13, 6.5), at(13, -6.5)}, false
	case HeadDiamond, HeadDiamondFilled:
		return 16, nil, []Pt{tip, at(8, 5.5), at(16, 0), at(8, -5.5)}, kind == HeadDiamondFilled
	case HeadCross:
		return 0, [][]Pt{{at(-5, 5), at(5, -5)}, {at(-5, -5), at(5, 5)}}, nil, false
	}
	return 0, nil, nil, false
}

func unit(a, b Pt) Pt {
	dx, dy := b.X-a.X, b.Y-a.Y
	l := math.Hypot(dx, dy)
	if l == 0 {
		return Pt{0, 1}
	}
	return Pt{dx / l, dy / l}
}

func (b *builder) line(l Line) {
	if len(l.Pts) < 2 {
		return
	}
	w := l.Weight
	if w <= 0 {
		w = 1.5
	}
	pts := append([]Pt(nil), l.Pts...)
	var subs [][]Pt
	type headPoly struct {
		pts    []Pt
		filled bool
	}
	var polys []headPoly
	apply := func(kind HeadKind, endIdx, prevIdx int) {
		if kind == HeadNone {
			return
		}
		tip := pts[endIdx]
		dir := unit(pts[prevIdx], tip)
		sh, open, closed, filled := head(kind, tip, dir, w)
		subs = append(subs, open...)
		if closed != nil {
			polys = append(polys, headPoly{closed, filled})
		}
		if seg := math.Hypot(tip.X-pts[prevIdx].X, tip.Y-pts[prevIdx].Y); sh > 0 && seg > sh {
			pts[endIdx] = Pt{tip.X - dir.X*sh, tip.Y - dir.Y*sh}
		}
	}
	last := len(pts) - 1
	apply(l.End, last, last-1)
	apply(l.Start, 0, 1)

	if l.Dashed {
		subs = append(dashes(pts, 6, 5), subs...)
	} else {
		subs = append([][]Pt{pts}, subs...)
	}
	n := b.vector(orName(l.Name, "Line"), subs, false)
	n.Strokes = stroke(l.Color, w)
	b.add(n)
	for _, hp := range polys {
		var fill *RGB
		if hp.filled {
			fill = rgb(l.Color)
		} else {
			fill = rgb(colWhite)
		}
		b.poly(Poly{Pts: hp.pts, Fill: fill, Stroke: rgb(l.Color), W: w, Name: "Tip"})
	}
}

// buildNodes transforms the scene into the document's nodes; the first is the root.
func buildNodes(sc *Scene, kind, source string) []*opendesignerv1.Node {
	root := &opendesignerv1.Node{
		Id:      uuid.NewString(),
		Name:    "Diagram",
		Visible: true, Opacity: 1,
		Width: r2(sc.W), Height: r2(sc.H),
		Shape: &opendesignerv1.Node_Group{Group: &opendesignerv1.GroupNode{}},
		Meta:  map[string]string{MetaKind: kind, MetaSource: source},
	}
	b := &builder{rootID: root.Id}
	for _, it := range sc.Items {
		switch x := it.(type) {
		case Box:
			b.box(x)
		case Text:
			b.text(x)
		case Line:
			b.line(x)
		case Poly:
			b.poly(x)
		}
	}
	return append([]*opendesignerv1.Node{root}, b.nodes...)
}
