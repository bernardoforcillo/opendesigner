package core

import (
	"errors"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

func objectStyleOp(d *opendesignerv1.ObjectStyleDef) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetObjectStyleDef{SetObjectStyleDef: &opendesignerv1.SetObjectStyleDef{ObjectStyle: d}}}
}

func layerOp(l *opendesignerv1.Layer) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetLayer{SetLayer: &opendesignerv1.SetLayer{Layer: l}}}
}

func setPath(id string, patch *opendesignerv1.Node, paths ...string) *opendesignerv1.Op {
	patch.Id = id
	return setPropsOp(&opendesignerv1.SetProperties{Id: id, Patch: patch, Mask: &fieldmaskpb.FieldMask{Paths: paths}})
}

func red() []*opendesignerv1.Paint {
	return []*opendesignerv1.Paint{{Kind: &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{Color: &opendesignerv1.Color{R: 1, A: 1}}}}}
}

func TestObjectStyles(t *testing.T) {
	doc := NewDocument("d", "d")
	mustApply(t, doc, createOp(rectNode("a", 0, 0)), createOp(rectNode("b", 0, 0)))
	card := &opendesignerv1.ObjectStyleDef{Id: "card", Name: "Card", Sets: []string{"fills", "opacity", "corner_radius"}, Fills: red(), Opacity: 0.5, CornerRadius: 8}
	mustApply(t, doc, objectStyleOp(card), setPath("a", &opendesignerv1.Node{ObjectStyleId: "card"}, "object_style_id"))

	// The resolved node takes what the style sets; the document keeps the node's own values.
	got := ResolveNode(doc, doc.Nodes["a"])
	if got.GetOpacity() != 0.5 || got.GetRect().GetCornerRadius() != 8 || got.GetFills()[0].GetSolid().GetColor().GetR() != 1 {
		t.Fatalf("resolved = %v", got)
	}
	if doc.Nodes["a"].GetOpacity() == 0.5 {
		t.Fatal("the document's node was changed by resolving it")
	}
	// A style based on another starts from it and overrides what it sets.
	mustApply(t, doc, objectStyleOp(&opendesignerv1.ObjectStyleDef{Id: "soft", Name: "Soft", BasedOn: "card", Sets: []string{"opacity"}, Opacity: 0.2}),
		setPath("b", &opendesignerv1.Node{ObjectStyleId: "soft"}, "object_style_id"))
	b := ResolveNode(doc, doc.Nodes["b"])
	if b.GetOpacity() != 0.2 || b.GetRect().GetCornerRadius() != 8 {
		t.Fatalf("based-on resolved = %v", b)
	}

	bad := map[string]*opendesignerv1.Op{
		"unknown property": objectStyleOp(&opendesignerv1.ObjectStyleDef{Id: "x", Sets: []string{"width"}}),
		"duplicate":        objectStyleOp(&opendesignerv1.ObjectStyleDef{Id: "x", Sets: []string{"fills", "fills"}}),
		"opacity 2":        objectStyleOp(&opendesignerv1.ObjectStyleDef{Id: "x", Sets: []string{"opacity"}, Opacity: 2}),
		"based on itself":  objectStyleOp(&opendesignerv1.ObjectStyleDef{Id: "card", BasedOn: "card"}),
		"based on missing": objectStyleOp(&opendesignerv1.ObjectStyleDef{Id: "x", BasedOn: "nope"}),
		"loop":             objectStyleOp(&opendesignerv1.ObjectStyleDef{Id: "card", BasedOn: "soft"}),
		"missing style":    setPath("a", &opendesignerv1.Node{ObjectStyleId: "nope"}, "object_style_id"),
	}
	for name, op := range bad {
		if err := Apply(doc, op); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}

	// Deleting a style detaches its nodes and the styles based on it.
	mustApply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteObjectStyleDef{DeleteObjectStyleDef: &opendesignerv1.DeleteObjectStyleDef{Id: "card"}}})
	if doc.Nodes["a"].GetObjectStyleId() != "" || doc.ObjectStyles["soft"].GetBasedOn() != "" {
		t.Fatalf("not detached: %v / %v", doc.Nodes["a"].GetObjectStyleId(), doc.ObjectStyles["soft"])
	}
	if err := Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteObjectStyleDef{DeleteObjectStyleDef: &opendesignerv1.DeleteObjectStyleDef{Id: "card"}}}); !errors.Is(err, ErrObjectStyleMissing) {
		t.Fatalf("second delete: %v", err)
	}
}

