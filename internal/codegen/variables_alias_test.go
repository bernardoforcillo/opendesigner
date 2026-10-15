package codegen_test

import (
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	. "github.com/bernardoforcillo/opendesigner/internal/codegen/samples"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

// TestAliasAndStringVariablesAreResolvedInTheExport: a semantic color token that
// aliases a primitive, a string variable (through an alias) bound to the content
// and a number bound to the font size all come out as plain values.
func TestAliasAndStringVariablesAreResolvedInTheExport(t *testing.T) {
	doc := screenDoc(func(b *B, s string) {
		b.Add("card", s, "Card", 20, 20, 100, 100, Fill(Solid(C(1, 0, 0))))
		b.Add("label", s, "Label", 20, 140, 200, 30, Text("literal", 12, "400", opendesignerv1.TextAlign_TEXT_ALIGN_LEFT))
	})
	str := func(v string) *opendesignerv1.VariableValue {
		return &opendesignerv1.VariableValue{Kind: &opendesignerv1.VariableValue_Text{Text: v}}
	}
	size := &opendesignerv1.VariableValue{Kind: &opendesignerv1.VariableValue_Number{Number: 31}}
	bind := func(id string, b map[string]string) *opendesignerv1.Op {
		return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
			Id: id, Patch: &opendesignerv1.Node{Bindings: b}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"bindings"}}}}}
	}
	setVar := func(v *opendesignerv1.Variable) *opendesignerv1.Op {
		return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetVariable{SetVariable: &opendesignerv1.SetVariable{Variable: v}}}
	}
	apply(t, doc,
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetCollection{SetCollection: &opendesignerv1.SetCollection{Collection: &opendesignerv1.VariableCollection{
			Id: "theme", Name: "Theme", Modes: []*opendesignerv1.VariableMode{{Id: "light", Name: "Light"}}}}}},
		setVar(&opendesignerv1.Variable{Id: "green", CollectionId: "theme", Name: "prim/green", Type: opendesignerv1.VariableType_VARIABLE_TYPE_COLOR,
			Values: map[string]*opendesignerv1.VariableValue{"light": colorValue(0, 1, 0)}}),
		setVar(&opendesignerv1.Variable{Id: "ok", CollectionId: "theme", Name: "sem/ok", Type: opendesignerv1.VariableType_VARIABLE_TYPE_COLOR, AliasOf: "green"}),
		setVar(&opendesignerv1.Variable{Id: "word", CollectionId: "theme", Name: "prim/word", Type: opendesignerv1.VariableType_VARIABLE_TYPE_STRING,
			Values: map[string]*opendesignerv1.VariableValue{"light": str("From a token")}}),
		setVar(&opendesignerv1.Variable{Id: "copy", CollectionId: "theme", Name: "sem/copy", Type: opendesignerv1.VariableType_VARIABLE_TYPE_STRING, AliasOf: "word"}),
		setVar(&opendesignerv1.Variable{Id: "big", CollectionId: "theme", Name: "size/big", Type: opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER,
			Values: map[string]*opendesignerv1.VariableValue{"light": size}}),
		bind("card", map[string]string{"fills.0": "ok"}),
		bind("label", map[string]string{"text": "copy", "font_size": "big"}),
	)
	out := screenHTML(t, doc)
	for _, want := range []string{"background-color: #0f0;", "From a token", "font-size: 31px"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "literal") || strings.Contains(out, "#f00") {
		t.Fatalf("a literal survived its binding:\n%s", out)
	}
}
