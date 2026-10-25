package mcp

import (
	"fmt"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

// EffectFx holds the parameters of the progressive blur, noise, texture and glass
// effects (docs/effects.md). Every field is optional: a missing one takes the same default
// the editor's panel starts from. Embedded in EffectSpec.
type EffectFx struct {
	StartRadius *float64  `json:"startRadius,omitempty" jsonschema:"progressiveBlur: radius at the start point (default 0)"`
	EndRadius   *float64  `json:"endRadius,omitempty" jsonschema:"progressiveBlur: radius at the end point (default 16)"`
	X1          *float64  `json:"x1,omitempty" jsonschema:"progressiveBlur: start point in the node's unit box, 0..1 (default 0.5)"`
	Y1          *float64  `json:"y1,omitempty" jsonschema:"progressiveBlur: start point (default 0)"`
	X2          *float64  `json:"x2,omitempty" jsonschema:"progressiveBlur: end point (default 0.5)"`
	Y2          *float64  `json:"y2,omitempty" jsonschema:"progressiveBlur: end point (default 1)"`
	Background  bool      `json:"background,omitempty" jsonschema:"progressiveBlur: true blurs what is behind the node (inside its outline), false the node itself"`
	Mode        string    `json:"mode,omitempty" jsonschema:"noise: mono (default) | duo | multi"`
	Size        *float64  `json:"size,omitempty" jsonschema:"noise: grain size in world units (default 1)"`
	Density     *float64  `json:"density,omitempty" jsonschema:"noise: 0..1, share of grains that show (default 0.5)"`
	Opacity     *float64  `json:"opacity,omitempty" jsonschema:"noise: 0..1 (default 0.25)"`
	Color2      StopColor `json:"color2,omitempty" jsonschema:"noise duo: the second colour (color is the first); defaults to white"`
	Seed        *uint32   `json:"seed,omitempty" jsonschema:"noise and texture: the random seed, same seed same grain (default 1)"`
	Scale       *float64  `json:"scale,omitempty" jsonschema:"texture: blob size in world units (default 8)"`
	Intensity   *float64  `json:"intensity,omitempty" jsonschema:"texture: 0..1 (default 0.4)"`
	Frost       *float64  `json:"frost,omitempty" jsonschema:"glass: backdrop blur radius (default 12)"`
	Light       *float64  `json:"light,omitempty" jsonschema:"glass: 0..1 strength of the light edge (default 0.5)"`
	LightAngle  *float64  `json:"lightAngle,omitempty" jsonschema:"glass: degrees, where the light comes from: 0 = left, 90 = top (default 45)"`
	Noise       *float64  `json:"noise,omitempty" jsonschema:"glass: 0..1 strength of the grain (default 0.25)"`
}

func or(p *float64, def float64) float64 {
	if p != nil {
		return *p
	}
	return def
}

func isFxKind(k string) bool {
	return k == "progressiveBlur" || k == "noise" || k == "texture" || k == "glass"
}

func fxColor(c StopColor, def float64) *opendesignerv1.Color {
	if c == (StopColor{}) {
		return &opendesignerv1.Color{R: float32(def), G: float32(def), B: float32(def), A: 1}
	}
	return &opendesignerv1.Color{R: float32(c.R), G: float32(c.G), B: float32(c.B), A: 1}
}

// fxProto builds the proto of a progressiveBlur / noise / texture / glass spec and runs
// the authority's own range check, so the error names the offending field.
func (e EffectSpec) fxProto() (*opendesignerv1.Effect, error) {
	var out *opendesignerv1.Effect
	switch e.Kind {
	case "progressiveBlur":
		out = &opendesignerv1.Effect{Kind: &opendesignerv1.Effect_ProgressiveBlur{ProgressiveBlur: &opendesignerv1.ProgressiveBlur{
			StartRadius: or(e.StartRadius, 0), EndRadius: or(e.EndRadius, 16),
			X1: or(e.X1, 0.5), Y1: or(e.Y1, 0), X2: or(e.X2, 0.5), Y2: or(e.Y2, 1), Background: e.Background,
		}}}
	case "noise":
		mode := opendesignerv1.NoiseMode_NOISE_MODE_MONO
		switch e.Mode {
		case "", "mono":
		case "duo":
			mode = opendesignerv1.NoiseMode_NOISE_MODE_DUO
		case "multi":
			mode = opendesignerv1.NoiseMode_NOISE_MODE_MULTI
		default:
			return nil, fmt.Errorf("mode must be mono, duo or multi, got %q", e.Mode)
		}
		seed := uint32(1)
		if e.Seed != nil {
			seed = *e.Seed
		}
		out = &opendesignerv1.Effect{Kind: &opendesignerv1.Effect_Noise{Noise: &opendesignerv1.Noise{
			Mode: mode, Size: or(e.Size, 1), Density: or(e.Density, 0.5), Opacity: or(e.Opacity, 0.25),
			Color: fxColor(e.Color, 0), Color2: fxColor(e.Color2, 1), Seed: seed,
		}}}
	case "texture":
		seed := uint32(1)
		if e.Seed != nil {
			seed = *e.Seed
		}
		out = &opendesignerv1.Effect{Kind: &opendesignerv1.Effect_Texture{Texture: &opendesignerv1.Texture{
			Scale: or(e.Scale, 8), Intensity: or(e.Intensity, 0.4), Seed: seed,
		}}}
	case "glass":
		out = &opendesignerv1.Effect{Kind: &opendesignerv1.Effect_Glass{Glass: &opendesignerv1.Glass{
			Frost: or(e.Frost, 12), Light: or(e.Light, 0.5), LightAngle: or(e.LightAngle, 45), Noise: or(e.Noise, 0.25),
		}}}
	default:
		return nil, fmt.Errorf("not a type-and-effects kind: %q", e.Kind)
	}
	if err := core.ValidateEffects([]*opendesignerv1.Effect{out}); err != nil {
		return nil, err
	}
	return out, nil
}

// effectKinds names each effect's kind, in order.
func effectKinds(effects []*opendesignerv1.Effect) []string {
	var out []string
	for _, e := range effects {
		switch e.GetKind().(type) {
		case *opendesignerv1.Effect_DropShadow:
			out = append(out, "dropShadow")
		case *opendesignerv1.Effect_InnerShadow:
			out = append(out, "innerShadow")
		case *opendesignerv1.Effect_LayerBlur:
			out = append(out, "layerBlur")
		case *opendesignerv1.Effect_BackgroundBlur:
			out = append(out, "backgroundBlur")
		case *opendesignerv1.Effect_ProgressiveBlur:
			out = append(out, "progressiveBlur")
		case *opendesignerv1.Effect_Noise:
			out = append(out, "noise")
		case *opendesignerv1.Effect_Texture:
			out = append(out, "texture")
		case *opendesignerv1.Effect_Glass:
			out = append(out, "glass")
		}
	}
	return out
}
