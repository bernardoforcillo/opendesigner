package mcp_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestVariableToolsEndToEnd: modes, variables, binding, listing, deletion, and
// the errors an agent should be able to act on.
func TestVariableToolsEndToEnd(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	home := frame(t, s, "Home")
	card := rect(t, s, home, "Card")

	if _, err := s.SetModes(ctx, odmcp.SetModesInput{Modes: []odmcp.ModeIO{{Id: "light", Name: "Light"}, {Id: "dark"}}}); err != nil {
		t.Fatalf("SetModes: %v", err)
	}
	if _, err := s.SetModes(ctx, odmcp.SetModesInput{Modes: []odmcp.ModeIO{{Id: "a"}, {Id: "a"}}}); err == nil || !strings.Contains(err.Error(), "unique") {
		t.Fatalf("duplicate modes must be refused with a hint, got %v", err)
	}

	created, err := s.SetVariable(ctx, odmcp.SetVariableInput{Name: "color/brand", Values: map[string]odmcp.RGBA{
		"light": {R: 1, A: 1}, "dark": {B: 1, A: 1},
	}})
	if err != nil || created.VariableId == "" {
		t.Fatalf("SetVariable create: %+v %v", created, err)
	}
	if _, err := s.SetVariable(ctx, odmcp.SetVariableInput{Name: "x", Values: map[string]odmcp.RGBA{"sepia": {A: 1}}}); err == nil || !strings.Contains(err.Error(), "mode") {
		t.Fatalf("a value for an unknown mode must be refused, got %v", err)
	}
	if _, err := s.SetVariable(ctx, odmcp.SetVariableInput{Id: "ghost", Name: "x"}); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("replacing an unknown id must say not found, got %v", err)
	}

	if _, err := s.BindVariable(ctx, odmcp.BindVariableInput{NodeId: card, VariableId: created.VariableId}); err != nil {
		t.Fatalf("BindVariable: %v", err)
	}
	if _, err := s.BindVariable(ctx, odmcp.BindVariableInput{NodeId: card, VariableId: created.VariableId, Target: "stroke"}); err == nil || !strings.Contains(err.Error(), "no stroke") {
		t.Fatalf("binding a stroke the node lacks must be refused, got %v", err)
	}
	if _, err := s.BindVariable(ctx, odmcp.BindVariableInput{NodeId: card, VariableId: "ghost"}); err == nil {
		t.Fatal("binding an unknown variable must be refused")
	}

	list, _ := s.ListVariables(ctx, struct{}{})
	if len(list.Modes) != 2 || list.Modes[1].Name != "dark" || len(list.Variables) != 1 {
		t.Fatalf("ListVariables = %+v", list)
	}
	v := list.Variables[0]
	if v.Name != "color/brand" || v.UsedBy != 1 || v.Values["dark"].B != 1 {
		t.Fatalf("variable view = %+v", v)
	}
	doc, _ := s.GetDocument(ctx, struct{}{})
	if len(doc.Variables) != 1 || len(doc.Modes) != 2 {
		t.Fatalf("get_document lacks the tokens: %+v", doc)
	}

	// Replace entirely.
	if _, err := s.SetVariable(ctx, odmcp.SetVariableInput{Id: created.VariableId, Name: "color/brand", Values: map[string]odmcp.RGBA{"light": {G: 1, A: 1}}}); err != nil {
		t.Fatalf("SetVariable replace: %v", err)
	}
	list, _ = s.ListVariables(ctx, struct{}{})
	if _, ok := list.Variables[0].Values["dark"]; ok || list.Variables[0].Values["light"].G != 1 {
		t.Fatalf("replace must be absolute: %+v", list.Variables[0])
	}

	if _, err := s.DeleteVariable(ctx, odmcp.VariableIdInput{Id: created.VariableId}); err != nil {
		t.Fatalf("DeleteVariable: %v", err)
	}
	if _, err := s.DeleteVariable(ctx, odmcp.VariableIdInput{Id: created.VariableId}); err == nil {
		t.Fatal("deleting twice must fail")
	}
}

