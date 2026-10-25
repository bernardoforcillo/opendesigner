package mcp_test

import (
	"context"
	"strings"
	"testing"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

func fp(v float64) *float64 { return &v }
func ip(v int) *int         { return &v }
func bp(v bool) *bool       { return &v }

func nodeView(t *testing.T, s *odmcp.Session, id string) odmcp.NodeView {
	t.Helper()
	doc, err := s.GetDocument(context.Background(), struct{}{})
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range doc.Nodes {
		if n.Id == id {
			return n
		}
	}
	t.Fatalf("node %s not in the document", id)
	return odmcp.NodeView{}
}

// TestShapeToolsEndToEnd: polygons and stars are created with their defaults and range-checked, the
// parametric fields of set_properties apply only to the shape that owns them, and the strokes tool takes
// arrowheads and per-side weights.
func TestShapeToolsEndToEnd(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()
	home := frame(t, s, "Home")
	box := odmcp.CreateShapeInput{ParentId: home, Width: 100, Height: 100}

	poly, err := s.CreatePolygon(ctx, odmcp.CreatePolygonInput{CreateShapeInput: box})
	if err != nil {
		t.Fatal(err)
	}
	if v := nodeView(t, s, poly.NodeId); v.Kind != "polygon" || v.Shape == nil || v.Shape.Sides != 6 {
		t.Fatalf("polygon view = %+v", v)
	}
	star, err := s.CreateStar(ctx, odmcp.CreateStarInput{CreateShapeInput: box, Points: 7})
	if err != nil {
		t.Fatal(err)
	}
	if v := nodeView(t, s, star.NodeId); v.Kind != "star" || v.Shape.Points != 7 || v.Shape.InnerRatio != 0.4 {
		t.Fatalf("star view = %+v", v.Shape)
	}
	if _, err := s.CreatePolygon(ctx, odmcp.CreatePolygonInput{CreateShapeInput: box, Sides: 2}); err == nil {
		t.Error("a 2-sided polygon was accepted")
	}
	if _, err := s.CreateStar(ctx, odmcp.CreateStarInput{CreateShapeInput: box, InnerRatio: 2}); err == nil {
		t.Error("a star with innerRatio 2 was accepted")
	}

	// set_properties: the fields of the shape.
	if _, err := s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: poly.NodeId, ShapeFields: odmcp.ShapeFields{Sides: ip(9)}}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: star.NodeId, ShapeFields: odmcp.ShapeFields{Points: ip(5), InnerRatio: fp(0.25)}}); err != nil {
		t.Fatal(err)
	}
	if v := nodeView(t, s, poly.NodeId); v.Shape.Sides != 9 {
		t.Fatalf("sides = %+v", v.Shape)
	}
	if v := nodeView(t, s, star.NodeId); v.Shape.Points != 5 || v.Shape.InnerRatio != 0.25 {
		t.Fatalf("star = %+v", v.Shape)
	}

	ell, _ := s.CreateEllipse(ctx, box)
	if _, err := s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: ell.NodeId, ShapeFields: odmcp.ShapeFields{ArcStart: fp(-90), ArcSweep: fp(270), InnerRatio: fp(0.5)}}); err != nil {
		t.Fatal(err)
	}
	if v := nodeView(t, s, ell.NodeId); v.Shape == nil || v.Shape.ArcStart != -90 || v.Shape.ArcSweep != 270 || v.Shape.InnerRatio != 0.5 {
		t.Fatalf("ellipse arc = %+v", v.Shape)
	}

	rect, _ := s.CreateRectangle(ctx, box)
	radius := 12.0
	if _, err := s.SetProperties(ctx, odmcp.SetPropertiesInput{
		Id: rect.NodeId, CornerRadius: &radius,
		ShapeFields: odmcp.ShapeFields{CornerSmoothing: fp(0.6), CornerRadii: &odmcp.CornerRadiiSpec{TopLeft: 1, TopRight: 2, BottomRight: 3, BottomLeft: 4}},
	}); err != nil {
		t.Fatal(err)
	}
	if v := nodeView(t, s, rect.NodeId); v.Shape == nil || v.Shape.CornerSmoothing != 0.6 || v.Shape.CornerRadii == nil || v.Shape.CornerRadii.BottomRight != 3 || v.Shape.CornerRadius != 12 {
		t.Fatalf("rect corners = %+v", v.Shape)
	}
	if _, err := s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: rect.NodeId, ShapeFields: odmcp.ShapeFields{UniformCorners: bp(true)}}); err != nil {
		t.Fatal(err)
	}
	if v := nodeView(t, s, rect.NodeId); v.Shape.CornerRadii != nil {
		t.Fatalf("radii not cleared: %+v", v.Shape)
	}

	// The wrong shape, and out-of-range values, are errors the agent can read.
	for name, call := range map[string]func() error{
		"arc on a rectangle": func() error {
			_, e := s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: rect.NodeId, ShapeFields: odmcp.ShapeFields{ArcSweep: fp(90)}})
			return e
		},
		"smoothing on an ellipse": func() error {
			_, e := s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: ell.NodeId, ShapeFields: odmcp.ShapeFields{CornerSmoothing: fp(0.5)}})
			return e
		},
		"points on a polygon": func() error {
			_, e := s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: poly.NodeId, ShapeFields: odmcp.ShapeFields{Points: ip(5)}})
			return e
		},
		"sides out of range": func() error {
			_, e := s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: poly.NodeId, ShapeFields: odmcp.ShapeFields{Sides: ip(100)}})
			return e
		},
		"smoothing out of range": func() error {
			_, e := s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: rect.NodeId, ShapeFields: odmcp.ShapeFields{CornerSmoothing: fp(2)}})
			return e
		},
		"sweep out of range": func() error {
			_, e := s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: ell.NodeId, ShapeFields: odmcp.ShapeFields{ArcSweep: fp(400)}})
			return e
		},
	} {
		if err := call(); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}

	// set_stroke: per-side weights and arrowheads.
	black := odmcp.RGBA{A: 1}
	if _, err := s.SetStroke(ctx, odmcp.SetStrokeInput{Id: rect.NodeId, Strokes: []odmcp.StrokeSpec{{
		Color: black, Weight: 1, Align: "inside", Sides: &odmcp.StrokeSidesSpec{Bottom: 6}, EndCap: "triangle",
	}}}); err != nil {
		t.Fatal(err)
	}
	open, err := odmcp.NewClient(url).OpenDocument(ctx, connect.NewRequest(&opendesignerv1.OpenRequest{DocId: docID}))
	if err != nil {
		t.Fatal(err)
	}
	st := open.Msg.GetSnapshot().GetNodes()[rect.NodeId].GetStrokes()[0]
	if st.GetSides().GetBottom() != 6 || st.GetWeight() != 6 || st.GetEndCap() != opendesignerv1.ArrowHead_ARROW_HEAD_TRIANGLE || st.GetAlign() != opendesignerv1.StrokeAlign_STROKE_ALIGN_INSIDE {
		t.Fatalf("stroke = %v", st)
	}
	for name, spec := range map[string]odmcp.StrokeSpec{
		"bad cap":      {Color: black, Weight: 1, StartCap: "star"},
		"bad align":    {Color: black, Weight: 1, Align: "around"},
		"negative":     {Color: black, Weight: -1},
		"bad side":     {Color: black, Weight: 1, Sides: &odmcp.StrokeSidesSpec{Top: -2}},
		"bad gradient": {Color: odmcp.RGBA{Gradient: &odmcp.GradientSpec{Kind: "sweep"}}, Weight: 1},
	} {
		if _, err := s.SetStroke(ctx, odmcp.SetStrokeInput{Id: rect.NodeId, Strokes: []odmcp.StrokeSpec{spec}}); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// TestStyleToolsEndToEnd: shared paint and effect styles are created, applied to fills and strokes, replaced,
// listed and deleted, with the cascade to the nodes.
func TestStyleToolsEndToEnd(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()
	home := frame(t, s, "Home")
	a, _ := s.CreateRectangle(ctx, odmcp.CreateShapeInput{ParentId: home, Width: 10, Height: 10})

	paint, err := s.SetPaintStyle(ctx, odmcp.SetPaintStyleInput{PaintStyleBody: odmcp.PaintStyleBody{
		Name: "Brand", Paints: []odmcp.RGBA{{R: 1, A: 1}, {Gradient: &odmcp.GradientSpec{
			Kind: "angular", X1: 0.5, Y1: 0.5, X2: 1, Y2: 0.5,
			Stops: []odmcp.GradientStopSpec{{Color: odmcp.StopColor{R: 1, A: 1}, Position: 0}, {Color: odmcp.StopColor{B: 1, A: 1}, Position: 1}},
		}}},
	}})
	if err != nil || paint.StyleId == "" {
		t.Fatalf("SetPaintStyle = %+v %v", paint, err)
	}
	list, _ := s.ListPaintStyles(ctx, struct{}{})
	if len(list.PaintStyles) != 1 || list.PaintStyles[0].Name != "Brand" || len(list.PaintStyles[0].Paints) != 2 || list.PaintStyles[0].Paints[1].Gradient.Kind != "angular" {
		t.Fatalf("ListPaintStyles = %+v", list)
	}

	if out, err := s.ApplyPaintStyle(ctx, odmcp.ApplyPaintStyleInput{NodeIds: []string{a.NodeId}, Target: "fill", StyleId: paint.StyleId}); err != nil || out.Changed != 1 {
		t.Fatalf("apply fill = %+v %v", out, err)
	}
	if out, _ := s.ApplyPaintStyle(ctx, odmcp.ApplyPaintStyleInput{NodeIds: []string{a.NodeId}, Target: "fill", StyleId: paint.StyleId}); out.Changed != 0 {
		t.Errorf("applying twice changed %d", out.Changed)
	}
	if _, err := s.ApplyPaintStyle(ctx, odmcp.ApplyPaintStyleInput{NodeIds: []string{a.NodeId}, Target: "stroke", StyleId: paint.StyleId}); err != nil {
		t.Fatal(err)
	}
	if v := nodeView(t, s, a.NodeId); v.FillStyleId != paint.StyleId || v.StrokeStyleId != paint.StyleId {
		t.Fatalf("node style ids = %+v", v)
	}

	// REPLACE: the node follows (the style is the source of truth).
	if _, err := s.SetPaintStyle(ctx, odmcp.SetPaintStyleInput{Id: paint.StyleId, PaintStyleBody: odmcp.PaintStyleBody{Name: "Brand v2", Paints: []odmcp.RGBA{{G: 1, A: 1}}}}); err != nil {
		t.Fatal(err)
	}
	if list, _ := s.ListPaintStyles(ctx, struct{}{}); list.PaintStyles[0].Name != "Brand v2" || len(list.PaintStyles[0].Paints) != 1 {
		t.Fatalf("after replace = %+v", list)
	}

	fx, err := s.SetEffectStyle(ctx, odmcp.SetEffectStyleInput{EffectStyleBody: odmcp.EffectStyleBody{
		Name: "Soft shadow", Effects: []odmcp.EffectSpec{{Kind: "dropShadow", Color: odmcp.StopColor{A: 0.3}, OffsetY: 4, Blur: 8}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if out, err := s.ApplyEffectStyle(ctx, odmcp.ApplyEffectStyleInput{NodeIds: []string{a.NodeId}, StyleId: fx.StyleId}); err != nil || out.Changed != 1 {
		t.Fatalf("apply effect = %+v %v", out, err)
	}
	if fl, _ := s.ListEffectStyles(ctx, struct{}{}); len(fl.EffectStyles) != 1 || fl.EffectStyles[0].Effects[0].Kind != "dropShadow" || fl.EffectStyles[0].Effects[0].Blur != 8 {
		t.Fatalf("ListEffectStyles = %+v", fl)
	}

	// Deleting detaches.
	if _, err := s.DeletePaintStyle(ctx, odmcp.IdInput{Id: paint.StyleId}); err != nil {
		t.Fatal(err)
	}
	if v := nodeView(t, s, a.NodeId); v.FillStyleId != "" || v.StrokeStyleId != "" || v.EffectStyleId != fx.StyleId {
		t.Fatalf("after delete = %+v", v)
	}
	if out, err := s.ApplyEffectStyle(ctx, odmcp.ApplyEffectStyleInput{NodeIds: []string{a.NodeId}}); err != nil || out.Changed != 1 {
		t.Fatalf("detach effect = %+v %v", out, err)
	}

	for name, call := range map[string]func() error{
		"unknown paint style to replace": func() error {
			_, e := s.SetPaintStyle(ctx, odmcp.SetPaintStyleInput{Id: "nope", PaintStyleBody: odmcp.PaintStyleBody{Name: "x", Paints: []odmcp.RGBA{{A: 1}}}})
			return e
		},
		"no name": func() error {
			_, e := s.SetPaintStyle(ctx, odmcp.SetPaintStyleInput{PaintStyleBody: odmcp.PaintStyleBody{Paints: []odmcp.RGBA{{A: 1}}}})
			return e
		},
		"no paints": func() error {
			_, e := s.SetPaintStyle(ctx, odmcp.SetPaintStyleInput{PaintStyleBody: odmcp.PaintStyleBody{Name: "x"}})
			return e
		},
		"bad effect": func() error {
			_, e := s.SetEffectStyle(ctx, odmcp.SetEffectStyleInput{EffectStyleBody: odmcp.EffectStyleBody{Name: "x", Effects: []odmcp.EffectSpec{{Kind: "glow"}}}})
			return e
		},
		"bad target": func() error {
			_, e := s.ApplyPaintStyle(ctx, odmcp.ApplyPaintStyleInput{NodeIds: []string{a.NodeId}, Target: "text"})
			return e
		},
		"unknown node": func() error {
			_, e := s.ApplyEffectStyle(ctx, odmcp.ApplyEffectStyleInput{NodeIds: []string{"zzz"}})
			return e
		},
		"unknown style": func() error {
			_, e := s.ApplyEffectStyle(ctx, odmcp.ApplyEffectStyleInput{NodeIds: []string{a.NodeId}, StyleId: "nope"})
			return e
		},
		"delete unknown": func() error { _, e := s.DeleteEffectStyle(ctx, odmcp.IdInput{Id: "nope"}); return e },
	} {
		if err := call(); err == nil {
			t.Errorf("%s: accepted", name)
		} else if strings.TrimSpace(err.Error()) == "" {
			t.Errorf("%s: empty error", name)
		}
	}
}
