package core

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
)

// TYPOGRAPHY -- the Go half (the authority) of web/src/store/typography.ts for
// the four ops setFont / deleteFont / setTextStyleDef / deleteTextStyleDef and
// for the "text_style_id" mask path of SetProperties.
//
// A FONT FACE is an uploaded font file (one weight/style of one family); the
// bytes are a content-addressed asset, the document only references them. A TEXT
// STYLE is a named, reusable TextStyle that text nodes point to. The invariants:
//
//	1. a font has a non-empty id, a plain family name (letters, digits, space,
//	   '_', '.', '-': it ends up unquoted-safe in ctx.font, SVG and @font-face),
//	   a weight "100".."900", a style "normal" or "italic" and a sha256 asset hash;
//	2. two different fonts cannot claim the same (family, weight, style): which
//	   file would draw it?
//	3. a text style has a non-empty id and a style with finite, non-negative size
//	   and line height and a font family made of plain characters (a CSS family
//	   LIST such as "Inter, sans-serif" is fine);
//	4. "text_style_id" only applies to a text node and must be empty or an
//	   existing style;
//	5. deleting a text style clears the id on the nodes that used it (they keep
//	   their own style as the fallback); deleting a font is not a cascade: text
//	   that names its family falls back to the renderer's default font.
//
// Upserts are ABSOLUTE: the inverse of an op is the previous state. Both maps may
// be nil and are initialized on the first write.

var (
	ErrNilFont          = errors.New("core: nil font")
	ErrFontNotFound     = errors.New("core: font not found")
	ErrFontFamily       = errors.New("core: font family must be 1..64 letters, digits, spaces, '_', '.' or '-'")
	ErrFontWeight       = errors.New("core: font weight must be 100, 200, ... 900")
	ErrFontStyle        = errors.New("core: font style must be normal or italic")
	ErrFontAsset        = errors.New("core: font asset hash must be 64 lowercase hex digits")
	ErrFontDuplicate    = errors.New("core: another font already has this family, weight and style")
	ErrNilTextStyle     = errors.New("core: nil text style")
	ErrTextStyleMissing = errors.New("core: text style not found")
	ErrTextStyleValue   = errors.New("core: text style needs a finite non-negative size and line height and a plain font family")
)

