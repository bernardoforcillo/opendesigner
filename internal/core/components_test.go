package core

import (
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// buttonSet builds a two-variant "Button" set: c-default (m1: label, icon) and
// c-hover (m2: label2, icon2), both with a text property Label and a boolean ShowIcon,
// and an instance i of c-default.
func buttonSet(t *testing.T) *opendesignerv1.Document {
	t.Helper()
	doc := NewDocument("d", "d")
	node := func(id, parent string, shape func(*opendesignerv1.Node)) *opendesignerv1.Op {
		n := &opendesignerv1.Node{Id: id, ParentId: parent, OrderKey: id, Visible: true, Opacity: 1, Width: 10, Height: 10}
		shape(n)
		return &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}}
	}
	frame := func(n *opendesignerv1.Node) { n.Shape = &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}} }
	text := func(n *opendesignerv1.Node) {
		n.Shape = &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{Content: "Button", Style: &opendesignerv1.TextStyle{FontSize: 14}}}
	}
	rect := func(n *opendesignerv1.Node) { n.Shape = &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}} }
	props := func(label, icon string) []*opendesignerv1.ComponentProperty {
		return []*opendesignerv1.ComponentProperty{
			{Name: "Label", Type: opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_TEXT, DefaultValue: "Button", TargetNodeIds: []string{label}},
			{Name: "ShowIcon", Type: opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_BOOLEAN, DefaultValue: "true", TargetNodeIds: []string{icon}},
		}
	}
	def := func(c, state string, p []*opendesignerv1.ComponentProperty) *opendesignerv1.Op {
		return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComponentDef{SetComponentDef: &opendesignerv1.SetComponentDef{
			ComponentId: c, SetId: "s", Variant: map[string]string{"State": state}, Properties: p}}}
	}
	mustApply(t, doc,
		node("m1", "page1", frame), node("label", "m1", text), node("icon", "m1", rect),
		node("m2", "page1", frame), node("label2", "m2", text), node("icon2", "m2", rect),
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateComponent{CreateComponent: &opendesignerv1.CreateComponent{ComponentId: "c-default", RootNodeId: "m1", Name: "Button"}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateComponent{CreateComponent: &opendesignerv1.CreateComponent{ComponentId: "c-hover", RootNodeId: "m2", Name: "Button hover"}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComponentSet{SetComponentSet: &opendesignerv1.SetComponentSet{ComponentSet: &opendesignerv1.ComponentSet{
			Id: "s", Name: "Button", Axes: []*opendesignerv1.VariantAxis{{Name: "State", Options: []string{"default", "hover"}}}}}}},
		def("c-default", "default", props("label", "icon")),
		def("c-hover", "hover", props("label2", "icon2")),
		node("i", "page1", func(n *opendesignerv1.Node) {
			n.Shape = &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: "c-default"}}
		}),
	)
	return doc
}

func setInstanceProps(t *testing.T, doc *opendesignerv1.Document, values, variants map[string]string) error {
	t.Helper()
	return Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstanceProps{SetInstanceProps: &opendesignerv1.SetInstanceProps{
		InstanceId: "i", PropertyValues: values, VariantProps: variants}}})
}

func TestInstanceResolvesToTheChosenVariant(t *testing.T) {
	doc := buttonSet(t)
	inst := func() *opendesignerv1.InstanceNode { return doc.Nodes["i"].GetInstance() }
	if got := EffectiveComponentID(doc, inst()); got != "c-default" {
		t.Fatalf("no choice: %s", got)
	}
	if err := setInstanceProps(t, doc, nil, map[string]string{"State": "hover"}); err != nil {
		t.Fatal(err)
	}
	if got := EffectiveComponentID(doc, inst()); got != "c-hover" {
		t.Fatalf("State=hover: %s", got)
	}
	// A choice that no member matches (stale after the set changed) falls back to the base.
	inst().VariantProps = map[string]string{"State": "pressed"}
	if got := EffectiveComponentID(doc, inst()); got != "c-default" {
		t.Fatalf("stale choice: %s", got)
	}
}

func TestPropertiesBecomeOverridesAndHiddenNodes(t *testing.T) {
	doc := buttonSet(t)
	// Defaults: the text property sets the label, nothing is hidden.
	ov, hidden := EffectiveOverrides(doc, doc.Nodes["i"].GetInstance())
	if ov["label"].GetText() != "Button" || len(hidden) != 0 {
		t.Fatalf("defaults: %v %v", ov, hidden)
	}
	if err := setInstanceProps(t, doc, map[string]string{"Label": "Save", "ShowIcon": "false"}, map[string]string{"State": "hover"}); err != nil {
		t.Fatal(err)
	}
	ov, hidden = EffectiveOverrides(doc, doc.Nodes["i"].GetInstance())
	// By NAME across variants: the values land on the HOVER variant's nodes.
	if ov["label2"].GetText() != "Save" || !hidden["icon2"] || hidden["icon"] || ov["label"] != nil {
		t.Fatalf("hover variant: %v %v", ov, hidden)
	}
	// An explicit override wins over the property-derived one.
	mustApply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstanceOverride{SetInstanceOverride: &opendesignerv1.SetInstanceOverride{
		InstanceId: "i", Override: &opendesignerv1.InstanceOverride{MasterNodeId: "label2", Text: "Explicit", TextPresent: true}}}})
	ov, _ = EffectiveOverrides(doc, doc.Nodes["i"].GetInstance())
	if ov["label2"].GetText() != "Explicit" {
		t.Fatalf("explicit override: %v", ov["label2"])
	}
	// An invalid stored value (the property changed type under it) is ignored for the default.
	doc.Nodes["i"].GetInstance().PropertyValues["ShowIcon"] = "perhaps"
	_, hidden = EffectiveOverrides(doc, doc.Nodes["i"].GetInstance())
	if hidden["icon2"] {
		t.Fatal("an invalid boolean value must fall back to the default (shown)")
	}
}

func TestSetInstancePropsKeepsSharedNodesIntact(t *testing.T) {
	doc := buttonSet(t)
	shared := doc.Nodes["i"]
	cow := NewShared()
	if err := ApplyShared(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstanceProps{SetInstanceProps: &opendesignerv1.SetInstanceProps{
		InstanceId: "i", PropertyValues: map[string]string{"Label": "Save"}}}}, cow); err != nil {
		t.Fatal(err)
	}
	if len(shared.GetInstance().GetPropertyValues()) != 0 {
		t.Fatal("setInstanceProps wrote through a shared node")
	}
	if doc.Nodes["i"].GetInstance().GetPropertyValues()["Label"] != "Save" {
		t.Fatal("the value was not stored")
	}
}
