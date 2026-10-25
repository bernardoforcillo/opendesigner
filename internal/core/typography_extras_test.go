package core

import (
	"math"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

func TestTextExtrasAreValidated(t *testing.T) {
	def := func(mod func(*opendesignerv1.TextStyle)) *opendesignerv1.TextStyleDef {
		st := &opendesignerv1.TextStyle{FontSize: 16, TextCase: opendesignerv1.TextCase_TEXT_CASE_SMALL_CAPS,
			TextScript: opendesignerv1.TextScript_TEXT_SCRIPT_SUPER, ListKind: opendesignerv1.ListKind_LIST_KIND_NUMBERED,
			Indent: 12, Inset: 4, VerticalAlign: opendesignerv1.TextVAlign_TEXT_V_ALIGN_MIDDLE, FontFeatures: `"liga" 0, "tnum", "ss01" 1`}
		if mod != nil {
			mod(st)
		}
		return &opendesignerv1.TextStyleDef{Id: "x", Name: "x", Style: st}
	}
	if err := ValidateTextStyleDef(NewDocument("d", "d"), def(nil)); err != nil {
		t.Fatal(err)
	}
	for _, ok := range []float64{0, 1, 100, 1000} {
		if err := ValidateTextStyleDef(NewDocument("d", "d"), def(func(s *opendesignerv1.TextStyle) { s.TextScale = ok })); err != nil {
			t.Errorf("text_scale %v must be accepted: %v", ok, err)
		}
	}
	for name, mod := range map[string]func(*opendesignerv1.TextStyle){
		"case":       func(s *opendesignerv1.TextStyle) { s.TextCase = 99 },
		"script":     func(s *opendesignerv1.TextStyle) { s.TextScript = -1 },
		"list":       func(s *opendesignerv1.TextStyle) { s.ListKind = 9 },
		"valign":     func(s *opendesignerv1.TextStyle) { s.VerticalAlign = 9 },
		"indent":     func(s *opendesignerv1.TextStyle) { s.Indent = -1 },
		"inset":      func(s *opendesignerv1.TextStyle) { s.Inset = math.NaN() },
		"unquoted":   func(s *opendesignerv1.TextStyle) { s.FontFeatures = "liga" },
		"semicolon":  func(s *opendesignerv1.TextStyle) { s.FontFeatures = `"liga";color:red` },
		"long tag":   func(s *opendesignerv1.TextStyle) { s.FontFeatures = `"ligature"` },
		"bad value":  func(s *opendesignerv1.TextStyle) { s.FontFeatures = `"liga" x` },
		"scale low":  func(s *opendesignerv1.TextStyle) { s.TextScale = 0.5 },
		"scale high": func(s *opendesignerv1.TextStyle) { s.TextScale = 1001 },
		"scale nan":  func(s *opendesignerv1.TextStyle) { s.TextScale = math.NaN() },
		"empty item": func(s *opendesignerv1.TextStyle) { s.FontFeatures = `"liga",,"tnum"` },
	} {
		if ValidateTextStyleDef(NewDocument("d", "d"), def(mod)) == nil {
			t.Errorf("%s must be rejected", name)
		}
	}
}

// A character style may carry case, script, features and scale, but not what only a paragraph or the
// whole box can apply (list, indent, vertical alignment, inset).
func TestCharacterStyleCannotCarryParagraphTypeSettings(t *testing.T) {
	char := func(st *opendesignerv1.TextStyle) *opendesignerv1.TextStyleDef {
		return &opendesignerv1.TextStyleDef{Id: "c", Name: "c", Kind: opendesignerv1.TextStyleKind_TEXT_STYLE_KIND_CHARACTER, Style: st}
	}
	doc := NewDocument("d", "d")
	if err := ValidateTextStyleDef(doc, char(&opendesignerv1.TextStyle{TextCase: opendesignerv1.TextCase_TEXT_CASE_UPPER,
		TextScript: opendesignerv1.TextScript_TEXT_SCRIPT_SUB, FontFeatures: `"tnum"`, TextScale: 120})); err != nil {
		t.Fatal(err)
	}
	for name, st := range map[string]*opendesignerv1.TextStyle{
		"list":   {ListKind: opendesignerv1.ListKind_LIST_KIND_BULLET},
		"indent": {Indent: 4},
		"valign": {VerticalAlign: opendesignerv1.TextVAlign_TEXT_V_ALIGN_BOTTOM},
		"inset":  {Inset: 2},
	} {
		if ValidateTextStyleDef(doc, char(st)) == nil {
			t.Errorf("a character style with %s must be rejected", name)
		}
	}
	// The same fields are fine on a paragraph style.
	para := &opendesignerv1.TextStyleDef{Id: "p", Name: "p", Style: &opendesignerv1.TextStyle{ListKind: opendesignerv1.ListKind_LIST_KIND_BULLET, Indent: 4, Inset: 2}}
	if err := ValidateTextStyleDef(doc, para); err != nil {
		t.Fatal(err)
	}
}
