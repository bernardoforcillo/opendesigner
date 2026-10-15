package mcp_test

import (
	"context"
	"strings"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestTypographyToolsEndToEnd: registers a font, creates and applies a text style,
// edits it, checks the rejections the tools report before sending, and the cascade.
func TestTypographyToolsEndToEnd(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	home := frame(t, s, "Home")
	title, err := s.CreateText(ctx, odmcp.CreateTextInput{ParentId: home, Content: "Hello", Width: 200, Height: 30, Name: "Title"})
	if err != nil {
		t.Fatal(err)
	}
	italic := true
	if _, err := s.SetText(ctx, odmcp.SetTextInput{Id: title.NodeId, Content: "Hello", Italic: &italic}); err != nil {
		t.Fatal(err)
	}

	font, err := s.SetFont(ctx, odmcp.SetFontInput{Family: "Brand Sans", Weight: "700", AssetHash: strings.Repeat("a", 64)})
	if err != nil || font.FontId == "" {
		t.Fatalf("SetFont = %+v %v", font, err)
	}
	fonts, _ := s.ListFonts(ctx, struct{}{})
	if len(fonts.Fonts) != 1 || fonts.Fonts[0].Style != "normal" || fonts.Fonts[0].Family != "Brand Sans" {
		t.Fatalf("ListFonts = %+v", fonts)
	}

	created, err := s.SetTextStyle(ctx, odmcp.SetTextStyleInput{TextStyleBody: odmcp.TextStyleBody{
		Name: "Heading", FontFamily: "Brand Sans", FontSize: 32, FontWeight: "700", LineHeight: 1.1, Align: "center",
	}})
	if err != nil || created.TextStyleId == "" {
		t.Fatalf("SetTextStyle = %+v %v", created, err)
	}
	if out, err := s.ApplyTextStyle(ctx, odmcp.ApplyTextStyleInput{NodeIds: []string{title.NodeId}, TextStyleId: created.TextStyleId}); err != nil || out.Changed != 1 {
		t.Fatalf("ApplyTextStyle = %+v %v", out, err)
	}
	if out, _ := s.ApplyTextStyle(ctx, odmcp.ApplyTextStyleInput{NodeIds: []string{title.NodeId}, TextStyleId: created.TextStyleId}); out.Changed != 0 {
		t.Fatalf("applying the same style again changed %d nodes", out.Changed)
	}

	// REPLACE the style: the node follows.
	if _, err := s.SetTextStyle(ctx, odmcp.SetTextStyleInput{Id: created.TextStyleId, TextStyleBody: odmcp.TextStyleBody{Name: "Heading", FontSize: 40, Italic: true}}); err != nil {
		t.Fatal(err)
	}
	list, _ := s.ListTextStyles(ctx, struct{}{})
	if len(list.TextStyles) != 1 || list.TextStyles[0].FontSize != 40 || !list.TextStyles[0].Italic || list.TextStyles[0].Align != "left" {
		t.Fatalf("ListTextStyles = %+v", list)
	}
	doc, _ := s.GetDocument(ctx, struct{}{})
	if len(doc.Fonts) != 1 || len(doc.TextStyles) != 1 {
		t.Fatalf("get_document typography = %+v %+v", doc.Fonts, doc.TextStyles)
	}
	for _, n := range doc.Nodes {
		if n.Id == title.NodeId && n.TextStyleId != created.TextStyleId {
			t.Fatalf("node text style = %q", n.TextStyleId)
		}
	}

	for name, call := range map[string]func() error{
		"negative size": func() error {
			_, err := s.SetTextStyle(ctx, odmcp.SetTextStyleInput{TextStyleBody: odmcp.TextStyleBody{Name: "x", FontSize: -1}})
			return err
		},
		"unsafe family": func() error {
			_, err := s.SetTextStyle(ctx, odmcp.SetTextStyleInput{TextStyleBody: odmcp.TextStyleBody{Name: "x", FontSize: 10, FontFamily: "a{b}"}})
			return err
		},
		"bad align": func() error {
			_, err := s.SetTextStyle(ctx, odmcp.SetTextStyleInput{TextStyleBody: odmcp.TextStyleBody{Name: "x", FontSize: 10, Align: "justify"}})
			return err
		},
		"unknown style": func() error {
			_, err := s.ApplyTextStyle(ctx, odmcp.ApplyTextStyleInput{NodeIds: []string{title.NodeId}, TextStyleId: "ghost"})
			return err
		},
		"not a text node": func() error {
			_, err := s.ApplyTextStyle(ctx, odmcp.ApplyTextStyleInput{NodeIds: []string{home}, TextStyleId: created.TextStyleId})
			return err
		},
		"duplicate font": func() error {
			_, err := s.SetFont(ctx, odmcp.SetFontInput{Family: "Brand Sans", Weight: "700", AssetHash: strings.Repeat("b", 64)})
			return err
		},
		"bad hash": func() error {
			_, err := s.SetFont(ctx, odmcp.SetFontInput{Family: "Other", Weight: "400", AssetHash: "xyz"})
			return err
		},
		"bad weight": func() error {
			_, err := s.SetFont(ctx, odmcp.SetFontInput{Family: "Other", Weight: "450", AssetHash: strings.Repeat("b", 64)})
			return err
		},
		"missing font":  func() error { _, err := s.DeleteFont(ctx, odmcp.IdInput{Id: "ghost"}); return err },
		"missing style": func() error { _, err := s.DeleteTextStyle(ctx, odmcp.IdInput{Id: "ghost"}); return err },
	} {
		if err := call(); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}

	if _, err := s.DeleteTextStyle(ctx, odmcp.IdInput{Id: created.TextStyleId}); err != nil {
		t.Fatal(err)
	}
	doc, _ = s.GetDocument(ctx, struct{}{})
	for _, n := range doc.Nodes {
		if n.Id == title.NodeId && n.TextStyleId != "" {
			t.Fatalf("deleting the style left the node pointing to it: %q", n.TextStyleId)
		}
	}
	if _, err := s.DeleteFont(ctx, odmcp.IdInput{Id: font.FontId}); err != nil {
		t.Fatal(err)
	}
}
