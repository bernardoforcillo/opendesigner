package core

import (
	"errors"
	"math"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

func TestWidthProfileValidation(t *testing.T) {
	pt := func(pos, l, r float64) *opendesignerv1.WidthPoint {
		return &opendesignerv1.WidthPoint{Position: pos, Left: l, Right: r}
	}
	stroke := func(pts ...*opendesignerv1.WidthPoint) []*opendesignerv1.Stroke {
		return []*opendesignerv1.Stroke{{Paint: solidPaint(0, 0, 0), Weight: 4, WidthProfile: pts}}
	}
	if err := ValidateStrokes(stroke(pt(0, 0, 0), pt(0.5, 1, 1), pt(0.5, 2, 0), pt(1, 0, 0))); err != nil {
		t.Fatalf("a good profile: %v", err)
	}
	var many []*opendesignerv1.WidthPoint
	for i := 0; i <= MaxWidthPoints; i++ {
		many = append(many, pt(0.5, 1, 1))
	}
	for name, strokes := range map[string][]*opendesignerv1.Stroke{
		"position above 1":    stroke(pt(1.5, 1, 1)),
		"position decreasing": stroke(pt(0.6, 1, 1), pt(0.2, 1, 1)),
		"negative width":      stroke(pt(0, -1, 1)),
		"width too large":     stroke(pt(0, 1, MaxWidthScale+1)),
		"NaN width":           stroke(pt(0, math.NaN(), 1)),
		"too many points":     stroke(many...),
	} {
		if err := ValidateStrokes(strokes); !errors.Is(err, ErrStrokeExtra) {
			t.Errorf("%s: got %v", name, err)
		}
	}
}
