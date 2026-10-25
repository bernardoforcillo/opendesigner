package codegen

import (
	"fmt"
	"math"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
)

// THE PARAMETRIC SHAPES IN CODE (docs/shapes.md). A polygon, a star, an ellipse arc / ring and a rectangle with
// smoothed or independent corners have no CSS box that draws them exactly, so the export writes each as an
// inline <svg> path, like a vector node: the outline is computed here (the Go twin of
// web/src/renderer/shapeGeometry.ts -- same construction, same numbers) and turned into a synthetic vector the
// vector writer already knows how to fill and stroke. The arrowheads of open paths (web/src/renderer/arrowheads.ts)
// are drawn the same way, after the stroke.

type cmd struct {
	op byte // 'M', 'L', 'C' or 'Z'
	v  [6]float64
}

func mv(x, y float64) cmd             { return cmd{op: 'M', v: [6]float64{x, y}} }
func ln(x, y float64) cmd             { return cmd{op: 'L', v: [6]float64{x, y}} }
func cu(a, b, c, d, e, f float64) cmd { return cmd{op: 'C', v: [6]float64{a, b, c, d, e, f}} }
func closePath() cmd                  { return cmd{op: 'Z'} }
func polylineCmds(pts [][2]float64) []cmd {
	out := []cmd{mv(pts[0][0], pts[0][1])}
	for _, p := range pts[1:] {
		out = append(out, ln(p[0], p[1]))
	}
	return append(out, closePath())
}

const deg = math.Pi / 180

// computedCmds is the outline of a node whose shape is one of the computed ones, in the node's local space, or nil
// for a plain rectangle / ellipse / anything else.
func computedCmds(n *opendesignerv1.Node) []cmd {
	w, h := n.GetWidth(), n.GetHeight()
	switch s := n.GetShape().(type) {
	case *opendesignerv1.Node_Polygon:
		return polylineCmds(ellipseVertices(w, h, int(s.Polygon.GetSides()), 1, 1))
	case *opendesignerv1.Node_Star:
		pts := int(s.Star.GetPoints())
		return polylineCmds(starVertices(w, h, pts, s.Star.GetInnerRatio()))
	case *opendesignerv1.Node_Ellipse:
		e := s.Ellipse
		sweep := e.GetArcSweep()
		full := sweep == 0 || math.Abs(sweep) >= 360
		if full && e.GetInnerRatio() <= 0 {
			return nil
		}
		return arcCmds(w, h, e.GetArcStart(), sweep, e.GetInnerRatio())
	case *opendesignerv1.Node_Rect:
		r := s.Rect
		if r.GetCornerSmoothing() <= 0 && r.GetRadii() == nil {
			return nil
		}
		return roundedRectCmds(w, h, r)
	}
	return nil
}

func ellipseVertices(w, h float64, sides int, outer, _ float64) [][2]float64 {
	pts := make([][2]float64, sides)
	for i := range pts {
		a := -math.Pi/2 + float64(i)*2*math.Pi/float64(sides)
		pts[i] = [2]float64{w/2 + w/2*outer*math.Cos(a), h/2 + h/2*outer*math.Sin(a)}
	}
	return pts
}

func starVertices(w, h float64, points int, ratio float64) [][2]float64 {
	pts := make([][2]float64, points*2)
	for i := range pts {
		k := 1.0
		if i%2 == 1 {
			k = ratio
		}
		a := -math.Pi/2 + float64(i)*math.Pi/float64(points)
		pts[i] = [2]float64{w/2 + w/2*k*math.Cos(a), h/2 + h/2*k*math.Sin(a)}
	}
	return pts
}

// arcSegs: cubic segments of the elliptical arc a0 -> a1 (radians), at most 90 degrees each.
func arcSegs(cx, cy, rx, ry, a0, a1 float64) []cmd {
	count := int(math.Max(1, math.Ceil(math.Abs(a1-a0)/(math.Pi/2)-1e-9)))
	step := (a1 - a0) / float64(count)
	k := 4.0 / 3 * math.Tan(step/4)
	out := make([]cmd, 0, count)
	for i := 0; i < count; i++ {
		s := a0 + float64(i)*step
		e := s + step
		cs, sn, ce, se := math.Cos(s), math.Sin(s), math.Cos(e), math.Sin(e)
		out = append(out, cu(
			cx+rx*(cs-k*sn), cy+ry*(sn+k*cs),
			cx+rx*(ce+k*se), cy+ry*(se-k*ce),
			cx+rx*ce, cy+ry*se))
	}
	return out
}

