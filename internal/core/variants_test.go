package core

import (
	"errors"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

func setOp(id, name string, props ...*opendesignerv1.VariantProperty) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComponentSet{SetComponentSet: &opendesignerv1.SetComponentSet{
		Set: &opendesignerv1.ComponentSet{Id: id, Name: name, Properties: props}}}}
}

func prop(name string, values ...string) *opendesignerv1.VariantProperty {
	return &opendesignerv1.VariantProperty{Name: name, Values: values}
}

func variantOp(comp, set string, v map[string]string) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComponentVariant{SetComponentVariant: &opendesignerv1.SetComponentVariant{ComponentId: comp, SetId: set, Variant: v}}}
}

func swapOp(inst, comp string) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SwapInstance{SwapInstance: &opendesignerv1.SwapInstance{InstanceId: inst, ComponentId: comp}}}
}

// button builds a master frame "name" with a child text "Label", and registers it as component id.
func button(t *testing.T, doc *opendesignerv1.Document, id, order string) (root, label string) {
	t.Helper()
	root, label = id+"-root", id+"-label"
	addNode(t, doc, &opendesignerv1.Node{Id: root, Name: "Button", OrderKey: order, Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}})
	n := &opendesignerv1.Node{Id: label, Name: "Label", OrderKey: "a", Shape: &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{Content: id}}}
	n.ParentId, n.Visible, n.Opacity = root, true, 1
	applyAll(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateComponent{CreateComponent: &opendesignerv1.CreateComponent{ComponentId: id, RootNodeId: root, Name: "Button/" + id}}})
	return root, label
}

func TestComponentSetValidation(t *testing.T) {
	doc := NewDocument("d", "d")
	for name, op := range map[string]*opendesignerv1.Op{
		"no id":           setOp("", "Button"),
		"no name":         setOp("s", ""),
		"empty property":  setOp("s", "B", prop("", "a")),
		"dup property":    setOp("s", "B", prop("Size", "a"), prop("Size", "b")),
		"no values":       setOp("s", "B", prop("Size")),
		"duplicate value": setOp("s", "B", prop("Size", "a", "a")),
		"empty value":     setOp("s", "B", prop("Size", "")),
	} {
		if err := Apply(doc, op); err == nil {
			t.Errorf("%s: must be refused", name)
		}
	}
	applyAll(t, doc, setOp("s", "Button", prop("Size", "S", "L"), prop("State", "Default", "Hover")))
	if len(doc.ComponentSets["s"].Properties) != 2 {
		t.Fatal("set not stored")
	}
}

func TestVariantAssignment(t *testing.T) {
	doc := NewDocument("d", "d")
	button(t, doc, "a", "a")
	button(t, doc, "b", "b")
	applyAll(t, doc, setOp("s", "Button", prop("Size", "S", "L")))
	applyAll(t, doc, variantOp("a", "s", map[string]string{"Size": "S"}))
	if c := doc.Components["a"]; c.SetId != "s" || c.Variant["Size"] != "S" {
		t.Fatalf("component not assigned: %v", c)
	}
	for name, op := range map[string]*opendesignerv1.Op{
		"duplicate combination": variantOp("b", "s", map[string]string{"Size": "S"}),
		"unknown value":         variantOp("b", "s", map[string]string{"Size": "XL"}),
		"missing property":      variantOp("b", "s", map[string]string{}),
		"extra property":        variantOp("b", "s", map[string]string{"Size": "L", "Color": "red"}),
		"unknown set":           variantOp("b", "ghost", map[string]string{"Size": "L"}),
		"unknown component":     variantOp("ghost", "s", map[string]string{"Size": "L"}),
		"variant without set":   variantOp("b", "", map[string]string{"Size": "L"}),
	} {
		if err := Apply(doc, op); err == nil {
			t.Errorf("%s: must be refused", name)
		}
	}
	// A set edit that would make two members identical is refused.
	applyAll(t, doc, variantOp("b", "s", map[string]string{"Size": "L"}))
	if err := Apply(doc, setOp("s", "Button", prop("Size", "X"))); !errors.Is(err, ErrBadVariant) {
		t.Fatalf("a migration that merges two variants: want ErrBadVariant, got %v", err)
	}
	// Adding a value is fine; detaching works; deleting the set detaches members.
	applyAll(t, doc, setOp("s", "Button", prop("Size", "S", "L", "XL")), variantOp("b", "s", map[string]string{"Size": "XL"}))
	applyAll(t, doc, variantOp("b", "", nil))
	if doc.Components["b"].SetId != "" {
		t.Fatal("detach did not clear the set")
	}
	applyAll(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteComponentSet{DeleteComponentSet: &opendesignerv1.DeleteComponentSet{Id: "s"}}})
	if doc.Components["a"].SetId != "" || len(doc.Components["a"].Variant) != 0 || len(doc.ComponentSets) != 0 {
		t.Fatalf("deleting the set must detach its members: %v", doc.Components["a"])
	}
	if err := Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteComponentSet{DeleteComponentSet: &opendesignerv1.DeleteComponentSet{Id: "s"}}}); !errors.Is(err, ErrSetNotFound) {
		t.Fatalf("deleting twice: want ErrSetNotFound, got %v", err)
	}
}