// TestVariableKindsAliasesAndPropertyBindings: the second half of the tool surface.
func TestVariableKindsAliasesAndPropertyBindings(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	home := frame(t, s, "Home")
	card := rect(t, s, home, "Card")
	title, err := s.CreateText(ctx, odmcp.CreateTextInput{ParentId: home, X: 5, Y: 5, Content: "old"})
	if err != nil {
		t.Fatalf("CreateText: %v", err)
	}
	if _, err := s.SetModes(ctx, odmcp.SetModesInput{Modes: []odmcp.ModeIO{{Id: "light"}, {Id: "dark"}}}); err != nil {
		t.Fatal(err)
	}

	radius, err := s.SetVariable(ctx, odmcp.SetVariableInput{Name: "space/radius", Type: "number", Numbers: map[string]float64{"light": 8, "dark": 16}})
	if err != nil {
		t.Fatalf("number variable: %v", err)
	}
	copyVar, err := s.SetVariable(ctx, odmcp.SetVariableInput{Name: "copy/title", Type: "string", Strings: map[string]string{"light": "Hello"}})
	if err != nil {
		t.Fatalf("string variable: %v", err)
	}
	brand, _ := s.SetVariable(ctx, odmcp.SetVariableInput{Name: "color/brand", Values: map[string]odmcp.RGBA{"light": {R: 1, A: 1}}})
	sem, err := s.SetVariable(ctx, odmcp.SetVariableInput{Name: "color/semantic", AliasOf: brand.VariableId})
	if err != nil {
		t.Fatalf("alias: %v", err)
	}

	// Refusals an agent must be able to act on.
	for name, in := range map[string]odmcp.SetVariableInput{
		"mixed kinds":   {Name: "x", Type: "number", Values: map[string]odmcp.RGBA{"light": {A: 1}}},
		"alias+values":  {Name: "x", AliasOf: brand.VariableId, Values: map[string]odmcp.RGBA{"light": {A: 1}}},
		"alias of kind": {Name: "x", Type: "number", AliasOf: brand.VariableId},
		"unknown type":  {Name: "x", Type: "date"},
	} {
		if _, err := s.SetVariable(ctx, in); err == nil {
			t.Errorf("%s: must be refused", name)
		}
	}

	// Property bindings: the server writes the values.
	for _, b := range []odmcp.BindVariableInput{
		{NodeId: card, VariableId: radius.VariableId, Target: "corner_radius"},
		{NodeId: title.NodeId, VariableId: copyVar.VariableId, Target: "text"},
		{NodeId: card, VariableId: sem.VariableId}, // fill bound through the alias
	} {
		if _, err := s.BindVariable(ctx, b); err != nil {
			t.Fatalf("BindVariable(%+v): %v", b, err)
		}
	}
	if _, err := s.BindVariable(ctx, odmcp.BindVariableInput{NodeId: card, VariableId: brand.VariableId, Target: "opacity"}); err == nil || !strings.Contains(err.Error(), "number variable") {
		t.Fatalf("a colour for opacity must be refused with the kind named, got %v", err)
	}
	if _, err := s.BindVariable(ctx, odmcp.BindVariableInput{NodeId: card, VariableId: radius.VariableId, Target: "font_size"}); err == nil {
		t.Fatal("font_size on a rectangle must be refused")
	}
	doc, _ := s.GetDocument(ctx, struct{}{})
	if len(doc.Variables) != 4 {
		t.Fatalf("get_document variables = %+v", doc.Variables)
	}
	list, _ := s.ListVariables(ctx, struct{}{})
	byName := map[string]odmcp.VariableView{}
	for _, v := range list.Variables {
		byName[v.Name] = v
	}
	if byName["space/radius"].Type != "number" || byName["space/radius"].Numbers["dark"] != 16 || byName["space/radius"].UsedBy != 1 {
		t.Errorf("number view = %+v", byName["space/radius"])
	}
	if byName["color/semantic"].AliasOf != brand.VariableId || byName["color/semantic"].UsedBy != 1 || len(byName["color/semantic"].Values) != 0 {
		t.Errorf("alias view = %+v", byName["color/semantic"])
	}

	// Unbind a property; the value stays.
	if _, err := s.BindVariable(ctx, odmcp.BindVariableInput{NodeId: card, Target: "corner_radius"}); err != nil {
		t.Fatalf("unbind: %v", err)
	}
	list, _ = s.ListVariables(ctx, struct{}{})
	for _, v := range list.Variables {
		if v.Name == "space/radius" && v.UsedBy != 0 {
			t.Errorf("unbound variable still counted: %+v", v)
		}
	}
}

func TestBindGradientStop(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()
	card := rect(t, s, frame(t, s, "Home"), "Card")
	v, _ := s.SetVariable(ctx, odmcp.SetVariableInput{Name: "color/a", Values: map[string]odmcp.RGBA{"x": {R: 1, A: 1}}})

	if _, err := s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: card, Fills: []odmcp.RGBA{{R: 1, A: 1}}}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.BindVariable(ctx, odmcp.BindVariableInput{NodeId: card, VariableId: v.VariableId, Stop: ptr(0)}); err == nil || !strings.Contains(err.Error(), "not a gradient") {
		t.Fatalf("a stop on a solid fill must be refused, got %v", err)
	}
	if _, err := s.SetProperties(ctx, odmcp.SetPropertiesInput{Id: card, Fills: []odmcp.RGBA{{Gradient: &odmcp.GradientSpec{
		Kind: "linear", X2: 1, Stops: []odmcp.GradientStopSpec{{Color: odmcp.StopColor{A: 1}, Position: 0}, {Color: odmcp.StopColor{R: 1, G: 1, B: 1, A: 1}, Position: 1}},
	}}}}); err != nil {
		t.Fatalf("gradient: %v", err)
	}
	if _, err := s.BindVariable(ctx, odmcp.BindVariableInput{NodeId: card, VariableId: v.VariableId, Stop: ptr(5)}); err == nil || !strings.Contains(err.Error(), "no stop 5") {
		t.Fatalf("an out-of-range stop must be refused, got %v", err)
	}
	if _, err := s.BindVariable(ctx, odmcp.BindVariableInput{NodeId: card, VariableId: v.VariableId, Stop: ptr(0)}); err != nil {
		t.Fatalf("bind stop: %v", err)
	}
	list, _ := s.ListVariables(ctx, struct{}{})
	if list.Variables[0].UsedBy != 1 {
		t.Fatalf("the bound stop is not counted: %+v", list.Variables[0])
	}
}

