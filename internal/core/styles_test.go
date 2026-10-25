package core

import (
	"errors"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

func solidPaint(r, g, b float32) *opendesignerv1.Paint {
	return &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{Color: &opendesignerv1.Color{R: r, G: g, B: b, A: 1}}}}
}

func createRect(id string) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: &opendesignerv1.Node{
		Id: id, ParentId: "page1", OrderKey: "a0", Visible: true, Opacity: 1, Width: 10, Height: 10,
		Fills:   []*opendesignerv1.Paint{solidPaint(1, 0, 0)},
		Strokes: []*opendesignerv1.Stroke{{Paint: solidPaint(0, 0, 0), Weight: 3, Align: opendesignerv1.StrokeAlign_STROKE_ALIGN_INSIDE, EndCap: opendesignerv1.ArrowHead_ARROW_HEAD_ARROW}},
		Effects: []*opendesignerv1.Effect{{Kind: &opendesignerv1.Effect_LayerBlur{LayerBlur: &opendesignerv1.LayerBlur{Radius: 2}}}},
		Shape:   &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}},
	}}}}
}

func setStyleIDs(id string, patch *opendesignerv1.Node, paths ...string) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{Id: id, Patch: patch, Mask: &fieldmaskpb.FieldMask{Paths: paths}}}}
}

// A node that names styles resolves to the style's paints and effects; its own values stay in the document, the
// stroke keeps its weight, alignment and arrowhead, and a deleted style hands the node back to its own values.
func TestResolveNodeAppliesPaintAndEffectStyles(t *testing.T) {
	doc := NewDocument("d", "Doc")
	mustApply(t, doc,
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetPaintStyleDef{SetPaintStyleDef: &opendesignerv1.SetPaintStyleDef{PaintStyle: &opendesignerv1.PaintStyleDef{
			Id: "brand", Name: "Brand", Paints: []*opendesignerv1.Paint{solidPaint(0, 1, 0)}}}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetEffectStyleDef{SetEffectStyleDef: &opendesignerv1.SetEffectStyleDef{EffectStyle: &opendesignerv1.EffectStyleDef{
			Id: "none", Name: "No effects"}}}},
		createRect("a"),
		setStyleIDs("a", &opendesignerv1.Node{FillStyleId: "brand", StrokeStyleId: "brand", EffectStyleId: "none"}, "fill_style_id", "stroke_style_id", "effect_style_id"),
	)
	n := ResolveNode(doc, doc.Nodes["a"])
	if g := n.Fills[0].GetSolid().GetColor(); g.G != 1 || g.R != 0 {
		t.Fatalf("fill = %v", n.Fills)
	}
	st := n.Strokes[0]
	if st.GetPaint().GetSolid().GetColor().G != 1 || st.Weight != 3 || st.Align != opendesignerv1.StrokeAlign_STROKE_ALIGN_INSIDE || st.EndCap != opendesignerv1.ArrowHead_ARROW_HEAD_ARROW {
		t.Fatalf("stroke = %v", st)
	}
	if len(n.Effects) != 0 {
		t.Fatalf("effects = %v", n.Effects)
	}
	// The document keeps the node's own values.
	if doc.Nodes["a"].Fills[0].GetSolid().GetColor().R != 1 || len(doc.Nodes["a"].Effects) != 1 {
		t.Fatal("the resolution wrote into the document")
	}
	mustApply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeletePaintStyleDef{DeletePaintStyleDef: &opendesignerv1.DeletePaintStyleDef{Id: "brand"}}})
	if doc.Nodes["a"].FillStyleId != "" || doc.Nodes["a"].StrokeStyleId != "" || doc.Nodes["a"].EffectStyleId != "none" {
		t.Fatalf("ids after delete = %q %q %q", doc.Nodes["a"].FillStyleId, doc.Nodes["a"].StrokeStyleId, doc.Nodes["a"].EffectStyleId)
	}
	if got := ResolveNode(doc, doc.Nodes["a"]); got.Fills[0].GetSolid().GetColor().R != 1 {
		t.Fatalf("the node should be back on its own fill: %v", got.Fills)
	}
}

