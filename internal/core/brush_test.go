package core

import (
	"errors"
	"math"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

func TestBrushValidation(t *testing.T) {
	good := func() *opendesignerv1.Brush {
		return &opendesignerv1.Brush{
			Kind: opendesignerv1.BrushKind_BRUSH_KIND_SCATTER, Tip: opendesignerv1.BrushTip_BRUSH_TIP_LEAF,
			Spacing: 1.5, Scatter: 0.8, SizeJitter: 0.4, AngleJitter: 60, Seed: 7,
		}
	}
	stroke := func(b *opendesignerv1.Brush) []*opendesignerv1.Stroke {
		return []*opendesignerv1.Stroke{{Paint: solidPaint(0, 0, 0), Weight: 4, Brush: b}}
	}
	if err := ValidateStrokes(stroke(good())); err != nil {
		t.Fatalf("a good brush: %v", err)
	}
	if err := ValidateStrokes(stroke(&opendesignerv1.Brush{Spacing: math.NaN()})); err != nil {
		t.Fatalf("a NONE brush is the plain stroke and its parameters are not read: %v", err)
	}
	mut := func(f func(b *opendesignerv1.Brush)) []*opendesignerv1.Stroke {
		b := good()
		f(b)
		return stroke(b)
	}
	for name, strokes := range map[string][]*opendesignerv1.Stroke{
		"unknown kind":       mut(func(b *opendesignerv1.Brush) { b.Kind = 9 }),
		"unknown tip":        mut(func(b *opendesignerv1.Brush) { b.Tip = 9 }),
		"spacing zero":       mut(func(b *opendesignerv1.Brush) { b.Spacing = 0 }),
		"spacing too small":  mut(func(b *opendesignerv1.Brush) { b.Spacing = MinBrushSpacing / 2 }),
		"spacing too large":  mut(func(b *opendesignerv1.Brush) { b.Spacing = MaxBrushSpacing + 1 }),
		"scatter negative":   mut(func(b *opendesignerv1.Brush) { b.Scatter = -1 }),
		"scatter too large":  mut(func(b *opendesignerv1.Brush) { b.Scatter = MaxBrushScatter + 1 }),
		"size jitter > 1":    mut(func(b *opendesignerv1.Brush) { b.SizeJitter = 1.5 }),
		"angle jitter > 180": mut(func(b *opendesignerv1.Brush) { b.AngleJitter = 181 }),
		"NaN spacing":        mut(func(b *opendesignerv1.Brush) { b.Spacing = math.NaN() }),
		"infinite scatter":   mut(func(b *opendesignerv1.Brush) { b.Scatter = math.Inf(1) }),
	} {
		if err := ValidateStrokes(strokes); !errors.Is(err, ErrStrokeExtra) {
			t.Errorf("%s: got %v", name, err)
		}
	}
}