var (
	fontFamilyRe     = regexp.MustCompile(`^[\p{L}\p{N} _.\-]{1,64}$`)
	fontFamilyListRe = regexp.MustCompile(`^[\p{L}\p{N} _.,'\-]{0,128}$`)
	fontWeightRe     = regexp.MustCompile(`^[1-9]00$`)
	assetHashRe      = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

func validateFont(doc *opendesignerv1.Document, f *opendesignerv1.FontFace) error {
	if f == nil || f.GetId() == "" {
		return ErrNilFont
	}
	if !fontFamilyRe.MatchString(f.GetFamily()) || strings.TrimSpace(f.GetFamily()) == "" {
		return ErrFontFamily
	}
	if !fontWeightRe.MatchString(f.GetWeight()) {
		return ErrFontWeight
	}
	if f.GetStyle() != "normal" && f.GetStyle() != "italic" {
		return ErrFontStyle
	}
	if !assetHashRe.MatchString(f.GetAssetHash()) {
		return ErrFontAsset
	}
	for id, o := range doc.GetFonts() {
		if id != f.GetId() && o.GetFamily() == f.GetFamily() && o.GetWeight() == f.GetWeight() && o.GetStyle() == f.GetStyle() {
			return ErrFontDuplicate
		}
	}
	return nil
}

func finiteNonNeg(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0 }

func validateTextStyleDef(doc *opendesignerv1.Document, d *opendesignerv1.TextStyleDef) error {
	if d == nil || d.GetId() == "" {
		return ErrNilTextStyle
	}
	st := d.GetStyle()
	if st == nil || !finiteNonNeg(st.GetFontSize()) || !finiteNonNeg(st.GetLineHeight()) ||
		!fontFamilyListRe.MatchString(st.GetFontFamily()) {
		return ErrTextStyleValue
	}
	if w := st.GetFontWeight(); w != "" && !fontWeightRe.MatchString(w) && w != "normal" && w != "bold" {
		return ErrTextStyleValue
	}
	if ls := st.GetLetterSpacing(); math.IsNaN(ls) || math.IsInf(ls, 0) || ls < -1000 || ls > 1000 {
		return ErrTextStyleValue
	}
	if err := validateStyleGlyphs(st); err != nil {
		return err
	}
	return validateStyleRelations(doc, d)
}

// validateStyleGlyphs checks the character-level fields added for typesetting: horizontal scale, script and colour.
var featureRe = regexp.MustCompile(`^[A-Za-z0-9]{4}( (on|off|[0-9]{1,3}))?$`)

// validFontFeatures reports whether s is a comma-separated list of OpenType feature settings.
func validFontFeatures(s string) bool {
	if s == "" {
		return true
	}
	if len(s) > 128 {
		return false
	}
	for _, item := range strings.Split(s, ",") {
		if !featureRe.MatchString(strings.TrimSpace(item)) {
			return false
		}
	}
	return true
}

var variationRe = regexp.MustCompile(`^[A-Za-z0-9]{4} -?[0-9]{1,4}(\.[0-9]{1,3})?$`)

// validFontVariations reports whether s is a comma-separated list of variable-font axis settings ("wght 650, wdth 90").
func validFontVariations(s string) bool {
	if s == "" {
		return true
	}
	if len(s) > 128 {
		return false
	}
	for _, item := range strings.Split(s, ",") {
		if !variationRe.MatchString(strings.TrimSpace(item)) {
			return false
		}
	}
	return true
}

func validRule(r *opendesignerv1.ParagraphRule) bool {
	return r == nil || (finiteIn(r.GetWeight(), 0, 100) && finiteIn(r.GetOffset(), -1000, 1000) &&
		finiteIn(r.GetIndentLeft(), 0, 100000) && finiteIn(r.GetIndentRight(), 0, 100000) && validColor(r.GetColor()))
}

// hasParagraphLook reports whether d sets any keep, rule, shading, border or optical-margin field.
func hasParagraphLook(d *opendesignerv1.TextStyleDef) bool {
	return d.GetKeepWithNext() || d.GetKeepLinesTogether() || d.GetKeepFirstLines() != 0 || d.GetKeepLastLines() != 0 ||
		d.GetRuleAbove() != nil || d.GetRuleBelow() != nil || d.GetShading() != nil || d.GetShadingOffset() != 0 ||
		d.GetBorderColor() != nil || d.GetBorderWeight() != 0 || d.GetOpticalMargin()
}

func validateStyleGlyphs(st *opendesignerv1.TextStyle) error {
	if !validFontFeatures(st.GetFontFeatures()) {
		return fmt.Errorf("%w: font features %q", ErrTextStyleValue, st.GetFontFeatures())
	}
	if !validFontVariations(st.GetFontVariations()) {
		return fmt.Errorf("%w: font variations %q", ErrTextStyleValue, st.GetFontVariations())
	}
	if hs := st.GetHorizontalScale(); hs != 0 && !(hs >= 0.1 && hs <= 10) {
		return fmt.Errorf("%w: horizontal scale %v", ErrTextStyleValue, hs)
	}
	if sc := st.GetScript(); sc < 0 || sc > opendesignerv1.TextScript_TEXT_SCRIPT_SUBSCRIPT {
		return fmt.Errorf("%w: script", ErrTextStyleValue)
	}
	if c := st.GetColor(); c != nil {
		for _, v := range []float32{c.GetR(), c.GetG(), c.GetB(), c.GetA()} {
			if math.IsNaN(float64(v)) || v < 0 || v > 1 {
				return fmt.Errorf("%w: colour", ErrTextStyleValue)
			}
		}
	}
	return nil
}

var numberStyles = map[string]bool{"": true, "i": true, "I": true, "a": true, "A": true}

// validateParagraphFeatures checks the paragraph-only settings: lists, tab stops, drop caps, nested styles.
// A character style has none of them.
func validateParagraphFeatures(doc *opendesignerv1.Document, d *opendesignerv1.TextStyleDef) error {
	any := d.GetHyphenate() || d.GetListKind() != opendesignerv1.ListKind_LIST_KIND_NONE || d.GetListMarker() != "" || d.GetListNumberStyle() != "" ||
		d.GetListIndent() != 0 || d.GetOutlineLevel() != 0 || len(d.GetTabStops()) > 0 || d.GetDropCapLines() != 0 || d.GetDropCapChars() != 0 || len(d.GetNestedStyles()) > 0
	if d.GetKind() == opendesignerv1.TextStyleKind_TEXT_STYLE_KIND_CHARACTER {
		if any || hasParagraphLook(d) {
			return fmt.Errorf("%w: a character style has no paragraph features", ErrTextStyleValue)
		}
		return nil
	}
	if d.GetListKind() < 0 || d.GetListKind() > opendesignerv1.ListKind_LIST_KIND_NUMBER || !numberStyles[d.GetListNumberStyle()] ||
		len(d.GetListMarker()) > 16 || strings.ContainsAny(d.GetListMarker(), "\n\r") || !(d.GetListIndent() == 0 || finiteIn(d.GetListIndent(), 0, 1000)) {
		return fmt.Errorf("%w: list", ErrTextStyleValue)
	}
	if d.GetOutlineLevel() > 9 {
		return fmt.Errorf("%w: outline level", ErrTextStyleValue)
	}
	if d.GetKeepFirstLines() > 6 || d.GetKeepLastLines() > 6 {
		return fmt.Errorf("%w: keep lines", ErrTextStyleValue)
	}
	if !validRule(d.GetRuleAbove()) || !validRule(d.GetRuleBelow()) || !validColor(d.GetShading()) || !validColor(d.GetBorderColor()) ||
		!finiteIn(d.GetShadingOffset(), 0, 1000) || !finiteIn(d.GetBorderWeight(), 0, 100) {
		return fmt.Errorf("%w: rule, shading or border", ErrTextStyleValue)
	}
	if n := d.GetDropCapLines(); n != 0 && (n < 2 || n > 10) || d.GetDropCapChars() > 10 {
		return fmt.Errorf("%w: drop cap", ErrTextStyleValue)
	}
	if len(d.GetTabStops()) > 32 {
		return fmt.Errorf("%w: too many tab stops", ErrTextStyleValue)
	}
	prev := -1.0
	for _, t := range d.GetTabStops() {
		if t == nil || !finiteIn(t.GetPosition(), 0, 100000) || t.GetPosition() <= prev || t.GetAlign() < 0 || t.GetAlign() > opendesignerv1.TabAlign_TAB_ALIGN_RIGHT ||
			utf8.RuneCountInString(t.GetLeader()) > 1 || strings.ContainsAny(t.GetLeader(), "\n\r\t") {
			return fmt.Errorf("%w: tab stops must ascend", ErrTextStyleValue)
		}
		prev = t.GetPosition()
	}
	if len(d.GetNestedStyles()) > 8 {
		return fmt.Errorf("%w: too many nested styles", ErrTextStyleValue)
	}
	for _, n := range d.GetNestedStyles() {
		c, ok := doc.GetTextStyles()[n.GetStyleId()]
		if n == nil || !ok || c.GetKind() != opendesignerv1.TextStyleKind_TEXT_STYLE_KIND_CHARACTER || n.GetDelimiter() == "" || len(n.GetDelimiter()) > 8 ||
			n.GetCount() < 1 || n.GetCount() > 50 {
			return fmt.Errorf("%w: nested style", ErrTextStyleValue)
		}
	}
	return nil
}

// validateStyleRelations checks what a style says about OTHER styles and about paragraphs: spacing and
// indents are finite and non-negative; based_on names an existing style of the same kind and never
// loops back; next_style_id names an existing paragraph style (itself included); a character style has
// no paragraph settings and no next style.
func validateStyleRelations(doc *opendesignerv1.Document, d *opendesignerv1.TextStyleDef) error {
	if d.GetKind() != opendesignerv1.TextStyleKind_TEXT_STYLE_KIND_PARAGRAPH && d.GetKind() != opendesignerv1.TextStyleKind_TEXT_STYLE_KIND_CHARACTER {
		return ErrTextStyleValue
	}
	for _, v := range []float64{d.GetSpaceBefore(), d.GetSpaceAfter(), d.GetIndentFirst(), d.GetIndentLeft()} {
		if !finiteNonNeg(v) {
			return ErrTextStyleValue
		}
	}
	if err := validateParagraphFeatures(doc, d); err != nil {
		return err
	}
	character := d.GetKind() == opendesignerv1.TextStyleKind_TEXT_STYLE_KIND_CHARACTER
	if character && d.GetAlignToGrid() {
		return fmt.Errorf("%w: a character style cannot align to the grid", ErrTextStyleValue)
	}
	if character && (d.GetNextStyleId() != "" || d.GetSpaceBefore() != 0 || d.GetSpaceAfter() != 0 || d.GetIndentFirst() != 0 || d.GetIndentLeft() != 0) {
		return fmt.Errorf("%w: a character style has no paragraph settings", ErrTextStyleValue)
	}
	if next := d.GetNextStyleId(); next != "" && next != d.GetId() {
		n, ok := doc.GetTextStyles()[next]
		if !ok || n.GetKind() != opendesignerv1.TextStyleKind_TEXT_STYLE_KIND_PARAGRAPH {
			return fmt.Errorf("%w: next style %q", ErrTextStyleMissing, next)
		}
	}
	for cur, hops := d.GetBasedOn(), 0; cur != ""; hops++ {
		b, ok := doc.GetTextStyles()[cur]
		if cur == d.GetId() || !ok || b.GetKind() != d.GetKind() || hops > len(doc.GetTextStyles())+1 {
			return fmt.Errorf("%w: based on %q", ErrTextStyleValue, cur)
		}
		cur = b.GetBasedOn()
	}
	return nil
}

func applySetFont(doc *opendesignerv1.Document, s *opendesignerv1.SetFont) error {
	f := s.GetFont()
	if err := validateFont(doc, f); err != nil {
		return err
	}
	if doc.Fonts == nil {
		doc.Fonts = map[string]*opendesignerv1.FontFace{}
	}
	doc.Fonts[f.GetId()] = proto.Clone(f).(*opendesignerv1.FontFace)
	return nil
}

func applyDeleteFont(doc *opendesignerv1.Document, d *opendesignerv1.DeleteFont) error {
	if _, ok := doc.GetFonts()[d.GetId()]; !ok {
		return fmt.Errorf("%w: %s", ErrFontNotFound, d.GetId())
	}
	delete(doc.Fonts, d.GetId())
	return nil
}

func applySetTextStyleDef(doc *opendesignerv1.Document, s *opendesignerv1.SetTextStyleDef) error {
	d := s.GetTextStyle()
	if err := validateTextStyleDef(doc, d); err != nil {
		return err
	}
	if doc.TextStyles == nil {
		doc.TextStyles = map[string]*opendesignerv1.TextStyleDef{}
	}
	doc.TextStyles[d.GetId()] = proto.Clone(d).(*opendesignerv1.TextStyleDef)
	return nil
}

func applyDeleteTextStyleDef(doc *opendesignerv1.Document, d *opendesignerv1.DeleteTextStyleDef, cow *Shared) error {
	if _, ok := doc.GetTextStyles()[d.GetId()]; !ok {
		return fmt.Errorf("%w: %s", ErrTextStyleMissing, d.GetId())
	}
	delete(doc.TextStyles, d.GetId())
	ids := make([]string, 0)
	for id, n := range doc.GetNodes() {
		if n.GetTextStyleId() == d.GetId() {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		cow.mut(doc, id).TextStyleId = ""
	}
	return nil
}

// validateTextStyleID checks a node's text_style_id write (invariant 4).
func validateTextStyleID(doc *opendesignerv1.Document, n *opendesignerv1.Node, id string) error {
	if _, isText := n.GetShape().(*opendesignerv1.Node_Text); !isText {
		return fmt.Errorf("%w: %s", ErrNotTextNode, n.GetId())
	}
	if id != "" {
		if _, ok := doc.GetTextStyles()[id]; !ok {
			return fmt.Errorf("%w: %s", ErrTextStyleMissing, id)
		}
	}
	return nil
}

// ValidateFont and ValidateTextStyleDef are for the MCP tools, which run the
// authority's own checks before submitting.
func ValidateFont(doc *opendesignerv1.Document, f *opendesignerv1.FontFace) error {
	return validateFont(doc, f)
}

func ValidateTextStyleDef(doc *opendesignerv1.Document, d *opendesignerv1.TextStyleDef) error {
	return validateTextStyleDef(doc, d)
}

// resolveTextStyle returns n with its shared text style applied: the style's
// values replace the node's own (which stay in the document as the fallback).
func resolveTextStyle(doc *opendesignerv1.Document, n *opendesignerv1.Node) *opendesignerv1.Node {
	t, ok := n.GetShape().(*opendesignerv1.Node_Text)
	if !ok || t.Text == nil || n.GetTextStyleId() == "" {
		return n
	}
	def := doc.GetTextStyles()[n.GetTextStyleId()]
	if def == nil || def.GetStyle() == nil {
		return n
	}
	out := proto.Clone(n).(*opendesignerv1.Node)
	out.GetShape().(*opendesignerv1.Node_Text).Text.Style = proto.Clone(def.GetStyle()).(*opendesignerv1.TextStyle)
	return out
}
