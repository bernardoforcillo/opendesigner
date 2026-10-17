package core

import (
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// NUMBER and INSTANCE_SWAP properties, option lists on TEXT, and rename-aware set edits.

const (
	tText   = opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_TEXT
	tNumber = opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_NUMBER
	tSwap   = opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_INSTANCE_SWAP
)

func setDef(c string, props ...*opendesignerv1.ComponentProperty) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComponentDef{SetComponentDef: &opendesignerv1.SetComponentDef{
		ComponentId: c, Properties: props}}}
}

func numProp(name string, typ opendesignerv1.ComponentPropertyType, def, attr string, targets ...string) *opendesignerv1.ComponentProperty {
	return &opendesignerv1.ComponentProperty{Name: name, Type: typ, DefaultValue: def, Attribute: attr, TargetNodeIds: targets}
}

func TestNumberSwapAndOptionProperties(t *testing.T) {
	doc := buttonSet(t)
	// A nested instance of c-hover inside the master of c-default.
	mustApply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: &opendesignerv1.Node{
		Id: "nested", ParentId: "m1", OrderKey: "z", Visible: true, Opacity: 1, Width: 5, Height: 5,
		Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: "c-hover"}}}}}})
	tone := numProp("Tone", tText, "a", "", "label")
	tone.Options = []string{"a", "b"}
	// A plain definition, no set (SetComponentDef replaces the membership wholesale).
	good := []*opendesignerv1.ComponentProperty{
		numProp("Opacity", tNumber, "0.5", "opacity", "label"),
		numProp("Radius", tNumber, "4", "corner_radius", "icon"),
		numProp("Size", tNumber, "16", "font_size", "label"),
		numProp("Nested", tSwap, "c-hover", "", "nested"),
		tone,
	}
	mustApply(t, doc, setDef("c-default", good...))
	if len(doc.Components["c-default"].GetProperties()) != 5 {
		t.Fatal("valid properties not stored")
	}

	bad := map[string]*opendesignerv1.ComponentProperty{
		"opacity out of range":     numProp("X", tNumber, "2", "opacity", "label"),
		"no attribute":             numProp("X", tNumber, "1", "", "label"),
		"unknown attribute":        numProp("X", tNumber, "1", "width", "label"),
		"not a number":             numProp("X", tNumber, "0x10", "font_size", "label"),
		"radius on a text":         numProp("X", tNumber, "4", "corner_radius", "label"),
		"size on a rect":           numProp("X", tNumber, "4", "font_size", "icon"),
		"attribute on a text prop": {Name: "X", Type: tText, Attribute: "opacity", TargetNodeIds: []string{"label"}},
		"swap onto a non-instance": numProp("X", tSwap, "c-hover", "", "label"),
		"swap to a missing comp":   numProp("X", tSwap, "ghost", "", "nested"),
		"swap into itself":         numProp("X", tSwap, "c-default", "", "nested"),
		"default outside options":  {Name: "X", Type: tText, DefaultValue: "z", Options: []string{"a"}, TargetNodeIds: []string{"label"}},
		"duplicate option":         {Name: "X", Type: tText, DefaultValue: "a", Options: []string{"a", "a"}, TargetNodeIds: []string{"label"}},
		"options on a number":      {Name: "X", Type: tNumber, DefaultValue: "1", Attribute: "opacity", Options: []string{"1"}, TargetNodeIds: []string{"label"}},
	}
	for name, p := range bad {
		if err := Apply(doc, setDef("c-default", p)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if len(doc.Components["c-default"].GetProperties()) != 5 {
		t.Fatal("a rejected definition changed the component")
	}

	// Values are validated per type.
	for name, v := range map[string]string{"Opacity": "0.2", "Radius": "8", "Size": "20", "Nested": "c-default", "Tone": "b"} {
		if err := setInstanceProps(t, doc, map[string]string{name: v}, nil); err != nil {
			t.Errorf("%s=%s: %v", name, v, err)
		}
	}
	for name, v := range map[string]string{"Opacity": "1.5", "Radius": "-1", "Size": "0", "Nested": "ghost", "Tone": "free"} {
		if err := setInstanceProps(t, doc, map[string]string{name: v}, nil); err == nil {
			t.Errorf("%s=%s accepted", name, v)
		}
	}
	// An invalid stored value falls back to the default.
	byName := map[string]*opendesignerv1.ComponentProperty{}
	for _, p := range doc.Components["c-default"].GetProperties() {
		byName[p.GetName()] = p
	}
	inst := &opendesignerv1.InstanceNode{ComponentId: "c-default", PropertyValues: map[string]string{"Opacity": "9", "Tone": "b"}}
	if got := PropertyValue(doc, inst, byName["Opacity"]); got != "0.5" {
		t.Errorf("an invalid number should fall back to the default, got %q", got)
	}
	if got := PropertyValue(doc, inst, byName["Tone"]); got != "b" {
		t.Errorf("option value = %q", got)
	}
}

func renameOp(axes map[string]string, opts []*opendesignerv1.OptionRename, axis string, options ...string) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComponentSet{SetComponentSet: &opendesignerv1.SetComponentSet{
		ComponentSet: &opendesignerv1.ComponentSet{Id: "s", Name: "Button", Axes: []*opendesignerv1.VariantAxis{{Name: axis, Options: options}}},
		AxisRenames:  axes, OptionRenames: opts}}}
}

