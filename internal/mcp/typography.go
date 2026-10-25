package mcp

import (
	"context"
	"errors"
	"fmt"
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

// The typography tools: the agent reads and writes the document's shared TEXT
// STYLES and font registry. The model lives in internal/core/typography.go and
// docs/typography.md; the tools run the authority's own validators before
// submitting, so the error says what to fix.

type FontView struct {
	Id        string `json:"id"`
	Family    string `json:"family"`
	Weight    string `json:"weight"`
	Style     string `json:"style" jsonschema:"normal | italic"`
	AssetHash string `json:"assetHash"`
}

type TextStyleBody struct {
	Name       string  `json:"name" jsonschema:"e.g. Heading 1"`
	FontFamily string  `json:"fontFamily,omitempty" jsonschema:"a family name or CSS list, e.g. Inter, sans-serif; an uploaded family (see list_fonts) draws with its file"`
	FontSize   float64 `json:"fontSize" jsonschema:"px in world coordinates, > 0"`
	FontWeight string  `json:"fontWeight,omitempty" jsonschema:"100..900, normal or bold"`
	LineHeight float64 `json:"lineHeight,omitempty" jsonschema:"multiplier; 0 means the default 1.2"`
	Italic     bool    `json:"italic,omitempty"`
	Align      string  `json:"align,omitempty" jsonschema:"left (default) | center | right | justify"`
	// Rich text (see docs/rich-text.md).
	Underline     bool    `json:"underline,omitempty"`
	Strikethrough bool    `json:"strikethrough,omitempty"`
	Kind          string  `json:"kind,omitempty" jsonschema:"paragraph (default) | character. A character style overrides only the fields that are set (fontFamily, fontSize, fontWeight, italic, underline, strikethrough) over a range of characters; fontSize 0 keeps the size"`
	BasedOn       string  `json:"basedOn,omitempty" jsonschema:"id of a style of the same kind whose unset fields this one inherits"`
	NextStyleId   string  `json:"nextStyleId,omitempty" jsonschema:"paragraph style a new paragraph gets after one in this style"`
	SpaceBefore   float64 `json:"spaceBefore,omitempty" jsonschema:"px above a paragraph (paragraph styles only)"`
	SpaceAfter    float64 `json:"spaceAfter,omitempty" jsonschema:"px below a paragraph"`
	IndentFirst   float64 `json:"indentFirst,omitempty" jsonschema:"extra px of indent on the first line"`
	IndentLeft    float64 `json:"indentLeft,omitempty" jsonschema:"px of indent on every line"`
	LetterSpacing float64 `json:"letterSpacing,omitempty" jsonschema:"tracking: px added after every character; negative tightens"`
	AlignToGrid   bool    `json:"alignToGrid,omitempty" jsonschema:"paragraph styles only: the lines sit on the document's baseline grid (set_document_settings)"`
	// Typesetting (see docs/rich-text.md).
	SmallCaps       bool        `json:"smallCaps,omitempty" jsonschema:"lowercase letters drawn as smaller capitals"`
	Script          string      `json:"script,omitempty" jsonschema:"superscript | subscript (smaller, raised / lowered); empty = normal"`
	HorizontalScale float64     `json:"horizontalScale,omitempty" jsonschema:"glyph width multiplier 0.1..10; 0 = 1"`
	NoKerning       bool        `json:"noKerning,omitempty" jsonschema:"switch the font's pair kerning off"`
	Color           *RGBA       `json:"color,omitempty" jsonschema:"text colour of the style; absent = the node's fill"`
	Hyphenate       bool        `json:"hyphenate,omitempty" jsonschema:"paragraph styles: long words break at a syllable with a hyphen"`
	ListKind        string      `json:"listKind,omitempty" jsonschema:"paragraph styles: bullet | number"`
	ListMarker      string      `json:"listMarker,omitempty" jsonschema:"bullet: the character (default •); number: a template, # is the number (default #.)"`
	ListNumberStyle string      `json:"listNumberStyle,omitempty" jsonschema:"numbered lists: empty (1,2,3) | i | I | a | A"`
	ListIndent      float64     `json:"listIndent,omitempty" jsonschema:"distance from the marker to the text (default 18)"`
	TabStops        []TabStopIO `json:"tabStops,omitempty" jsonschema:"paragraph styles: tab stops from the left edge, ascending"`
	DropCapLines    uint32      `json:"dropCapLines,omitempty" jsonschema:"paragraph styles: a drop cap this many lines tall (2..10); 0 = none"`
	DropCapChars    uint32      `json:"dropCapChars,omitempty" jsonschema:"how many characters make the drop cap (default 1)"`
	NestedStyles    []NestedIO  `json:"nestedStyles,omitempty" jsonschema:"paragraph styles: character styles applied to the start of every paragraph"`
	OutlineLevel    uint32      `json:"outlineLevel,omitempty" jsonschema:"paragraph styles: 1..9 = a heading (table of contents, running heads, PDF bookmarks); 0 = body"`
	FontFeatures    string      `json:"fontFeatures,omitempty" jsonschema:"OpenType features, e.g. liga off, onum, ss01 2"`
	FontVariations  string      `json:"fontVariations,omitempty" jsonschema:"variable-font axes, e.g. wght 650, wdth 90 (drawn in SVG and the editing field; kept everywhere)"`
	// Paragraph look (see docs/rich-text.md).
	KeepWithNext      bool    `json:"keepWithNext,omitempty" jsonschema:"paragraph styles: never the last paragraph of a threaded frame unless the next one starts there too"`
	KeepLinesTogether bool    `json:"keepLinesTogether,omitempty" jsonschema:"paragraph styles: the paragraph is not split between threaded frames"`
	KeepFirstLines    uint32  `json:"keepFirstLines,omitempty" jsonschema:"orphans: at least this many lines at the bottom of a frame (0..6)"`
	KeepLastLines     uint32  `json:"keepLastLines,omitempty" jsonschema:"widows: at least this many lines at the top of the next frame (0..6)"`
	RuleAbove         *RuleIO `json:"ruleAbove,omitempty" jsonschema:"a line above the paragraph"`
	RuleBelow         *RuleIO `json:"ruleBelow,omitempty" jsonschema:"a line below the paragraph"`
	Shading           *RGBA   `json:"shading,omitempty" jsonschema:"fill behind the paragraph"`
	ShadingOffset     float64 `json:"shadingOffset,omitempty" jsonschema:"how far shading and border extend past the text, px"`
	BorderColor       *RGBA   `json:"borderColor,omitempty"`
	BorderWeight      float64 `json:"borderWeight,omitempty" jsonschema:"0 = no border"`
	OpticalMargin     bool    `json:"opticalMargin,omitempty" jsonschema:"hanging punctuation at the line edges"`
}

// RuleIO is a paragraph rule.
type RuleIO struct {
	Weight      float64 `json:"weight" jsonschema:"px, 0 = none"`
	Color       *RGBA   `json:"color,omitempty" jsonschema:"default black"`
	Offset      float64 `json:"offset,omitempty" jsonschema:"distance from the text, px"`
	IndentLeft  float64 `json:"indentLeft,omitempty"`
	IndentRight float64 `json:"indentRight,omitempty"`
	ColumnWidth bool    `json:"columnWidth,omitempty" jsonschema:"across the whole frame instead of the paragraph's text width"`
}

func colorPb(c *RGBA) *opendesignerv1.Color {
	if c == nil {
		return nil
	}
	return &opendesignerv1.Color{R: float32(c.R), G: float32(c.G), B: float32(c.B), A: float32(c.A)}
}

func rulePb(r *RuleIO) *opendesignerv1.ParagraphRule {
	if r == nil {
		return nil
	}
	return &opendesignerv1.ParagraphRule{Weight: r.Weight, Color: colorPb(r.Color), Offset: r.Offset, IndentLeft: r.IndentLeft, IndentRight: r.IndentRight, ColumnWidth: r.ColumnWidth}
}

func ruleView(r *opendesignerv1.ParagraphRule) *RuleIO {
	if r == nil {
		return nil
	}
	return &RuleIO{Weight: r.GetWeight(), Color: rgbaOf(r.GetColor()), Offset: r.GetOffset(), IndentLeft: r.GetIndentLeft(), IndentRight: r.GetIndentRight(), ColumnWidth: r.GetColumnWidth()}
}

// TabStopIO is a tab stop: the text after a tab starts at (left), is centred on (center) or ends at (right) position.
type TabStopIO struct {
	Position float64 `json:"position"`
	Align    string  `json:"align,omitempty" jsonschema:"left (default) | center | right"`
	Leader   string  `json:"leader,omitempty" jsonschema:"one character that fills the gap before the stop, e.g. a dot"`
}

// NestedIO applies a character style up to the count-th delimiter of each paragraph (" " counts words).
type NestedIO struct {
	StyleId   string `json:"styleId" jsonschema:"a character style"`
	Delimiter string `json:"delimiter"`
	Count     uint32 `json:"count"`
	Inclusive bool   `json:"inclusive,omitempty" jsonschema:"the delimiter itself is styled too"`
}

type TextStyleView struct {
	Id string `json:"id"`
	TextStyleBody
}

type ListFontsOutput struct {
	Fonts []FontView `json:"fonts"`
}

type ListTextStylesOutput struct {
	TextStyles []TextStyleView `json:"textStyles"`
}

const typographyConventions = " Rich text: a PARAGRAPH style (kind paragraph) also sets spacing and indents and can be basedOn another and name a nextStyleId; a CHARACTER style (kind character) overrides a few fields over a range of characters; both are applied with format_text. Typography: a TEXT STYLE is a named, reusable style; a text node that applies one is drawn with the style's values (its own style stays as the fallback). " +
	"Editing a text style changes every node that uses it; deleting one detaches the nodes (they keep their own style). " +
	"An uploaded FONT is a file in the document's assets (upload it in the editor: document menu → Fonts…) registered with a family, weight and style; a text style whose fontFamily is that family draws with it."

func alignName(a opendesignerv1.TextAlign) string {
	switch a {
	case opendesignerv1.TextAlign_TEXT_ALIGN_CENTER:
		return "center"
	case opendesignerv1.TextAlign_TEXT_ALIGN_RIGHT:
		return "right"
	case opendesignerv1.TextAlign_TEXT_ALIGN_JUSTIFY:
		return "justify"
	}
	return "left"
}

func alignEnum(s string) (opendesignerv1.TextAlign, error) {
	switch s {
	case "", "left":
		return opendesignerv1.TextAlign_TEXT_ALIGN_LEFT, nil
	case "center":
		return opendesignerv1.TextAlign_TEXT_ALIGN_CENTER, nil
	case "right":
		return opendesignerv1.TextAlign_TEXT_ALIGN_RIGHT, nil
	case "justify":
		return opendesignerv1.TextAlign_TEXT_ALIGN_JUSTIFY, nil
	}
	return 0, fmt.Errorf("align must be left, center, right or justify, got %q", s)
}

func fontViews(doc *opendesignerv1.Document) []FontView {
	out := make([]FontView, 0, len(doc.GetFonts()))
	for id, f := range doc.GetFonts() {
		out = append(out, FontView{Id: id, Family: f.GetFamily(), Weight: f.GetWeight(), Style: f.GetStyle(), AssetHash: f.GetAssetHash()})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Family != out[j].Family {
			return out[i].Family < out[j].Family
		}
		if out[i].Weight != out[j].Weight {
			return out[i].Weight < out[j].Weight
		}
		return out[i].Style < out[j].Style
	})
	return out
}

