package mcp

import (
	"fmt"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// BrushSpec is a stroke brush for set_stroke: a preset, or a kind with its parameters, or a preset with some
// parameters overridden. Distances are multiples of the stroke weight. Vectors only.
type BrushSpec struct {
	Preset      string   `json:"preset,omitempty" jsonschema:"chalk | marker | dots | leaves | none; the fields below override the preset's"`
	Kind        string   `json:"kind,omitempty" jsonschema:"stretch (tiles end to end) | scatter (tips every spacing); required without a preset"`
	Tip         string   `json:"tip,omitempty" jsonschema:"dot | dash | square | diamond | leaf"`
	Spacing     *float64 `json:"spacing,omitempty" jsonschema:"0.05..64 weights between stamps (stretch: the tile length)"`
	Scatter     *float64 `json:"scatter,omitempty" jsonschema:"0..8 weights of random spread across the path"`
	SizeJitter  *float64 `json:"sizeJitter,omitempty" jsonschema:"0..1 random scale of a stamp"`
	AngleJitter *float64 `json:"angleJitter,omitempty" jsonschema:"0..180 degrees of random turn"`
	Seed        *uint32  `json:"seed,omitempty" jsonschema:"seeds the jitter; the same seed draws the same marks"`
}

var brushKinds = map[string]opendesignerv1.BrushKind{
	"": opendesignerv1.BrushKind_BRUSH_KIND_NONE, "none": opendesignerv1.BrushKind_BRUSH_KIND_NONE,
	"stretch": opendesignerv1.BrushKind_BRUSH_KIND_STRETCH, "scatter": opendesignerv1.BrushKind_BRUSH_KIND_SCATTER,
}

var brushTips = map[string]opendesignerv1.BrushTip{
	"": opendesignerv1.BrushTip_BRUSH_TIP_DOT, "dot": opendesignerv1.BrushTip_BRUSH_TIP_DOT,
	"dash": opendesignerv1.BrushTip_BRUSH_TIP_DASH, "square": opendesignerv1.BrushTip_BRUSH_TIP_SQUARE,
	"diamond": opendesignerv1.BrushTip_BRUSH_TIP_DIAMOND, "leaf": opendesignerv1.BrushTip_BRUSH_TIP_LEAF,
}

// brushPresets mirrors web/src/vector/brushSpec.ts::BRUSH_PRESETS, so both ends offer the same brushes.
var brushPresets = map[string]*opendesignerv1.Brush{
	"chalk":  {Kind: opendesignerv1.BrushKind_BRUSH_KIND_SCATTER, Tip: opendesignerv1.BrushTip_BRUSH_TIP_DOT, Spacing: 0.15, Scatter: 0.6, SizeJitter: 0.5, AngleJitter: 0, Seed: 1},
	"marker": {Kind: opendesignerv1.BrushKind_BRUSH_KIND_STRETCH, Tip: opendesignerv1.BrushTip_BRUSH_TIP_DASH, Spacing: 0.6, Scatter: 0, SizeJitter: 0.2, AngleJitter: 0, Seed: 2},
	"dots":   {Kind: opendesignerv1.BrushKind_BRUSH_KIND_SCATTER, Tip: opendesignerv1.BrushTip_BRUSH_TIP_DOT, Spacing: 2, Scatter: 0, SizeJitter: 0, AngleJitter: 0, Seed: 3},
	"leaves": {Kind: opendesignerv1.BrushKind_BRUSH_KIND_SCATTER, Tip: opendesignerv1.BrushTip_BRUSH_TIP_LEAF, Spacing: 1.5, Scatter: 0.8, SizeJitter: 0.4, AngleJitter: 60, Seed: 4},
}

// brushOf resolves a spec to a message: nil for no brush. The range checks are the authority's
// (core.ValidateStrokes), run on the whole list afterwards.
func brushOf(sp *BrushSpec) (*opendesignerv1.Brush, error) {
	if sp == nil || sp.Preset == "none" {
		return nil, nil
	}
	b := &opendesignerv1.Brush{}
	if sp.Preset != "" {
		p, ok := brushPresets[sp.Preset]
		if !ok {
			return nil, fmt.Errorf("brush.preset must be chalk, marker, dots, leaves or none, got %q", sp.Preset)
		}
		b = &opendesignerv1.Brush{Kind: p.Kind, Tip: p.Tip, Spacing: p.Spacing, Scatter: p.Scatter, SizeJitter: p.SizeJitter, AngleJitter: p.AngleJitter, Seed: p.Seed}
	}
	if sp.Kind != "" {
		k, ok := brushKinds[sp.Kind]
		if !ok {
			return nil, fmt.Errorf("brush.kind must be stretch, scatter or none, got %q", sp.Kind)
		}
		b.Kind = k
	}
	if sp.Tip != "" {
		t, ok := brushTips[sp.Tip]
		if !ok {
			return nil, fmt.Errorf("brush.tip must be dot, dash, square, diamond or leaf, got %q", sp.Tip)
		}
		b.Tip = t
	}
	if sp.Spacing != nil {
		b.Spacing = *sp.Spacing
	}
	if sp.Scatter != nil {
		b.Scatter = *sp.Scatter
	}
	if sp.SizeJitter != nil {
		b.SizeJitter = *sp.SizeJitter
	}
	if sp.AngleJitter != nil {
		b.AngleJitter = *sp.AngleJitter
	}
	if sp.Seed != nil {
		b.Seed = *sp.Seed
	}
	if b.Kind == opendesignerv1.BrushKind_BRUSH_KIND_NONE {
		if sp.Preset == "" {
			return nil, fmt.Errorf("brush needs a preset or a kind (stretch | scatter)")
		}
		return nil, nil
	}
	if b.Spacing == 0 {
		b.Spacing = 1 // a kind without a spacing: one weight
	}
	return b, nil
}
