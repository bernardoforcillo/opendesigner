package core

import (
	"errors"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

func styleOp(d *opendesignerv1.TextStyleDef) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetTextStyleDef{SetTextStyleDef: &opendesignerv1.SetTextStyleDef{TextStyle: d}}}
}

func richDoc(t *testing.T) *opendesignerv1.Document {
	t.Helper()
	doc := NewDocument("d", "Rich")
	body := &opendesignerv1.TextStyleDef{Id: "body", Name: "Body", Style: &opendesignerv1.TextStyle{FontSize: 12}, SpaceAfter: 6}
	bold := &opendesignerv1.TextStyleDef{Id: "bold", Name: "Bold", Kind: opendesignerv1.TextStyleKind_TEXT_STYLE_KIND_CHARACTER, Style: &opendesignerv1.TextStyle{FontWeight: "700"}}
	mustApply(t, doc, styleOp(body), styleOp(bold), createOp(textNode("t", "one\ntwo\nthree")))
	return doc
}

func text(doc *opendesignerv1.Document, id string) *opendesignerv1.TextNode {
	return doc.GetNodes()[id].GetText()
}

func TestSetTextRich(t *testing.T) {
	doc := richDoc(t)
	mustApply(t, doc, setTextOp(&opendesignerv1.SetText{
		Id: "t", Content: "one\ntwo\nthree", RichPresent: true,
		ParagraphStyles: []string{"body", "", "body"},
		Runs:            []*opendesignerv1.TextRun{{Start: 0, End: 3, StyleId: "bold"}, {Start: 8, End: 13, StyleId: "bold"}},
	}))
	if got := text(doc, "t"); len(got.GetParagraphStyles()) != 3 || len(got.GetRuns()) != 2 {
		t.Fatalf("rich text not stored: %+v", got)
	}
	// Without rich_present the formatting follows the content: shortened to 2 paragraphs and 6 characters.
	mustApply(t, doc, setTextOp(&opendesignerv1.SetText{Id: "t", Content: "one\ntwo"}))
	got := text(doc, "t")
	if len(got.GetParagraphStyles()) != 2 || len(got.GetRuns()) != 1 || got.GetRuns()[0].GetEnd() != 3 {
		t.Fatalf("rich text not clamped: %+v", got)
	}
	// A run is cut at the new end, and dropped when nothing is left of it.
	mustApply(t, doc, setTextOp(&opendesignerv1.SetText{Id: "t", Content: "on"}))
	if got = text(doc, "t"); got.GetRuns()[0].GetEnd() != 2 || len(got.GetParagraphStyles()) != 1 {
		t.Fatalf("clamp = %+v", got)
	}
	mustApply(t, doc, setTextOp(&opendesignerv1.SetText{Id: "t", Content: ""}))
	if got = text(doc, "t"); len(got.GetRuns()) != 0 {
		t.Fatalf("runs left on empty content: %+v", got)
	}
}

func TestSetTextRichRejects(t *testing.T) {
	doc := richDoc(t)
	run := func(s, e int32, id string) []*opendesignerv1.TextRun {
		return []*opendesignerv1.TextRun{{Start: s, End: e, StyleId: id}}
	}
	cases := map[string]*opendesignerv1.SetText{
		"too many paragraph styles":  {Id: "t", Content: "a", RichPresent: true, ParagraphStyles: []string{"body", "body"}},
		"a character style as para":  {Id: "t", Content: "a", RichPresent: true, ParagraphStyles: []string{"bold"}},
		"a missing paragraph style":  {Id: "t", Content: "a", RichPresent: true, ParagraphStyles: []string{"nope"}},
		"a paragraph style as a run": {Id: "t", Content: "abc", RichPresent: true, Runs: run(0, 1, "body")},
		"a run past the end":         {Id: "t", Content: "abc", RichPresent: true, Runs: run(0, 4, "bold")},
		"an empty run":               {Id: "t", Content: "abc", RichPresent: true, Runs: run(1, 1, "bold")},
		"overlapping runs":           {Id: "t", Content: "abcdef", RichPresent: true, Runs: append(run(0, 4, "bold"), run(3, 5, "bold")...)},
		"runs out of order":          {Id: "t", Content: "abcdef", RichPresent: true, Runs: append(run(3, 5, "bold"), run(0, 2, "bold")...)},
	}
	for name, op := range cases {
		before := text(doc, "t").GetContent()
		if err := Apply(doc, setTextOp(op)); !errors.Is(err, ErrBadRichText) {
			t.Errorf("%s: got %v, want ErrBadRichText", name, err)
		}
		if text(doc, "t").GetContent() != before {
			t.Errorf("%s: the node changed although the op was rejected", name)
		}
	}
	// Runs count UTF-16 units: an emoji is two.
	mustApply(t, doc, setTextOp(&opendesignerv1.SetText{Id: "t", Content: "a😀b", RichPresent: true, Runs: run(1, 3, "bold")}))
	if err := Apply(doc, setTextOp(&opendesignerv1.SetText{Id: "t", Content: "a😀b", RichPresent: true, Runs: run(1, 5, "bold")})); !errors.Is(err, ErrBadRichText) {
		t.Errorf("a run past the end in UTF-16 units: %v", err)
	}
}