func arcCmds(w, h, startDeg, sweepDeg, ratio float64) []cmd {
	cx, cy, rx, ry := w/2, h/2, w/2, h/2
	ratio = math.Min(0.99, math.Max(0, ratio))
	full := sweepDeg == 0 || math.Abs(sweepDeg) >= 360
	a0 := startDeg * deg
	a1 := a0 + 2*math.Pi
	if !full {
		a1 = a0 + sweepDeg*deg
	}
	at := func(a, k float64) (float64, float64) { return cx + rx*k*math.Cos(a), cy + ry*k*math.Sin(a) }
	sx, sy := at(a0, 1)
	out := []cmd{mv(sx, sy)}
	if full {
		out = append(out, arcSegs(cx, cy, rx, ry, a0, a1)...)
		out = append(out, closePath())
		ix, iy := at(a0, ratio)
		out = append(out, mv(ix, iy))
		out = append(out, arcSegs(cx, cy, rx*ratio, ry*ratio, a0, a0-2*math.Pi)...)
		return append(out, closePath())
	}
	out = append(out, arcSegs(cx, cy, rx, ry, a0, a1)...)
	if ratio > 0 {
		ex, ey := at(a1, ratio)
		out = append(out, ln(ex, ey))
		out = append(out, arcSegs(cx, cy, rx*ratio, ry*ratio, a1, a0)...)
	} else {
		out = append(out, ln(cx, cy))
	}
	return append(out, closePath())
}

// clampedRadii: the four radii [tl, tr, br, bl], scaled down together so neighbours fit along each side.
func clampedRadii(w, h float64, r *opendesignerv1.RectNode) [4]float64 {
	var rad [4]float64
	if c := r.GetRadii(); c != nil {
		rad = [4]float64{c.GetTopLeft(), c.GetTopRight(), c.GetBottomRight(), c.GetBottomLeft()}
	} else {
		rad = [4]float64{r.GetCornerRadius(), r.GetCornerRadius(), r.GetCornerRadius(), r.GetCornerRadius()}
	}
	for i := range rad {
		rad[i] = math.Max(0, rad[i])
	}
	f := 1.0
	for _, p := range [4][2]float64{{rad[0] + rad[1], w}, {rad[1] + rad[2], h}, {rad[2] + rad[3], w}, {rad[3] + rad[0], h}} {
		if p[0] > p[1] && p[0] > 0 {
			f = math.Min(f, p[1]/p[0])
		}
	}
	for i := range rad {
		rad[i] *= f
	}
	return rad
}

// cornerLocal: one corner in its own frame (vertex at 0,0, the top edge arriving along -x, the right edge leaving
// along +y). Returns how far the curve reaches along the edges and its three cubic segments.
func cornerLocal(r, s, budget float64) (float64, [3][6]float64) {
	smooth := s
	p := (1 + smooth) * r
	room := math.Max(r, budget)
	if p > room {
		smooth = math.Max(0, room/r-1)
		p = math.Min(p, room)
	}
	arcMeasure := 90 * (1 - smooth)
	arcLen := math.Sin(arcMeasure/2*deg) * r * math.Sqrt2
	alpha := (90 - arcMeasure) / 2
	p3p4 := r * math.Tan(alpha/2*deg)
	beta := 45 * smooth
	c := p3p4 * math.Cos(beta*deg)
	d := c * math.Tan(beta*deg)
	b := (p - arcLen - c - d) / 3
	a := 2 * b
	p0x := -p
	p1x, p1y := p0x+a+b+c, d
	p2x, p2y := p1x+arcLen, p1y+arcLen
	endX, endY := p2x+d, p2y+a+b+c
	phi := arcMeasure * deg
	l := 4.0 / 3 * math.Tan(phi/4) * r
	t1x, t1y := math.Cos(beta*deg), math.Sin(beta*deg)
	t2x, t2y := math.Sin(beta*deg), math.Cos(beta*deg)
	return p, [3][6]float64{
		{p0x + a, 0, p0x + a + b, 0, p1x, p1y},
		{p1x + l*t1x, p1y + l*t1y, p2x - l*t2x, p2y - l*t2y, p2x, p2y},
		{p2x + d, p2y + c, p2x + d, p2y + b + c, endX, endY},
	}
}

