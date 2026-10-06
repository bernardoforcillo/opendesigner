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
	Align      string  `json:"align,omitempty" jsonschema:"left (default) | center | right"`
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

const typographyConventions = " Typography: a TEXT STYLE is a named, reusable style; a text node that applies one is drawn with the style's values (its own style stays as the fallback). " +
	"Editing a text style changes every node that uses it; deleting one detaches the nodes (they keep their own style). " +
	"An uploaded FONT is a file in the document's assets (upload it in the editor: document menu → Fonts…) registered with a family, weight and style; a text style whose fontFamily is that family draws with it."

func alignName(a opendesignerv1.TextAlign) string {
	switch a {
	case opendesignerv1.TextAlign_TEXT_ALIGN_CENTER:
		return "center"
	case opendesignerv1.TextAlign_TEXT_ALIGN_RIGHT:
		return "right"
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
	}
	return 0, fmt.Errorf("align must be left, center or right, got %q", s)
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
	return &opendesignerv1.TextStyleDef{Id: id, Name: b.Name, Style: &opendesignerv1.TextStyle{
		FontFamily: b.FontFamily, FontSize: b.FontSize, FontWeight: b.FontWeight, LineHeight: b.LineHeight, Italic: b.Italic, Align: align,
	}}, nil
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
	s.mu.Unlock()
	def, err := in.TextStyleBody.toProto(id)
	if err == nil {
		err = core.ValidateTextStyleDef(def)
	}
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

func registerTypographyTools(srv *mcp.Server, s *Session) {
	addTool(srv, "list_text_styles", "List the document's shared text styles."+typographyConventions, s.ListTextStyles)
	addTool(srv, "set_text_style", "Create a text style (omit id) or REPLACE one entirely (read it with list_text_styles, edit, send it all back)."+typographyConventions, s.SetTextStyle)
	addTool(srv, "delete_text_style", "Delete a text style; the nodes that used it keep their own style.", s.DeleteTextStyle)
	addTool(srv, "apply_text_style", "Apply a shared text style to one or more text nodes, or detach it (empty textStyleId)."+typographyConventions, s.ApplyTextStyle)
	addTool(srv, "list_fonts", "List the fonts uploaded to the document (family, weight, style, asset hash)."+typographyConventions, s.ListFonts)
	addTool(srv, "set_font", "Register an already-uploaded font file as a family/weight/style, or REPLACE a registered one. The file itself is uploaded in the editor (document menu → Fonts…)."+typographyConventions, s.SetFont)
	addTool(srv, "delete_font", "Remove a registered font; text that names its family falls back to the default font.", s.DeleteFont)
}