func textStyleViews(doc *opendesignerv1.Document) []TextStyleView {
	out := make([]TextStyleView, 0, len(doc.GetTextStyles()))
	for id, d := range doc.GetTextStyles() {
		st := d.GetStyle()
		out = append(out, TextStyleView{Id: id, TextStyleBody: TextStyleBody{
			Name: d.GetName(), FontFamily: st.GetFontFamily(), FontSize: st.GetFontSize(), FontWeight: st.GetFontWeight(),
			LineHeight: st.GetLineHeight(), Italic: st.GetItalic(), Align: alignName(st.GetAlign()),
			Underline: st.GetUnderline(), Strikethrough: st.GetStrikethrough(), Kind: kindName(d.GetKind()),
			BasedOn: d.GetBasedOn(), NextStyleId: d.GetNextStyleId(), SpaceBefore: d.GetSpaceBefore(), SpaceAfter: d.GetSpaceAfter(),
			IndentFirst: d.GetIndentFirst(), IndentLeft: d.GetIndentLeft(),
			LetterSpacing: st.GetLetterSpacing(), AlignToGrid: d.GetAlignToGrid(),
			SmallCaps: st.GetSmallCaps(), Script: scriptName(st.GetScript()), HorizontalScale: st.GetHorizontalScale(), NoKerning: st.GetNoKerning(),
			Color: rgbaOf(st.GetColor()), Hyphenate: d.GetHyphenate(), ListKind: listKindName(d.GetListKind()), ListMarker: d.GetListMarker(),
			ListNumberStyle: d.GetListNumberStyle(), ListIndent: d.GetListIndent(), TabStops: tabStopViews(d.GetTabStops()),
			DropCapLines: d.GetDropCapLines(), DropCapChars: d.GetDropCapChars(), NestedStyles: nestedViews(d.GetNestedStyles()),
			OutlineLevel: d.GetOutlineLevel(), FontFeatures: st.GetFontFeatures(), FontVariations: st.GetFontVariations(),
			KeepWithNext: d.GetKeepWithNext(), KeepLinesTogether: d.GetKeepLinesTogether(), KeepFirstLines: d.GetKeepFirstLines(), KeepLastLines: d.GetKeepLastLines(),
			RuleAbove: ruleView(d.GetRuleAbove()), RuleBelow: ruleView(d.GetRuleBelow()), Shading: rgbaOf(d.GetShading()), ShadingOffset: d.GetShadingOffset(),
			BorderColor: rgbaOf(d.GetBorderColor()), BorderWeight: d.GetBorderWeight(), OpticalMargin: d.GetOpticalMargin(),
		}})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].Name < out[j].Name || (out[i].Name == out[j].Name && out[i].Id < out[j].Id)
	})
	return out
}

