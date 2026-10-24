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
	if err := ValidateTextStyleDef(def(nil)); err != nil {
		t.Fatal(err)
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
		"empty item": func(s *opendesignerv1.TextStyle) { s.FontFeatures = `"liga",,"tnum"` },
	} {
		if ValidateTextStyleDef(def(mod)) == nil {
			t.Errorf("%s must be rejected", name)
		}
	}
}
