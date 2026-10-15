package core

import (
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
)

func textDoc(t *testing.T) *opendesignerv1.Document {
	t.Helper()
	doc := NewDocument("d", "d")
	mustApply(t, doc,
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: &opendesignerv1.Node{
			Id: "t", ParentId: "page1", OrderKey: "a1", Visible: true, Opacity: 1, Width: 100, Height: 20,
			Shape: &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{Content: "Hi", Style: &opendesignerv1.TextStyle{FontFamily: "Inter, sans-serif", FontSize: 16}}},
		}}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetTextStyleDef{SetTextStyleDef: &opendesignerv1.SetTextStyleDef{TextStyle: &opendesignerv1.TextStyleDef{
			Id: "h", Name: "Heading", Style: &opendesignerv1.TextStyle{FontFamily: "Brand Sans", FontSize: 32, FontWeight: "700"},
		}}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
			Id: "t", Patch: &opendesignerv1.Node{TextStyleId: "h"}, Mask: mask("text_style_id")}}},
	)
	return doc
}

func TestResolveAppliesTheSharedTextStyleWithoutTouchingTheDocument(t *testing.T) {
	doc := textDoc(t)
	r := ResolveNode(doc, doc.Nodes["t"])
	if got := r.GetText().GetStyle(); got.GetFontSize() != 32 || got.GetFontFamily() != "Brand Sans" {
		t.Fatalf("resolved style = %v", got)
	}
	if own := doc.Nodes["t"].GetText().GetStyle(); own.GetFontSize() != 16 {
		t.Fatalf("the node's own style (the fallback) was modified: %v", own)
	}
	// Editing the shared style changes every node that uses it.
	mustApply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetTextStyleDef{SetTextStyleDef: &opendesignerv1.SetTextStyleDef{TextStyle: &opendesignerv1.TextStyleDef{
		Id: "h", Name: "Heading", Style: &opendesignerv1.TextStyle{FontSize: 40}}}}})
	if got := ResolveNode(doc, doc.Nodes["t"]).GetText().GetStyle().GetFontSize(); got != 40 {
		t.Fatalf("after editing the style: %v", got)
	}
}

func TestResolveComposesTextStyleAndVariables(t *testing.T) {
	doc := textDoc(t)
	mustApply(t, doc,
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetCollection{SetCollection: &opendesignerv1.SetCollection{Collection: &opendesignerv1.VariableCollection{
			Id: "c", Modes: []*opendesignerv1.VariableMode{{Id: "m"}}}}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetVariable{SetVariable: &opendesignerv1.SetVariable{Variable: &opendesignerv1.Variable{
			Id: "o", CollectionId: "c", Type: opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER,
			Values: map[string]*opendesignerv1.VariableValue{"m": numVal(0.5)}}}}},
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
			Id: "t", Patch: &opendesignerv1.Node{Bindings: map[string]string{"opacity": "o"}}, Mask: mask("bindings")}}},
	)
	r := ResolveNode(doc, doc.Nodes["t"])
	if r.GetOpacity() != 0.5 || r.GetText().GetStyle().GetFontSize() != 32 {
		t.Fatalf("both resolutions must apply: opacity=%v size=%v", r.GetOpacity(), r.GetText().GetStyle().GetFontSize())
	}
}

func TestDeleteTextStyleKeepsSharedNodesIntact(t *testing.T) {
	doc := textDoc(t)
	snap := &opendesignerv1.Document{Nodes: map[string]*opendesignerv1.Node{"t": doc.Nodes["t"]}}
	before := proto.Clone(doc.Nodes["t"])
	if err := ApplyShared(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteTextStyleDef{DeleteTextStyleDef: &opendesignerv1.DeleteTextStyleDef{Id: "h"}}}, NewShared()); err != nil {
		t.Fatal(err)
	}
	if !proto.Equal(snap.Nodes["t"], before) {
		t.Fatal("the cascade wrote through a shared node")
	}
	if doc.Nodes["t"].GetTextStyleId() != "" || doc.Nodes["t"].GetText().GetStyle().GetFontSize() != 16 {
		t.Fatalf("after deleting the style the node keeps its own style: %v", doc.Nodes["t"])
	}
}

func TestFontFamilyAndHashAreValidated(t *testing.T) {
	doc := NewDocument("d", "d")
	ok := &opendesignerv1.FontFace{Id: "f", Family: "Fira Code", Weight: "400", Style: "normal", AssetHash: strings.Repeat("a", 64)}
	if err := ValidateFont(doc, ok); err != nil {
		t.Fatal(err)
	}
	for name, mod := range map[string]func(*opendesignerv1.FontFace){
		"quote":     func(f *opendesignerv1.FontFace) { f.Family = `A"B` },
		"semicolon": func(f *opendesignerv1.FontFace) { f.Family = "A;B" },
		"brace":     func(f *opendesignerv1.FontFace) { f.Family = "A{B}" },
		"empty":     func(f *opendesignerv1.FontFace) { f.Family = "" },
		"long":      func(f *opendesignerv1.FontFace) { f.Family = strings.Repeat("x", 65) },
		"upper hex": func(f *opendesignerv1.FontFace) { f.AssetHash = strings.Repeat("A", 64) },
		"short":     func(f *opendesignerv1.FontFace) { f.AssetHash = "abc" },
	} {
		bad := proto.Clone(ok).(*opendesignerv1.FontFace)
		mod(bad)
		if ValidateFont(doc, bad) == nil {
			t.Errorf("%s must be rejected", name)
		}
	}
	// Non-ASCII family names are fine.
	ok.Family = "Noto Sans 日本語"
	if err := ValidateFont(doc, ok); err != nil {
		t.Fatal(err)
	}
}
