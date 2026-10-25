package core

import (
	"errors"
	"fmt"
	"math"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// EFFECT VALUES -- the Go half (the authority) of web/src/store/effects.ts, run on the
// "effects" mask path of SetProperties. Only the effects with a ramp or a bounded
// parameter are checked: progressive blur, noise, texture and glass (docs/effects.md).
// The older kinds keep their historical leniency.
//
//  1. radii (progressive blur, glass frost) are finite and >= 0, at most maxEffectRadius;
//  2. progressive blur points are finite;
//  3. noise/texture density, opacity, intensity and glass light/noise are in 0..1, sizes
//     are finite and >= 0, the noise mode is a known enum, an angle is finite.
var ErrEffectValue = errors.New("core: effect value out of range")

// maxEffectRadius bounds a blur radius, like the renderers do when they clamp it.
const maxEffectRadius = 10000

func unit(v float64) bool     { return !math.IsNaN(v) && v >= 0 && v <= 1 }
func radiusOK(v float64) bool { return !math.IsNaN(v) && v >= 0 && v <= maxEffectRadius }

// ValidateEffects is for the MCP tools, which run the same check before submitting.
func ValidateEffects(effects []*opendesignerv1.Effect) error { return validateEffects(effects) }

func validateEffects(effects []*opendesignerv1.Effect) error {
	for i, e := range effects {
		bad := func(what string) error { return fmt.Errorf("%w: effects[%d] %s", ErrEffectValue, i, what) }
		switch k := e.GetKind().(type) {
		case *opendesignerv1.Effect_ProgressiveBlur:
			p := k.ProgressiveBlur
			if !radiusOK(p.GetStartRadius()) || !radiusOK(p.GetEndRadius()) {
				return bad("progressive blur radius")
			}
			for _, v := range []float64{p.GetX1(), p.GetY1(), p.GetX2(), p.GetY2()} {
				if math.IsNaN(v) || math.IsInf(v, 0) {
					return bad("progressive blur point")
				}
			}
		case *opendesignerv1.Effect_Noise:
			n := k.Noise
			if _, ok := opendesignerv1.NoiseMode_name[int32(n.GetMode())]; !ok {
				return bad("noise mode")
			}
			if !finiteNonNeg(n.GetSize()) || !unit(n.GetDensity()) || !unit(n.GetOpacity()) {
				return bad("noise size, density or opacity")
			}
		case *opendesignerv1.Effect_Texture:
			t := k.Texture
			if !finiteNonNeg(t.GetScale()) || !unit(t.GetIntensity()) {
				return bad("texture scale or intensity")
			}
		case *opendesignerv1.Effect_Glass:
			g := k.Glass
			if !radiusOK(g.GetFrost()) || !unit(g.GetLight()) || !unit(g.GetNoise()) || math.IsNaN(g.GetLightAngle()) || math.IsInf(g.GetLightAngle(), 0) {
				return bad("glass frost, light, angle or noise")
			}
		}
	}
	return nil
}
