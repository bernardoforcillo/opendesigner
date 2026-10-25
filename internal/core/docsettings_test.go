package core

import (
	"errors"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

func settingsOp(s *opendesignerv1.DocSettings) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetDocSettings{SetDocSettings: &opendesignerv1.SetDocSettings{Settings: s}}}
}

func TestSetDocSettings(t *testing.T) {
	doc := NewDocument("d", "Book")
	mustApply(t, doc, settingsOp(&opendesignerv1.DocSettings{Vertical: "publishing", BaselineIncrement: 14, BaselineStart: 36}))
	if got := doc.GetSettings(); got.GetVertical() != "publishing" || got.GetBaselineIncrement() != 14 || got.GetBaselineStart() != 36 {
		t.Fatalf("settings = %v", got)
	}
	// An absolute upsert: the next op replaces all of it.
	mustApply(t, doc, settingsOp(&opendesignerv1.DocSettings{Vertical: "design"}))
	if got := doc.GetSettings(); got.GetVertical() != "design" || got.GetBaselineIncrement() != 0 {
		t.Fatalf("settings after the second op = %v", got)
	}
	for name, s := range map[string]*opendesignerv1.DocSettings{
		"unknown vertical":    {Vertical: "cinema"},
		"negative increment":  {BaselineIncrement: -1},
		"increment too large": {BaselineIncrement: 5000},
		"negative start":      {BaselineStart: -3},
		"unknown device":      {PresentDevice: "watch"},
	} {
		if err := Apply(doc, settingsOp(s)); err == nil {
			t.Errorf("%s: should be rejected", name)
		}
	}
	if err := Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetDocSettings{SetDocSettings: &opendesignerv1.SetDocSettings{}}}); err == nil {
		t.Error("a nil settings message should be rejected")
	}
	mustApply(t, doc, settingsOp(&opendesignerv1.DocSettings{PresentDevice: "phone"}))
	if doc.GetSettings().GetPresentDevice() != "phone" {
		t.Errorf("present device = %q", doc.GetSettings().GetPresentDevice())
	}
	for _, d := range append([]string{""}, PresentDevices...) {
		if !ValidPresentDevice(d) {
			t.Errorf("device %q should be valid", d)
		}
	}
	if !ValidVertical("") || !ValidVertical("product") || ValidVertical("x") {
		t.Error("ValidVertical")
	}
}

func TestPageSetupValidation(t *testing.T) {
	doc := NewDocument("d", "Book")
	a5 := &opendesignerv1.Page{Id: "p2", Name: "A5", Width: 420, Height: 595, MarginTop: 40, MarginBottom: 50, MarginLeft: 36, MarginRight: 36, Columns: 2, Gutter: 18, Bleed: 9}
	mustApply(t, doc, createPageOp(a5))
	if got := doc.Pages[1]; got.GetWidth() != 420 || got.GetColumns() != 2 || got.GetBleed() != 9 {
		t.Fatalf("page setup not stored: %v", got)
	}
	// UpdatePage replaces the setup too.
	mustApply(t, doc, updatePageOp(&opendesignerv1.Page{Id: "p2", Name: "A5", Width: 300, Height: 400}))
	if got := doc.Pages[1]; got.GetWidth() != 300 || got.GetColumns() != 0 || got.GetMarginLeft() != 0 {
		t.Fatalf("page setup after the update: %v", got)
	}
	bad := map[string]*opendesignerv1.Page{
		"negative width":         {Id: "x", Width: -5},
		"width under one unit":   {Id: "x", Width: 0.5},
		"huge height":            {Id: "x", Height: 1e9},
		"negative margin":        {Id: "x", MarginTop: -1},
		"margins eat the width":  {Id: "x", Width: 100, Height: 200, MarginLeft: 60, MarginRight: 40},
		"margins eat the height": {Id: "x", Width: 100, Height: 100, MarginTop: 50, MarginBottom: 50},
		"too many columns":       {Id: "x", Width: 1000, Height: 100, Columns: 25},
		"gutters eat the text":   {Id: "x", Width: 100, Height: 100, Columns: 4, Gutter: 40},
		"bleed too large":        {Id: "x", Bleed: 5000},
	}
	for name, p := range bad {
		if err := Apply(doc, createPageOp(p)); !errors.Is(err, ErrBadPageSetup) {
			t.Errorf("%s: got %v, want ErrBadPageSetup", name, err)
		}
	}
	// An unbounded page (size 0) may still carry margins and columns: they are guides at the origin.
	mustApply(t, doc, createPageOp(&opendesignerv1.Page{Id: "free", Name: "Free", MarginLeft: 10, Columns: 3, Gutter: 5}))
}
