package codegen_test

import (
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
)

// buttonDoc: a screen with two master rectangles registered as the S and L
// variants of the set "Button", and three instances: of S, of L, and of S with an
// override (which has no prop to carry it, so it must stay inline).
func buttonDoc() *opendesignerv1.Document {
	rect := func(id, name string, x, w float64, c *opendesignerv1.Paint) *opendesignerv1.Node {
		return &opendesignerv1.Node{
			Id: id, ParentId: "s", OrderKey: id, Name: name, Visible: true, Opacity: 1, X: x, Y: 0, Width: w, Height: 20,
			Fills: []*opendesignerv1.Paint{c}, Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}},
		}
	}
	inst := func(id, comp string, y float64, ov ...*opendesignerv1.InstanceOverride) *opendesignerv1.Node {
		return &opendesignerv1.Node{
			Id: id, ParentId: "s", OrderKey: "z" + id, Name: id, Visible: true, Opacity: 1, X: 10, Y: y, Width: 80, Height: 20,
			Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: comp, Overrides: ov}},
		}
	}
	return &opendesignerv1.Document{
		Id: "doc", Name: "Buttons", SchemaVersion: 1,
		Pages: []*opendesignerv1.Page{{Id: "page1", Name: "Page 1"}},
		Nodes: map[string]*opendesignerv1.Node{
			"s":  {Id: "s", ParentId: "page1", OrderKey: "a", Name: "Home", Visible: true, Opacity: 1, Width: 400, Height: 300, Fills: []*opendesignerv1.Paint{solid(1, 1, 1)}, Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}},
			"ma": rect("ma", "Button S", 200, 80, solid(1, 0, 0)),
			"mb": rect("mb", "Button L", 200, 160, solid(0, 0, 1)),
			"i1": inst("i1", "a", 40),
			"i2": inst("i2", "b", 80),
			"i3": inst("i3", "a", 120, &opendesignerv1.InstanceOverride{MasterNodeId: "ma", FillsPresent: true, Fills: []*opendesignerv1.Paint{solid(0, 1, 0)}}),
		},
		Components: map[string]*opendesignerv1.Component{
			"a": {RootNodeId: "ma", Name: "Button/S", SetId: "set", Variant: map[string]string{"Size": "S", "default": "yes"}},
			"b": {RootNodeId: "mb", Name: "Button/L", SetId: "set", Variant: map[string]string{"Size": "L", "default": "yes"}},
		},
		ComponentSets: map[string]*opendesignerv1.ComponentSet{"set": {Id: "set", Name: "Button", Properties: []*opendesignerv1.VariantProperty{
			{Name: "Size", Values: []string{"S", "L"}},
			{Name: "default", Values: []string{"yes", "no"}}, // a reserved word as a property name
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
		`<Button size="S" defaultProp="yes" />`,
		`<Button size="L" defaultProp="yes" />`,
	} {
		if !strings.Contains(screen, want) {
			t.Errorf("Home.tsx lacks %q:\n%s", want, screen)
		}
	}
	// The instance with an override stays inline: its own colour, no component call.
	if strings.Count(screen, "<Button ") != 2 || !strings.Contains(screen, "bg-[#0f0]") {
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
	page := htmlWith(t, buttonDoc(), `data-variant="Size=S;default=yes"`)
	if !strings.Contains(page, "background-color: #f00") || !strings.Contains(page, "background-color: #00f") {
		t.Errorf("html keeps the inline expansion:\n%s", page)
	}
}

func TestComponentNamesAvoidScreenNames(t *testing.T) {
	doc := buttonDoc()
	doc.Nodes["s"].Name = "Button" // a screen named like the component
	out := gen(t, doc, codegen.TargetReact, nil)
	file(t, out, "src/screens/Button.tsx")
	file(t, out, "src/components/Button2.tsx")
	if !strings.Contains(string(file(t, out, "src/screens/Button.tsx")), `import { Button2 } from "../components/Button2";`) {
		t.Error("the screen must import the deduplicated component name")
	}
}

func TestNestedVariantSetsImportEachOther(t *testing.T) {
	doc := buttonDoc()
	// Card (set "card") contains an instance of the Button S; the screen uses Card.
	doc.Nodes["mc"] = &opendesignerv1.Node{Id: "mc", ParentId: "s", OrderKey: "m", Name: "Card", Visible: true, Opacity: 1, X: 300, Width: 100, Height: 50, Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}}
	doc.Nodes["mc-btn"] = &opendesignerv1.Node{Id: "mc-btn", ParentId: "mc", OrderKey: "a", Name: "Btn", Visible: true, Opacity: 1, Width: 80, Height: 20,
		Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: "a"}}}
	doc.Components["c"] = &opendesignerv1.Component{RootNodeId: "mc", Name: "Card/Default", SetId: "cards", Variant: map[string]string{"Kind": "plain"}}
	doc.ComponentSets["cards"] = &opendesignerv1.ComponentSet{Id: "cards", Name: "Card", Properties: []*opendesignerv1.VariantProperty{{Name: "Kind", Values: []string{"plain"}}}}
	doc.Nodes["i4"] = &opendesignerv1.Node{Id: "i4", ParentId: "s", OrderKey: "zz", Name: "i4", Visible: true, Opacity: 1, X: 10, Y: 200, Width: 100, Height: 50,
		Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: "c"}}}
	out := gen(t, doc, codegen.TargetReact, nil)
	card := string(file(t, out, "src/components/Card.tsx"))
	if !strings.Contains(card, `import { Button } from "./Button";`) || !strings.Contains(card, `<Button size="S" defaultProp="yes" />`) {
		t.Errorf("Card must import and call Button:\n%s", card)
	}
	file(t, out, "src/components/Button.tsx")
}