// TestVariablesSurviveARealExport: the whole chain on a real document. An agent
// builds a screen over the in-memory server, defines tokens of every kind, binds
// them, and exports React and HTML to disk. What lands in the files is what a
// developer would ship.
func TestVariablesSurviveARealExport(t *testing.T) {
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	home := frame(t, s, "Home")
	card := rect(t, s, home, "Card")
	title, err := s.CreateText(ctx, odmcp.CreateTextInput{ParentId: home, X: 5, Y: 5, Content: "stale"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetModes(ctx, odmcp.SetModesInput{Modes: []odmcp.ModeIO{{Id: "light", Name: "Light"}, {Id: "dark", Name: "Dark"}}}); err != nil {
		t.Fatal(err)
	}
	brand, _ := s.SetVariable(ctx, odmcp.SetVariableInput{Name: "color/brand", Values: map[string]odmcp.RGBA{"light": {R: 1, A: 1}, "dark": {B: 1, A: 1}}})
	accent, _ := s.SetVariable(ctx, odmcp.SetVariableInput{Name: "color/accent", AliasOf: brand.VariableId})
	radius, _ := s.SetVariable(ctx, odmcp.SetVariableInput{Name: "radius/md", Type: "number", Numbers: map[string]float64{"light": 8, "dark": 16}})
	size, _ := s.SetVariable(ctx, odmcp.SetVariableInput{Name: "type/title", Type: "number", Numbers: map[string]float64{"light": 24}})
	copyV, _ := s.SetVariable(ctx, odmcp.SetVariableInput{Name: "copy/title", Type: "string", Strings: map[string]string{"light": "Welcome"}})
	for _, b := range []odmcp.BindVariableInput{
		{NodeId: card, VariableId: accent.VariableId},
		{NodeId: card, VariableId: radius.VariableId, Target: "corner_radius"},
		{NodeId: title.NodeId, VariableId: size.VariableId, Target: "font_size"},
		{NodeId: title.NodeId, VariableId: copyV.VariableId, Target: "text"},
	} {
		if _, err := s.BindVariable(ctx, b); err != nil {
			t.Fatalf("bind %+v: %v", b, err)
		}
	}

	dir := filepath.Join(t.TempDir(), "app")
	if keep := os.Getenv("OD_KEEP_EXPORT"); keep != "" {
		dir = keep // inspect or build the generated project by hand
	}
	if _, err := s.ExportCode(ctx, odmcp.ExportCodeInput{OutDir: dir, Force: true}); err != nil {
		t.Fatalf("react export: %v", err)
	}
	read := func(p string) string {
		b, err := os.ReadFile(filepath.Join(dir, p))
		if err != nil {
			t.Fatalf("read %s: %v", p, err)
		}
		return string(b)
	}
	css := read("src/index.css")
	for _, want := range []string{
		"@theme{--color-brand:#f00;}",        // colour token, Tailwind theme
		"--color-accent:var(--color-brand);", // the alias points at its target
		"--radius-md:8;", "--type-title:24;", // numbers, unitless
		`[data-mode="dark"]{`, "--color-brand:#00f;", "--radius-md:16;",
	} {
		if !strings.Contains(css, want) {
			t.Errorf("index.css lacks %q:\n%s", want, css)
		}
	}
	screen := read("src/screens/Home.tsx")
	for _, want := range []string{"var(--color-accent)", "var(--radius-md)", "var(--type-title)", "Welcome"} {
		if !strings.Contains(screen, want) {
			t.Errorf("Home.tsx lacks %q:\n%s", want, screen)
		}
	}
	if strings.Contains(screen, "stale") {
		t.Error("the bound text must export the variable's value")
	}

	if _, err := s.ExportCode(ctx, odmcp.ExportCodeInput{OutDir: filepath.Join(t.TempDir(), "site"), Target: "html"}); err != nil {
		t.Fatalf("html export: %v", err)
	}
}
