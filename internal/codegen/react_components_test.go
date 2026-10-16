package codegen_test

import (
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
)

const (
	tBool   = opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_BOOLEAN
	tText   = opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_TEXT
	tNumber = opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_NUMBER
	tSwap   = opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_INSTANCE_SWAP
)

func fill(r, g, b float32) *opendesignerv1.Paint {
	return &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{Color: &opendesignerv1.Color{R: r, G: g, B: b, A: 1}}}}
}

// htmlContaining is the generated html page that holds `needle`.
func htmlContaining(t *testing.T, doc *opendesignerv1.Document, needle string) string {
	t.Helper()
	for _, f := range gen(t, doc, codegen.TargetHTML, nil).Files {
		if strings.HasSuffix(f.Path, ".html") && strings.Contains(string(f.Content), needle) {
			return string(f.Content)
		}
	}
	t.Fatalf("no page contains %q", needle)
	return ""
}

// buttonDoc: a screen with two master rectangles registered as the S and L
// members of the set "Button" (axes Size and `default`, a reserved word), and
// three instances: of S, of L (a variant_props choice on top of S), and of S with
// an override (which has no prop to carry it, so it must stay inline).
func buttonDoc() *opendesignerv1.Document {
	rect := func(id, name string, x, w float64, c *opendesignerv1.Paint) *opendesignerv1.Node {
		return &opendesignerv1.Node{
			Id: id, ParentId: "s", OrderKey: id, Name: name, Visible: true, Opacity: 1, X: x, Y: 0, Width: w, Height: 20,
			Fills: []*opendesignerv1.Paint{c}, Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}},
		}
	}
	inst := func(id, comp string, y float64, variant map[string]string, ov ...*opendesignerv1.InstanceOverride) *opendesignerv1.Node {
		return &opendesignerv1.Node{
			Id: id, ParentId: "s", OrderKey: "z" + id, Name: id, Visible: true, Opacity: 1, X: 10, Y: y, Width: 80, Height: 20,
			Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: comp, VariantProps: variant, Overrides: ov}},
		}
	}
	return &opendesignerv1.Document{
		Id: "doc", Name: "Buttons", SchemaVersion: 1,
		Pages: []*opendesignerv1.Page{{Id: "page1", Name: "Page 1"}},
		Nodes: map[string]*opendesignerv1.Node{
			"s":  {Id: "s", ParentId: "page1", OrderKey: "a", Name: "Home", Visible: true, Opacity: 1, Width: 400, Height: 300, Fills: []*opendesignerv1.Paint{fill(1, 1, 1)}, Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}},
			"ma": rect("ma", "Button S", 200, 80, fill(1, 0, 0)),
			"mb": rect("mb", "Button L", 200, 160, fill(0, 0, 1)),
			"i1": inst("i1", "a", 40, nil),
			"i2": inst("i2", "a", 80, map[string]string{"Size": "L"}),
			"i3": inst("i3", "a", 120, nil, &opendesignerv1.InstanceOverride{MasterNodeId: "ma", FillsPresent: true, Fills: []*opendesignerv1.Paint{fill(0, 1, 0)}}),
		},
		Components: map[string]*opendesignerv1.Component{
			"a": {RootNodeId: "ma", Name: "Button/S", SetId: "set", Variant: map[string]string{"Size": "S", "default": "yes"}},
			"b": {RootNodeId: "mb", Name: "Button/L", SetId: "set", Variant: map[string]string{"Size": "L", "default": "yes"}},
		},
		ComponentSets: map[string]*opendesignerv1.ComponentSet{"set": {Id: "set", Name: "Button", Axes: []*opendesignerv1.VariantAxis{
			{Name: "Size", Options: []string{"S", "L"}},
			{Name: "default", Options: []string{"yes", "no"}},
		}}},
	}
}

func TestVariantSetBecomesAReactComponent(t *testing.T) {
	out := gen(t, buttonDoc(), codegen.TargetReact, nil)
	comp := string(file(t, out, "src/components/Button.tsx"))
	for _, want := range []string{
		`export type ButtonProps = {`,
		`size?: "S" | "L";`,
		`defaultProp?: "yes" | "no";`, // `default` is a reserved word
		`export function Button({ size = "S", defaultProp = "yes" }: ButtonProps) {`,
		"switch (`${size}|${defaultProp}`) {",
		`case "S|yes":`,
		`case "L|yes":`,
		"bg-[#f00]", "bg-[#00f]", // both masters are rendered, each in its own case
		"return null; // this combination has no variant in the design",
	} {
		if !strings.Contains(comp, want) {
			t.Errorf("Button.tsx lacks %q:\n%s", want, comp)
		}
	}
	screen := string(file(t, out, "src/screens/Home.tsx"))
	for _, want := range []string{
		`import { Button } from "../components/Button";`,
		"<Button />",          // i1: the first option of every axis, nothing to pass
		`<Button size="L" />`, // i2: its variant_props choice
	} {
		if !strings.Contains(screen, want) {
			t.Errorf("Home.tsx lacks %q:\n%s", want, screen)
		}
	}
	// The instance with an override stays inline: its own colour, no component call.
	if strings.Count(screen, "<Button") != 2 || !strings.Contains(screen, "bg-[#0f0]") {
		t.Errorf("the overridden instance must stay inline:\n%s", screen)
	}
}

