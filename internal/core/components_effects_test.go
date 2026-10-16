package core

import (
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

func TestEffectsCarryNumbersAndSwaps(t *testing.T) {
	doc := buttonSet(t)
	mustApply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: &opendesignerv1.Node{
		Id: "nested", ParentId: "m1", OrderKey: "z", Visible: true, Opacity: 1, Width: 5, Height: 5,
		Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: "c-default"}}}}}})
	// SetComponentDef replaces the membership wholesale: keep c-default in its set.
	mustApply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComponentDef{SetComponentDef: &opendesignerv1.SetComponentDef{
		ComponentId: "c-default", SetId: "s", Variant: map[string]string{"State": "default"},
		Properties: []*opendesignerv1.ComponentProperty{
			numProp("Opacity", tNumber, "0.5", "opacity", "label"),
			numProp("Radius", tNumber, "4", "corner_radius", "icon"),
			numProp("Size", tNumber, "16", "font_size", "label"),
			numProp("Nested", tSwap, "", "", "nested"),
		}}}})
	inst := doc.Nodes["i"].GetInstance()
	fx := EffectsOf(doc, inst, "")
	if fx.Opacity["label"] != 0.5 || fx.CornerRadius["icon"] != 4 || fx.FontSize["label"] != 16 || len(fx.Swap) != 0 {
		t.Fatalf("defaults: %+v", fx)
	}
	if err := setInstanceProps(t, doc, map[string]string{"Opacity": "0.2", "Nested": "c-hover"}, nil); err != nil {
		t.Fatal(err)
	}
	fx = EffectsOf(doc, inst, "")
	if fx.Opacity["label"] != 0.2 || fx.Swap["nested"] != "c-hover" {
		t.Fatalf("values: %+v", fx)
	}
	// A number is not a text override.
	if ov, _ := EffectiveOverrides(doc, inst); ov["label"] != nil {
		t.Fatalf("a number must not become a text override: %v", ov["label"])
	}
	// A nested instance that a swap pointed at another component resolves through it.
	nested := &opendesignerv1.InstanceNode{ComponentId: "c-default", VariantProps: map[string]string{"State": "hover"}}
	if got := EffectiveComponentIDSwapped(doc, nested, "c-default"); got != "c-hover" {
		t.Fatalf("swapped: %s", got)
	}
	if got := EffectiveComponentIDSwapped(doc, &opendesignerv1.InstanceNode{ComponentId: "c-default"}, "c-hover"); got != "c-hover" {
		t.Fatalf("swapped without a choice: %s", got)
	}
	if got := EffectiveComponentIDSwapped(doc, &opendesignerv1.InstanceNode{ComponentId: "c-default"}, "ghost"); got != "c-default" {
		t.Fatalf("an unknown swap target is ignored: %s", got)
	}
}
