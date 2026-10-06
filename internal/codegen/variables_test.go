package codegen_test

import (
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