func TestVariantSetStaysInlineInHTML(t *testing.T) {
	out := gen(t, buttonDoc(), codegen.TargetHTML, nil)
	for _, f := range out.Files {
		if strings.Contains(f.Path, "components/") {
			t.Fatalf("the html target has no components: %s", f.Path)
		}
	}
	page := htmlContaining(t, buttonDoc(), "background-color: #f00")
	if !strings.Contains(page, "background-color: #00f") {
		t.Errorf("html keeps the inline expansion (i2 shows the L master):\n%s", page)
	}
}

func TestComponentNamesAvoidScreenNames(t *testing.T) {
	doc := buttonDoc()
	doc.Nodes["s"].Name = "Button" // a screen named like the component
	out := gen(t, doc, codegen.TargetReact, nil)
	file(t, out, "src/components/Button2.tsx")
	if !strings.Contains(string(file(t, out, "src/screens/Button.tsx")), `import { Button2 } from "../components/Button2";`) {
		t.Error("the screen must import the deduplicated component name")
	}
}

func TestNestedComponentsImportEachOther(t *testing.T) {
	doc := buttonDoc()
	// Card (set "cards") contains an instance of the Button S; the screen uses Card.
	doc.Nodes["mc"] = &opendesignerv1.Node{Id: "mc", ParentId: "s", OrderKey: "m", Name: "Card", Visible: true, Opacity: 1, X: 300, Width: 100, Height: 50, Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}}
	doc.Nodes["mc-btn"] = &opendesignerv1.Node{Id: "mc-btn", ParentId: "mc", OrderKey: "a", Name: "Btn", Visible: true, Opacity: 1, Width: 80, Height: 20,
		Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: "a", VariantProps: map[string]string{"default": "no"}}}}
	doc.Components["c"] = &opendesignerv1.Component{RootNodeId: "mc", Name: "Card/Plain", SetId: "cards", Variant: map[string]string{"Kind": "plain"}}
	doc.ComponentSets["cards"] = &opendesignerv1.ComponentSet{Id: "cards", Name: "Card", Axes: []*opendesignerv1.VariantAxis{{Name: "Kind", Options: []string{"plain"}}}}
	doc.Nodes["i4"] = &opendesignerv1.Node{Id: "i4", ParentId: "s", OrderKey: "zz", Name: "i4", Visible: true, Opacity: 1, X: 10, Y: 200, Width: 100, Height: 50,
		Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: "c"}}}
	out := gen(t, doc, codegen.TargetReact, nil)
	card := string(file(t, out, "src/components/Card.tsx"))
	// "default=no" has no member in the set: the instance falls back to the base
	// component, and the call carries the axis it asked for... of that base (yes).
	if !strings.Contains(card, `import { Button } from "./Button";`) || !strings.Contains(card, "<Button />") {
		t.Errorf("Card must import and call Button:\n%s", card)
	}
	file(t, out, "src/components/Button.tsx")
}

// propsDoc: the Button set with a text property on both masters' label and a
// boolean "Icon" property (off by default) hiding a child, by name across members.
func propsDoc() *opendesignerv1.Document {
	doc := buttonDoc()
	for _, m := range []string{"ma", "mb"} {
		doc.Nodes[m].Shape = &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}
		doc.Nodes[m+"-label"] = &opendesignerv1.Node{Id: m + "-label", ParentId: m, OrderKey: "a", Name: "Label", Visible: true, Opacity: 1, Width: 60, Height: 20,
			Shape: &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{Content: "Master " + m, Style: &opendesignerv1.TextStyle{FontSize: 12}}}}
		doc.Nodes[m+"-icon"] = &opendesignerv1.Node{Id: m + "-icon", ParentId: m, OrderKey: "b", Name: "Icon", Visible: true, Opacity: 1, X: 70, Width: 10, Height: 10,
			Fills: []*opendesignerv1.Paint{fill(1, 0, 1)}, Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}}}
	}
	for id, m := range map[string]string{"a": "ma", "b": "mb"} {
		doc.Components[id].Properties = []*opendesignerv1.ComponentProperty{
			{Name: "Label", Type: tText, TargetNodeIds: []string{m + "-label"}, DefaultValue: "Click"},
			{Name: "Icon", Type: tBool, TargetNodeIds: []string{m + "-icon"}, DefaultValue: "false"},
		}
	}
	// i2 (the L variant) sets Icon on and a label; i1 and i3 keep the defaults.
	doc.Nodes["i2"].GetInstance().PropertyValues = map[string]string{"Icon": "true", "Label": "Buy"}
	return doc
}