func TestObjectStyleNotOnGroups(t *testing.T) {
	doc := NewDocument("d", "d")
	g := &opendesignerv1.Node{Id: "g", ParentId: "page1", OrderKey: "a", Visible: true, Opacity: 1, Shape: &opendesignerv1.Node_Group{Group: &opendesignerv1.GroupNode{}}}
	mustApply(t, doc, createOp(g), objectStyleOp(&opendesignerv1.ObjectStyleDef{Id: "s", Name: "S"}))
	if err := Apply(doc, setPath("g", &opendesignerv1.Node{ObjectStyleId: "s"}, "object_style_id")); !errors.Is(err, ErrNotStylable) {
		t.Fatalf("group: %v", err)
	}
}

func TestLayers(t *testing.T) {
	doc := NewDocument("d", "d")
	mustApply(t, doc, createOp(rectNode("a", 0, 0)), layerOp(&opendesignerv1.Layer{Id: "l1", Name: "Art"}), layerOp(&opendesignerv1.Layer{Id: "l2", Name: "Text"}),
		setPath("a", &opendesignerv1.Node{LayerId: "l1"}, "layer_id"))
	// Upserting keeps the place; a new id is appended.
	mustApply(t, doc, layerOp(&opendesignerv1.Layer{Id: "l1", Name: "Artwork", Hidden: true}))
	if len(doc.Layers) != 2 || doc.Layers[0].GetName() != "Artwork" || !doc.Layers[0].GetHidden() || doc.Layers[1].GetId() != "l2" {
		t.Fatalf("layers = %v", doc.Layers)
	}
	for name, op := range map[string]*opendesignerv1.Op{
		"empty id":      layerOp(&opendesignerv1.Layer{Name: "x"}),
		"control name":  layerOp(&opendesignerv1.Layer{Id: "x", Name: "a\nb"}),
		"missing layer": setPath("a", &opendesignerv1.Node{LayerId: "nope"}, "layer_id"),
	} {
		if err := Apply(doc, op); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
	mustApply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteLayer{DeleteLayer: &opendesignerv1.DeleteLayer{Id: "l1"}}})
	if doc.Nodes["a"].GetLayerId() != "" || len(doc.Layers) != 1 {
		t.Fatalf("not detached: %q %v", doc.Nodes["a"].GetLayerId(), doc.Layers)
	}
	if err := Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteLayer{DeleteLayer: &opendesignerv1.DeleteLayer{Id: "l1"}}}); !errors.Is(err, ErrLayerMissing) {
		t.Fatalf("second delete: %v", err)
	}
}

