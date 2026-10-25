package codegen

import (
	"math"
	"strconv"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

// The type extras of a text node (case, super/subscript, lists, indent, OpenType
// features, vertical alignment, inset) as CSS. The constants repeat
// web/src/renderer/text.ts so the export sits where the canvas draws.
const (
	textScriptScale = 0.65 // SCRIPT_SCALE
	textSuperRise   = 0.33
	textSubDrop     = 0.12
	listGapEm       = 0.4 // LIST_GAP_EM
	listMinMarkerEm = 0.9 // LIST_MIN_MARKER_EM
)

// scriptScale is the glyph scale of a super/subscript (1 for none).
func scriptScale(st *opendesignerv1.TextStyle) float64 {
	if st.GetTextScript() != opendesignerv1.TextScript_TEXT_SCRIPT_UNSPECIFIED {
		return textScriptScale
	}
	return 1
}

// textExtras adds the declarations for the style's type extras to a text element.
// `size` is the unscaled font size and `lh` the line-height multiplier (both resolved);
// `listable` is false when the text is bound to a component property (its content
// cannot be split into paragraph elements).
func textExtras(el *Element, st *opendesignerv1.TextStyle, size, lh float64, height float64, listable, rotated bool) {
	switch st.GetTextCase() {
	case opendesignerv1.TextCase_TEXT_CASE_UPPER:
		el.addStyle("text-transform", "uppercase")
	case opendesignerv1.TextCase_TEXT_CASE_LOWER:
		el.addStyle("text-transform", "lowercase")
	case opendesignerv1.TextCase_TEXT_CASE_TITLE:
		// `capitalize` leaves the rest of each word alone, the canvas lowercases it.
		el.Text = strings.ToLower(el.Text)
		el.addStyle("text-transform", "capitalize")
	case opendesignerv1.TextCase_TEXT_CASE_SMALL_CAPS:
		el.addStyle("font-variant-caps", "small-caps")
	}
	if f := st.GetFontFeatures(); f != "" && core.ValidFontFeatures(f) {
		el.addStyle("font-feature-settings", f)
	}

	// A script text is drawn smaller (font-size is already scaled by the caller) and
	// shifted from the baseline: the padding stands in for the shift.
	if sc := scriptScale(st); sc != 1 {
		asc := (size*lh-size)/2 + 0.8*size
		shift := size * textSubDrop
		if st.GetTextScript() == opendesignerv1.TextScript_TEXT_SCRIPT_SUPER {
			shift = -size * textSuperRise
		}
		if pad := asc + shift - sc*asc; pad > 0.5 {
			el.addStyle("padding-top", px(pad))
		}
	}

	// Horizontal scale: scaleX about the edge the text hangs from, with the width divided so the box
	// keeps its size. A rotated text keeps the rotation transform alone (declared approximation).
	if sc := st.GetTextScale(); sc > 0 && sc != 100 && sc <= 1000 && !rotated {
		k := sc / 100
		origin := "left top"
		switch st.GetAlign() {
		case opendesignerv1.TextAlign_TEXT_ALIGN_CENTER:
			origin = "center top"
		case opendesignerv1.TextAlign_TEXT_ALIGN_RIGHT:
			origin = "right top"
		}
		el.addStyle("transform", "scaleX("+num(k)+")")
		el.addStyle("transform-origin", origin)
		if w := el.style("width"); strings.HasSuffix(w, "px") {
			if v, err := strconv.ParseFloat(strings.TrimSuffix(w, "px"), 64); err == nil {
				el.delStyle("width")
				el.addStyle("width", px(v/k))
			}
		}
	}

	inset, indent := st.GetInset(), st.GetIndent()
	if inset > 0 || indent > 0 {
		el.addStyle("box-sizing", "border-box")
		if inset > 0 {
			el.addStyle("padding", px(inset))
		}
		if indent > 0 {
			el.addStyle("padding-left", px(inset+indent))
		}
	}
	if va := st.GetVerticalAlign(); va != opendesignerv1.TextVAlign_TEXT_V_ALIGN_UNSPECIFIED && height > 0 {
		el.addStyle("display", "flex")
		el.addStyle("flex-direction", "column")
		if va == opendesignerv1.TextVAlign_TEXT_V_ALIGN_MIDDLE {
			el.addStyle("justify-content", "center")
		} else {
			el.addStyle("justify-content", "flex-end")
		}
		el.addStyle("height", px(height))
		el.addStyle("box-sizing", "border-box")
	}

	if st.GetListKind() != opendesignerv1.ListKind_LIST_KIND_UNSPECIFIED && listable && el.Text != "" {
		listParagraphs(el, st, size, lh)
	}
}

// listParagraphs turns the text into one `display: list-item` child per paragraph, so the
// browser draws the marker (disc or decimal, numbered in order) hanging outside the
// text. Empty paragraphs are plain blocks: no marker, but they keep a line's height.
func listParagraphs(el *Element, st *opendesignerv1.TextStyle, size, lh float64) {
	paras := strings.Split(strings.ReplaceAll(strings.ReplaceAll(el.Text, "\r\n", "\n"), "\r", "\n"), "\n")
	items := 0
	for _, p := range paras {
		if strings.TrimSpace(p) != "" {
			items++
		}
	}
	numbered := st.GetListKind() == opendesignerv1.ListKind_LIST_KIND_NUMBERED
	col := listMinMarkerEm
	if numbered {
		col = math.Max(col, float64(len(strconv.Itoa(items)))*0.6+0.35)
	}
	col += listGapEm

	el.Text, el.HasText = "", false
	// The paragraphs are separate blocks: the parent must not keep their source
	// whitespace as visible lines.
	el.delStyle("white-space")
	el.addStyle("white-space", "normal")
	for _, p := range paras {
		child := &Element{Tag: "div", Text: p, HasText: true}
		child.addStyle("white-space", "pre-wrap")
		child.addStyle("overflow-wrap", "break-word")
		if strings.TrimSpace(p) == "" {
			child.addStyle("min-height", px(size*lh))
		} else {
			child.addStyle("display", "list-item")
			if numbered {
				child.addStyle("list-style-type", "decimal")
			} else {
				child.addStyle("list-style-type", "disc")
			}
			child.addStyle("list-style-position", "outside")
			child.addStyle("margin-left", px(col*size))
		}
		el.Children = append(el.Children, child)
	}
}