func TestComponentPropertiesApplyInTheInlineExport(t *testing.T) {
	page := htmlContaining(t, propsDoc(), "Buy")
	if strings.Count(page, ">Buy<") != 1 || strings.Count(page, ">Click<") != 2 {
		t.Errorf("the label property must reach each instance (one Buy, two Click):\n%s", page)
	}
	// Icon: hidden by default (i1, i3), shown for i2 (which resolves to the L variant).
	if strings.Contains(page, `data-node-id="i1/ma-icon"`) || strings.Contains(page, `data-node-id="i3/ma-icon"`) {
		t.Errorf("the icon must be hidden by default:\n%s", page)
	}
	if !strings.Contains(page, `data-node-id="i2/mb-icon"`) {
		t.Errorf("the icon must be shown on the instance that turned it on:\n%s", page)
	}
}

func TestComponentPropertiesBecomeReactProps(t *testing.T) {
	out := gen(t, propsDoc(), codegen.TargetReact, nil)
	comp := string(file(t, out, "src/components/Button.tsx"))
	for _, want := range []string{
		"  /** Label (text) */\n  label?: string;",
		"  /** Icon (show/hide) */\n  icon?: boolean;",
		`label = "Click", icon = false }: ButtonProps`, // defaults from the design
		"{icon && (", // the layer a boolean property drives
		"{label}",    // the text a text property drives
	} {
		if !strings.Contains(comp, want) {
			t.Errorf("Button.tsx lacks %q:\n%s", want, comp)
		}
	}
	if strings.Contains(comp, "Master ma") {
		t.Errorf("a property-driven text must print the prop, not the master's literal:\n%s", comp)
	}
	screen := string(file(t, out, "src/screens/Home.tsx"))
	for _, want := range []string{
		"<Button />",                           // i1: defaults, nothing passed
		`<Button size="L" label="Buy" icon />`, // i2: its choices travel as props
	} {
		if !strings.Contains(screen, want) {
			t.Errorf("Home.tsx lacks %q:\n%s", want, screen)
		}
	}
	// Only the instance with an OVERRIDE stays inline (i3).
	if strings.Count(screen, "<Button") != 2 || !strings.Contains(screen, "i3/ma") {
		t.Errorf("i1 and i2 call the component, i3 (an override) stays inline:\n%s", screen)
	}
}

func TestFalseBooleanPropIsPassedExplicitly(t *testing.T) {
	doc := propsDoc()
	// A component whose icon is ON by default, and an instance that turns it off.
	for _, id := range []string{"a", "b"} {
		doc.Components[id].Properties[1].DefaultValue = "true"
	}
	doc.Nodes["i2"].GetInstance().PropertyValues = map[string]string{"Icon": "false"}
	out := gen(t, doc, codegen.TargetReact, nil)
	if screen := string(file(t, out, "src/screens/Home.tsx")); !strings.Contains(screen, "icon={false}") {
		t.Errorf("turning a default-on layer off must pass icon={false}:\n%s", screen)
	}
	if comp := string(file(t, out, "src/components/Button.tsx")); !strings.Contains(comp, "icon = true") {
		t.Errorf("the default must come from the design:\n%s", comp)
	}
}