func (b TextStyleBody) toProto(id string) (*opendesignerv1.TextStyleDef, error) {
	align, err := alignEnum(b.Align)
	if err != nil {
		return nil, err
	}
	kind := opendesignerv1.TextStyleKind_TEXT_STYLE_KIND_PARAGRAPH
	switch b.Kind {
	case "", "paragraph":
	case "character":
		kind = opendesignerv1.TextStyleKind_TEXT_STYLE_KIND_CHARACTER
	default:
		return nil, fmt.Errorf("kind must be paragraph or character, got %q", b.Kind)
	}
	script, err := scriptEnum(b.Script)
	if err != nil {
		return nil, err
	}
	listKind, err := listKindEnum(b.ListKind)
	if err != nil {
		return nil, err
	}
	d := &opendesignerv1.TextStyleDef{Id: id, Name: b.Name, Style: &opendesignerv1.TextStyle{
		FontFamily: b.FontFamily, FontSize: b.FontSize, FontWeight: b.FontWeight, LineHeight: b.LineHeight, Italic: b.Italic, Align: align,
		Underline: b.Underline, Strikethrough: b.Strikethrough, LetterSpacing: b.LetterSpacing,
		SmallCaps: b.SmallCaps, Script: script, HorizontalScale: b.HorizontalScale, NoKerning: b.NoKerning,
		FontFeatures: b.FontFeatures, FontVariations: b.FontVariations,
	}, AlignToGrid: b.AlignToGrid, Kind: kind, BasedOn: b.BasedOn, NextStyleId: b.NextStyleId, SpaceBefore: b.SpaceBefore, SpaceAfter: b.SpaceAfter,
		IndentFirst: b.IndentFirst, IndentLeft: b.IndentLeft,
		Hyphenate: b.Hyphenate, ListKind: listKind, ListMarker: b.ListMarker, ListNumberStyle: b.ListNumberStyle, ListIndent: b.ListIndent,
		DropCapLines: b.DropCapLines, DropCapChars: b.DropCapChars, OutlineLevel: b.OutlineLevel,
		KeepWithNext: b.KeepWithNext, KeepLinesTogether: b.KeepLinesTogether, KeepFirstLines: b.KeepFirstLines, KeepLastLines: b.KeepLastLines,
		RuleAbove: rulePb(b.RuleAbove), RuleBelow: rulePb(b.RuleBelow), Shading: colorPb(b.Shading), ShadingOffset: b.ShadingOffset,
		BorderColor: colorPb(b.BorderColor), BorderWeight: b.BorderWeight, OpticalMargin: b.OpticalMargin}
	if b.Color != nil {
		d.Style.Color = &opendesignerv1.Color{R: float32(b.Color.R), G: float32(b.Color.G), B: float32(b.Color.B), A: float32(b.Color.A)}
	}
	for _, t := range b.TabStops {
		a, err := tabAlignEnum(t.Align)
		if err != nil {
			return nil, err
		}
		d.TabStops = append(d.TabStops, &opendesignerv1.TabStop{Position: t.Position, Align: a, Leader: t.Leader})
	}
	for _, n := range b.NestedStyles {
		d.NestedStyles = append(d.NestedStyles, &opendesignerv1.NestedStyle{StyleId: n.StyleId, Delimiter: n.Delimiter, Count: n.Count, Inclusive: n.Inclusive})
	}
	return d, nil
}