func roundedRectCmds(w, h float64, r *opendesignerv1.RectNode) []cmd {
	s := math.Min(1, math.Max(0, r.GetCornerSmoothing()))
	rad := clampedRadii(w, h, r)
	budget := math.Min(w, h) / 2
	type corner struct {
		vx, vy, r float64
		rot       int
	}
	corners := []corner{{w, 0, rad[1], 0}, {w, h, rad[2], 1}, {0, h, rad[3], 2}, {0, 0, rad[0], 3}}
	place := func(rot int, lx, ly, vx, vy float64) (float64, float64) {
		switch rot {
		case 0:
			return vx + lx, vy + ly
		case 1:
			return vx - ly, vy + lx
		case 2:
			return vx - lx, vy - ly
		}
		return vx + ly, vy - lx
	}
	var out []cmd
	for i, cn := range corners {
		if !(cn.r > 0) {
			x, y := place(cn.rot, 0, 0, cn.vx, cn.vy)
			if i == 0 {
				out = append(out, mv(x, y))
			} else {
				out = append(out, ln(x, y))
			}
			continue
		}
		p, segs := cornerLocal(cn.r, s, budget)
		x, y := place(cn.rot, -p, 0, cn.vx, cn.vy)
		if i == 0 {
			out = append(out, mv(x, y))
		} else {
			out = append(out, ln(x, y))
		}
		for _, sg := range segs {
			x1, y1 := place(cn.rot, sg[0], sg[1], cn.vx, cn.vy)
			x2, y2 := place(cn.rot, sg[2], sg[3], cn.vx, cn.vy)
			x3, y3 := place(cn.rot, sg[4], sg[5], cn.vx, cn.vy)
			out = append(out, cu(x1, y1, x2, y2, x3, y3))
		}
	}
	return append(out, closePath())
}

// cmdsToSubpaths turns path commands into the anchors-and-handles model of a vector (a cubic's controls become
// the handles of its two anchors, as OFFSETS from the anchor).
func cmdsToSubpaths(cmds []cmd) []*opendesignerv1.SubPath {
	var out []*opendesignerv1.SubPath
	var cur *opendesignerv1.SubPath
	var last *opendesignerv1.Anchor
	finish := func(closed bool) {
		if cur == nil {
			return
		}
		cur.Closed = closed
		// A closed contour ends back on its first anchor: fold the duplicate into the first anchor's in-handle.
		if closed && len(cur.Anchors) > 1 {
			f, l := cur.Anchors[0], cur.Anchors[len(cur.Anchors)-1]
			if math.Abs(f.X-l.X) < 1e-9 && math.Abs(f.Y-l.Y) < 1e-9 {
				f.InX, f.InY = l.InX, l.InY
				cur.Anchors = cur.Anchors[:len(cur.Anchors)-1]
			}
		}
		out = append(out, cur)
		cur, last = nil, nil
	}
	for _, c := range cmds {
		switch c.op {
		case 'M':
			finish(false)
			last = &opendesignerv1.Anchor{X: c.v[0], Y: c.v[1]}
			cur = &opendesignerv1.SubPath{Anchors: []*opendesignerv1.Anchor{last}}
		case 'L':
			last = &opendesignerv1.Anchor{X: c.v[0], Y: c.v[1]}
			cur.Anchors = append(cur.Anchors, last)
		case 'C':
			last.OutX, last.OutY = c.v[0]-last.X, c.v[1]-last.Y
			next := &opendesignerv1.Anchor{X: c.v[4], Y: c.v[5], InX: c.v[2] - c.v[4], InY: c.v[3] - c.v[5]}
			cur.Anchors = append(cur.Anchors, next)
			last = next
		case 'Z':
			finish(true)
		}
	}
	finish(false)
	return out
}