func TestStyleRelations(t *testing.T) {
	doc := richDoc(t)
	ok := &opendesignerv1.TextStyleDef{Id: "h1", Name: "H1", Style: &opendesignerv1.TextStyle{FontSize: 32}, BasedOn: "body", NextStyleId: "body", SpaceBefore: 12, IndentFirst: 8}
	mustApply(t, doc, styleOp(ok))
	bad := map[string]*opendesignerv1.TextStyleDef{
		"based on a missing style":        {Id: "x", Name: "x", Style: &opendesignerv1.TextStyle{}, BasedOn: "nope"},
		"based on itself":                 {Id: "x", Name: "x", Style: &opendesignerv1.TextStyle{}, BasedOn: "x"},
		"a loop":                          {Id: "body", Name: "Body", Style: &opendesignerv1.TextStyle{FontSize: 12}, BasedOn: "h1"},
		"based on another kind":           {Id: "x", Name: "x", Style: &opendesignerv1.TextStyle{}, BasedOn: "bold"},
		"a missing next style":            {Id: "x", Name: "x", Style: &opendesignerv1.TextStyle{}, NextStyleId: "nope"},
		"a character style as next style": {Id: "x", Name: "x", Style: &opendesignerv1.TextStyle{}, NextStyleId: "bold"},
		"negative spacing":                {Id: "x", Name: "x", Style: &opendesignerv1.TextStyle{}, SpaceBefore: -1},
		"a character style with spacing":  {Id: "x", Name: "x", Style: &opendesignerv1.TextStyle{}, Kind: opendesignerv1.TextStyleKind_TEXT_STYLE_KIND_CHARACTER, SpaceAfter: 4},
		"a character style with next":     {Id: "x", Name: "x", Style: &opendesignerv1.TextStyle{}, Kind: opendesignerv1.TextStyleKind_TEXT_STYLE_KIND_CHARACTER, NextStyleId: "body"},
	}
	for name, d := range bad {
		if err := Apply(doc, styleOp(d)); err == nil {
			t.Errorf("%s: should be rejected", name)
		}
	}
	// A style that is deleted leaves its id behind in text: it is ignored, and the text stays valid.
	mustApply(t, doc, setTextOp(&opendesignerv1.SetText{Id: "t", Content: "one", RichPresent: true, ParagraphStyles: []string{"body"}}))
	mustApply(t, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteTextStyleDef{DeleteTextStyleDef: &opendesignerv1.DeleteTextStyleDef{Id: "body"}}})
	if got := text(doc, "t").GetParagraphStyles(); len(got) != 1 || got[0] != "body" {
		t.Errorf("paragraph styles after deleting the style: %v", got)
	}
}

func TestLetterSpacingAndGridAlignment(t *testing.T) {
	doc := richDoc(t)
	mustApply(t, doc, styleOp(&opendesignerv1.TextStyleDef{
		Id: "tight", Name: "Tight", AlignToGrid: true,
		Style: &opendesignerv1.TextStyle{FontSize: 12, LetterSpacing: -0.5},
	}))
	if d := doc.GetTextStyles()["tight"]; d.GetStyle().GetLetterSpacing() != -0.5 || !d.GetAlignToGrid() {
		t.Fatalf("style not stored: %v", d)
	}
	// A character style may track, but not align to the grid.
	mustApply(t, doc, styleOp(&opendesignerv1.TextStyleDef{
		Id: "wide", Name: "Wide", Kind: opendesignerv1.TextStyleKind_TEXT_STYLE_KIND_CHARACTER,
		Style: &opendesignerv1.TextStyle{LetterSpacing: 2},
	}))
	for name, d := range map[string]*opendesignerv1.TextStyleDef{
		"a character style on the grid": {Id: "x", Name: "x", AlignToGrid: true, Kind: opendesignerv1.TextStyleKind_TEXT_STYLE_KIND_CHARACTER, Style: &opendesignerv1.TextStyle{}},
		"huge tracking":                 {Id: "x", Name: "x", Style: &opendesignerv1.TextStyle{LetterSpacing: 5000}},
	} {
		if err := Apply(doc, styleOp(d)); err == nil {
			t.Errorf("%s: should be rejected", name)
		}
	}
}

