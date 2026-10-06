package codegen_test

import (
	"bytes"
	"os"
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
	. "github.com/bernardoforcillo/opendesigner/internal/codegen/samples"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

func apply(t *testing.T, doc *opendesignerv1.Document, ops ...*opendesignerv1.Op) {
	t.Helper()
	for _, op := range ops {
		if err := core.Apply(doc, op); err != nil {
			t.Fatal(err)
		}
	}
}

func colorValue(r, g, b float32) *opendesignerv1.VariableValue {
	return &opendesignerv1.VariableValue{Kind: &opendesignerv1.VariableValue_Color{Color: &opendesignerv1.Color{R: r, G: g, B: b, A: 1}}}
}

// themedDoc: a screen with a card whose fill is bound to the "surface" color
// variable (light = pure green, dark = pure blue). The card's literal fill is red.
func themedDoc(t *testing.T) *opendesignerv1.Document {
	doc := screenDoc(func(b *B, s string) {
		b.Add("card", s, "Card", 20, 20, 100, 100, Fill(Solid(C(1, 0, 0))))
	})
	apply(t, doc,
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetCollection{SetCollection: &opendesignerv1.SetCollection{Collection: &opendesignerv1.VariableCollection{
			Id: "theme", Name: "Theme", Modes: []*opendesignerv1.VariableMode{{Id: "light", Name: "Light"}, {Id: "dark", Name: "Dark"}}}}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetVariable{SetVariable: &opendesignerv1.SetVariable{Variable: &opendesignerv1.Variable{
			Id: "surface", CollectionId: "theme", Name: "color/surface", Type: opendesignerv1.VariableType_VARIABLE_TYPE_COLOR,
			Values: map[string]*opendesignerv1.VariableValue{"light": colorValue(0, 1, 0), "dark": colorValue(0, 0, 1)}}}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
			Id: "card", Patch: &opendesignerv1.Node{Bindings: map[string]string{"fills.0": "surface"}},
			Mask: &fieldmaskpb.FieldMask{Paths: []string{"bindings"}}}}},
	)
	return doc
}

func screenHTML(t *testing.T, doc *opendesignerv1.Document) string {
	return string(file(t, gen(t, doc, codegen.TargetHTML, nil), "screen.html"))
}

// TestVariablesAreResolvedInTheExport: the code carries the value of the node's
// active mode, exactly what the canvas draws -- and the document is not touched.
func TestVariablesAreResolvedInTheExport(t *testing.T) {
	doc := themedDoc(t)
	before := proto.Clone(doc)

	light := screenHTML(t, doc)
	if !strings.Contains(light, "background-color: #0f0;") || strings.Contains(light, "#f00") {
		t.Fatalf("default mode: want the light green and not the literal red:\n%s", light)
	}
	apply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: "scr", Patch: &opendesignerv1.Node{Modes: map[string]string{"theme": "dark"}},
		Mask: &fieldmaskpb.FieldMask{Paths: []string{"modes"}}}}})
	if dark := screenHTML(t, doc); !strings.Contains(dark, "background-color: #00f;") {
		t.Fatalf("screen pinned to dark: want the blue:\n%s", dark)
	}
	if !proto.Equal(before.(*opendesignerv1.Document).GetNodes()["card"], doc.GetNodes()["card"]) {
		t.Fatal("the export modified the document")
	}
}

// TestFontsAndTextStylesInTheExport: uploaded fonts become @font-face rules plus
// copied files, an italic text carries font-style, and a node that applies a shared
// text style is exported with that style's values (the same the canvas draws).
func TestFontsAndTextStylesInTheExport(t *testing.T) {
	ttf := append([]byte("\x00\x01\x00\x00"), []byte("fake-ttf-bytes")...)
	hash := strings.Repeat("a", 64)
	missing := strings.Repeat("b", 64)
	doc := screenDoc(func(b *B, s string) {
		b.Add("plain", s, "Plain", 10, 10, 200, 30, TextStyled("Plain", &opendesignerv1.TextStyle{FontFamily: "Inter, sans-serif", FontSize: 14, Italic: true}))
		b.Add("title", s, "Title", 10, 60, 200, 40, TextStyled("Title", &opendesignerv1.TextStyle{FontSize: 12}))
	})
	apply(t, doc,
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetFont{SetFont: &opendesignerv1.SetFont{Font: &opendesignerv1.FontFace{Id: "f1", Family: "Brand Sans", Weight: "700", Style: "normal", AssetHash: hash}}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetFont{SetFont: &opendesignerv1.SetFont{Font: &opendesignerv1.FontFace{Id: "f2", Family: "Gone Sans", Weight: "400", Style: "italic", AssetHash: missing}}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetTextStyleDef{SetTextStyleDef: &opendesignerv1.SetTextStyleDef{TextStyle: &opendesignerv1.TextStyleDef{
			Id: "h", Name: "Heading", Style: &opendesignerv1.TextStyle{FontFamily: "Brand Sans", FontSize: 32, FontWeight: "700"}}}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
			Id: "title", Patch: &opendesignerv1.Node{TextStyleId: "h"}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"text_style_id"}}}}},
	)
	src := codegen.FuncAssets(func(h string) ([]byte, error) {
		if h == hash {
			return ttf, nil
		}
		return nil, os.ErrNotExist
	})

	for target, dir := range map[codegen.Target]string{codegen.TargetHTML: "assets/", codegen.TargetReact: "public/assets/"} {
		out, err := codegen.Generate(doc, codegen.Options{Target: target}, src)
		if err != nil {
			t.Fatal(err)
		}
		if got := file(t, out, dir+hash+".ttf"); !bytes.Equal(got, ttf) {
			t.Errorf("%s: font copied with different bytes", target)
		}
		css := string(file(t, out, map[codegen.Target]string{codegen.TargetHTML: "screen.html", codegen.TargetReact: "src/index.css"}[target]))
		if !strings.Contains(css, `font-family: "Brand Sans";`) || !strings.Contains(css, `format("truetype")`) || !strings.Contains(css, "font-weight: 700;") {
			t.Errorf("%s: missing @font-face for the uploaded font:\n%s", target, css)
		}
		if strings.Contains(css, "Gone Sans") {
			t.Errorf("%s: a font whose file is missing must not get a rule", target)
		}
		warned := false
		for _, w := range out.Warnings {
			warned = warned || strings.Contains(w, "Gone Sans")
		}
		if !warned {
			t.Errorf("%s: no warning for the missing font file: %v", target, out.Warnings)
		}
	}

	html := string(file(t, gen(t, doc, codegen.TargetHTML, src), "screen.html"))
	if !strings.Contains(html, "font-style: italic;") {
		t.Errorf("italic text lost its font-style:\n%s", html)
	}
	if !strings.Contains(html, "font-size: 32px;") || !strings.Contains(html, `font-family: "Brand Sans"`) {
		t.Errorf("the shared text style was not applied to the exported text:\n%s", html)
	}
	react := string(file(t, gen(t, doc, codegen.TargetReact, src), "src/screens/Screen.tsx"))
	if !strings.Contains(react, "italic") {
		t.Errorf("react: italic text has no italic class:\n%s", react)
	}
}

