package codegen_test

import (
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
)

func varPaint(id string) *opendesignerv1.Paint {
	return &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Variable{Variable: &opendesignerv1.VariableRef{VariableId: id}}}
}

func solid(r, g, b float32) *opendesignerv1.Paint {
	return &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{Color: &opendesignerv1.Color{R: r, G: g, B: b, A: 1}}}}
}

// varDoc: one screen with a rectangle filled by variable "v1" (colour/Brand,
// red in "light", blue in "dark") and a second rectangle that references a
// variable that does not exist.
func varDoc() *opendesignerv1.Document {
	return &opendesignerv1.Document{
		Id: "doc", Name: "Tokens", SchemaVersion: 1,
		Pages: []*opendesignerv1.Page{{Id: "page1", Name: "Page 1"}},
		Modes: []*opendesignerv1.Mode{{Id: "light", Name: "Light"}, {Id: "dark", Name: "Dark"}},
		Variables: map[string]*opendesignerv1.Variable{
			"v1": {Id: "v1", Name: "colour/Brand", Values: map[string]*opendesignerv1.Color{
				"light": {R: 1, A: 1}, "dark": {B: 1, A: 1},
			}},
		},
		Nodes: map[string]*opendesignerv1.Node{
			"s": {Id: "s", ParentId: "page1", OrderKey: "a", Name: "Home", Visible: true, Opacity: 1, Width: 400, Height: 300,
				Fills: []*opendesignerv1.Paint{solid(1, 1, 1)},
				Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}},
			"r": {Id: "r", ParentId: "s", OrderKey: "a", Name: "Brand box", Visible: true, Opacity: 1, X: 10, Y: 10, Width: 50, Height: 50,
				Fills: []*opendesignerv1.Paint{varPaint("v1")},
				Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}}},
			"x": {Id: "x", ParentId: "s", OrderKey: "b", Name: "Dangling", Visible: true, Opacity: 1, X: 100, Y: 10, Width: 50, Height: 50,
				Fills: []*opendesignerv1.Paint{varPaint("gone")},
				Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}}},
		},
	}
}

func TestVariableFillsExportAsCustomProperties(t *testing.T) {
	doc := varDoc()
	out := gen(t, doc, codegen.TargetHTML, nil)
	var page string
	for _, f := range out.Files {
		if strings.HasSuffix(f.Path, ".html") && strings.Contains(string(f.Content), "Brand box") || strings.Contains(string(f.Content), "--colour-brand") {
			page = string(f.Content)
		}
	}
	if page == "" {
		t.Fatalf("no page with the token found; files: %v", out.Files)
	}
	for _, want := range []string{
		":root{--colour-brand:#f00;}",              // default mode = first mode
		`[data-mode="dark"]{--colour-brand:#00f;}`, // other mode overrides
		"background-color: var(--colour-brand)",
	} {
		if !strings.Contains(page, want) {
			t.Errorf("missing %q in:\n%s", want, page)
		}
	}
	// A dangling reference draws black and must not invent a custom property.
	if strings.Count(page, "var(--") != 1 {
		t.Errorf("only the bound fill may use var(), got %d in:\n%s", strings.Count(page, "var(--"), page)
	}
	if !strings.Contains(page, "background-color: #000") {
		t.Errorf("dangling variable must draw black:\n%s", page)
	}
}

func TestVariableExportReactAddsTokensToIndexCSS(t *testing.T) {
	out := gen(t, varDoc(), codegen.TargetReact, nil)
	css := string(file(t, out, "src/index.css"))
	if !strings.Contains(css, ":root{--colour-brand:#f00;}") || !strings.Contains(css, `[data-mode="dark"]`) {
		t.Errorf("index.css lacks the tokens:\n%s", css)
	}
}

func TestExportDoesNotMutateTheDocumentsVariablePaints(t *testing.T) {
	doc := varDoc()
	gen(t, doc, codegen.TargetHTML, nil)
	if _, ok := doc.Nodes["r"].Fills[0].Kind.(*opendesignerv1.Paint_Variable); !ok {
		t.Fatal("Generate rewrote the caller's paint; it must work on a clone")
	}
}

func TestDocumentWithoutVariablesIsUnchanged(t *testing.T) {
	doc := varDoc()
	doc.Variables = nil
	doc.Nodes["r"].Fills = []*opendesignerv1.Paint{solid(0, 1, 0)}
	doc.Nodes["x"].Fills = []*opendesignerv1.Paint{solid(0, 0, 1)}
	out := gen(t, doc, codegen.TargetHTML, nil)
	for _, f := range out.Files {
		if strings.Contains(string(f.Content), "var(--") || strings.Contains(string(f.Content), "data-mode") {
			t.Fatalf("no variables, yet the output mentions tokens in %s", f.Path)
		}
	}
}

