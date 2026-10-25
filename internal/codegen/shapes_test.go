package codegen_test

import (
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
	. "github.com/bernardoforcillo/opendesigner/internal/codegen/samples"
)

func shapeOpt(s any) Opt {
	return func(n *opendesignerv1.Node) {
		switch v := s.(type) {
		case *opendesignerv1.PolygonNode:
			n.Shape = &opendesignerv1.Node_Polygon{Polygon: v}
		case *opendesignerv1.StarNode:
			n.Shape = &opendesignerv1.Node_Star{Star: v}
		case *opendesignerv1.EllipseNode:
			n.Shape = &opendesignerv1.Node_Ellipse{Ellipse: v}
		case *opendesignerv1.RectNode:
			n.Shape = &opendesignerv1.Node_Rect{Rect: v}
		}
	}
}

func strokeOpt(s *opendesignerv1.Stroke) Opt {
	return func(n *opendesignerv1.Node) { n.Strokes = []*opendesignerv1.Stroke{s} }
}

func shapeHTML(t *testing.T, fill func(b *B, s string)) string {
	t.Helper()
	out := gen(t, screenDoc(fill), codegen.TargetHTML, nil)
	return string(file(t, out, "screen.html"))
}

func TestPolygonAndStarAreInlineSvgPaths(t *testing.T) {
	html := shapeHTML(t, func(b *B, s string) {
		b.Add("p", s, "Hexagon", 10, 10, 100, 100, shapeOpt(&opendesignerv1.PolygonNode{Sides: 6}), Fill(Solid(C(1, 0, 0))))
		b.Add("st", s, "Star", 150, 10, 100, 100, shapeOpt(&opendesignerv1.StarNode{Points: 5, InnerRatio: 0.4}), Fill(Solid(C(0, 0, 1))))
	})
	if strings.Count(html, "<svg") != 2 {
		t.Fatalf("want two inline svgs:\n%s", html)
	}
	// The hexagon's first vertex is at the top: M50 0.
	if !strings.Contains(html, `d="M50 0L`) {
		t.Errorf("hexagon path missing:\n%s", html)
	}
	// No hairline stroke on a shape without a stroke.
	if strings.Contains(html, `stroke-width="1.5"`) {
		t.Errorf("a shape without a stroke got the vector hairline:\n%s", html)
	}
}

func TestArcRingAndSmoothedRectangleCodegen(t *testing.T) {
	html := shapeHTML(t, func(b *B, s string) {
		b.Add("a", s, "Pie", 10, 10, 100, 100, shapeOpt(&opendesignerv1.EllipseNode{ArcSweep: 90}), Fill(Solid(C(1, 0, 0))))
		b.Add("r", s, "Ring", 150, 10, 100, 100, shapeOpt(&opendesignerv1.EllipseNode{InnerRatio: 0.5}), Fill(Solid(C(1, 0, 0))))
		b.Add("q", s, "Squircle", 10, 150, 100, 100, shapeOpt(&opendesignerv1.RectNode{CornerRadius: 20, CornerSmoothing: 0.8}), Fill(Solid(C(1, 0, 0))))
		b.Add("plain", s, "Plain", 150, 150, 100, 100, Fill(Solid(C(1, 0, 0))))
	})
	if strings.Count(html, "<svg") != 3 {
		t.Fatalf("pie, ring and squircle are svgs, the plain rectangle is not:\n%s", html)
	}
	// A ring is two contours, filled even-odd.
	if !strings.Contains(html, `fill-rule="evenodd"`) {
		t.Errorf("no even-odd fill:\n%s", html)
	}
}