func TestTypesettingStyleFields(t *testing.T) {
	doc := richDoc(t)
	ok := func(d *opendesignerv1.TextStyleDef) {
		t.Helper()
		if err := Apply(doc, styleOp(d)); err != nil {
			t.Errorf("%s: %v", d.GetId(), err)
		}
	}
	bad := func(name string, d *opendesignerv1.TextStyleDef) {
		t.Helper()
		if err := Apply(doc, styleOp(d)); !errors.Is(err, ErrTextStyleValue) {
			t.Errorf("%s: got %v, want ErrTextStyleValue", name, err)
		}
	}
	para := func(id string, mod func(*opendesignerv1.TextStyleDef)) *opendesignerv1.TextStyleDef {
		d := &opendesignerv1.TextStyleDef{Id: id, Name: id, Style: &opendesignerv1.TextStyle{FontSize: 12}}
		mod(d)
		return d
	}
	ok(para("list", func(d *opendesignerv1.TextStyleDef) {
		d.ListKind, d.ListMarker, d.ListNumberStyle, d.ListIndent = opendesignerv1.ListKind_LIST_KIND_NUMBER, "#)", "a", 20
		d.Hyphenate = true
		d.Style.Align = opendesignerv1.TextAlign_TEXT_ALIGN_JUSTIFY
		d.Style.SmallCaps, d.Style.HorizontalScale, d.Style.Script = true, 1.2, opendesignerv1.TextScript_TEXT_SCRIPT_SUPERSCRIPT
		d.Style.Color = &opendesignerv1.Color{R: 1, A: 1}
		d.TabStops = []*opendesignerv1.TabStop{{Position: 100}, {Position: 300, Align: opendesignerv1.TabAlign_TAB_ALIGN_RIGHT, Leader: "."}}
		d.DropCapLines, d.DropCapChars = 3, 1
		d.NestedStyles = []*opendesignerv1.NestedStyle{{StyleId: "bold", Delimiter: ":", Count: 1, Inclusive: true}}
	}))
	ok(para("heading", func(d *opendesignerv1.TextStyleDef) {
		d.OutlineLevel = 2
		d.Style.FontFeatures = "liga off, onum, ss01 2"
	}))
	bad("outline level 10", para("b0", func(d *opendesignerv1.TextStyleDef) { d.OutlineLevel = 10 }))
	bad("font feature with a long tag", para("b0b", func(d *opendesignerv1.TextStyleDef) { d.Style.FontFeatures = "ligature" }))
	bad("font feature value", para("b0c", func(d *opendesignerv1.TextStyleDef) { d.Style.FontFeatures = "liga maybe" }))
	bad("unknown number style", para("b1", func(d *opendesignerv1.TextStyleDef) { d.ListNumberStyle = "x" }))
	bad("marker with a newline", para("b2", func(d *opendesignerv1.TextStyleDef) { d.ListMarker = "a\nb" }))
	bad("tabs not ascending", para("b3", func(d *opendesignerv1.TextStyleDef) {
		d.TabStops = []*opendesignerv1.TabStop{{Position: 100}, {Position: 100}}
	}))
	bad("two-character leader", para("b4", func(d *opendesignerv1.TextStyleDef) {
		d.TabStops = []*opendesignerv1.TabStop{{Position: 9, Leader: ".."}}
	}))
	bad("drop cap of one line", para("b5", func(d *opendesignerv1.TextStyleDef) { d.DropCapLines = 1 }))
	bad("nested style that is a paragraph style", para("b6", func(d *opendesignerv1.TextStyleDef) {
		d.NestedStyles = []*opendesignerv1.NestedStyle{{StyleId: "body", Delimiter: ":", Count: 1}}
	}))
	bad("nested style without delimiter", para("b7", func(d *opendesignerv1.TextStyleDef) {
		d.NestedStyles = []*opendesignerv1.NestedStyle{{StyleId: "bold", Count: 1}}
	}))
	bad("horizontal scale 0.01", para("b8", func(d *opendesignerv1.TextStyleDef) { d.Style.HorizontalScale = 0.01 }))
	bad("colour out of range", para("b9", func(d *opendesignerv1.TextStyleDef) { d.Style.Color = &opendesignerv1.Color{R: 2} }))
	bad("a character style with a list", &opendesignerv1.TextStyleDef{Id: "c1", Name: "c", Kind: opendesignerv1.TextStyleKind_TEXT_STYLE_KIND_CHARACTER,
		Style: &opendesignerv1.TextStyle{}, ListKind: opendesignerv1.ListKind_LIST_KIND_BULLET})
	// A character style may carry the glyph-level fields.
	ok(&opendesignerv1.TextStyleDef{Id: "c2", Name: "c", Kind: opendesignerv1.TextStyleKind_TEXT_STYLE_KIND_CHARACTER,
		Style: &opendesignerv1.TextStyle{SmallCaps: true, Color: &opendesignerv1.Color{G: 0.5, A: 1}}})
}