func TestStyleAndShapeRejections(t *testing.T) {
	doc := NewDocument("d", "Doc")
	mustApply(t, doc, createRect("a"))
	for name, tc := range map[string]struct {
		op  *opendesignerv1.Op
		err error
	}{
		"unknown fill style":            {setStyleIDs("a", &opendesignerv1.Node{FillStyleId: "nope"}, "fill_style_id"), ErrPaintStyleMissing},
		"unknown effect style":          {setStyleIDs("a", &opendesignerv1.Node{EffectStyleId: "nope"}, "effect_style_id"), ErrEffectStyleMissing},
		"delete unknown paint style":    {&opendesignerv1.Op{Kind: &opendesignerv1.Op_DeletePaintStyleDef{DeletePaintStyleDef: &opendesignerv1.DeletePaintStyleDef{Id: "x"}}}, ErrPaintStyleMissing},
		"paint style without paints":    {&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetPaintStyleDef{SetPaintStyleDef: &opendesignerv1.SetPaintStyleDef{PaintStyle: &opendesignerv1.PaintStyleDef{Id: "x", Name: "x"}}}}, ErrStyleValue},
		"effect style without a name":   {&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetEffectStyleDef{SetEffectStyleDef: &opendesignerv1.SetEffectStyleDef{EffectStyle: &opendesignerv1.EffectStyleDef{Id: "x"}}}}, ErrStyleValue},
		"sides on an ellipse-only path": {setStyleIDs("a", &opendesignerv1.Node{Shape: &opendesignerv1.Node_Polygon{Polygon: &opendesignerv1.PolygonNode{Sides: 5}}}, "sides"), ErrNotPolygon},
		"arc on a rectangle":            {setStyleIDs("a", &opendesignerv1.Node{Shape: &opendesignerv1.Node_Ellipse{Ellipse: &opendesignerv1.EllipseNode{ArcSweep: 90}}}, "arc_sweep"), ErrNotEllipse},
		"smoothing out of range":        {setStyleIDs("a", &opendesignerv1.Node{Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{CornerSmoothing: 1.5}}}, "corner_smoothing"), ErrShapeValue},
		"negative radius":               {setStyleIDs("a", &opendesignerv1.Node{Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{Radii: &opendesignerv1.CornerRadii{TopLeft: -1}}}}, "radii"), ErrShapeValue},
		"unknown arrowhead":             {setStyleIDs("a", &opendesignerv1.Node{Strokes: []*opendesignerv1.Stroke{{Paint: solidPaint(0, 0, 0), Weight: 1, StartCap: 99}}}, "strokes"), ErrStrokeExtra},
		"negative side weight":          {setStyleIDs("a", &opendesignerv1.Node{Strokes: []*opendesignerv1.Stroke{{Paint: solidPaint(0, 0, 0), Weight: 1, Sides: &opendesignerv1.StrokeSides{Left: -1}}}}, "strokes"), ErrStrokeExtra},
	} {
		if err := Apply(doc, tc.op); !errors.Is(err, tc.err) {
			t.Errorf("%s: got %v, want %v", name, err, tc.err)
		}
	}
	// A mixed mask with one bad path leaves the node untouched.
	if err := Apply(doc, setStyleIDs("a", &opendesignerv1.Node{X: 50, Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{CornerSmoothing: 9}}}, "x", "corner_smoothing")); err == nil {
		t.Fatal("accepted")
	}
	if doc.Nodes["a"].X != 0 {
		t.Fatal("x moved despite the rejected mask")
	}
	// Creating a polygon or star out of range is rejected too.
	for _, sh := range []opendesignerv1.Node{
		{Shape: &opendesignerv1.Node_Polygon{Polygon: &opendesignerv1.PolygonNode{Sides: 2}}},
		{Shape: &opendesignerv1.Node_Star{Star: &opendesignerv1.StarNode{Points: 5, InnerRatio: 1}}},
		{Shape: &opendesignerv1.Node_Ellipse{Ellipse: &opendesignerv1.EllipseNode{ArcSweep: 500}}},
	} {
		n := &opendesignerv1.Node{Id: "bad", ParentId: "page1", OrderKey: "a9", Visible: true, Opacity: 1, Shape: sh.Shape}
		if err := Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}}); !errors.Is(err, ErrShapeValue) {
			t.Errorf("create %T: %v", sh.Shape, err)
		}
	}
}
