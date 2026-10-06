package codegen

import (
	"google.golang.org/protobuf/proto"
	"math"
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/ctessum/polyclip-go"
)

// LIVE BOOLEAN GROUPS in the export. A group whose meta has `boolean.op` draws as the result of
// the operation over its shapes (web/src/store/booleans.ts is the editor's twin); here the result
// is computed and emitted as an ordinary vector node, so the existing vector path draws it.
// The geometry follows web/src/vector/regions.ts: rounded corners and ellipses are polygons,
// curves are flattened, a node's region is the XOR of its closed rings (even-odd).

const metaBoolean = "boolean.op"

func booleanOpOf(n *opendesignerv1.Node) (polyclip.Op, bool) {
	if n.GetGroup() == nil {
		return 0, false
	}
	switch n.GetMeta()[metaBoolean] {
	case "union":
		return polyclip.UNION, true
	case "subtract":
		return polyclip.DIFFERENCE, true
	case "intersect":
		return polyclip.INTERSECTION, true
	case "exclude":
		return polyclip.XOR, true
	}
	return 0, false
}

// affine is the matrix [a c e; b d f] applied as (a*x + c*y + e, b*x + d*y + f).
type affine struct{ a, b, c, d, e, f float64 }

var identity = affine{1, 0, 0, 1, 0, 0}

func (m affine) apply(x, y float64) (float64, float64) {
	return m.a*x + m.c*y + m.e, m.b*x + m.d*y + m.f
}

// then returns the matrix that applies m first and o after.
func (m affine) then(o affine) affine {
	return affine{
		a: o.a*m.a + o.c*m.b, b: o.b*m.a + o.d*m.b,
		c: o.a*m.c + o.c*m.d, d: o.b*m.c + o.d*m.d,
		e: o.a*m.e + o.c*m.f + o.e, f: o.b*m.e + o.d*m.f + o.f,
	}
}

// localAffine maps a node's own space into its parent's: translate to (x, y), then rotate about
// the center of its box (the canvas convention, see canvas/transform.ts::localTransformOf).
func localAffine(n *opendesignerv1.Node) affine {
	t := affine{1, 0, 0, 1, n.GetX(), n.GetY()}
	if math.Mod(n.GetRotation(), 360) == 0 {
		return t
	}
	cx, cy := n.GetX()+n.GetWidth()/2, n.GetY()+n.GetHeight()/2
	r := n.GetRotation() * math.Pi / 180
	cos, sin := math.Cos(r), math.Sin(r)
	rot := affine{cos, sin, -sin, cos, 0, 0}
	around := affine{1, 0, 0, 1, -cx, -cy}.then(rot).then(affine{1, 0, 0, 1, cx, cy})
	return t.then(around)
}

type ring = polyclip.Contour

func pt(m affine, x, y float64) polyclip.Point {
	px, py := m.apply(x, y)
	return polyclip.Point{X: px, Y: py}
}

func roundedRing(m affine, w, h, radius float64) ring {
	r := math.Max(0, math.Min(radius, math.Min(w/2, h/2)))
	if r == 0 {
		return ring{pt(m, 0, 0), pt(m, w, 0), pt(m, w, h), pt(m, 0, h)}
	}
	const steps = 12
	var out ring
	corner := func(cx, cy, from float64) {
		for i := 0; i <= steps; i++ {
			a := from + (math.Pi/2)*float64(i)/steps
			out = append(out, pt(m, cx+r*math.Cos(a), cy+r*math.Sin(a)))
		}
	}
	corner(w-r, r, -math.Pi/2)
	corner(w-r, h-r, 0)
	corner(r, h-r, math.Pi/2)
	corner(r, r, math.Pi)
	return out
}

func ellipseRing(m affine, w, h float64) ring {
	const steps = 96
	out := make(ring, 0, steps)
	for i := 0; i < steps; i++ {
		a := 2 * math.Pi * float64(i) / steps
		out = append(out, pt(m, w/2+w/2*math.Cos(a), h/2+h/2*math.Sin(a)))
	}
	return out
}

// flattenCubic appends points of the cubic p0..p3 (excluding p0) within tol of the curve.
func flattenCubic(out *[][2]float64, p0, p1, p2, p3 [2]float64, tol float64, depth int) {
	// Flat enough when both controls are within tol of the chord.
	d := func(p [2]float64) float64 {
		dx, dy := p3[0]-p0[0], p3[1]-p0[1]
		l := math.Hypot(dx, dy)
		if l == 0 {
			return math.Hypot(p[0]-p0[0], p[1]-p0[1])
		}
		return math.Abs((p[0]-p0[0])*dy-(p[1]-p0[1])*dx) / l
	}
	if depth > 16 || (d(p1) <= tol && d(p2) <= tol) {
		*out = append(*out, p3)
		return
	}
	mid := func(a, b [2]float64) [2]float64 { return [2]float64{(a[0] + b[0]) / 2, (a[1] + b[1]) / 2} }
	p01, p12, p23 := mid(p0, p1), mid(p1, p2), mid(p2, p3)
	p012, p123 := mid(p01, p12), mid(p12, p23)
	m := mid(p012, p123)
	flattenCubic(out, p0, p01, p012, m, tol, depth+1)
	flattenCubic(out, m, p123, p23, p3, tol, depth+1)
}

