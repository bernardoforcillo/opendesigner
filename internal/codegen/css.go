package codegen

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// PURE functions that translate model values (float colours, normalised
// gradients, shadows) into CSS values. They reproduce the canvas semantics
// (web/src/renderer/canvasRenderer.ts), not the "typical" one of a design
// editor: where canvas and CSS diverge, the comment says so.

// num formats a number with at most 3 decimals, no trailing zeros and no
// "-0": the generated file must not contain floating-point tails.
func num(v float64) string {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return "0"
	}
	v = math.Round(v*1000) / 1000
	if v == 0 {
		return "0"
	}
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// px: "0" for zero (valid in CSS without a unit and more idiomatic in Tailwind),
// otherwise "<n>px".
func px(v float64) string {
	s := num(v)
	if s == "0" {
		return "0"
	}
	return s + "px"
}

func channel(v float32) int {
	f := math.Round(math.Min(1, math.Max(0, float64(v))) * 255)
	return int(f)
}

// colorCSS: "#rgb"/"#rrggbb" if opaque, "rgba(r,g,b,a)" otherwise (no spaces:
// the value also ends up inside Tailwind classes, where spaces are `_`).
// `mul` multiplies the alpha: it is used to "bake" a container's opacity into
// its colours (see build.go::bakeOpacity).
func colorCSS(c *opendesignerv1.Color, mul float64) string {
	r, g, b := channel(c.GetR()), channel(c.GetG()), channel(c.GetB())
	a := float64(c.GetA()) * mul
	if a >= 0.9995 {
		if r>>4 == r&15 && g>>4 == g&15 && b>>4 == b&15 {
			return fmt.Sprintf("#%x%x%x", r&15, g&15, b&15)
		}
		return fmt.Sprintf("#%02x%02x%02x", r, g, b)
	}
	if a < 0 {
		a = 0
	}
	return fmt.Sprintf("rgba(%d,%d,%d,%s)", r, g, b, num(a))
}

// fill is an already-resolved paint: the flat colour (for a gradient: the first
// stop, like FillLite in the client) and, if present, the gradient.
type fill struct {
	color  *opendesignerv1.Color
	grad   *opendesignerv1.GradientPaint
	radial bool
	image  *opendesignerv1.ImagePaint
}

var defaultGrey = &opendesignerv1.Color{R: 0.8, G: 0.8, B: 0.8, A: 1}
var black = &opendesignerv1.Color{R: 0, G: 0, B: 0, A: 1}

// toFill translates a Paint like web/src/store/types.ts::toFillLite: a missing
// paint or one without `kind` is opaque black.
func toFill(p *opendesignerv1.Paint) fill {
	switch k := p.GetKind().(type) {
	case *opendesignerv1.Paint_Linear:
		return gradFill(k.Linear, false)
	case *opendesignerv1.Paint_Radial:
		return gradFill(k.Radial, true)
	case *opendesignerv1.Paint_Image:
		// The flat base color the canvas shows until the image arrives; the image itself is a
		// background-image where the box can carry one (boxPaint).
		return fill{color: defaultGrey, image: k.Image}
	case *opendesignerv1.Paint_Solid:
		if c := k.Solid.GetColor(); c != nil {
			return fill{color: c}
		}
	}
	return fill{color: black}
}

func gradFill(g *opendesignerv1.GradientPaint, radial bool) fill {
	first := black
	if len(g.GetStops()) > 0 && g.GetStops()[0].GetColor() != nil {
		first = g.GetStops()[0].GetColor()
	}
	return fill{color: first, grad: g, radial: radial}
}

// resolvedFill: the paint a node is filled with, DEFAULT INCLUDED (light
// grey): it is the same decision as canvasRenderer.ts::resolvedFill.
func resolvedFill(fills []*opendesignerv1.Paint) fill {
	if len(fills) == 0 {
		return fill{color: defaultGrey}
	}
	return toFill(fills[0])
}

