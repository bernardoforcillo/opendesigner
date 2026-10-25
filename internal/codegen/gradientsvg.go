package codegen

import (
	"fmt"
	"math"
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Angular and diamond gradients in the SVG of a vector node. SVG has neither, and a flat first-stop
// colour (what this used to write) loses the whole gradient, so both are built from primitives SVG does
// have, in a <pattern> that covers the node's box (userSpaceOnUse, local px, like vectorGradient):
//
//   - diamond: four <rect>s, one per quadrant around the centre, each filled with a <linearGradient>
//     along the quadrant's diagonal (inside a quadrant |dx|+|dy| is linear), the same split as the CSS
//     layers of diamondLayers;
//   - angular: angularSteps wedges (triangles from the centre), each filled with the stops' colour at
//     its middle angle.
//
// The geometry is the canvas's (renderer/gradientBitmap.ts::gradientPosition) and the output is a pure
// function of the document, so it is deterministic.

// angularSteps: the wedges of an angular gradient (3 degrees each).
const angularSteps = 120

// patternMargin: how far the pattern tile extends past the box on every side (a vector's
// ink can overhang the box; outside the tile the pattern would repeat).
func patternMargin(w, h float64) float64 { return math.Max(math.Max(w, h), 1) }

// vectorPattern: <defs> with the pattern of an angular or diamond fill, and its url(#id) reference.
func vectorPattern(id string, f fill, w, h float64) (*Element, string) {
	g := f.grad
	if len(g.GetStops()) < 2 {
		return nil, ""
	}
	cx, cy := g.GetX1()*w, g.GetY1()*h
	dx, dy := g.GetX2()*w-cx, g.GetY2()*h-cy
	l := math.Hypot(dx, dy)
	if !(l > 0) {
		return nil, ""
	}
	m := patternMargin(w, h)
	x0, y0, x1, y1 := -m, -m, w+m, h+m // the tile
	pat := &Element{Tag: "pattern"}
	pat.addAttr("id", id)
	pat.addAttr("patternUnits", "userSpaceOnUse")
	pat.addAttr("x", num(x0))
	pat.addAttr("y", num(y0))
	pat.addAttr("width", num(x1-x0))
	pat.addAttr("height", num(y1-y0))
	defs := &Element{Tag: "defs"}
	if f.diamond {
		// Quadrants: top right, bottom right, bottom left, top left; (sx, sy) is the direction of the ramp.
		right0, right1 := cx, math.Max(x1, cx)
		left0, left1 := math.Min(x0, cx), cx
		top0, top1 := math.Min(y0, cy), cy
		bottom0, bottom1 := cy, math.Max(y1, cy)
		for i, q := range []struct {
			sx, sy   float64
			qx0, qx1 float64
			qy0, qy1 float64
		}{
			{1, -1, right0, right1, top0, top1},
			{1, 1, right0, right1, bottom0, bottom1},
			{-1, 1, left0, left1, bottom0, bottom1},
			{-1, -1, left0, left1, top0, top1},
		} {
			if !(q.qx1 > q.qx0 && q.qy1 > q.qy0) {
				continue
			}
			gid := fmt.Sprintf("%s-q%d", id, i)
			// d = |dx|+|dy| = t*sqrt(2) along the unit diagonal, so the gradient vector is L/2 on each axis.
			gr := &Element{Tag: "linearGradient"}
			gr.addAttr("id", gid)
			gr.addAttr("x1", num(cx))
			gr.addAttr("y1", num(cy))
			gr.addAttr("x2", num(cx+q.sx*l/2))
			gr.addAttr("y2", num(cy+q.sy*l/2))
			gr.addAttr("gradientUnits", "userSpaceOnUse")
			for _, st := range g.GetStops() {
				s := &Element{Tag: "stop"}
				s.addAttr("offset", num(math.Min(1, math.Max(0, st.GetPosition()))))
				s.addAttr("stop-color", colorCSS(st.GetColor(), 1))
				gr.Children = append(gr.Children, s)
			}
			defs.Children = append(defs.Children, gr)
			r := &Element{Tag: "rect"}
			r.addAttr("x", num(round3(q.qx0)))
			r.addAttr("y", num(round3(q.qy0)))
			r.addAttr("width", num(round3(q.qx1-q.qx0)))
			r.addAttr("height", num(round3(q.qy1-q.qy0)))
			r.addAttr("fill", "url(#"+gid+")")
			// Abutting quadrants must not leave an antialiased seam.
			r.addAttr("shape-rendering", "crispEdges")
			pat.Children = append(pat.Children, r)
		}
	} else {
		start := math.Atan2(dy, dx) // radians, 0 = +x, growing clockwise on screen (y points down)
		// The wedge's chord must cover the farthest corner of the tile.
		reach := 0.0
		for _, c := range [][2]float64{{x0, y0}, {x1, y0}, {x0, y1}, {x1, y1}} {
			reach = math.Max(reach, math.Hypot(c[0]-cx, c[1]-cy))
		}
		step := 2 * math.Pi / angularSteps
		r := reach / math.Cos(step/2)
		opaque := true
		for _, st := range g.GetStops() {
			opaque = opaque && st.GetColor().GetA() >= 1
		}
		for i := 0; i < angularSteps; i++ {
			a0, a1 := start+float64(i)*step, start+float64(i+1)*step
			if opaque {
				// Opaque wedges overlap a little (the next one is drawn on top): no seam. Translucent ones
				// would blend twice, so they abut and rely on crispEdges.
				a1 += step / 4
			}
			p := &Element{Tag: "path"}
			p.addAttr("d", fmt.Sprintf("M%s %sL%s %sL%s %sZ", num(round3(cx)), num(round3(cy)),
				num(round3(cx+r*math.Cos(a0))), num(round3(cy+r*math.Sin(a0))),
				num(round3(cx+r*math.Cos(a1))), num(round3(cy+r*math.Sin(a1)))))
			p.addAttr("fill", colorCSS(colorAtStops(g.GetStops(), (float64(i)+0.5)/angularSteps), 1))
			if !opaque {
				p.addAttr("shape-rendering", "crispEdges")
			}
			pat.Children = append(pat.Children, p)
		}
	}
	defs.Children = append(defs.Children, pat)
	return defs, "url(#" + id + ")"
}

// colorAtStops: the colour of the stops at t, interpolated NON-premultiplied like the canvas
// (renderer/gradientBitmap.ts::colorAtStops); the end colours extend.
func colorAtStops(stops []*opendesignerv1.GradientStop, t float64) *opendesignerv1.Color {
	s := append([]*opendesignerv1.GradientStop(nil), stops...)
	sort.SliceStable(s, func(i, j int) bool { return s[i].GetPosition() < s[j].GetPosition() })
	if t <= float64(s[0].GetPosition()) {
		return s[0].GetColor()
	}
	last := s[len(s)-1]
	if t >= float64(last.GetPosition()) {
		return last.GetColor()
	}
	for i := 0; i+1 < len(s); i++ {
		a, b := s[i], s[i+1]
		if t <= float64(b.GetPosition()) {
			k := 1.0
			if b.GetPosition() > a.GetPosition() {
				k = (t - float64(a.GetPosition())) / float64(b.GetPosition()-a.GetPosition())
			}
			return lerpColor(a.GetColor(), b.GetColor(), float32(k))
		}
	}
	return last.GetColor()
}
