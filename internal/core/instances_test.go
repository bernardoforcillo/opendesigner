package core

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

// otherMaster adds a standalone component c-card whose master (m3: a text and two rectangles)
// has the same layers as the button's, and a nested instance in a third master.
func withCard(t *testing.T, doc *opendesignerv1.Document) {
	t.Helper()
	node := func(id, parent string, w, h float64, shape any) *opendesignerv1.Op {
		// Layers are paired by name across masters: "label3" is the card's "label".
		n := &opendesignerv1.Node{Id: id, ParentId: parent, OrderKey: id, Name: strings.TrimRight(id, "0123456789"), Visible: true, Opacity: 1, Width: w, Height: h}
		switch s := shape.(type) {
		case *opendesignerv1.FrameNode:
			n.Shape = &opendesignerv1.Node_Frame{Frame: s}
		case *opendesignerv1.TextNode:
			n.Shape = &opendesignerv1.Node_Text{Text: s}
		case *opendesignerv1.RectNode:
			n.Shape = &opendesignerv1.Node_Rect{Rect: s}
		}
		return &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}}
	}
	mustApply(t, doc,
		node("m3", "page1", 120, 80, &opendesignerv1.FrameNode{}),
		node("label3", "m3", 100, 20, &opendesignerv1.TextNode{Content: "Card"}),
		node("icon3", "m3", 20, 20, &opendesignerv1.RectNode{}),
		node("extra3", "m3", 20, 20, &opendesignerv1.RectNode{}),
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateComponent{CreateComponent: &opendesignerv1.CreateComponent{ComponentId: "c-card", RootNodeId: "m3", Name: "Card"}}},
	)
}

func setInstance(doc *opendesignerv1.Document, in *opendesignerv1.InstanceNode) error {
	return Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstance{SetInstance: &opendesignerv1.SetInstance{InstanceId: "i", Instance: in}}})
}

func TestSwapInstanceCarriesWhatFits(t *testing.T) {
	doc := buttonSet(t)
	withCard(t, doc)
	for id, name := range map[string]string{"label": "label", "icon": "icon", "m1": "m"} {
		mustApply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
			Id: id, Patch: &opendesignerv1.Node{Name: name}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"name"}}}}})
	}
	mustApply(t, doc,
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstanceOverride{SetInstanceOverride: &opendesignerv1.SetInstanceOverride{
			InstanceId: "i", Override: &opendesignerv1.InstanceOverride{MasterNodeId: "label", Text: "Pay", TextPresent: true}}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstanceOverride{SetInstanceOverride: &opendesignerv1.SetInstanceOverride{
			InstanceId: "i", Override: &opendesignerv1.InstanceOverride{MasterNodeId: "icon", FillsPresent: true,
				Fills: []*opendesignerv1.Paint{{Kind: &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{Color: &opendesignerv1.Color{R: 1, A: 1}}}}}}}}},
	)
	if err := setInstanceProps(t, doc, map[string]string{"Label": "Pay", "ShowIcon": "false"}, nil); err != nil {
		t.Fatal(err)
	}
	next, err := SwapInstance(doc, "i", "c-card")
	if err != nil {
		t.Fatal(err)
	}
	if next.ComponentId != "c-card" || len(next.PropertyValues) != 0 || len(next.VariantProps) != 0 {
		t.Errorf("payload = %v: the properties and variant of the button do not exist on the card", next)
	}
	got := map[string]bool{}
	for _, o := range next.Overrides {
		got[o.MasterNodeId] = o.TextPresent
	}
	if len(got) != 2 || !got["label3"] {
		t.Errorf("overrides = %v, want the text on label3 and the fill on icon3", got)
	}
	if _, ok := got["icon3"]; !ok {
		t.Errorf("overrides = %v, want the text on label3 and the fill on icon3", got)
	}
	if err := setInstance(doc, next); err != nil {
		t.Fatal(err)
	}
	if doc.Nodes["i"].GetInstance().ComponentId != "c-card" {
		t.Error("the instance still points at the button")
	}
	if w, h, ok := SwapSize(doc, doc.Nodes["i"].GetInstance()); !ok || w != 120 || h != 80 {
		t.Errorf("SwapSize = %v x %v %v", w, h, ok)
	}
	// Swapping within a set keeps the matching property values and the variant choice.
	doc = buttonSet(t)
	if err := setInstanceProps(t, doc, map[string]string{"Label": "Go"}, map[string]string{"State": "hover"}); err != nil {
		t.Fatal(err)
	}
	same, err := SwapInstance(doc, "i", "c-hover")
	if err != nil {
		t.Fatal(err)
	}
	if same.PropertyValues["Label"] != "Go" || same.VariantProps["State"] != "hover" {
		t.Errorf("swap inside the set lost the choices: %v", same)
	}
}