func scriptName(s opendesignerv1.TextScript) string {
	switch s {
	case opendesignerv1.TextScript_TEXT_SCRIPT_SUPERSCRIPT:
		return "superscript"
	case opendesignerv1.TextScript_TEXT_SCRIPT_SUBSCRIPT:
		return "subscript"
	}
	return ""
}

func scriptEnum(s string) (opendesignerv1.TextScript, error) {
	switch s {
	case "", "normal":
		return opendesignerv1.TextScript_TEXT_SCRIPT_NORMAL, nil
	case "superscript":
		return opendesignerv1.TextScript_TEXT_SCRIPT_SUPERSCRIPT, nil
	case "subscript":
		return opendesignerv1.TextScript_TEXT_SCRIPT_SUBSCRIPT, nil
	}
	return 0, fmt.Errorf("script must be superscript or subscript, got %q", s)
}

func listKindName(k opendesignerv1.ListKind) string {
	switch k {
	case opendesignerv1.ListKind_LIST_KIND_BULLET:
		return "bullet"
	case opendesignerv1.ListKind_LIST_KIND_NUMBER:
		return "number"
	}
	return ""
}

func listKindEnum(s string) (opendesignerv1.ListKind, error) {
	switch s {
	case "":
		return opendesignerv1.ListKind_LIST_KIND_NONE, nil
	case "bullet":
		return opendesignerv1.ListKind_LIST_KIND_BULLET, nil
	case "number":
		return opendesignerv1.ListKind_LIST_KIND_NUMBER, nil
	}
	return 0, fmt.Errorf("listKind must be bullet or number, got %q", s)
}