func TestRenamesKeepMembersAndInstancesChoices(t *testing.T) {
	doc := buttonSet(t)
	mustApply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstanceProps{SetInstanceProps: &opendesignerv1.SetInstanceProps{
		InstanceId: "i", VariantProps: map[string]string{"State": "hover"}}}})
	// Without the renames this would detach both members; with them nothing is lost.
	mustApply(t, doc, renameOp(map[string]string{"State": "Mode"},
		[]*opendesignerv1.OptionRename{{Axis: "Mode", From: "hover", To: "pressed"}}, "Mode", "default", "pressed", "off"))
	if c := doc.Components["c-hover"]; c.GetVariant()["Mode"] != "pressed" || len(c.GetVariant()) != 1 || c.GetSetId() != "s" {
		t.Fatalf("member lost its choice: %v", c)
	}
	if v := doc.Components["c-default"].GetVariant(); v["Mode"] != "default" {
		t.Fatalf("untouched option changed: %v", v)
	}
	if v := doc.Nodes["i"].GetInstance().GetVariantProps(); v["Mode"] != "pressed" || len(v) != 1 {
		t.Fatalf("instance lost its choice: %v", v)
	}
	if got := EffectiveComponentID(doc, doc.Nodes["i"].GetInstance()); got != "c-hover" {
		t.Fatalf("instance resolves to %s", got)
	}

	for name, op := range map[string]*opendesignerv1.Op{
		"axis to nothing":      renameOp(map[string]string{"Mode": "Ghost"}, nil, "Mode", "default", "pressed", "off"),
		"option to nothing":    renameOp(nil, []*opendesignerv1.OptionRename{{Axis: "Mode", From: "pressed", To: "huge"}}, "Mode", "default", "pressed"),
		"unknown new axis":     renameOp(nil, []*opendesignerv1.OptionRename{{Axis: "Ghost", From: "a", To: "b"}}, "Mode", "default", "pressed"),
		"two axes into one":    renameOp(map[string]string{"A": "Mode", "B": "Mode"}, nil, "Mode", "default", "pressed"),
		"two options into one": renameOp(nil, []*opendesignerv1.OptionRename{{Axis: "Mode", From: "pressed", To: "default"}, {Axis: "Mode", From: "x", To: "default"}}, "Mode", "default", "pressed"),
		"merging two members":  renameOp(nil, []*opendesignerv1.OptionRename{{Axis: "Mode", From: "pressed", To: "default"}}, "Mode", "default", "off"),
	} {
		if err := Apply(doc, op); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if doc.Components["c-hover"].GetVariant()["Mode"] != "pressed" || len(doc.ComponentSets["s"].GetAxes()[0].GetOptions()) != 3 {
		t.Fatal("a rejected rename changed the document")
	}
}