// TestVariantsAndPropertiesInTheExport: the exported instance is the variant it chose,
// a text property sets the label, and a false boolean property leaves its target out --
// the same thing the canvas shows.
func TestVariantsAndPropertiesInTheExport(t *testing.T) {
	doc := screenDoc(func(b *B, s string) {
		for _, v := range []struct{ root, label, icon, text string }{
			{"m1", "l1", "i1", "Default button"}, {"m2", "l2", "i2", "Hover button"},
		} {
			b.Add(v.root, "page1", v.root, 0, 400, 200, 40, Frame(false, nil))
			b.Add(v.label, v.root, v.label, 0, 0, 150, 20, TextStyled(v.text, &opendesignerv1.TextStyle{FontSize: 14}))
			b.Add(v.icon, v.root, v.icon, 160, 0, 20, 20, Fill(Solid(C(1, 0, 0))))
		}
	})
	boolT, textT := opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_BOOLEAN, opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_TEXT
	props := func(label, icon string) []*opendesignerv1.ComponentProperty {
		return []*opendesignerv1.ComponentProperty{
			{Name: "Label", Type: textT, DefaultValue: "Button", TargetNodeIds: []string{label}},
			{Name: "ShowIcon", Type: boolT, DefaultValue: "true", TargetNodeIds: []string{icon}},
		}
	}
	apply(t, doc,
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateComponent{CreateComponent: &opendesignerv1.CreateComponent{ComponentId: "c1", RootNodeId: "m1", Name: "Button"}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateComponent{CreateComponent: &opendesignerv1.CreateComponent{ComponentId: "c2", RootNodeId: "m2", Name: "Button hover"}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComponentSet{SetComponentSet: &opendesignerv1.SetComponentSet{ComponentSet: &opendesignerv1.ComponentSet{
			Id: "s", Name: "Button", Axes: []*opendesignerv1.VariantAxis{{Name: "State", Options: []string{"default", "hover"}}}}}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComponentDef{SetComponentDef: &opendesignerv1.SetComponentDef{ComponentId: "c1", SetId: "s", Variant: map[string]string{"State": "default"}, Properties: props("l1", "i1")}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComponentDef{SetComponentDef: &opendesignerv1.SetComponentDef{ComponentId: "c2", SetId: "s", Variant: map[string]string{"State": "hover"}, Properties: props("l2", "i2")}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: &opendesignerv1.Node{
			Id: "inst", ParentId: "scr", OrderKey: "z1", Name: "Inst", Visible: true, Opacity: 1, X: 10, Y: 10, Width: 200, Height: 40,
			Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: "c1"}}}}}},
	)
	set := func(values, variants map[string]string) {
		apply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstanceProps{SetInstanceProps: &opendesignerv1.SetInstanceProps{InstanceId: "inst", PropertyValues: values, VariantProps: variants}}})
	}
	// The icon is the only red-filled node: its CSS background tells whether it was exported.
	hasIcon := func(html string) bool { return strings.Contains(html, "background-color: #f00;") }

	set(nil, nil)
	html := screenHTML(t, doc)
	if !strings.Contains(html, "Button") || strings.Contains(html, "Hover button") || !hasIcon(html) {
		t.Fatalf("defaults: the base variant with its default label and the icon:\n%s", html)
	}
	set(map[string]string{"Label": "Save", "ShowIcon": "false"}, map[string]string{"State": "hover"})
	html = screenHTML(t, doc)
	if !strings.Contains(html, ">Save<") || hasIcon(html) {
		t.Fatalf("hover + properties: the label must be \"Save\" and the icon left out:\n%s", html)
	}
	if strings.Contains(html, "Default button") || strings.Contains(html, "Hover button") {
		t.Fatalf("the property's text must replace the master's content:\n%s", html)
	}
}
