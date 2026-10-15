package core

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"

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

func validateTextStyleDef(d *opendesignerv1.TextStyleDef) error {
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
	if err := validateTextStyleDef(d); err != nil {
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

func ValidateTextStyleDef(d *opendesignerv1.TextStyleDef) error { return validateTextStyleDef(d) }

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