func tabAlignEnum(s string) (opendesignerv1.TabAlign, error) {
	switch s {
	case "", "left":
		return opendesignerv1.TabAlign_TAB_ALIGN_LEFT, nil
	case "center":
		return opendesignerv1.TabAlign_TAB_ALIGN_CENTER, nil
	case "right":
		return opendesignerv1.TabAlign_TAB_ALIGN_RIGHT, nil
	}
	return 0, fmt.Errorf("tab align must be left, center or right, got %q", s)
}

func rgbaOf(c *opendesignerv1.Color) *RGBA {
	if c == nil {
		return nil
	}
	return &RGBA{R: float64(c.GetR()), G: float64(c.GetG()), B: float64(c.GetB()), A: float64(c.GetA())}
}

func tabStopViews(ts []*opendesignerv1.TabStop) []TabStopIO {
	var out []TabStopIO
	for _, t := range ts {
		a := ""
		switch t.GetAlign() {
		case opendesignerv1.TabAlign_TAB_ALIGN_CENTER:
			a = "center"
		case opendesignerv1.TabAlign_TAB_ALIGN_RIGHT:
			a = "right"
		}
		out = append(out, TabStopIO{Position: t.GetPosition(), Align: a, Leader: t.GetLeader()})
	}
	return out
}

