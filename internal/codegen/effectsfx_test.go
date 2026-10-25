package codegen_test

import (
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	. "github.com/bernardoforcillo/opendesigner/internal/codegen/samples"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

// TestGlassInTheExport: glass is exported as its parts (a backdrop blur and the light edge as
// inset shadows); noise, texture and a progressive blur are left out of the CSS.
func TestGlassInTheExport(t *testing.T) {
	doc := screenDoc(func(b *B, s string) {
		b.Add("card", s, "Card", 20, 20, 100, 100, Fill(Solid(C(1, 1, 1))))
	})
	apply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: "card",
		Patch: &opendesignerv1.Node{Effects: []*opendesignerv1.Effect{
			{Kind: &opendesignerv1.Effect_Glass{Glass: &opendesignerv1.Glass{Frost: 14, Light: 0.5, LightAngle: 0, Noise: 0.3}}},
			{Kind: &opendesignerv1.Effect_Noise{Noise: &opendesignerv1.Noise{Size: 1, Density: 0.5, Opacity: 0.2}}},
			{Kind: &opendesignerv1.Effect_ProgressiveBlur{ProgressiveBlur: &opendesignerv1.ProgressiveBlur{EndRadius: 8, Y2: 1}}},
		}},
		Mask: &fieldmaskpb.FieldMask{Paths: []string{"effects"}},
	}}})
	html := screenHTML(t, doc)
	for _, want := range []string{"backdrop-filter: blur(14px);", "inset 1.5px 0 1px rgba(255,255,255,0.5)", "inset -1.5px"} {
		if !strings.Contains(html, want) {
			t.Errorf("missing %q in:\n%s", want, html)
		}
	}
	if strings.Contains(html, "feTurbulence") || strings.Contains(html, "noise") {
		t.Errorf("noise must not reach the CSS:\n%s", html)
	}
}
