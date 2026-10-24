package codegen_test

import (
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
	. "github.com/bernardoforcillo/opendesigner/internal/codegen/samples"
)

// annotatedDoc: the native sample with an annotation on the card and the screen marked ready.
func annotatedDoc() *opendesignerv1.Document {
	doc := nativeDoc()
	doc.Annotations = map[string]*opendesignerv1.Annotation{
		"a1": {Id: "a1", NodeId: "card", Category: "interaction", Text: "Opens the cart\nas a sheet --- fast */", Author: "Ana", CreatedAt: 1},
		"a2": {Id: "a2", NodeId: "card", Category: "accessibility", Text: "Role: button", CreatedAt: 2},
	}
	doc.ReadyForDev = map[string]*opendesignerv1.ReadyForDev{
		"scr": {NodeId: "scr", Note: "Start with the card", MarkedBy: "Ana", MarkedAt: 1761264000}, // 2025-10-24
	}
	return doc
}

func TestAnnotationsAndReadyMarkBecomeComments(t *testing.T) {
	doc := annotatedDoc()
	wantLines := []string{
		"annotation [interaction] Opens the cart as a sheet - - fast * / (Ana)",
		"annotation [accessibility] Role: button",
		"ready for dev since 2025-10-24 by Ana: Start with the card",
	}
	cases := []struct {
		target codegen.Target
		file   string
		wrap   func(string) string
	}{
		{codegen.TargetHTML, "screen.html", func(s string) string { return "<!-- " + s + " -->" }},
		{codegen.TargetReact, "src/screens/Screen.tsx", func(s string) string { return "// " + s }},
		{codegen.TargetSwiftUI, "Sources/Screens/Screen.swift", func(s string) string { return "// " + s }},
		{codegen.TargetCompose, "app/src/main/kotlin/design/generated/screens/Screen.kt", func(s string) string { return "// " + s }},
	}
	for _, c := range cases {
		src := string(file(t, gen(t, doc, c.target, nil), c.file))
		for _, l := range wantLines {
			if !strings.Contains(src, c.wrap(l)) {
				t.Errorf("%s: %s lacks %q:\n%s", c.target, c.file, c.wrap(l), src)
			}
		}
		// The annotations sit above the card, not above the screen; the ready mark above the screen.
		card := strings.Index(src, "annotation [interaction]")
		ready := strings.Index(src, "ready for dev since")
		if ready < 0 || card < 0 || ready > card {
			t.Errorf("%s: the ready mark must come before the card's annotations (%d, %d)", c.target, ready, card)
		}
	}
}

func TestExportWithoutDevDataIsUnchanged(t *testing.T) {
	// No annotations, no ready frames: not a single extra line (the goldens of the other tests
	// already pin this; here the comments themselves are checked).
	for _, tg := range []codegen.Target{codegen.TargetHTML, codegen.TargetReact, codegen.TargetSwiftUI, codegen.TargetCompose} {
		out := gen(t, Shop(), tg, nil)
		for _, f := range out.Files {
			if strings.Contains(string(f.Content), "annotation [") || strings.Contains(string(f.Content), "ready for dev") {
				t.Errorf("%s: %s mentions dev mode data that the document does not have", tg, f.Path)
			}
		}
	}
}

func TestNotesInsideInstancesAreLeftOut(t *testing.T) {
	// An annotation on a component master describes the master, not every instance of it.
	doc := buttonDoc()
	doc.Annotations = map[string]*opendesignerv1.Annotation{"a": {Id: "a", NodeId: "ma", Category: "note", Text: "master only"}}
	out := gen(t, doc, codegen.TargetReact, nil)
	screen := string(file(t, out, "src/screens/Home.tsx"))
	if n := strings.Count(screen, "master only"); n != 1 {
		t.Errorf("the master's own element (a loose rectangle in the screen) is annotated once, got %d:\n%s", n, screen)
	}
	if strings.Contains(string(file(t, out, "src/components/Button.tsx")), "master only") {
		t.Error("a component file must not carry the master's annotation")
	}
}