// computedVector returns a clone of the node as a VECTOR drawing the computed outline (same box, fills,
// strokes, effects and rotation), or nil when the node's outline is a plain box / ellipse. The hairline is
// turned off: a computed shape has no stroke unless the document gives it one.
func computedVector(n *opendesignerv1.Node) *opendesignerv1.Node {
	cmds := computedCmds(n)
	if cmds == nil {
		return nil
	}
	v := proto.Clone(n).(*opendesignerv1.Node)
	v.Shape = &opendesignerv1.Node_Vector{Vector: &opendesignerv1.VectorNode{Subpaths: cmdsToSubpaths(cmds)}}
	meta := map[string]string{}
	for k, val := range n.GetMeta() {
		meta[k] = val
	}
	meta["vector.hairline"] = "0"
	v.Meta = meta
	return v
}

// ---------------------------------------------------------------------------
// arrowheads
// ---------------------------------------------------------------------------

// headSize is the head's length for a stroke weight (renderer/arrowheads.ts::headSize).
func headSize(weight float64) float64 { return math.Max(8, weight*4) }

type vec struct{ x, y float64 }

// arrowHeadCmds: the head of `kind` with its tip at `tip`; out is the unit vector pointing away from the path.
// filled is drawn with the stroke's paint, open (the arrow's V) is stroked with it.
func arrowHeadCmds(kind opendesignerv1.ArrowHead, tip, out vec, weight float64) (filled, open []cmd) {
	s := headSize(weight)
	v := vec{-out.y, out.x}
	at := func(back, side float64) (float64, float64) {
		return tip.x - out.x*back + v.x*side, tip.y - out.y*back + v.y*side
	}
	poly := func(coords ...[2]float64) []cmd { return polylineCmds(coords) }
	pt := func(back, side float64) [2]float64 { x, y := at(back, side); return [2]float64{x, y} }
	switch kind {
	case opendesignerv1.ArrowHead_ARROW_HEAD_TRIANGLE:
		return poly(pt(0, 0), pt(s, s*0.45), pt(s, -s*0.45)), nil
	case opendesignerv1.ArrowHead_ARROW_HEAD_ARROW:
		a, b := at(s, s*0.45)
		c, d := at(0, 0)
		e, f := at(s, -s*0.45)
		return nil, []cmd{mv(a, b), ln(c, d), ln(e, f)}
	case opendesignerv1.ArrowHead_ARROW_HEAD_SQUARE:
		q := s * 0.7
		return poly(pt(0, q/2), pt(q, q/2), pt(q, -q/2), pt(0, -q/2)), nil
	case opendesignerv1.ArrowHead_ARROW_HEAD_DIAMOND:
		r := s * 0.45
		return poly(pt(0, 0), pt(r, r), pt(r*2, 0), pt(r, -r)), nil
	case opendesignerv1.ArrowHead_ARROW_HEAD_CIRCLE:
		r := s * 0.4
		k := r * 0.5523
		cx, cy := tip.x-out.x*r, tip.y-out.y*r
		p := func(a, b float64) (float64, float64) { return cx + out.x*a + v.x*b, cy + out.y*a + v.y*b }
		x0, y0 := p(r, 0)
		seg := func(a1, b1, a2, b2, a3, b3 float64) cmd {
			x1, y1 := p(a1, b1)
			x2, y2 := p(a2, b2)
			x3, y3 := p(a3, b3)
			return cu(x1, y1, x2, y2, x3, y3)
		}
		return []cmd{mv(x0, y0), seg(r, k, k, r, 0, r), seg(-k, r, -r, k, -r, 0), seg(-r, -k, -k, -r, 0, -r), seg(k, -r, r, -k, r, 0), closePath()}, nil
	}
	return nil, nil
}

// arrowEnds: the first anchor of the first OPEN subpath and the last anchor of the last open subpath, with the
// direction the path leaves each (handles first, the neighbouring anchor as the fallback). Local coordinates.
func arrowEnds(subs []*opendesignerv1.SubPath) (start, end *[2]vec) {
	var open []*opendesignerv1.SubPath
	for _, sp := range subs {
		if !sp.GetClosed() && len(sp.GetAnchors()) >= 2 {
			open = append(open, sp)
		}
	}
	unit := func(dx, dy float64) (vec, bool) {
		l := math.Hypot(dx, dy)
		if l <= 1e-9 {
			return vec{}, false
		}
		return vec{dx / l, dy / l}, true
	}
	if len(open) == 0 {
		return nil, nil
	}
	if f := open[0]; true {
		a, b := f.Anchors[0], f.Anchors[1]
		d, ok := unit(-a.OutX, -a.OutY)
		if !ok {
			d, ok = unit(a.X-b.X, a.Y-b.Y)
		}
		if ok {
			start = &[2]vec{{a.X, a.Y}, d}
		}
	}
	l := open[len(open)-1]
	a, p := l.Anchors[len(l.Anchors)-1], l.Anchors[len(l.Anchors)-2]
	d, ok := unit(-a.InX, -a.InY)
	if !ok {
		d, ok = unit(a.X-p.X, a.Y-p.Y)
	}
	if ok {
		end = &[2]vec{{a.X, a.Y}, d}
	}
	return start, end
}