// propsDoc: the Button set with a text property on both masters' label and a
// boolean "Icon" property (off by default) hiding a child.
func propsDoc() *opendesignerv1.Document {
	doc := buttonDoc()
	for _, m := range []string{"ma", "mb"} {
		doc.Nodes[m].Shape = &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}
		doc.Nodes[m+"-label"] = &opendesignerv1.Node{Id: m + "-label", ParentId: m, OrderKey: "a", Name: "Label", Visible: true, Opacity: 1, Width: 60, Height: 20,
			Shape: &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{Content: "Master " + m, Style: &opendesignerv1.TextStyle{FontSize: 12}}}}
		doc.Nodes[m+"-icon"] = &opendesignerv1.Node{Id: m + "-icon", ParentId: m, OrderKey: "b", Name: "Icon", Visible: true, Opacity: 1, X: 70, Width: 10, Height: 10,
			Fills: []*opendesignerv1.Paint{solid(1, 0, 1)}, Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}}}
	}
	for id, m := range map[string]string{"a": "ma", "b": "mb"} {
		doc.Components[id].Properties = []*opendesignerv1.ComponentProperty{
			{Name: "Label", Type: opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_TEXT, NodeId: m + "-label", DefaultValue: "Click"},
			{Name: "Icon", Type: opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_BOOLEAN, NodeId: m + "-icon", DefaultValue: "false"},
		}
	}
	// i2 sets Icon on and a label; i1 and i3 keep the defaults.
	doc.Nodes["i2"].GetInstance().PropertyValues = map[string]string{"Icon": "true", "Label": "Buy"}
	return doc
}

func TestComponentPropertiesApplyInTheInlineExport(t *testing.T) {
	page := htmlWith(t, propsDoc(), "Buy")
	if strings.Count(page, ">Buy<") != 1 || strings.Count(page, ">Click<") != 2 {
		t.Errorf("the label property must reach each instance (one Buy, two Click):\n%s", page)
	}
	if strings.Contains(page, "Master ma") || strings.Contains(page, "Master mb") {
		// the masters themselves sit on the screen too, so look for them only inside instances
		for _, id := range []string{`data-node-id="i1/ma-label"`, `data-node-id="i2/mb-label"`} {
			idx := strings.Index(page, id)
			if idx >= 0 && strings.Contains(page[idx:idx+120], "Master") {
				t.Errorf("an instance shows the master's own text instead of the property:\n%s", page[idx:idx+120])
			}
		}
	}
	// Icon: hidden by default (i1, i3), shown for i2.
	if strings.Contains(page, `data-node-id="i1/ma-icon"`) || strings.Contains(page, `data-node-id="i3/ma-icon"`) {
		t.Errorf("the icon must be hidden by default:\n%s", page)
	}
	if !strings.Contains(page, `data-node-id="i2/mb-icon"`) {
		t.Errorf("the icon must be shown on the instance that turned it on:\n%s", page)
	}
}

func TestComponentPropertiesInReactComponents(t *testing.T) {
	out := gen(t, propsDoc(), codegen.TargetReact, nil)
	comp := string(file(t, out, "src/components/Button.tsx"))
	// The component renders its defaults: default text, hidden icon.
	if !strings.Contains(comp, `{"Click"}`) || strings.Contains(comp, "cmp-a/ma-icon") {
		t.Errorf("the component must render the defaults:\n%s", comp)
	}
	screen := string(file(t, out, "src/screens/Home.tsx"))
	// i1 (defaults, no overrides) is a component call; i2 sets properties and stays inline with them applied.
	if strings.Count(screen, "<Button ") != 1 {
		t.Errorf("only the instance with default properties may call the component:\n%s", screen)
	}
	if !strings.Contains(screen, `{"Buy"}`) || !strings.Contains(screen, "i2/mb-icon") {
		t.Errorf("the inline instance must carry its property values:\n%s", screen)
	}
}