func nestedViews(ns []*opendesignerv1.NestedStyle) []NestedIO {
	var out []NestedIO
	for _, n := range ns {
		out = append(out, NestedIO{StyleId: n.GetStyleId(), Delimiter: n.GetDelimiter(), Count: n.GetCount(), Inclusive: n.GetInclusive()})
	}
	return out
}

func kindName(k opendesignerv1.TextStyleKind) string {
	if k == opendesignerv1.TextStyleKind_TEXT_STYLE_KIND_CHARACTER {
		return "character"
	}
	return "paragraph"
}

func (s *Session) ListFonts(_ context.Context, _ struct{}) (ListFontsOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return ListFontsOutput{Fonts: fontViews(s.doc)}, nil
}

func (s *Session) ListTextStyles(_ context.Context, _ struct{}) (ListTextStylesOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return ListTextStylesOutput{TextStyles: textStyleViews(s.doc)}, nil
}

type SetTextStyleInput struct {
	Id string `json:"id,omitempty" jsonschema:"id of an existing text style to REPLACE; omit to create a new one"`
	TextStyleBody
}

type SetTextStyleOutput struct {
	TextStyleId string `json:"textStyleId"`
	Seq         uint64 `json:"seq"`
}

func (s *Session) SetTextStyle(ctx context.Context, in SetTextStyleInput) (SetTextStyleOutput, error) {
	id := in.Id
	s.mu.Lock()
	if id == "" {
		id = uuid.NewString()
	} else if _, ok := s.doc.GetTextStyles()[id]; !ok {
		s.mu.Unlock()
		return SetTextStyleOutput{}, fmt.Errorf("set_text_style: text style %q not found (omit id to create one; list_text_styles for the ids)", id)
	}
	doc := s.doc
	def, err := in.TextStyleBody.toProto(id)
	if err == nil {
		err = core.ValidateTextStyleDef(doc, def)
	}
	s.mu.Unlock()
	if err != nil {
		return SetTextStyleOutput{}, fmt.Errorf("set_text_style: %w", err)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetTextStyleDef{SetTextStyleDef: &opendesignerv1.SetTextStyleDef{TextStyle: def}}})
	if err != nil {
		return SetTextStyleOutput{}, err
	}
	return SetTextStyleOutput{TextStyleId: id, Seq: seq}, nil
}

func (s *Session) DeleteTextStyle(ctx context.Context, in IdInput) (SeqOutput, error) {
	s.mu.Lock()
	_, ok := s.doc.GetTextStyles()[in.Id]
	s.mu.Unlock()
	if !ok {
		return SeqOutput{}, fmt.Errorf("delete_text_style: text style %q not found (list_text_styles for the ids)", in.Id)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteTextStyleDef{DeleteTextStyleDef: &opendesignerv1.DeleteTextStyleDef{Id: in.Id}}})
	return SeqOutput{Seq: seq}, err
}