func TestSetInstanceRejections(t *testing.T) {
	doc := buttonSet(t)
	withCard(t, doc)
	for name, in := range map[string]*opendesignerv1.InstanceNode{
		"unknown component":     {ComponentId: "nope"},
		"override off master":   {ComponentId: "c-card", Overrides: []*opendesignerv1.InstanceOverride{{MasterNodeId: "label", TextPresent: true, Text: "x"}}},
		"empty override":        {ComponentId: "c-card", Overrides: []*opendesignerv1.InstanceOverride{{MasterNodeId: "label3"}}},
		"property of nobody":    {ComponentId: "c-card", PropertyValues: map[string]string{"Label": "x"}},
		"variant without a set": {ComponentId: "c-card", VariantProps: map[string]string{"State": "hover"}},
	} {
		if err := setInstance(doc, in); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	// A rectangle is not an instance.
	err := Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstance{SetInstance: &opendesignerv1.SetInstance{
		InstanceId: "icon", Instance: &opendesignerv1.InstanceNode{ComponentId: "c-card"}}}})
	if !errors.Is(err, ErrNotInstanceNode) {
		t.Errorf("rectangle: %v", err)
	}
}

func TestSetInstanceRefusesACycle(t *testing.T) {
	doc := buttonSet(t)
	withCard(t, doc)
	// An instance of the button INSIDE the card's master: the card cannot be shown by it.
	mustApply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: &opendesignerv1.Node{
		Id: "nested", ParentId: "m3", OrderKey: "z", Visible: true, Opacity: 1, Width: 10, Height: 10,
		Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: "c-default"}},
	}}}})
	err := Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstance{SetInstance: &opendesignerv1.SetInstance{
		InstanceId: "nested", Instance: &opendesignerv1.InstanceNode{ComponentId: "c-card"}}}})
	if !errors.Is(err, ErrInstanceCycle) {
		t.Fatalf("nested instance of its own host: %v", err)
	}
	// Through a second level: the button master holds an instance of the card, so an instance
	// of the button inside the card closes a loop.
	mustApply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: &opendesignerv1.Node{
		Id: "inner", ParentId: "m1", OrderKey: "z", Visible: true, Opacity: 1, Width: 10, Height: 10,
		Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: "c-default"}},
	}}}})
	if err := Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstance{SetInstance: &opendesignerv1.SetInstance{
		InstanceId: "inner", Instance: &opendesignerv1.InstanceNode{ComponentId: "c-card"}}}}); err == nil {
		t.Error("an instance of the card inside the button, whose nested button sits in the card, was accepted")
	}
}

func TestResetInstance(t *testing.T) {
	doc := buttonSet(t)
	mustApply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstanceOverride{SetInstanceOverride: &opendesignerv1.SetInstanceOverride{
		InstanceId: "i", Override: &opendesignerv1.InstanceOverride{MasterNodeId: "label", Text: "Pay", TextPresent: true}}}})
	if err := setInstanceProps(t, doc, map[string]string{"ShowIcon": "false"}, map[string]string{"State": "hover"}); err != nil {
		t.Fatal(err)
	}
	reset, err := ResetInstance(doc, "i")
	if err != nil {
		t.Fatal(err)
	}
	if err := setInstance(doc, reset); err != nil {
		t.Fatal(err)
	}
	in := doc.Nodes["i"].GetInstance()
	if in.ComponentId != "c-default" || len(in.Overrides) != 0 || len(in.PropertyValues) != 0 || len(in.VariantProps) != 0 {
		t.Errorf("instance after reset: %v", in)
	}
}

func TestDetachInstanceBakesTheMaster(t *testing.T) {
	doc := buttonSet(t)
	mustApply(t, doc,
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{Id: "i", Patch: &opendesignerv1.Node{
			Name: "Pay button", X: 40, Y: 50, Width: 90, Height: 30}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"name", "x", "y", "width", "height"}}}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstanceOverride{SetInstanceOverride: &opendesignerv1.SetInstanceOverride{
			InstanceId: "i", Override: &opendesignerv1.InstanceOverride{MasterNodeId: "label", Text: "Pay", TextPresent: true}}}},
	)
	if err := setInstanceProps(t, doc, map[string]string{"ShowIcon": "false"}, nil); err != nil {
		t.Fatal(err)
	}
	n := 0
	ops, err := DetachInstance(doc, "i", func() string { n++; return fmt.Sprintf("d%d", n) })
	if err != nil {
		t.Fatal(err)
	}
	mustApply(t, doc, ops...)
	root := doc.Nodes["i"]
	if root == nil || root.GetInstance() != nil || root.GetFrame() == nil {
		t.Fatalf("the detached root is %v, want a frame", root)
	}
	if root.Name != "Pay button" || root.X != 40 || root.Y != 50 || root.Width != 90 || root.Height != 30 || root.ParentId != "page1" {
		t.Errorf("root lost the instance's place: %v", root)
	}
	kids := ChildrenOf(doc, "i")
	if len(kids) != 2 {
		t.Fatalf("%d children, want 2", len(kids))
	}
	for _, k := range kids {
		switch {
		case k.GetText() != nil:
			if k.GetText().Content != "Pay" {
				t.Errorf("text = %q, want the override", k.GetText().Content)
			}
		case k.GetRect() != nil:
			if k.Visible {
				t.Error("the icon should be hidden: ShowIcon is false")
			}
		}
	}
	// The master and the component are untouched.
	if doc.Nodes["label"].GetText().Content != "Button" || doc.Components["c-default"] == nil {
		t.Error("detaching changed the master")
	}
	if _, err := DetachInstance(doc, "label", func() string { return "x" }); !errors.Is(err, ErrNotInstanceNode) {
		t.Errorf("detaching a text: %v", err)
	}
}
