package codegen

import (
	"math"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
)

// Glass is sugar over other effects (web/src/renderer/effectsFx.ts::expandGlass, which this
// repeats): a backdrop blur and two inner shadows for the light edge. The grain is not
// exported to CSS, and neither are noise, texture or a progressive blur (CSS blurs are
// uniform): the code carries what CSS can say, Inspect lists the rest.

// withGlassExpanded returns n with its glass effects replaced by their parts (n itself when
// it has none).
func withGlassExpanded(n *opendesignerv1.Node) *opendesignerv1.Node {
	has := false
	for _, e := range n.GetEffects() {
		if e.GetGlass() != nil {
			has = true
		}
	}
	if !has {
		return n
	}
	out := proto.Clone(n).(*opendesignerv1.Node)
	out.Effects = nil
	for _, e := range n.GetEffects() {
		g := e.GetGlass()
		if g == nil {
			out.Effects = append(out.Effects, e)
			continue
		}
		a := g.GetLightAngle() * math.Pi / 180
		dx, dy := math.Cos(a), math.Sin(a)
		light := math.Min(1, math.Max(0, g.GetLight()))
		if g.GetFrost() > 0 {
			out.Effects = append(out.Effects, &opendesignerv1.Effect{Kind: &opendesignerv1.Effect_BackgroundBlur{BackgroundBlur: &opendesignerv1.BackgroundBlur{Radius: g.GetFrost()}}})
		}
		if light > 0 {
			out.Effects = append(out.Effects,
				&opendesignerv1.Effect{Kind: &opendesignerv1.Effect_InnerShadow{InnerShadow: &opendesignerv1.InnerShadow{
					Color: &opendesignerv1.Color{R: 1, G: 1, B: 1, A: float32(light)}, OffsetX: dx * 1.5, OffsetY: dy * 1.5, Blur: 1}}},
				&opendesignerv1.Effect{Kind: &opendesignerv1.Effect_InnerShadow{InnerShadow: &opendesignerv1.InnerShadow{
					Color: &opendesignerv1.Color{A: float32(light * 0.25)}, OffsetX: -dx * 1.5, OffsetY: -dy * 1.5, Blur: 1}}},
			)
		}
	}
	return out
}
