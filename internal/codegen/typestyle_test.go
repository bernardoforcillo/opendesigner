package codegen_test

import (
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
	. "github.com/bernardoforcillo/opendesigner/internal/codegen/samples"
)

func typeHTML(t *testing.T, content string, st *opendesignerv1.TextStyle) string {
	t.Helper()
	doc := screenDoc(func(b *B, s string) {
		b.Add("t", s, "T", 10, 10, 200, 80, TextStyled(content, st))
	})
	return screenHTML(t, doc)
}

// TestTextCaseScriptAndFeaturesInTheExport: case becomes text-transform (title also
// lowercases the content, as the canvas does), small caps and OpenType features become
// their CSS properties, a script shrinks the font.
func TestTextCaseScriptAndFeaturesInTheExport(t *testing.T) {
	cases := []struct {
		name string
		st   *opendesignerv1.TextStyle
		want []string
	}{
		{"upper", &opendesignerv1.TextStyle{FontSize: 20, TextCase: opendesignerv1.TextCase_TEXT_CASE_UPPER}, []string{"text-transform: uppercase;"}},
		{"lower", &opendesignerv1.TextStyle{FontSize: 20, TextCase: opendesignerv1.TextCase_TEXT_CASE_LOWER}, []string{"text-transform: lowercase;"}},
		{"title", &opendesignerv1.TextStyle{FontSize: 20, TextCase: opendesignerv1.TextCase_TEXT_CASE_TITLE}, []string{"text-transform: capitalize;", ">hello world</"}},
		{"small caps", &opendesignerv1.TextStyle{FontSize: 20, TextCase: opendesignerv1.TextCase_TEXT_CASE_SMALL_CAPS}, []string{"font-variant-caps: small-caps;"}},
		{"super", &opendesignerv1.TextStyle{FontSize: 20, TextScript: opendesignerv1.TextScript_TEXT_SCRIPT_SUPER}, []string{"font-size: 13px;"}},
		{"features", &opendesignerv1.TextStyle{FontSize: 20, FontFeatures: `"liga" 0, "tnum"`}, []string{`font-feature-settings: "liga" 0, "tnum";`}},
		{"inset and valign", &opendesignerv1.TextStyle{FontSize: 20, Inset: 6, Indent: 10, VerticalAlign: opendesignerv1.TextVAlign_TEXT_V_ALIGN_MIDDLE},
			[]string{"padding: 6px;", "padding-left: 16px;", "justify-content: center;", "box-sizing: border-box;"}},
	}
	for _, c := range cases {
		html := typeHTML(t, "Hello WORLD", c.st)
		if c.name == "title" {
			html = typeHTML(t, "HELLO world", c.st)
		}
		for _, w := range c.want {
			if !strings.Contains(html, w) {
				t.Errorf("%s: missing %q in:\n%s", c.name, w, html)
			}
		}
	}
	// A style without extras emits none of them.
	html := typeHTML(t, "plain", &opendesignerv1.TextStyle{FontSize: 20})
	for _, no := range []string{"text-transform", "font-variant-caps", "font-feature-settings", "list-item"} {
		if strings.Contains(html, no) {
			t.Errorf("plain text must not carry %q:\n%s", no, html)
		}
	}
}

// TestListsInTheExport: each paragraph becomes a list-item block with the marker hanging
// outside; an empty paragraph keeps its height but has no marker.
func TestListsInTheExport(t *testing.T) {
	html := typeHTML(t, "one\n\ntwo", &opendesignerv1.TextStyle{FontSize: 10, ListKind: opendesignerv1.ListKind_LIST_KIND_NUMBERED})
	for _, w := range []string{"display: list-item;", "list-style-type: decimal;", "list-style-position: outside;", "min-height: 12px;", ">one</", ">two</"} {
		if !strings.Contains(html, w) {
			t.Errorf("missing %q in:\n%s", w, html)
		}
	}
	bullets := typeHTML(t, "a\nb", &opendesignerv1.TextStyle{FontSize: 10, ListKind: opendesignerv1.ListKind_LIST_KIND_BULLET})
	if !strings.Contains(bullets, "list-style-type: disc;") {
		t.Errorf("bullet list lost its disc:\n%s", bullets)
	}
	react := string(file(t, gen(t, screenDoc(func(b *B, s string) {
		b.Add("t", s, "T", 10, 10, 200, 80, TextStyled("a\nb", &opendesignerv1.TextStyle{FontSize: 10, ListKind: opendesignerv1.ListKind_LIST_KIND_BULLET}))
	}), codegen.TargetReact, nil), "src/screens/Screen.tsx"))
	if !strings.Contains(react, `{"a"}`) || !strings.Contains(react, `{"b"}`) {
		t.Errorf("react: list items missing:\n%s", react)
	}
}

// TestTextScaleInTheExport: a horizontal scale becomes scaleX about the edge the text hangs from, with the
// width divided so the box keeps its size; a rotated text keeps its rotation alone.
func TestTextScaleInTheExport(t *testing.T) {
	html := typeHTML(t, "wide", &opendesignerv1.TextStyle{FontSize: 20, TextScale: 200})
	for _, w := range []string{"transform: scaleX(2);", "transform-origin: left top;", "width: 100px;"} {
		if !strings.Contains(html, w) {
			t.Errorf("missing %q in:\n%s", w, html)
		}
	}
	centered := typeHTML(t, "wide", &opendesignerv1.TextStyle{FontSize: 20, TextScale: 50, Align: opendesignerv1.TextAlign_TEXT_ALIGN_CENTER})
	if !strings.Contains(centered, "transform-origin: center top;") || !strings.Contains(centered, "scaleX(0.5)") {
		t.Errorf("centred scale:\n%s", centered)
	}
	for _, no := range []string{"scaleX"} {
		if h := typeHTML(t, "x", &opendesignerv1.TextStyle{FontSize: 20, TextScale: 100}); strings.Contains(h, no) {
			t.Errorf("100%% must emit nothing:\n%s", h)
		}
	}
}
