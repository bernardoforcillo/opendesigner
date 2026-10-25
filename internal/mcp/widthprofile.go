package mcp

import (
	"fmt"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// WidthPointSpec is one point of a variable-width stroke: `position` runs 0..1 along each subpath and
// `left` / `right` are the half-widths on either side of the direction of travel, as multiples of half
// the stroke weight (1 / 1 is the uniform stroke).
type WidthPointSpec struct {
	Position float64 `json:"position"`
	Left     float64 `json:"left"`
	Right    float64 `json:"right"`
}

// widthPresets mirrors web/src/vector/widthProfile.ts::WIDTH_PRESETS, so both ends offer the same shapes.
var widthPresets = map[string][]WidthPointSpec{
	"":            nil,
	"uniform":     nil,
	"taper":       {{Position: 0, Left: 1, Right: 1}, {Position: 1, Left: 0, Right: 0}},
	"taper-start": {{Position: 0, Left: 0, Right: 0}, {Position: 1, Left: 1, Right: 1}},
	"lens":        {{Position: 0, Left: 0, Right: 0}, {Position: 0.5, Left: 1, Right: 1}, {Position: 1, Left: 0, Right: 0}},
	"bulge":       {{Position: 0, Left: 0.4, Right: 0.4}, {Position: 0.5, Left: 1.6, Right: 1.6}, {Position: 1, Left: 0.4, Right: 0.4}},
	"pinch":       {{Position: 0, Left: 1, Right: 1}, {Position: 0.5, Left: 0.3, Right: 0.3}, {Position: 1, Left: 1, Right: 1}},
	"brush":       {{Position: 0, Left: 0.1, Right: 0.1}, {Position: 0.15, Left: 1.2, Right: 1.2}, {Position: 0.7, Left: 0.8, Right: 0.8}, {Position: 1, Left: 0, Right: 0}},
}

// widthProfileOf resolves a spec's explicit points, or its preset. The range checks are the authority's
// (core.ValidateStrokes), run on the whole list afterwards.
func widthProfileOf(sp StrokeSpec) ([]*opendesignerv1.WidthPoint, error) {
	pts := sp.WidthProfile
	if len(pts) == 0 {
		preset, ok := widthPresets[sp.WidthPreset]
		if !ok {
			return nil, fmt.Errorf("widthPreset must be uniform, taper, taper-start, lens, bulge, pinch or brush, got %q", sp.WidthPreset)
		}
		pts = preset
	}
	var out []*opendesignerv1.WidthPoint
	for _, p := range pts {
		out = append(out, &opendesignerv1.WidthPoint{Position: p.Position, Left: p.Left, Right: p.Right})
	}
	return out, nil
}
