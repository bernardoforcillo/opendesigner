package mcp_test

import (
	"context"
	"strings"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestTextFormatThroughTheTools: create_text and set_text take the case / script / list /
// OpenType / box params, a format-only set_text keeps the rest of the style, bad values are
// refused with a message, and text styles carry the format too.
func TestTextFormatThroughTheTools(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()
	home := frame(t, s, "Home")

	format := func(id string) *odmcp.TextFormat {
		t.Helper()
		doc, err := s.GetDocument(ctx, struct{}{})
		if err != nil {
			t.Fatal(err)
		}
		for _, n := range doc.Nodes {
			if n.Id == id {
				return n.Format
			}
		}
		t.Fatalf("node %s not in the document", id)
		return nil
	}

	made, err := s.CreateText(ctx, odmcp.CreateTextInput{
		ParentId: home, Content: "one\ntwo", Width: 200, Height: 60,
		TextFormat: odmcp.TextFormat{TextCase: "title", List: "numbered", Indent: ptr(8.0), FontFeatures: ptr(`"tnum", "liga" 0`), VerticalAlign: "middle", Inset: ptr(4.0)},
	})
	if err != nil {
		t.Fatal(err)
	}
	f := format(made.NodeId)
	if f == nil || f.TextCase != "title" || f.List != "numbered" || *f.Indent != 8 || *f.FontFeatures != `"tnum", "liga" 0` || f.VerticalAlign != "middle" || *f.Inset != 4 {
		t.Fatalf("created format = %+v", f)
	}

	// A format-only set_text overlays: the list stays, the case changes, the size is not zeroed.
	if _, err := s.SetText(ctx, odmcp.SetTextInput{Id: made.NodeId, Content: "one\ntwo", TextFormat: odmcp.TextFormat{TextCase: "smallCaps", Script: "super"}}); err != nil {
		t.Fatal(err)
	}
	f = format(made.NodeId)
	if f.TextCase != "smallCaps" || f.Script != "super" || f.List != "numbered" {
		t.Fatalf("overlaid format = %+v", f)
	}
	// "none" clears.
	if _, err := s.SetText(ctx, odmcp.SetTextInput{Id: made.NodeId, Content: "x", TextFormat: odmcp.TextFormat{TextCase: "none", Script: "none", List: "none", VerticalAlign: "top", Indent: ptr(0.0), Inset: ptr(0.0), FontFeatures: ptr("")}}); err != nil {
		t.Fatal(err)
	}
	if f := format(made.NodeId); f != nil {
		t.Fatalf("cleared format = %+v", f)
	}

	for name, bad := range map[string]odmcp.TextFormat{
		"case":     {TextCase: "shout"},
		"script":   {Script: "up"},
		"list":     {List: "roman"},
		"valign":   {VerticalAlign: "center"},
		"indent":   {Indent: ptr(-1.0)},
		"inset":    {Inset: ptr(-1.0)},
		"features": {FontFeatures: ptr(`"liga";x`)},
	} {
		if _, err := s.SetText(ctx, odmcp.SetTextInput{Id: made.NodeId, Content: "x", TextFormat: bad}); err == nil {
			t.Errorf("%s: set_text must refuse %+v", name, bad)
		}
		if _, err := s.CreateText(ctx, odmcp.CreateTextInput{ParentId: home, Content: "x", TextFormat: bad}); err == nil {
			t.Errorf("%s: create_text must refuse %+v", name, bad)
		}
	}

	// Text styles carry it, and list_text_styles reports it.
	st, err := s.SetTextStyle(ctx, odmcp.SetTextStyleInput{TextStyleBody: odmcp.TextStyleBody{
		Name: "Caption", FontSize: 12, TextFormat: odmcp.TextFormat{TextCase: "upper", FontFeatures: ptr(`"tnum"`)},
	}})
	if err != nil {
		t.Fatal(err)
	}
	list, _ := s.ListTextStyles(ctx, struct{}{})
	if len(list.TextStyles) != 1 || list.TextStyles[0].Id != st.TextStyleId || list.TextStyles[0].TextCase != "upper" || !strings.Contains(*list.TextStyles[0].FontFeatures, "tnum") {
		t.Fatalf("ListTextStyles = %+v", list)
	}
	if _, err := s.SetTextStyle(ctx, odmcp.SetTextStyleInput{TextStyleBody: odmcp.TextStyleBody{Name: "Bad", FontSize: 12, TextFormat: odmcp.TextFormat{List: "roman"}}}); err == nil {
		t.Error("set_text_style must refuse a bad list kind")
	}
}