func subpathRing(m affine, sp *opendesignerv1.SubPath) ring {
	as := sp.GetAnchors()
	if len(as) < 2 || !sp.GetClosed() {
		return nil
	}
	pts := [][2]float64{{as[0].GetX(), as[0].GetY()}}
	for i := range as {
		a, b := as[i], as[(i+1)%len(as)]
		flattenCubic(&pts,
			[2]float64{a.GetX(), a.GetY()},
			[2]float64{a.GetX() + a.GetOutX(), a.GetY() + a.GetOutY()},
			[2]float64{b.GetX() + b.GetInX(), b.GetY() + b.GetInY()},
			[2]float64{b.GetX(), b.GetY()}, 0.05, 0)
	}
	pts = pts[:len(pts)-1] // the closing point repeats the first
	out := make(ring, 0, len(pts))
	for _, p := range pts {
		out = append(out, pt(m, p[0], p[1]))
	}
	return out
}

// regionOf is the area a node fills, in the space its transform `m` maps to (m maps the node's
// PARENT space to the target; the node's own local transform is applied here).
func (b *builder) regionOf(n *opendesignerv1.Node, m affine) polyclip.Polygon {
	if !n.GetVisible() || n.GetIsMask() {
		return nil
	}
	own := localAffine(n).then(m)
	var rings []ring
	switch s := n.GetShape().(type) {
	case *opendesignerv1.Node_Rect:
		rings = []ring{roundedRing(own, n.GetWidth(), n.GetHeight(), s.Rect.GetCornerRadius())}
	case *opendesignerv1.Node_Frame:
		rings = []ring{roundedRing(own, n.GetWidth(), n.GetHeight(), 0)}
	case *opendesignerv1.Node_Ellipse:
		rings = []ring{ellipseRing(own, n.GetWidth(), n.GetHeight())}
	case *opendesignerv1.Node_Vector:
		for _, sp := range s.Vector.GetSubpaths() {
			if r := subpathRing(own, sp); len(r) >= 3 {
				rings = append(rings, r)
			}
		}
	case *opendesignerv1.Node_Group:
		op, live := booleanOpOf(n)
		if !live {
			op = polyclip.UNION
		}
		return b.combine(op, core.ChildrenOf(b.doc, n.GetId()), own)
	}
	// Even-odd across the node's own rings: XOR them together.
	var acc polyclip.Polygon
	for i, r := range rings {
		if len(r) < 3 {
			continue
		}
		p := polyclip.Polygon{r}
		if i == 0 || acc == nil {
			acc = p
		} else {
			acc = acc.Construct(polyclip.XOR, p)
		}
	}
	return acc
}

// combine folds `op` over the regions of `kids`, bottom first (subtract: the bottom minus the rest).
func (b *builder) combine(op polyclip.Op, kids []*opendesignerv1.Node, m affine) polyclip.Polygon {
	var acc polyclip.Polygon
	started := false
	for _, k := range kids {
		r := b.regionOf(k, m)
		if len(r) == 0 {
			// An empty operand: intersection with nothing is nothing; the others skip it.
			if op == polyclip.INTERSECTION && started {
				return nil
			}
			continue
		}
		if !started {
			acc, started = r, true
			continue
		}
		acc = acc.Construct(op, r)
	}
	return acc
}

// liveBoolean returns the vector node a live boolean group draws as, or nil when the result is empty.
func (b *builder) liveBoolean(g *opendesignerv1.Node) *opendesignerv1.Node {
	op, _ := booleanOpOf(g)
	// The group's own transform counts for its children (its parent space is the target).
	poly := b.combine(op, core.ChildrenOf(b.doc, g.GetId()), localAffine(g))
	var rings []ring
	for _, c := range poly {
		if len(c) >= 3 {
			rings = append(rings, c)
		}
	}
	if len(rings) == 0 {
		return nil
	}
	minX, minY, maxX, maxY := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
	for _, r := range rings {
		for _, p := range r {
			minX, minY = math.Min(minX, p.X), math.Min(minY, p.Y)
			maxX, maxY = math.Max(maxX, p.X), math.Max(maxY, p.Y)
		}
	}
	// Largest rings first: a stable order for the same document.
	sort.SliceStable(rings, func(i, j int) bool { return len(rings[i]) > len(rings[j]) })
	vn := &opendesignerv1.VectorNode{}
	for _, r := range rings {
		sp := &opendesignerv1.SubPath{Closed: true}
		for _, p := range r {
			sp.Anchors = append(sp.Anchors, &opendesignerv1.Anchor{X: round2(p.X - minX), Y: round2(p.Y - minY)})
		}
		vn.Subpaths = append(vn.Subpaths, sp)
	}
	out := proto.Clone(g).(*opendesignerv1.Node) // the group's own style, id and meta
	out.Shape = &opendesignerv1.Node_Vector{Vector: vn}
	out.X, out.Y, out.Width, out.Height, out.Rotation = round2(minX), round2(minY), round2(maxX-minX), round2(maxY-minY), 0
	return out
}

func round2(v float64) float64 { return math.Round(v*100)/100 + 0 }