// gradientCSS translates a gradient into the CSS linear-gradient()/radial-gradient()
// that draws the same pixels as the canvas on the w x h box. ok=false for a
// degenerate gradient (fewer than two stops, zero axis or radius): the canvas
// falls back to the flat colour, and so must the caller.
//
// GEOMETRY. The model gives the axis in normalised coordinates: P1=(x1*w,y1*h),
// P2=(x2*w,y2*h). The canvas colours each point according to its projection
// onto the axis, and outside [P1,P2] it extends the end colours. CSS does the
// same but with a line fixed by the ANGLE that passes through the box CENTRE
// and whose length is the one that touches the corners: |w*sin| + |h*cos|. So
// it is enough to derive the angle from the axis direction and rewrite the stop
// positions as percentages of THAT length, shifted by the offset between P1 and
// the centre projected onto the axis. It is not "to bottom right": on a
// non-square box the CSS diagonal does not have the (w,h) direction that the
// canvas would use.
//
// RADIAL: centre P1, radius |P2-P1| in px (circle, not ellipse), stops as a
// percentage of the radius.
func gradientCSS(g *opendesignerv1.GradientPaint, radial bool, w, h, mul float64) (string, bool) {
	stops := g.GetStops()
	if len(stops) < 2 {
		return "", false
	}
	x1, y1 := g.GetX1()*w, g.GetY1()*h
	x2, y2 := g.GetX2()*w, g.GetY2()*h
	length := math.Hypot(x2-x1, y2-y1)
	if !(length > 0) {
		return "", false
	}
	clamp := func(p float64) float64 { return math.Min(1, math.Max(0, p)) }
	pts := expandStops(stops, clamp)
	var parts []string
	if radial {
		for _, st := range pts {
			parts = append(parts, colorCSS(st.c, mul)+" "+pct(st.pos*100))
		}
		return fmt.Sprintf("radial-gradient(circle %s at %s %s,%s)", px(length), px(x1), px(y1), strings.Join(parts, ",")), true
	}
	dx, dy := (x2-x1)/length, (y2-y1)/length
	// CSS angle: 0deg points up and grows clockwise.
	deg := math.Atan2(dx, -dy) * 180 / math.Pi
	if deg < 0 {
		deg += 360
	}
	lcss := math.Abs(w*dx) + math.Abs(h*dy)
	if !(lcss > 0) {
		return "", false
	}
	// Position of P1 along the axis, measured from the box centre.
	t1 := (x1-w/2)*dx + (y1-h/2)*dy
	for _, st := range pts {
		at := (t1+st.pos*length)/lcss + 0.5
		parts = append(parts, colorCSS(st.c, mul)+" "+pct(at*100))
	}
	return fmt.Sprintf("linear-gradient(%sdeg,%s)", num(round3(deg)), strings.Join(parts, ",")), true
}

type stopPoint struct {
	pos float64
	c   *opendesignerv1.Color
}

// alphaSubdivisions: into how many pieces a segment with different alphas is split.
const alphaSubdivisions = 8

// expandStops brings the model's stops into CSS points. The canvas interpolates
// colours NON-premultiplied: from opaque yellow to TRANSPARENT pink it passes
// through pinkish yellows with decreasing alpha. CSS interpolates premultiplied,
// and the same gradient would stay yellow fading out. Where two neighbouring
// stops have different alphas the segment is split into pieces with colours
// already interpolated the canvas way: between two close points the difference
// between the two methods is below the visible threshold.
func expandStops(stops []*opendesignerv1.GradientStop, clamp func(float64) float64) []stopPoint {
	var out []stopPoint
	for i, st := range stops {
		p := clamp(st.GetPosition())
		if i > 0 {
			prev := stops[i-1]
			pp := clamp(prev.GetPosition())
			if prev.GetColor().GetA() != st.GetColor().GetA() && p > pp {
				for k := 1; k < alphaSubdivisions; k++ {
					t := float64(k) / alphaSubdivisions
					out = append(out, stopPoint{pp + (p-pp)*t, lerpColor(prev.GetColor(), st.GetColor(), float32(t))})
				}
			}
		}
		out = append(out, stopPoint{p, st.GetColor()})
	}
	return out
}

func lerpColor(a, b *opendesignerv1.Color, t float32) *opendesignerv1.Color {
	l := func(x, y float32) float32 { return x + (y-x)*t }
	return &opendesignerv1.Color{R: l(a.GetR(), b.GetR()), G: l(a.GetG(), b.GetG()), B: l(a.GetB(), b.GetB()), A: l(a.GetA(), b.GetA())}
}

func round3(v float64) float64 { return math.Round(v*1000) / 1000 }

func pct(v float64) string {
	s := num(v)
	if s == "0" {
		return "0%"
	}
	return s + "%"
}

// rotates: whether the renderer really applies the rotation (multiples of 360
// do not rotate, like canvas/transform.ts::isUnrotated).
func rotates(deg float64) bool { return math.Mod(deg, 360) != 0 }

// shadowCSS: "dx dy blur color" for box-shadow and text-shadow. The canvas
// shadowBlur has the same definition as the CSS blur-radius (standard deviation
// = half), so the value passes through unchanged.
func shadowCSS(s *opendesignerv1.DropShadow, mul float64) string {
	return fmt.Sprintf("%s %s %s %s", px(s.GetOffsetX()), px(s.GetOffsetY()), px(math.Max(0, s.GetBlur())), colorCSS(s.GetColor(), mul))
}

// extraShadows: the drop shadows after the first, as box-shadow entries; innerShadows:
// the inner shadows as `inset` entries. Both are in list order, the topmost first,
// like CSS.
func extraShadows(effects []*opendesignerv1.Effect, mul float64) []string {
	var out []string
	first := true
	for _, e := range effects {
		if s := e.GetDropShadow(); s != nil {
			if first {
				first = false
				continue
			}
			out = append(out, shadowCSS(s, mul))
		}
	}
	return out
}