type ApplyTextStyleInput struct {
	NodeIds     []string `json:"nodeIds" jsonschema:"text nodes (see list_nodes)"`
	TextStyleId string   `json:"textStyleId,omitempty" jsonschema:"the text style to apply; empty detaches (the node falls back to its own style)"`
}

func (s *Session) ApplyTextStyle(ctx context.Context, in ApplyTextStyleInput) (NodesOutput, error) {
	if len(in.NodeIds) == 0 {
		return NodesOutput{}, errors.New("apply_text_style: nodeIds is empty")
	}
	s.mu.Lock()
	for _, id := range in.NodeIds {
		n, ok := s.doc.GetNodes()[id]
		if !ok {
			s.mu.Unlock()
			return NodesOutput{}, fmt.Errorf("apply_text_style: node %q not found (list_nodes for the ids)", id)
		}
		if _, isText := n.GetShape().(*opendesignerv1.Node_Text); !isText {
			s.mu.Unlock()
			return NodesOutput{}, fmt.Errorf("apply_text_style: node %q is not a text node", id)
		}
	}
	if in.TextStyleId != "" {
		if _, ok := s.doc.GetTextStyles()[in.TextStyleId]; !ok {
			s.mu.Unlock()
			return NodesOutput{}, fmt.Errorf("apply_text_style: text style %q not found (list_text_styles for the ids)", in.TextStyleId)
		}
	}
	var todo []string
	for _, id := range in.NodeIds {
		if s.doc.GetNodes()[id].GetTextStyleId() != in.TextStyleId {
			todo = append(todo, id)
		}
	}
	s.mu.Unlock()
	out := NodesOutput{}
	for _, id := range todo {
		seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
			Id: id, Patch: &opendesignerv1.Node{TextStyleId: in.TextStyleId}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"text_style_id"}},
		}}})
		if err != nil {
			return out, err
		}
		out.Changed++
		out.Seq = seq
	}
	return out, nil
}

type SetFontInput struct {
	Id        string `json:"id,omitempty" jsonschema:"id of an existing font to REPLACE; omit to register a new one"`
	Family    string `json:"family" jsonschema:"family name text styles refer to: letters, digits, spaces, _ . -"`
	Weight    string `json:"weight" jsonschema:"100, 200, ... 900"`
	Style     string `json:"style,omitempty" jsonschema:"normal (default) | italic"`
	AssetHash string `json:"assetHash" jsonschema:"sha256 (64 lowercase hex) of a font file already in the document's assets: upload it in the editor first (document menu → Fonts…)"`
}

type SetFontOutput struct {
	FontId string `json:"fontId"`
	Seq    uint64 `json:"seq"`
}

func (s *Session) SetFont(ctx context.Context, in SetFontInput) (SetFontOutput, error) {
	style := in.Style
	if style == "" {
		style = "normal"
	}
	s.mu.Lock()
	id := in.Id
	if id == "" {
		id = uuid.NewString()
	} else if _, ok := s.doc.GetFonts()[id]; !ok {
		s.mu.Unlock()
		return SetFontOutput{}, fmt.Errorf("set_font: font %q not found (omit id to register one; list_fonts for the ids)", id)
	}
	f := &opendesignerv1.FontFace{Id: id, Family: in.Family, Weight: in.Weight, Style: style, AssetHash: in.AssetHash}
	err := core.ValidateFont(s.doc, f)
	s.mu.Unlock()
	if err != nil {
		return SetFontOutput{}, fmt.Errorf("set_font: %w", err)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetFont{SetFont: &opendesignerv1.SetFont{Font: f}}})
	if err != nil {
		return SetFontOutput{}, err
	}
	return SetFontOutput{FontId: id, Seq: seq}, nil
}