func TestSwapInstanceRemapsOverridesByNamePath(t *testing.T) {
	doc := NewDocument("d", "d")
	_, labelA := button(t, doc, "a", "a")
	_, labelB := button(t, doc, "b", "b")
	inst := &opendesignerv1.Node{Id: "i", Name: "Inst", OrderKey: "z", Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: "a"}}}
	addNode(t, doc, inst)
	override := &opendesignerv1.InstanceOverride{MasterNodeId: labelA, TextPresent: true, Text: "Custom"}
	// An override on a master node that has no counterpart in the target must be dropped.
	extra := &opendesignerv1.Node{Id: "a-extra", Name: "Only in A", OrderKey: "b", ParentId: "a-root", Visible: true, Opacity: 1, Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}}}
	applyAll(t, doc,
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: extra}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstanceOverride{SetInstanceOverride: &opendesignerv1.SetInstanceOverride{InstanceId: "i", Override: override}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstanceOverride{SetInstanceOverride: &opendesignerv1.SetInstanceOverride{InstanceId: "i",
			Override: &opendesignerv1.InstanceOverride{MasterNodeId: "a-extra", FillsPresent: true, Fills: []*opendesignerv1.Paint{{Kind: &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{Color: col(1, 0, 0)}}}}}}}},
	)
	applyAll(t, doc, swapOp("i", "b"))
	got := doc.Nodes["i"].GetInstance()
	if got.ComponentId != "b" || len(got.Overrides) != 1 || got.Overrides[0].MasterNodeId != labelB || got.Overrides[0].Text != "Custom" {
		t.Fatalf("overrides must follow the label to the new master and the orphan be dropped: %v", got)
	}
	for name, op := range map[string]*opendesignerv1.Op{
		"unknown instance":  swapOp("ghost", "a"),
		"unknown component": swapOp("i", "ghost"),
		"not an instance":   swapOp("a-root", "a"),
	} {
		if err := Apply(doc, op); err == nil {
			t.Errorf("%s: must be refused", name)
		}
	}
	// An instance inside the master of A cannot be pointed at A.
	inside := &opendesignerv1.Node{Id: "in", Name: "Inside", OrderKey: "c", ParentId: "a-root", Visible: true, Opacity: 1,
		Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: "b"}}}
	applyAll(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: inside}}})
	if err := Apply(doc, swapOp("in", "a")); !errors.Is(err, ErrBadSwap) {
		t.Fatalf("a component cannot contain an instance of itself: want ErrBadSwap, got %v", err)
	}
}

