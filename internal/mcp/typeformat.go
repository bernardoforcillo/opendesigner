package mcp

import (
	"fmt"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

// TextFormat is the type-and-paragraph half of a text style (docs/typography.md,
// "Case, scripts, lists and OpenType"): create_text, set_text and the text style tools
// embed it. Every field is optional; one that is left out keeps the node's value.
type TextFormat struct {
	TextCase      string   `json:"textCase,omitempty" jsonschema:"none (as typed) | upper | lower | title | smallCaps"`
	Script        string   `json:"script,omitempty" jsonschema:"none (baseline) | super | sub"`
	List          string   `json:"list,omitempty" jsonschema:"none | bullet | numbered; every line break in the content starts a list item"`
	Indent        *float64 `json:"indent,omitempty" jsonschema:"px added to the left of every paragraph (>= 0)"`
	FontFeatures  *string  `json:"fontFeatures,omitempty" jsonschema:"OpenType features as a CSS font-feature-settings value, e.g. \"liga\" 0, \"tnum\", \"ss01\" (ligatures off, tabular figures, stylistic set 1); \"\" clears. Canvas honours liga/smcp, the CSS and SVG exports all of them"`
	VerticalAlign string   `json:"verticalAlign,omitempty" jsonschema:"top (default) | middle | bottom: where the text sits in a box taller than it"`
	Inset         *float64 `json:"inset,omitempty" jsonschema:"padding between the text box and the text, on every side (>= 0)"`
}

func (f TextFormat) given() bool {
	return f.TextCase != "" || f.Script != "" || f.List != "" || f.Indent != nil || f.FontFeatures != nil || f.VerticalAlign != "" || f.Inset != nil
}

// apply overlays the given fields onto style, rejecting a bad name or value.
func (f TextFormat) apply(style *opendesignerv1.TextStyle) error {
	switch f.TextCase {
	case "":
	case "none":
		style.TextCase = opendesignerv1.TextCase_TEXT_CASE_UNSPECIFIED
	case "upper":
		style.TextCase = opendesignerv1.TextCase_TEXT_CASE_UPPER
	case "lower":
		style.TextCase = opendesignerv1.TextCase_TEXT_CASE_LOWER
	case "title":
		style.TextCase = opendesignerv1.TextCase_TEXT_CASE_TITLE
	case "smallCaps":
		style.TextCase = opendesignerv1.TextCase_TEXT_CASE_SMALL_CAPS
	default:
		return fmt.Errorf("textCase must be none, upper, lower, title or smallCaps, got %q", f.TextCase)
	}
	switch f.Script {
	case "":
	case "none":
		style.TextScript = opendesignerv1.TextScript_TEXT_SCRIPT_UNSPECIFIED
	case "super":
		style.TextScript = opendesignerv1.TextScript_TEXT_SCRIPT_SUPER
	case "sub":
		style.TextScript = opendesignerv1.TextScript_TEXT_SCRIPT_SUB
	default:
		return fmt.Errorf("script must be none, super or sub, got %q", f.Script)
	}
	switch f.List {
	case "":
	case "none":
		style.ListKind = opendesignerv1.ListKind_LIST_KIND_UNSPECIFIED
	case "bullet":
		style.ListKind = opendesignerv1.ListKind_LIST_KIND_BULLET
	case "numbered":
		style.ListKind = opendesignerv1.ListKind_LIST_KIND_NUMBERED
	default:
		return fmt.Errorf("list must be none, bullet or numbered, got %q", f.List)
	}
	switch f.VerticalAlign {
	case "":
	case "top":
		style.VerticalAlign = opendesignerv1.TextVAlign_TEXT_V_ALIGN_UNSPECIFIED
	case "middle":
		style.VerticalAlign = opendesignerv1.TextVAlign_TEXT_V_ALIGN_MIDDLE
	case "bottom":
		style.VerticalAlign = opendesignerv1.TextVAlign_TEXT_V_ALIGN_BOTTOM
	default:
		return fmt.Errorf("verticalAlign must be top, middle or bottom, got %q", f.VerticalAlign)
	}
	if f.Indent != nil {
		if !(*f.Indent >= 0) {
			return fmt.Errorf("indent must be >= 0, got %v", *f.Indent)
		}
		style.Indent = *f.Indent
	}
	if f.Inset != nil {
		if !(*f.Inset >= 0) {
			return fmt.Errorf("inset must be >= 0, got %v", *f.Inset)
		}
		style.Inset = *f.Inset
	}
	if f.FontFeatures != nil {
		if !core.ValidFontFeatures(*f.FontFeatures) {
			return fmt.Errorf(`fontFeatures must look like "liga" 0, "tnum", "ss01" 1, got %q`, *f.FontFeatures)
		}
		style.FontFeatures = *f.FontFeatures
	}
	return nil
}

// formatOf reads the format of a style back for the views (defaults left out).
func formatOf(st *opendesignerv1.TextStyle) TextFormat {
	var f TextFormat
	switch st.GetTextCase() {
	case opendesignerv1.TextCase_TEXT_CASE_UPPER:
		f.TextCase = "upper"
	case opendesignerv1.TextCase_TEXT_CASE_LOWER:
		f.TextCase = "lower"
	case opendesignerv1.TextCase_TEXT_CASE_TITLE:
		f.TextCase = "title"
	case opendesignerv1.TextCase_TEXT_CASE_SMALL_CAPS:
		f.TextCase = "smallCaps"
	}
	switch st.GetTextScript() {
	case opendesignerv1.TextScript_TEXT_SCRIPT_SUPER:
		f.Script = "super"
	case opendesignerv1.TextScript_TEXT_SCRIPT_SUB:
		f.Script = "sub"
	}
	switch st.GetListKind() {
	case opendesignerv1.ListKind_LIST_KIND_BULLET:
		f.List = "bullet"
	case opendesignerv1.ListKind_LIST_KIND_NUMBERED:
		f.List = "numbered"
	}
	switch st.GetVerticalAlign() {
	case opendesignerv1.TextVAlign_TEXT_V_ALIGN_MIDDLE:
		f.VerticalAlign = "middle"
	case opendesignerv1.TextVAlign_TEXT_V_ALIGN_BOTTOM:
		f.VerticalAlign = "bottom"
	}
	if v := st.GetIndent(); v > 0 {
		f.Indent = &v
	}
	if v := st.GetInset(); v > 0 {
		f.Inset = &v
	}
	if v := st.GetFontFeatures(); v != "" {
		f.FontFeatures = &v
	}
	return f
}