func cmdsD(cmds []cmd) string {
	var sb []byte
	for _, c := range cmds {
		switch c.op {
		case 'M':
			sb = fmt.Appendf(sb, "M%s %s", num(c.v[0]), num(c.v[1]))
		case 'L':
			sb = fmt.Appendf(sb, "L%s %s", num(c.v[0]), num(c.v[1]))
		case 'C':
			sb = fmt.Appendf(sb, "C%s %s %s %s %s %s", num(c.v[0]), num(c.v[1]), num(c.v[2]), num(c.v[3]), num(c.v[4]), num(c.v[5]))
		default:
			sb = append(sb, 'Z')
		}
	}
	return string(sb)
}

// arrowheadElements: the heads of every stroke of a vector node, as <path> elements to put after its strokes.
func arrowheadElements(eff *opendesignerv1.Node, opacity float64) []*Element {
	var out []*Element
	start, end := arrowEnds(eff.GetVector().GetSubpaths())
	for _, st := range eff.GetStrokes() {
		if !(st.GetWeight() > 0) {
			continue
		}
		col := colorCSS(toFill(st.GetPaint()).color, 1)
		for _, e := range []struct {
			kind opendesignerv1.ArrowHead
			at   *[2]vec
		}{{st.GetStartCap(), start}, {st.GetEndCap(), end}} {
			if e.kind == opendesignerv1.ArrowHead_ARROW_HEAD_NONE || e.at == nil {
				continue
			}
			filled, open := arrowHeadCmds(e.kind, e.at[0], e.at[1], st.GetWeight())
			if len(filled) > 0 {
				p := &Element{Tag: "path"}
				p.addAttr("d", cmdsD(filled))
				p.addAttr("fill", col)
				if opacity != 1 {
					p.addAttr("opacity", num(opacity))
				}
				out = append(out, p)
			}
			if len(open) > 0 {
				p := &Element{Tag: "path"}
				p.addAttr("d", cmdsD(open))
				p.addAttr("fill", "none")
				p.addAttr("stroke", col)
				p.addAttr("stroke-width", num(st.GetWeight()))
				if opacity != 1 {
					p.addAttr("opacity", num(opacity))
				}
				out = append(out, p)
			}
		}
	}
	return out
}

// sideRings: a stroke with per-side weights as box-shadow bands. An inset shadow shifted by the opposite offset
// leaves a band of exactly that width on one side; outside, the box-sized shadow shifted outward does the same.
// CENTER splits each weight in two. Corners overlap (square), as in the SVG export.
func sideRings(sd *opendesignerv1.StrokeSides, align opendesignerv1.StrokeAlign, col string) []string {
	sides := [4]struct {
		w      float64
		dx, dy float64 // the outward direction
	}{{sd.GetTop(), 0, -1}, {sd.GetRight(), 1, 0}, {sd.GetBottom(), 0, 1}, {sd.GetLeft(), -1, 0}}
	var rings []string
	for _, s := range sides {
		if !(s.w > 0) {
			continue
		}
		in, out := s.w, 0.0
		switch align {
		case opendesignerv1.StrokeAlign_STROKE_ALIGN_OUTSIDE:
			in, out = 0, s.w
		case opendesignerv1.StrokeAlign_STROKE_ALIGN_CENTER:
			in, out = s.w/2, s.w/2
		}
		if out > 0 {
			rings = append(rings, fmt.Sprintf("%s %s 0 0 %s", px(s.dx*out), px(s.dy*out), col))
		}
		if in > 0 {
			// Inset: shifting the shadow AWAY from a side leaves the band on that side.
			rings = append(rings, fmt.Sprintf("inset %s %s 0 0 %s", px(-s.dx*in), px(-s.dy*in), col))
		}
	}
	return rings
}