func TestSetEditMigratesMembers(t *testing.T) {
	doc := NewDocument("d", "d")
	button(t, doc, "a", "a")
	button(t, doc, "b", "b")
	applyAll(t, doc, setOp("s", "Button", prop("Size", "S", "L", "XL")),
		variantOp("a", "s", map[string]string{"Size": "S"}), variantOp("b", "s", map[string]string{"Size": "XL"}))
	// Adding a property gives every member its first value; the old one stays.
	applyAll(t, doc, setOp("s", "Button", prop("Size", "S", "L", "XL"), prop("State", "Default", "Hover")))
	if v := doc.Components["a"].Variant; v["Size"] != "S" || v["State"] != "Default" || len(v) != 2 {
		t.Fatalf("a = %v", v)
	}
	// Removing a value moves its members to the property's first value; here that
	// would collide with a, so first move a out of the way.
	applyAll(t, doc, setOp("s", "Button", prop("Size", "S", "L", "XL"), prop("State", "Default", "Hover")), variantOp("a", "s", map[string]string{"Size": "S", "State": "Hover"}))
	if err := Apply(doc, setOp("s", "Button", prop("Size", "S", "L"), prop("State", "Hover"))); !errors.Is(err, ErrBadVariant) {
		t.Fatalf("both members would be S/Hover: want ErrBadVariant, got %v", err)
	}
	applyAll(t, doc, setOp("s", "Button", prop("Size", "S", "L"), prop("State", "Default", "Hover")))
	if v := doc.Components["b"].Variant; v["Size"] != "S" || v["State"] != "Default" {
		t.Fatalf("b must fall back to the first values, got %v", v)
	}
	// Removing a property drops its key (b moves to L first so the two stay distinct).
	applyAll(t, doc, variantOp("b", "s", map[string]string{"Size": "L", "State": "Default"}))
	applyAll(t, doc, setOp("s", "Button", prop("Size", "S", "L")))
	if v := doc.Components["a"].Variant; len(v) != 1 || v["Size"] != "S" {
		t.Fatalf("a = %v", v)
	}
}

func renameOp(set *opendesignerv1.ComponentSet, props map[string]string, vals ...*opendesignerv1.ValueRename) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComponentSet{SetComponentSet: &opendesignerv1.SetComponentSet{Set: set, PropertyRenames: props, ValueRenames: vals}}}
}

func TestRenamesKeepMembersChoices(t *testing.T) {
	doc := NewDocument("d", "d")
	button(t, doc, "a", "a")
	button(t, doc, "b", "b")
	applyAll(t, doc, setOp("s", "Button", prop("Size", "S", "L")),
		variantOp("a", "s", map[string]string{"Size": "S"}), variantOp("b", "s", map[string]string{"Size": "L"}))

	// Rename the property and one value: members follow instead of falling back to the first value.
	renamed := &opendesignerv1.ComponentSet{Id: "s", Name: "Button", Properties: []*opendesignerv1.VariantProperty{prop("Scale", "Small", "L")}}
	applyAll(t, doc, renameOp(renamed, map[string]string{"Size": "Scale"}, &opendesignerv1.ValueRename{Property: "Scale", From: "S", To: "Small"}))
	if v := doc.Components["a"].Variant; len(v) != 1 || v["Scale"] != "Small" {
		t.Fatalf("a = %v", v)
	}
	if v := doc.Components["b"].Variant; len(v) != 1 || v["Scale"] != "L" {
		t.Fatalf("b = %v", v)
	}

	// A rename to something the new set does not have is refused, and nothing changes.
	bad := &opendesignerv1.ComponentSet{Id: "s", Name: "Button", Properties: []*opendesignerv1.VariantProperty{prop("Scale", "Small", "L")}}
	for name, op := range map[string]*opendesignerv1.Op{
		"property to nothing": renameOp(bad, map[string]string{"Scale": "Ghost"}),
		"value to nothing":    renameOp(bad, nil, &opendesignerv1.ValueRename{Property: "Scale", From: "Small", To: "Huge"}),
		"unknown property":    renameOp(bad, nil, &opendesignerv1.ValueRename{Property: "Ghost", From: "a", To: "b"}),
	} {
		if err := Apply(doc, op); !errors.Is(err, ErrBadVariant) {
			t.Errorf("%s: want ErrBadVariant, got %v", name, err)
		}
	}
	if doc.Components["a"].Variant["Scale"] != "Small" {
		t.Fatal("a rejected rename changed a member")
	}
}