func TestSwatches(t *testing.T) {
	doc := NewDocument("d", "d")
	col := &opendesignerv1.VariableCollection{Id: "c", Name: "Swatches", Modes: []*opendesignerv1.VariableMode{{Id: "m", Name: "Default"}}}
	value := map[string]*opendesignerv1.VariableValue{"m": {Kind: &opendesignerv1.VariableValue_Color{Color: &opendesignerv1.Color{R: 0.9, G: 0.1, B: 0.1, A: 1}}}}
	setVar := func(v *opendesignerv1.Variable) *opendesignerv1.Op {
		return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetVariable{SetVariable: &opendesignerv1.SetVariable{Variable: v}}}
	}
	mustApply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetCollection{SetCollection: &opendesignerv1.SetCollection{Collection: col}}})
	color := opendesignerv1.VariableType_VARIABLE_TYPE_COLOR
	mustApply(t, doc,
		setVar(&opendesignerv1.Variable{Id: "red", CollectionId: "c", Name: "Red", Type: color, Values: value, Swatch: true, Cmyk: &opendesignerv1.Cmyk{M: 1, Y: 1}}),
		setVar(&opendesignerv1.Variable{Id: "spot", CollectionId: "c", Name: "Brand", Type: color, Values: value, Swatch: true, SpotName: "PANTONE 485 C"}),
		setVar(&opendesignerv1.Variable{Id: "red50", CollectionId: "c", Name: "Red 50%", Type: color, Values: value, Swatch: true, TintOf: "red", Tint: 50}),
	)
	for name, v := range map[string]*opendesignerv1.Variable{
		"cmyk out of range": {Id: "x", CollectionId: "c", Name: "x", Type: color, Values: value, Swatch: true, Cmyk: &opendesignerv1.Cmyk{C: 2}},
		"tint without base": {Id: "x", CollectionId: "c", Name: "x", Type: color, Values: value, Swatch: true, Tint: 50},
		"base without tint": {Id: "x", CollectionId: "c", Name: "x", Type: color, Values: value, Swatch: true, TintOf: "red"},
		"tint of itself":    {Id: "x", CollectionId: "c", Name: "x", Type: color, Values: value, Swatch: true, TintOf: "x", Tint: 10},
		"tint of missing":   {Id: "x", CollectionId: "c", Name: "x", Type: color, Values: value, Swatch: true, TintOf: "nope", Tint: 10},
		"tint over 100":     {Id: "x", CollectionId: "c", Name: "x", Type: color, Values: value, Swatch: true, TintOf: "red", Tint: 120},
		"long spot name":    {Id: "x", CollectionId: "c", Name: "x", Type: color, Values: value, Swatch: true, SpotName: string(make([]byte, 100))},
		"swatch number":     {Id: "x", CollectionId: "c", Name: "x", Type: opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER, Swatch: true},
	} {
		if err := Apply(doc, setVar(v)); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}

func TestColorMode(t *testing.T) {
	doc := NewDocument("d", "d")
	set := func(s *opendesignerv1.DocSettings) error {
		return Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetDocSettings{SetDocSettings: &opendesignerv1.SetDocSettings{Settings: s}}})
	}
	if err := set(&opendesignerv1.DocSettings{ColorMode: "cmyk", IccProfile: "FOGRA39"}); err != nil {
		t.Fatal(err)
	}
	for _, s := range []*opendesignerv1.DocSettings{{ColorMode: "lab"}, {IccProfile: " padded "}, {IccProfile: string(make([]byte, 80))}, {IccProfile: "a\nb"}} {
		if err := set(s); !errors.Is(err, ErrBadDocSettings) {
			t.Errorf("%v: got %v", s, err)
		}
	}
}

func TestDeletingABaseSwatchKeepsItsTints(t *testing.T) {
	doc := NewDocument("d", "d")
	col := &opendesignerv1.VariableCollection{Id: "c", Name: "Swatches", Modes: []*opendesignerv1.VariableMode{{Id: "m", Name: "Default"}}}
	value := map[string]*opendesignerv1.VariableValue{"m": {Kind: &opendesignerv1.VariableValue_Color{Color: &opendesignerv1.Color{A: 1}}}}
	color := opendesignerv1.VariableType_VARIABLE_TYPE_COLOR
	set := func(v *opendesignerv1.Variable) *opendesignerv1.Op {
		return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetVariable{SetVariable: &opendesignerv1.SetVariable{Variable: v}}}
	}
	mustApply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetCollection{SetCollection: &opendesignerv1.SetCollection{Collection: col}}},
		set(&opendesignerv1.Variable{Id: "base", CollectionId: "c", Name: "Base", Type: color, Values: value, Swatch: true}),
		set(&opendesignerv1.Variable{Id: "t", CollectionId: "c", Name: "T", Type: color, Values: value, Swatch: true, TintOf: "base", Tint: 40}),
		&opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteVariable{DeleteVariable: &opendesignerv1.DeleteVariable{Id: "base"}}})
	if v := doc.Variables["t"]; v == nil || v.GetTintOf() != "" || v.GetTint() != 0 || !v.GetSwatch() {
		t.Fatalf("tint = %v", doc.Variables["t"])
	}
}
