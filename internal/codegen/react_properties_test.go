package codegen_test

import (
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
)

const (
	tNumber = opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_NUMBER
	tText   = opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_TEXT
	tSwap   = opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_INSTANCE_SWAP
)

// cardDoc: a screen with a "Card" component that is in NO set. Its master has a
// rounded background, a title text and a nested icon instance (of "Star"). Its
// properties: a text with an option list, a corner radius, an opacity, and a
// swap for the icon. Two other components can be swapped in: "Heart" (a plain
// component, no properties) and "Dot" (a plain one too).
func cardDoc() *opendesignerv1.Document {
	frame := func(id, parent string, w float64) *opendesignerv1.Node {
		return &opendesignerv1.Node{Id: id, ParentId: parent, OrderKey: id, Name: id, Visible: true, Opacity: 1, Width: w, Height: 20,
			Fills: []*opendesignerv1.Paint{solid(0.5, 0.5, 0.5)}, Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}}
	}
	inst := func(id, parent, comp string, x, y float64, values map[string]string) *opendesignerv1.Node {
		return &opendesignerv1.Node{Id: id, ParentId: parent, OrderKey: "z" + id, Name: id, Visible: true, Opacity: 1, X: x, Y: y, Width: 100, Height: 40,
			Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: comp, PropertyValues: values}}}
	}
	doc := &opendesignerv1.Document{
		Id: "doc", Name: "Cards", SchemaVersion: 1,
		Pages: []*opendesignerv1.Page{{Id: "page1", Name: "Page 1"}},
		Nodes: map[string]*opendesignerv1.Node{
			"s":     {Id: "s", ParentId: "page1", OrderKey: "a", Name: "Home", Visible: true, Opacity: 1, Width: 400, Height: 300, Fills: []*opendesignerv1.Paint{solid(1, 1, 1)}, Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}},
			"star":  frame("star", "s", 10),
			"heart": frame("heart", "s", 20),
			"dot":   frame("dot", "s", 5),
			"card":  frame("card", "s", 100),
			"title": {Id: "title", ParentId: "card", OrderKey: "a", Name: "Title", Visible: true, Opacity: 1, Width: 80, Height: 20, Shape: &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{Content: "Card", Style: &opendesignerv1.TextStyle{FontSize: 12}}}},
			"bg":    {Id: "bg", ParentId: "card", OrderKey: "b", Name: "Bg", Visible: true, Opacity: 1, Width: 100, Height: 40, Fills: []*opendesignerv1.Paint{solid(0, 0, 1)}, Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{CornerRadius: 4}}},
			"icon":  inst("icon", "card", "star", 80, 0, nil),
			"c1":    inst("c1", "s", "card", 10, 100, nil),
			"c2":    inst("c2", "s", "card", 10, 160, map[string]string{"Tone": "Warn", "Radius": "20", "Fade": "0.5", "Icon": "heart"}),
			"c3":    inst("c3", "s", "card", 10, 220, map[string]string{"Icon": "dot"}),
		},
		Components: map[string]*opendesignerv1.Component{
			"star": {RootNodeId: "star", Name: "Star"}, "heart": {RootNodeId: "heart", Name: "Heart"}, "dot": {RootNodeId: "dot", Name: "Dot"},
			"card": {RootNodeId: "card", Name: "Card", Properties: []*opendesignerv1.ComponentProperty{
				{Name: "Tone", Type: tText, NodeId: "title", Options: []string{"Info", "Warn"}, DefaultValue: "Info"},
				{Name: "Radius", Type: tNumber, NodeId: "bg", Attribute: "corner_radius"}, // default = the master's own (4)
				{Name: "Fade", Type: tNumber, NodeId: "bg", Attribute: "opacity", DefaultValue: "1"},
				{Name: "Icon", Type: tSwap, NodeId: "icon"},
			}},
		},
	}
	return doc
}

func TestComponentOutsideASetBecomesAReactComponent(t *testing.T) {
	out := gen(t, cardDoc(), codegen.TargetReact, nil)
	comp := string(file(t, out, "src/components/Card.tsx"))
	for _, want := range []string{
		`import type { ReactNode } from "react";`,
		`tone?: "Info" | "Warn";`, // an option list is a union
		"radius?: number;", "fade?: number;", "icon?: ReactNode;",
		`tone = "Info", radius = 4, fade = 1, icon }: CardProps`, // defaults from the design; the master's own radius
		"{tone}", // the text prop
		"style={{ borderRadius: radius, opacity: fade }}", // number props are inline styles
		"{icon ?? (", // the swap slot, default content inside
	} {
		if !strings.Contains(comp, want) {
			t.Errorf("Card.tsx lacks %q:\n%s", want, comp)
		}
	}
	if strings.Contains(comp, "switch (") {
		t.Errorf("a component with no variants has nothing to switch on:\n%s", comp)
	}
	screen := string(file(t, out, "src/screens/Home.tsx"))
	for _, want := range []string{
		`import { Card } from "../components/Card";`,
		"<Card />", // c1: all defaults
		`<Card tone="Warn" radius={20} fade={0.5} icon={`,
	} {
		if !strings.Contains(screen, want) {
			t.Errorf("Home.tsx lacks %q:\n%s", want, screen)
		}
	}
	// c3 swapped in a plain component (Dot): it is rendered inline as the prop's content.
	if strings.Count(screen, "<Card") != 3 {
		t.Errorf("every card instance is a call:\n%s", screen)
	}
	if !strings.Contains(screen, "swap-dot/dot") || !strings.Contains(screen, "swap-heart/heart") {
		t.Errorf("a swapped-in plain component must be expanded in the prop:\n%s", screen)
	}
}

func TestPropertiesApplyInTheInlineExport(t *testing.T) {
	page := htmlWith(t, cardDoc(), "c2/")
	// c2: option text, radius 20, opacity 0.5, icon swapped to Heart (20px wide).
	for _, want := range []string{
		">Warn<",
		"border-radius: 20px",
		`data-node-id="c2/icon/heart"`, // the nested instance shows Heart's master
	} {
		if !strings.Contains(page, want) {
			t.Errorf("inline export lacks %q:\n%s", want, page)
		}
	}
	if strings.Contains(page, `data-node-id="c2/icon/star"`) {
		t.Errorf("the swapped-out component must not be drawn:\n%s", page)
	}
	if !strings.Contains(page, `data-node-id="c1/icon/star"`) {
		t.Errorf("an instance that does not swap keeps the default component:\n%s", page)
	}
}