func TestBoundStrokesExportAsCustomProperties(t *testing.T) {
	doc := varDoc()
	doc.Nodes["r"].Strokes = []*opendesignerv1.Stroke{
		{Paint: solid(0, 1, 0), Weight: 2, Align: opendesignerv1.StrokeAlign_STROKE_ALIGN_OUTSIDE},
		{Paint: varPaint("v1"), Weight: 3, Align: opendesignerv1.StrokeAlign_STROKE_ALIGN_OUTSIDE},
	}
	out := gen(t, doc, codegen.TargetHTML, nil)
	page := ""
	for _, f := range out.Files {
		if strings.HasSuffix(f.Path, ".html") && strings.Contains(string(f.Content), "box-shadow") {
			page = string(f.Content)
		}
	}
	// The LAST stroke is drawn last, so it comes first in the shadow list; only
	// the bound one uses var(), the literal one keeps its colour.
	if !strings.Contains(page, "0 0 0 3px var(--colour-brand),0 0 0 2px #0f0") {
		t.Errorf("stroke binding lost or misplaced:\n%s", page)
	}
}

func TestReactTokensUseTailwindThemeForColorNames(t *testing.T) {
	doc := varDoc()
	doc.Variables["v1"].Name = "color/Brand"
	doc.Variables["v2"] = &opendesignerv1.Variable{Id: "v2", Name: "surface/page", Values: map[string]*opendesignerv1.Color{"light": {R: 1, G: 1, B: 1, A: 1}}}
	doc.Nodes["x"].Fills = []*opendesignerv1.Paint{varPaint("v2")}
	css := string(file(t, gen(t, doc, codegen.TargetReact, nil), "src/index.css"))
	if !strings.Contains(css, "@theme{--color-brand:#f00;}") {
		t.Errorf("--color-* tokens belong in @theme:\n%s", css)
	}
	if !strings.Contains(css, ":root{--surface-page:#fff;}") {
		t.Errorf("other tokens stay in :root (outside Tailwind's theme namespaces):\n%s", css)
	}
	if !strings.Contains(css, `[data-mode="dark"]{--color-brand:#00f;}`) {
		t.Errorf("mode overrides missing:\n%s", css)
	}
	html := ""
	for _, f := range gen(t, doc, codegen.TargetHTML, nil).Files {
		if strings.HasSuffix(f.Path, ".html") && strings.Contains(string(f.Content), "--color-brand") {
			html = string(f.Content)
		}
	}
	if !strings.Contains(html, ":root{--color-brand:#f00;--surface-page:#fff;}") {
		t.Errorf("plain HTML has no Tailwind: everything goes in :root:\n%s", html)
	}
}

// An instance's fill override bound to a variable must export the variable's
// colour (default mode), never the black a dangling paint draws.
func TestBoundInstanceOverrideExportsTheVariableColour(t *testing.T) {
	doc := varDoc()
	doc.Components = map[string]*opendesignerv1.Component{"c": {RootNodeId: "r", Name: "Box"}}
	doc.Nodes["i"] = &opendesignerv1.Node{
		Id: "i", ParentId: "s", OrderKey: "c", Name: "Inst", Visible: true, Opacity: 1, X: 200, Y: 10, Width: 50, Height: 50,
		Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{
			ComponentId: "c",
			Overrides:   []*opendesignerv1.InstanceOverride{{MasterNodeId: "r", FillsPresent: true, Fills: []*opendesignerv1.Paint{varPaint("v1")}}},
		}},
	}
	// Make the master itself a plain colour so a red instance can only come from the override.
	doc.Nodes["r"].Fills = []*opendesignerv1.Paint{solid(0, 1, 0)}
	out := gen(t, doc, codegen.TargetHTML, nil)
	for _, f := range out.Files {
		if strings.HasSuffix(f.Path, ".html") && strings.Contains(string(f.Content), "left: 200px") {
			if !strings.Contains(string(f.Content), "background-color: #f00") {
				t.Fatalf("the bound override must export the variable's colour:\n%s", f.Content)
			}
			return
		}
	}
	t.Fatal("no page with the instance")
}

// --- aliases, number/text kinds, bindings, gradient stops ---------------------------

func numberVar(id, name string, vals map[string]float64) *opendesignerv1.Variable {
	return &opendesignerv1.Variable{Id: id, Name: name, Type: opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER, Numbers: vals}
}

func htmlWith(t *testing.T, doc *opendesignerv1.Document, needle string) string {
	t.Helper()
	for _, f := range gen(t, doc, codegen.TargetHTML, nil).Files {
		if strings.HasSuffix(f.Path, ".html") && strings.Contains(string(f.Content), needle) {
			return string(f.Content)
		}
	}
	t.Fatalf("no page contains %q", needle)
	return ""
}

