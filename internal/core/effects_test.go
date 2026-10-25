package core

import (
	"errors"
	"math"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

func setEffects(t *testing.T, doc *opendesignerv1.Document, fx ...*opendesignerv1.Effect) error {
	t.Helper()
	return Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: "t", Patch: &opendesignerv1.Node{Effects: fx}, Mask: mask("effects")}}})
}

// TestEffectValuesAreValidated: progressive blur, noise, texture and glass are range-checked on
// the effects mask path and a refused write leaves the node as it was; the older kinds stay lenient.
func TestEffectValuesAreValidated(t *testing.T) {
	doc := textDoc(t)
	good := []*opendesignerv1.Effect{
		{Kind: &opendesignerv1.Effect_ProgressiveBlur{ProgressiveBlur: &opendesignerv1.ProgressiveBlur{StartRadius: 0, EndRadius: 20, Y2: 1, Background: true}}},
		{Kind: &opendesignerv1.Effect_Noise{Noise: &opendesignerv1.Noise{Mode: opendesignerv1.NoiseMode_NOISE_MODE_DUO, Size: 2, Density: 0.5, Opacity: 0.3, Seed: 7}}},
		{Kind: &opendesignerv1.Effect_Texture{Texture: &opendesignerv1.Texture{Scale: 8, Intensity: 0.4}}},
		{Kind: &opendesignerv1.Effect_Glass{Glass: &opendesignerv1.Glass{Frost: 12, Light: 0.5, LightAngle: -30, Noise: 0.2}}},
		{Kind: &opendesignerv1.Effect_LayerBlur{LayerBlur: &opendesignerv1.LayerBlur{Radius: -3}}}, // historical leniency
	}
	if err := setEffects(t, doc, good...); err != nil {
		t.Fatal(err)
	}
	if len(doc.Nodes["t"].GetEffects()) != len(good) {
		t.Fatalf("effects = %v", doc.Nodes["t"].GetEffects())
	}

	bad := map[string]*opendesignerv1.Effect{
		"negative radius": {Kind: &opendesignerv1.Effect_ProgressiveBlur{ProgressiveBlur: &opendesignerv1.ProgressiveBlur{EndRadius: -1}}},
		"huge radius":     {Kind: &opendesignerv1.Effect_ProgressiveBlur{ProgressiveBlur: &opendesignerv1.ProgressiveBlur{EndRadius: 1e9}}},
		"nan point":       {Kind: &opendesignerv1.Effect_ProgressiveBlur{ProgressiveBlur: &opendesignerv1.ProgressiveBlur{X1: math.NaN()}}},
		"noise mode":      {Kind: &opendesignerv1.Effect_Noise{Noise: &opendesignerv1.Noise{Mode: 9}}},
		"noise density":   {Kind: &opendesignerv1.Effect_Noise{Noise: &opendesignerv1.Noise{Density: 1.5}}},
		"noise opacity":   {Kind: &opendesignerv1.Effect_Noise{Noise: &opendesignerv1.Noise{Opacity: -0.1}}},
		"noise size":      {Kind: &opendesignerv1.Effect_Noise{Noise: &opendesignerv1.Noise{Size: -1}}},
		"texture":         {Kind: &opendesignerv1.Effect_Texture{Texture: &opendesignerv1.Texture{Intensity: 2}}},
		"glass light":     {Kind: &opendesignerv1.Effect_Glass{Glass: &opendesignerv1.Glass{Light: 3}}},
		"glass angle":     {Kind: &opendesignerv1.Effect_Glass{Glass: &opendesignerv1.Glass{LightAngle: math.Inf(1)}}},
	}
	for name, e := range bad {
		err := setEffects(t, doc, e)
		if !errors.Is(err, ErrEffectValue) {
			t.Errorf("%s: err = %v, want ErrEffectValue", name, err)
		}
	}
	if len(doc.Nodes["t"].GetEffects()) != len(good) {
		t.Fatalf("a refused write changed the effects: %v", doc.Nodes["t"].GetEffects())
	}
}