func (s *Session) DeleteFont(ctx context.Context, in IdInput) (SeqOutput, error) {
	s.mu.Lock()
	_, ok := s.doc.GetFonts()[in.Id]
	s.mu.Unlock()
	if !ok {
		return SeqOutput{}, fmt.Errorf("delete_font: font %q not found (list_fonts for the ids)", in.Id)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteFont{DeleteFont: &opendesignerv1.DeleteFont{Id: in.Id}}})
	return SeqOutput{Seq: seq}, err
}

type TextRunInput struct {
	Start   int    `json:"start" jsonschema:"first character, UTF-16 code units from the start of the content"`
	End     int    `json:"end" jsonschema:"one past the last character"`
	StyleId string `json:"styleId" jsonschema:"a CHARACTER style (set_text_style kind=character)"`
}

type FormatTextInput struct {
	NodeId          string         `json:"nodeId" jsonschema:"a text node"`
	ParagraphStyles []string       `json:"paragraphStyles,omitempty" jsonschema:"one PARAGRAPH style id per paragraph (paragraphs are separated by newlines); empty string = the node's own style. Replaces the current list"`
	Runs            []TextRunInput `json:"runs,omitempty" jsonschema:"character styles over ranges; sorted, non-overlapping. Replaces the current runs"`
}

// FormatText sets the paragraph styles and character-style runs of a text node, keeping its content.
func (s *Session) FormatText(ctx context.Context, in FormatTextInput) (SeqOutput, error) {
	s.mu.Lock()
	n := s.doc.GetNodes()[in.NodeId]
	t, isText := n.GetShape().(*opendesignerv1.Node_Text)
	if n == nil || !isText || t.Text == nil {
		s.mu.Unlock()
		return SeqOutput{}, fmt.Errorf("format_text: %q is not a text node", in.NodeId)
	}
	content := t.Text.GetContent()
	runs := make([]*opendesignerv1.TextRun, 0, len(in.Runs))
	for _, r := range in.Runs {
		runs = append(runs, &opendesignerv1.TextRun{Start: int32(r.Start), End: int32(r.End), StyleId: r.StyleId})
	}
	err := core.ValidateRichText(s.doc, content, in.ParagraphStyles, runs)
	s.mu.Unlock()
	if err != nil {
		return SeqOutput{}, fmt.Errorf("format_text: %w", err)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetText{SetText: &opendesignerv1.SetText{
		Id: in.NodeId, Content: content, ParagraphStyles: in.ParagraphStyles, Runs: runs, RichPresent: true,
	}}})
	return SeqOutput{Seq: seq}, err
}

func registerTypographyTools(srv *mcp.Server, s *Session) {
	addTool(srv, "format_text", "Set a text node's paragraph styles (one per paragraph) and character-style runs (ranges of characters), keeping its text. Create the styles with set_text_style (kind paragraph or character) first."+typographyConventions, s.FormatText)
	addTool(srv, "list_text_styles", "List the document's shared text styles."+typographyConventions, s.ListTextStyles)
	addTool(srv, "set_text_style", "Create a text style (omit id) or REPLACE one entirely (read it with list_text_styles, edit, send it all back)."+typographyConventions, s.SetTextStyle)
	addTool(srv, "delete_text_style", "Delete a text style; the nodes that used it keep their own style.", s.DeleteTextStyle)
	addTool(srv, "apply_text_style", "Apply a shared text style to one or more text nodes, or detach it (empty textStyleId)."+typographyConventions, s.ApplyTextStyle)
	addTool(srv, "list_fonts", "List the fonts uploaded to the document (family, weight, style, asset hash)."+typographyConventions, s.ListFonts)
	addTool(srv, "set_font", "Register an already-uploaded font file as a family/weight/style, or REPLACE a registered one. The file itself is uploaded in the editor (document menu → Fonts…)."+typographyConventions, s.SetFont)
	addTool(srv, "delete_font", "Remove a registered font; text that names its family falls back to the default font.", s.DeleteFont)
}