func TestAliasExportsAsVarOfItsTarget(t *testing.T) {
	doc := varDoc()
	doc.Variables["sem"] = &opendesignerv1.Variable{Id: "sem", Name: "surface/accent", AliasOf: "v1"}
	doc.Nodes["r"].Fills = []*opendesignerv1.Paint{varPaint("sem")}
	page := htmlWith(t, doc, "--surface-accent")
	for _, want := range []string{
		"--colour-brand:#f00;", // the target is exported although only the alias is used
		":root{--surface-accent:var(--colour-brand);",
		`[data-mode="dark"]{--surface-accent:var(--colour-brand);--colour-brand:#00f;}`, // alias re-declared per mode
		"background-color: var(--surface-accent)",
	} {
		if !strings.Contains(page, want) {
			t.Errorf("missing %q in:\n%s", want, page)
		}
	}
}

func TestBoundNumbersExportAsVarWithUnits(t *testing.T) {
	doc := varDoc()
	doc.Variables["rad"] = numberVar("rad", "space/radius", map[string]float64{"light": 8, "dark": 24})
	doc.Variables["op"] = numberVar("op", "alpha/card", map[string]float64{"light": 0.5, "dark": 1})
	doc.Nodes["r"].Bindings = map[string]string{"corner_radius": "rad", "opacity": "op"}
	page := htmlWith(t, doc, "--space-radius")
	for _, want := range []string{
		":root{--alpha-card:0.5;--space-radius:8;",
		`[data-mode="dark"]{--alpha-card:1;--space-radius:24;`,
		"border-radius: min(calc(var(--space-radius) * 1px), 25px)",
		"opacity: var(--alpha-card)",
	} {
		if !strings.Contains(page, want) {
			t.Errorf("missing %q in:\n%s", want, page)
		}
	}
}

func TestBoundTextAndFontSize(t *testing.T) {
	doc := varDoc()
	doc.Variables["size"] = numberVar("size", "type/body", map[string]float64{"light": 18})
	doc.Variables["copy"] = &opendesignerv1.Variable{Id: "copy", Name: "copy/title", Type: opendesignerv1.VariableType_VARIABLE_TYPE_STRING, Strings: map[string]string{"light": "Hello \"you\""}}
	doc.Nodes["tx"] = &opendesignerv1.Node{
		Id: "tx", ParentId: "s", OrderKey: "z", Name: "T", Visible: true, Opacity: 1, X: 5, Y: 90, Width: 100, Height: 20,
		Shape:    &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{Content: "stale", Style: &opendesignerv1.TextStyle{FontSize: 10}}},
		Bindings: map[string]string{"font_size": "size", "text": "copy"},
	}
	page := htmlWith(t, doc, "--type-body")
	for _, want := range []string{"font-size: calc(var(--type-body) * 1px)", `Hello &#34;you&#34;`} {
		if !strings.Contains(page, want) {
			t.Errorf("missing %q in:\n%s", want, page)
		}
	}
	if strings.Contains(page, "stale") {
		t.Error("a bound text must export the variable's value, not the stale content")
	}
}

func TestBoundGradientStopExportsItsDefaultColour(t *testing.T) {
	doc := varDoc()
	doc.Nodes["r"].Fills = []*opendesignerv1.Paint{{Kind: &opendesignerv1.Paint_Linear{Linear: &opendesignerv1.GradientPaint{
		X2: 1, Stops: []*opendesignerv1.GradientStop{
			{Color: &opendesignerv1.Color{A: 1}, Position: 0, VariableId: "v1"},
			{Color: &opendesignerv1.Color{R: 1, G: 1, B: 1, A: 1}, Position: 1},
		}}}}}
	page := htmlWith(t, doc, "linear-gradient")
	if !strings.Contains(page, "#f00 0%") {
		t.Errorf("the bound stop must export the variable's default-mode colour:\n%s", page)
	}
}

// An instance of a variant exports with the component and the combination, so
// the markup can be mapped back to the design component and its props.
func TestInstanceExportsItsVariant(t *testing.T) {
	doc := varDoc()
	doc.Components = map[string]*opendesignerv1.Component{
		"c": {RootNodeId: "r", Name: "Button/L", SetId: "s", Variant: map[string]string{"Size": "L", "State": "Default"}},
	}
	doc.ComponentSets = map[string]*opendesignerv1.ComponentSet{"s": {Id: "s", Name: "Button"}}
	doc.Nodes["i"] = &opendesignerv1.Node{
		Id: "i", ParentId: "s", OrderKey: "c", Name: "Inst", Visible: true, Opacity: 1, X: 200, Y: 10, Width: 50, Height: 50,
		Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: "c"}},
	}
	page := htmlWith(t, doc, "data-component")
	if !strings.Contains(page, `data-component="Button/L"`) || !strings.Contains(page, `data-variant="Size=L;State=Default"`) {
		t.Errorf("instance lacks its component/variant markers:\n%s", page)
	}
}
