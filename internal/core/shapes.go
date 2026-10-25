package core

import (
	"errors"
	"fmt"
	"math"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// SHAPES -- the Go half (the authority) of web/src/store/shapes.ts: the parametric shapes
// (polygon, star, ellipse arc / ring), rectangle corner smoothing and independent radii, and the
// stroke extras (arrowheads, per-side weights). Docs: docs/shapes.md.
//
// Like corner_radius, the shape parameters live INSIDE the `shape` oneof, so each has a mask path of
// its own that is valid only on the shape it belongs to (a WHITELIST: the shapes added later are
// rejected by default):
//
//	corner_smoothing, radii          rectangles
//	arc_start, arc_sweep             ellipses
//	inner_ratio                      ellipses (the ring's hole) and stars (the notch depth)
//	sides                            polygons
//	points                           stars

var (
	ErrShapeValue  = errors.New("core: invalid shape parameter")
	ErrNotEllipse  = errors.New("core: not an ellipse node")
	ErrNotPolygon  = errors.New("core: not a polygon node")
	ErrNotStar     = errors.New("core: not a star node")
	ErrStrokeExtra = errors.New("core: invalid stroke arrowhead or side weights")
)

// The ranges of the parametric shapes.
const (
	MinPolygonSides = 3
	MaxPolygonSides = 60
	MinStarRatio    = 0.05
	MaxStarRatio    = 0.95
)

func finiteNum(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

// validateShape checks the parameters of the node's own shape (what a CreateNode carries).
func validateShape(n *opendesignerv1.Node) error {
	switch s := n.GetShape().(type) {
	case *opendesignerv1.Node_Rect:
		return validateRect(s.Rect)
	case *opendesignerv1.Node_Ellipse:
		return validateArc(s.Ellipse)
	case *opendesignerv1.Node_Polygon:
		return validatePolygon(s.Polygon)
	case *opendesignerv1.Node_Star:
		return validateStar(s.Star)
	}
	return nil
}

func validateRect(r *opendesignerv1.RectNode) error {
	if r == nil {
		return nil
	}
	if sm := r.GetCornerSmoothing(); !finiteNum(sm) || sm < 0 || sm > 1 {
		return fmt.Errorf("%w: corner smoothing must be within 0..1, got %v", ErrShapeValue, sm)
	}
	if c := r.GetRadii(); c != nil {
		for _, v := range []float64{c.GetTopLeft(), c.GetTopRight(), c.GetBottomRight(), c.GetBottomLeft()} {
			if !finiteNonNeg(v) {
				return fmt.Errorf("%w: corner radii must be finite and non-negative, got %v", ErrShapeValue, v)
			}
		}
	}
	return nil
}

func validateArc(e *opendesignerv1.EllipseNode) error {
	if e == nil {
		return nil
	}
	if !finiteNum(e.GetArcStart()) {
		return fmt.Errorf("%w: arc start must be finite", ErrShapeValue)
	}
	if sw := e.GetArcSweep(); !finiteNum(sw) || sw < -360 || sw > 360 {
		return fmt.Errorf("%w: arc sweep must be within -360..360, got %v", ErrShapeValue, sw)
	}
	if r := e.GetInnerRatio(); !finiteNum(r) || r < 0 || r >= 1 {
		return fmt.Errorf("%w: ring inner ratio must be within 0..1 (1 excluded), got %v", ErrShapeValue, r)
	}
	return nil
}

func validatePolygon(p *opendesignerv1.PolygonNode) error {
	// An absent message / zero sides reads as the default triangle only on the client; a stored polygon
	// states its count.
	if p == nil || p.GetSides() < MinPolygonSides || p.GetSides() > MaxPolygonSides {
		return fmt.Errorf("%w: a polygon needs %d to %d sides", ErrShapeValue, MinPolygonSides, MaxPolygonSides)
	}
	return nil
}

func validateStar(s *opendesignerv1.StarNode) error {
	if err := validateStarPoints(s.GetPoints()); err != nil {
		return err
	}
	return validateStarRatio(s.GetInnerRatio())
}

func validateStarPoints(points uint32) error {
	if points < MinPolygonSides || points > MaxPolygonSides {
		return fmt.Errorf("%w: a star needs %d to %d points", ErrShapeValue, MinPolygonSides, MaxPolygonSides)
	}
	return nil
}

func validateStarRatio(r float64) error {
	if !finiteNum(r) || r < MinStarRatio || r > MaxStarRatio {
		return fmt.Errorf("%w: star inner ratio must be within %v..%v, got %v", ErrShapeValue, MinStarRatio, MaxStarRatio, r)
	}
	return nil
}

// validateStrokeExtras: the arrowhead enums are closed and per-side weights are finite and non-negative.
func validateStrokeExtras(strokes []*opendesignerv1.Stroke) error {
	for _, s := range strokes {
		for _, h := range []opendesignerv1.ArrowHead{s.GetStartCap(), s.GetEndCap()} {
			if h < opendesignerv1.ArrowHead_ARROW_HEAD_NONE || h > opendesignerv1.ArrowHead_ARROW_HEAD_DIAMOND {
				return fmt.Errorf("%w: unknown arrowhead %v", ErrStrokeExtra, h)
			}
		}
		if sd := s.GetSides(); sd != nil {
			for _, v := range []float64{sd.GetTop(), sd.GetRight(), sd.GetBottom(), sd.GetLeft()} {
				if !finiteNonNeg(v) {
					return fmt.Errorf("%w: side weights must be finite and non-negative, got %v", ErrStrokeExtra, v)
				}
			}
		}
		if err := validateWidthProfile(s.GetWidthProfile()); err != nil {
			return err
		}
		if err := validateBrush(s.GetBrush()); err != nil {
			return err
		}
	}
	return nil
}

// Limits of a variable-width profile (Stroke.width_profile).
const (
	MaxWidthPoints = 64
	MaxWidthScale  = 16.0
)

// validateWidthProfile: at most MaxWidthPoints points, positions within 0..1 and not decreasing, both
// widths finite within 0..MaxWidthScale.
func validateWidthProfile(pts []*opendesignerv1.WidthPoint) error {
	if len(pts) > MaxWidthPoints {
		return fmt.Errorf("%w: a width profile has at most %d points, got %d", ErrStrokeExtra, MaxWidthPoints, len(pts))
	}
	prev := 0.0
	for _, p := range pts {
		pos := p.GetPosition()
		if !finiteNum(pos) || pos < 0 || pos > 1 || pos < prev {
			return fmt.Errorf("%w: width point positions must be within 0..1 and not decrease, got %v", ErrStrokeExtra, pos)
		}
		prev = pos
		for _, w := range []float64{p.GetLeft(), p.GetRight()} {
			if !finiteNum(w) || w < 0 || w > MaxWidthScale {
				return fmt.Errorf("%w: width point sides must be within 0..%v, got %v", ErrStrokeExtra, MaxWidthScale, w)
			}
		}
	}
	return nil
}

// Limits of a brush (Stroke.brush); mirrored by web/src/store/shapes.ts::isValidBrush.
const (
	MinBrushSpacing = 0.05
	MaxBrushSpacing = 64.0
	MaxBrushScatter = 8.0
	MaxBrushAngle   = 180.0
)

// validateBrush: closed enums, and for a brush that is on (kind other than NONE) finite parameters within
// their ranges. A NONE brush is the plain stroke, so its parameters are not looked at.
func validateBrush(b *opendesignerv1.Brush) error {
	if b == nil {
		return nil
	}
	if b.GetKind() < opendesignerv1.BrushKind_BRUSH_KIND_NONE || b.GetKind() > opendesignerv1.BrushKind_BRUSH_KIND_SCATTER {
		return fmt.Errorf("%w: unknown brush kind %v", ErrStrokeExtra, b.GetKind())
	}
	if b.GetKind() == opendesignerv1.BrushKind_BRUSH_KIND_NONE {
		return nil
	}
	if b.GetTip() < opendesignerv1.BrushTip_BRUSH_TIP_DOT || b.GetTip() > opendesignerv1.BrushTip_BRUSH_TIP_LEAF {
		return fmt.Errorf("%w: unknown brush tip %v", ErrStrokeExtra, b.GetTip())
	}
	for _, c := range []struct {
		name        string
		v, min, max float64
	}{
		{"spacing", b.GetSpacing(), MinBrushSpacing, MaxBrushSpacing},
		{"scatter", b.GetScatter(), 0, MaxBrushScatter},
		{"size jitter", b.GetSizeJitter(), 0, 1},
		{"angle jitter", b.GetAngleJitter(), 0, MaxBrushAngle},
	} {
		if !finiteNum(c.v) || c.v < c.min || c.v > c.max {
			return fmt.Errorf("%w: brush %s must be within %v..%v, got %v", ErrStrokeExtra, c.name, c.min, c.max, c.v)
		}
	}
	return nil
}

// ValidateStrokes is for the MCP tools: the authority's own check of a stroke list's arrowheads and side weights.
func ValidateStrokes(strokes []*opendesignerv1.Stroke) error { return validateStrokeExtras(strokes) }

// checkShapePath validates one shape-parameter mask path against the target node (the whitelist) and
// the patch's value for that path alone (a patch carries only the fields its mask names).
func checkShapePath(n *opendesignerv1.Node, patch *opendesignerv1.Node, path string) error {
	switch path {
	case "corner_smoothing", "radii":
		switch n.GetShape().(type) {
		case nil, *opendesignerv1.Node_Rect: // an absent shape is the implicit rectangle, as for corner_radius
		default:
			return fmt.Errorf("%w: %s", ErrNotRectNode, n.GetId())
		}
		r := &opendesignerv1.RectNode{}
		if path == "corner_smoothing" {
			r.CornerSmoothing = patch.GetRect().GetCornerSmoothing()
		} else {
			r.Radii = patch.GetRect().GetRadii()
		}
		return validateRect(r)
	case "arc_start", "arc_sweep":
		if _, ok := n.GetShape().(*opendesignerv1.Node_Ellipse); !ok {
			return fmt.Errorf("%w: %s", ErrNotEllipse, n.GetId())
		}
		return validateArc(patch.GetEllipse())
	case "inner_ratio":
		// The ring's hole on an ellipse, the notch depth of a star.
		switch n.GetShape().(type) {
		case *opendesignerv1.Node_Ellipse:
			return validateArc(patch.GetEllipse())
		case *opendesignerv1.Node_Star:
			return validateStarRatio(patch.GetStar().GetInnerRatio())
		}
		return fmt.Errorf("%w: %s", ErrNotEllipse, n.GetId())
	case "sides":
		if _, ok := n.GetShape().(*opendesignerv1.Node_Polygon); !ok {
			return fmt.Errorf("%w: %s", ErrNotPolygon, n.GetId())
		}
		return validatePolygon(patch.GetPolygon())
	case "points":
		if _, ok := n.GetShape().(*opendesignerv1.Node_Star); !ok {
			return fmt.Errorf("%w: %s", ErrNotStar, n.GetId())
		}
		return validateStarPoints(patch.GetStar().GetPoints())
	}
	return nil
}

// applyShapePath writes one shape-parameter mask path (already validated by checkShapePath).
func applyShapePath(n *opendesignerv1.Node, p *opendesignerv1.Node, path string) {
	switch path {
	case "corner_smoothing", "radii":
		r := n.GetRect()
		if r == nil { // the implicit rectangle, or a Rect that lost its message in a round-trip
			r = &opendesignerv1.RectNode{}
			n.Shape = &opendesignerv1.Node_Rect{Rect: r}
		}
		if path == "corner_smoothing" {
			r.CornerSmoothing = p.GetRect().GetCornerSmoothing()
		} else {
			r.Radii = p.GetRect().GetRadii()
		}
	case "arc_start":
		n.GetEllipse().ArcStart = p.GetEllipse().GetArcStart()
	case "arc_sweep":
		n.GetEllipse().ArcSweep = p.GetEllipse().GetArcSweep()
	case "inner_ratio":
		if e := n.GetEllipse(); e != nil {
			e.InnerRatio = p.GetEllipse().GetInnerRatio()
		} else {
			n.GetStar().InnerRatio = p.GetStar().GetInnerRatio()
		}
	case "sides":
		n.GetPolygon().Sides = p.GetPolygon().GetSides()
	case "points":
		n.GetStar().Points = p.GetStar().GetPoints()
	}
}