func TestPerSideStrokeIsOneBandPerSide(t *testing.T) {
	html := shapeHTML(t, func(b *B, s string) {
		b.Add("r", s, "Card", 10, 10, 100, 100, Fill(Solid(C(1, 1, 1))), strokeOpt(&opendesignerv1.Stroke{
			Paint: Solid(C(0, 0, 0)), Weight: 6, Align: opendesignerv1.StrokeAlign_STROKE_ALIGN_INSIDE,
			Sides: &opendesignerv1.StrokeSides{Bottom: 6, Left: 2},
		}))
	})
	if !strings.Contains(html, "inset 0 -6px 0 0 #000") || !strings.Contains(html, "inset 2px 0 0 0 #000") {
		t.Errorf("per-side bands missing:\n%s", html)
	}
	if strings.Contains(html, "inset 0 0 0 6px") {
		t.Errorf("the uniform ring was written too:\n%s", html)
	}
}

func TestAngularAndDiamondGradientCSS(t *testing.T) {
	stops := []Stop{S(0, C(1, 0, 0)), S(1, C(0, 0, 1))}
	html := shapeHTML(t, func(b *B, s string) {
		b.Add("a", s, "Angular", 10, 10, 100, 100, Fill(&opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Angular{Angular: gradient(0.5, 0.5, 1, 0.5, stops)}}))
		b.Add("d", s, "Diamond", 150, 10, 100, 100, Fill(&opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Diamond{Diamond: gradient(0.5, 0.5, 1, 0.5, stops)}}))
	})
	if !strings.Contains(html, "conic-gradient(from 90deg at 50px 50px") {
		t.Errorf("no conic gradient:\n%s", html)
	}
	if !strings.Contains(html, "radial-gradient(circle 35.355px at 50px 50px") {
		t.Errorf("no diamond approximation:\n%s", html)
	}
}

func gradient(x1, y1, x2, y2 float64, stops []Stop) *opendesignerv1.GradientPaint {
	g := &opendesignerv1.GradientPaint{X1: x1, Y1: y1, X2: x2, Y2: y2}
	for _, s := range stops {
		g.Stops = append(g.Stops, &opendesignerv1.GradientStop{Color: s.C, Position: s.At})
	}
	return g
}

func TestArrowheadsFollowTheOpenPathEnds(t *testing.T) {
	line := func(n *opendesignerv1.Node) {
		n.Shape = &opendesignerv1.Node_Vector{Vector: &opendesignerv1.VectorNode{Subpaths: []*opendesignerv1.SubPath{{Anchors: []*opendesignerv1.Anchor{{X: 0, Y: 0}, {X: 100, Y: 0}}}}}}
	}
	html := shapeHTML(t, func(b *B, s string) {
		b.Add("l", s, "Line", 10, 10, 100, 0, line, strokeOpt(&opendesignerv1.Stroke{
			Paint: Solid(C(0, 0, 0)), Weight: 2, EndCap: opendesignerv1.ArrowHead_ARROW_HEAD_TRIANGLE, StartCap: opendesignerv1.ArrowHead_ARROW_HEAD_ARROW,
		}))
	})
	// The triangle's tip is the path's end point (100,0); the arrow's V ends at the start point (0,0).
	if !strings.Contains(html, `d="M100 0L92 3.6L92 -3.6Z"`) {
		t.Errorf("end triangle missing:\n%s", html)
	}
	if !strings.Contains(html, "L0 0L") {
		t.Errorf("start arrow missing:\n%s", html)
	}
}

func TestSmoothedCornerStartsFurtherAlongTheEdge(t *testing.T) {
	// With smoothing 1 and radius 20 the top-right curve starts (1+1)*20 = 40 before the corner.
	html := shapeHTML(t, func(b *B, s string) {
		b.Add("q", s, "Squircle", 0, 0, 200, 200, shapeOpt(&opendesignerv1.RectNode{CornerRadius: 20, CornerSmoothing: 1}), Fill(Solid(C(1, 0, 0))))
	})
	if !strings.Contains(html, "C") || !strings.Contains(html, `d="M`) {
		t.Fatalf("no path:\n%s", html)
	}
	// The path starts on the top edge, where the top-right curve begins: 40 before the corner at x=200.
	if !strings.Contains(html, `d="M160 0C`) {
		t.Errorf("the top-right curve should start 40 before the corner:\n%s", html)
	}
}