func innerShadows(effects []*opendesignerv1.Effect, mul float64) []string {
	var out []string
	for _, e := range effects {
		if s := e.GetInnerShadow(); s != nil {
			out = append(out, "inset "+fmt.Sprintf("%s %s %s %s", px(s.GetOffsetX()), px(s.GetOffsetY()), px(math.Max(0, s.GetBlur())), colorCSS(s.GetColor(), mul)))
		}
	}
	return out
}

// backgroundBlur: the first background blur with radius > 0, or nil.
func backgroundBlur(effects []*opendesignerv1.Effect) *opendesignerv1.BackgroundBlur {
	for _, e := range effects {
		if b := e.GetBackgroundBlur(); b != nil && b.GetRadius() > 0 {
			return b
		}
	}
	return nil
}

// blendCSS: the mix-blend-mode value of a node, "" for normal.
var blendNames = map[opendesignerv1.BlendMode]string{
	opendesignerv1.BlendMode_BLEND_MODE_MULTIPLY: "multiply", opendesignerv1.BlendMode_BLEND_MODE_SCREEN: "screen",
	opendesignerv1.BlendMode_BLEND_MODE_OVERLAY: "overlay", opendesignerv1.BlendMode_BLEND_MODE_DARKEN: "darken",
	opendesignerv1.BlendMode_BLEND_MODE_LIGHTEN: "lighten", opendesignerv1.BlendMode_BLEND_MODE_COLOR_DODGE: "color-dodge",
	opendesignerv1.BlendMode_BLEND_MODE_COLOR_BURN: "color-burn", opendesignerv1.BlendMode_BLEND_MODE_HARD_LIGHT: "hard-light",
	opendesignerv1.BlendMode_BLEND_MODE_SOFT_LIGHT: "soft-light", opendesignerv1.BlendMode_BLEND_MODE_DIFFERENCE: "difference",
	opendesignerv1.BlendMode_BLEND_MODE_EXCLUSION: "exclusion", opendesignerv1.BlendMode_BLEND_MODE_HUE: "hue",
	opendesignerv1.BlendMode_BLEND_MODE_SATURATION: "saturation", opendesignerv1.BlendMode_BLEND_MODE_COLOR: "color",
	opendesignerv1.BlendMode_BLEND_MODE_LUMINOSITY: "luminosity",
}

// firstShadow / firstBlur: the canvas draws the FIRST shadow and the FIRST
// blur with radius > 0 (canvasRenderer.ts::firstShadow/firstBlur).
func firstShadow(effects []*opendesignerv1.Effect) *opendesignerv1.DropShadow {
	for _, e := range effects {
		if s := e.GetDropShadow(); s != nil {
			return s
		}
	}
	return nil
}

func firstBlur(effects []*opendesignerv1.Effect) *opendesignerv1.LayerBlur {
	for _, e := range effects {
		if b := e.GetLayerBlur(); b != nil && b.GetRadius() > 0 {
			return b
		}
	}
	return nil
}

// strokeAlign: UNSPECIFIED collapses to CENTER (store/types.ts::toStrokeLite).
func strokeAlign(a opendesignerv1.StrokeAlign) opendesignerv1.StrokeAlign {
	if a == opendesignerv1.StrokeAlign_STROKE_ALIGN_INSIDE || a == opendesignerv1.StrokeAlign_STROKE_ALIGN_OUTSIDE {
		return a
	}
	return opendesignerv1.StrokeAlign_STROKE_ALIGN_CENTER
}

// strokeRings translates a box's strokes into box-shadow rings, in the order
// in which CSS stacks them (the FIRST in the list is on top, so the model's
// last stroke -- drawn last by the canvas -- goes first).
//
//	inside   inset 0 0 0 Wpx   (inner band, above the fill and below the children)
//	outside  0 0 0 Wpx         (outer band: box-shadow is NEVER painted
//	                            inside the box, so it does not cover the fill)
//	center   the two W/2 rings side by side
//
// A stroke with weight <= 0 is not a stroke (same rule as the canvas). A
// stroke with a gradient falls back to the first colour: a box-shadow ring
// cannot be shaded.
func strokeRings(strokes []*opendesignerv1.Stroke, mul float64) []string {
	var rings []string
	for i := len(strokes) - 1; i >= 0; i-- {
		s := strokes[i]
		if !(s.GetWeight() > 0) {
			continue
		}
		col := colorCSS(toFill(s.GetPaint()).color, mul)
		w := s.GetWeight()
		switch strokeAlign(s.GetAlign()) {
		case opendesignerv1.StrokeAlign_STROKE_ALIGN_INSIDE:
			rings = append(rings, fmt.Sprintf("inset 0 0 0 %s %s", px(w), col))
		case opendesignerv1.StrokeAlign_STROKE_ALIGN_OUTSIDE:
			rings = append(rings, fmt.Sprintf("0 0 0 %s %s", px(w), col))
		default:
			rings = append(rings,
				fmt.Sprintf("0 0 0 %s %s", px(w/2), col),
				fmt.Sprintf("inset 0 0 0 %s %s", px(w/2), col))
		}
	}
	return rings
}