// cardDoc: a screen with a "Card" component that is in NO set. Its master has a
// rounded background, a title text and a nested icon instance (of "Star"). Its
// properties: a text with an option list, a corner radius, an opacity, and a swap
// for the icon. Two other components can be swapped in: "Heart" and "Dot" (plain).
func cardDoc() *opendesignerv1.Document {
	frame := func(id, parent string, w float64) *opendesignerv1.Node {
		return &opendesignerv1.Node{Id: id, ParentId: parent, OrderKey: id, Name: id, Visible: true, Opacity: 1, Width: w, Height: 20,
			Fills: []*opendesignerv1.Paint{fill(0.5, 0.5, 0.5)}, Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}}
	}
	inst := func(id, parent, comp string, x, y float64, values map[string]string) *opendesignerv1.Node {
		return &opendesignerv1.Node{Id: id, ParentId: parent, OrderKey: "z" + id, Name: id, Visible: true, Opacity: 1, X: x, Y: y, Width: 100, Height: 40,
			Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: comp, PropertyValues: values}}}
	}
	return &opendesignerv1.Document{
		Id: "doc", Name: "Cards", SchemaVersion: 1,
		Pages: []*opendesignerv1.Page{{Id: "page1", Name: "Page 1"}},
		Nodes: map[string]*opendesignerv1.Node{
			"s":     {Id: "s", ParentId: "page1", OrderKey: "a", Name: "Home", Visible: true, Opacity: 1, Width: 400, Height: 300, Fills: []*opendesignerv1.Paint{fill(1, 1, 1)}, Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}},
			"star":  frame("star", "s", 10),
			"heart": frame("heart", "s", 20),
			"dot":   frame("dot", "s", 5),
			"card":  frame("card", "s", 100),
			"title": {Id: "title", ParentId: "card", OrderKey: "a", Name: "Title", Visible: true, Opacity: 1, Width: 80, Height: 20, Shape: &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{Content: "Card", Style: &opendesignerv1.TextStyle{FontSize: 12}}}},
			"bg":    {Id: "bg", ParentId: "card", OrderKey: "b", Name: "Bg", Visible: true, Opacity: 1, Width: 100, Height: 40, Fills: []*opendesignerv1.Paint{fill(0, 0, 1)}, Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{CornerRadius: 4}}},
			"icon":  inst("icon", "card", "star", 80, 0, nil),
			"c1":    inst("c1", "s", "card", 10, 100, nil),
			"c2":    inst("c2", "s", "card", 10, 160, map[string]string{"Tone": "Warn", "Radius": "20", "Fade": "0.5", "Icon": "heart"}),
			"c3":    inst("c3", "s", "card", 10, 220, map[string]string{"Icon": "dot"}),
		},
		Components: map[string]*opendesignerv1.Component{
			"star": {RootNodeId: "star", Name: "Star"}, "heart": {RootNodeId: "heart", Name: "Heart"}, "dot": {RootNodeId: "dot", Name: "Dot"},
			"card": {RootNodeId: "card", Name: "Card", Properties: []*opendesignerv1.ComponentProperty{
				{Name: "Tone", Type: tText, TargetNodeIds: []string{"title"}, Options: []string{"Info", "Warn"}, DefaultValue: "Info"},
				{Name: "Radius", Type: tNumber, TargetNodeIds: []string{"bg"}, Attribute: "corner_radius", DefaultValue: "4"},
				{Name: "Fade", Type: tNumber, TargetNodeIds: []string{"bg"}, Attribute: "opacity", DefaultValue: "1"},
				{Name: "Icon", Type: tSwap, TargetNodeIds: []string{"icon"}},
			}},
		},
	}
}

func TestComponentOutsideASetBecomesAReactComponent(t *testing.T) {
	out := gen(t, cardDoc(), codegen.TargetReact, nil)
	comp := string(file(t, out, "src/components/Card.tsx"))
	for _, want := range []string{
		`import type { ReactNode } from "react";`,
		`tone?: "Info" | "Warn";`, // an option list is a union
		"radius?: number;", "fade?: number;", "icon?: ReactNode;",
		`tone = "Info", radius = 4, fade = 1, icon }: CardProps`, // defaults from the design
		"{tone}", // the text prop
		"style={{ borderRadius: radius, opacity: fade }}", // number props are inline styles
		"{icon ?? (",         // the swap slot, default content inside
		"cmp-card/icon/star", // the default content: the nested Star master
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
	if strings.Count(screen, "<Card") != 3 {
		t.Errorf("every card instance is a call:\n%s", screen)
	}
	// Swapped-in plain components are expanded in the prop.
	if !strings.Contains(screen, "swap-dot/dot") || !strings.Contains(screen, "swap-heart/heart") {
		t.Errorf("a swapped-in plain component must be expanded in the prop:\n%s", screen)
	}
}

func TestSwapDefaultComponentIsTheFallback(t *testing.T) {
	doc := cardDoc()
	// The swap defaults to Heart: c1 keeps it (no prop), the master's slot falls back to it.
	doc.Components["card"].Properties[3].DefaultValue = "heart"
	out := gen(t, doc, codegen.TargetReact, nil)
	comp := string(file(t, out, "src/components/Card.tsx"))
	if !strings.Contains(comp, "cmp-card/icon/heart") || strings.Contains(comp, "cmp-card/icon/star") {
		t.Errorf("the slot's default content must be the default component:\n%s", comp)
	}
	screen := string(file(t, out, "src/screens/Home.tsx"))
	if strings.Contains(screen, "icon={") && strings.Contains(screen, "swap-heart") {
		t.Errorf("an instance that swaps to the default component passes nothing:\n%s", screen)
	}
}

func TestPropertiesApplyInTheInlineExport(t *testing.T) {
	page := htmlContaining(t, cardDoc(), "c2/")
	// c2: option text, radius 20, opacity 0.5, icon swapped to Heart (20px wide).
	for _, want := range []string{
		">Warn<",
		"border-radius: 20px",
		"opacity: 0.5",
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
