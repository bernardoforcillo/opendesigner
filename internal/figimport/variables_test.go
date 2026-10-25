package figimport

import (
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

// ---- builders for the variable parts of a generated file (names follow the schema FigCraft reads) ----

func vref(l int) map[string]any { return map[string]any{"guid": guid(1, l)} }
func assetRef(key, version string) map[string]any {
	r := map[string]any{"key": key}
	if version != "" {
		r["version"] = version
	}
	return map[string]any{"assetRef": r}
}
func aliasData(l int) map[string]any {
	return map[string]any{"value": map[string]any{"alias": vref(l)}, "dataType": "ALIAS"}
}
func colorData(r, g, b float64) map[string]any {
	return map[string]any{"value": map[string]any{"colorValue": map[string]any{"r": r, "g": g, "b": b, "a": 1}}, "dataType": "COLOR"}
}
func floatData(f float64) map[string]any {
	return map[string]any{"value": map[string]any{"floatValue": f}, "dataType": "FLOAT"}
}
func textData(s string) map[string]any {
	return map[string]any{"value": map[string]any{"textValue": s}, "dataType": "STRING"}
}
func boolData(b bool) map[string]any {
	return map[string]any{"value": map[string]any{"boolValue": b}, "dataType": "BOOLEAN"}
}
func modeValues(pairs ...any) map[string]any {
	var es []any
	for i := 0; i < len(pairs); i += 2 {
		es = append(es, map[string]any{"modeID": guid(1, pairs[i].(int)), "variableData": pairs[i+1]})
	}
	return map[string]any{"entries": es}
}
func setModes(pairs ...any) []any {
	var ms []any
	for i := 0; i < len(pairs); i += 3 {
		ms = append(ms, map[string]any{"id": guid(1, pairs[i].(int)), "name": pairs[i+1], "sortPosition": pairs[i+2]})
	}
	return ms
}
func variable(id int, pos, name string, set int, typ string, values map[string]any) any {
	return change(id, 2, pos, "VARIABLE", name, map[string]any{"variableSetID": vref(set), "variableResolvedType": typ, "variableDataValues": values})
}

// bound is one variableConsumptionMap entry; consumption wraps the entries.
func bound(field string, variable int) map[string]any {
	return map[string]any{"variableField": field, "variableData": aliasData(variable)}
}
func consumption(entries ...map[string]any) map[string]any {
	var es []any
	for _, e := range entries {
		es = append(es, e)
	}
	return map[string]any{"entries": es}
}
func modePins(pairs ...any) map[string]any {
	var es []any
	for i := 0; i < len(pairs); i += 2 {
		es = append(es, map[string]any{"variableSetID": pairs[i], "variableModeID": guid(1, pairs[i+1].(int))})
	}
	return map[string]any{"entries": es}
}
func withVar(p map[string]any, variable int) map[string]any {
	p["colorVar"] = aliasData(variable)
	return p
}

// Ids of the variable fixture.
const (
	setTheme   = 10
	setDensity = 11
	modeLight  = 90
	modeDark   = 91
	modeComfy  = 92
	modeTight  = 93

	vSurface = 20 // color: white / black
	vBg      = 21 // alias of surface in both modes
	vRadius  = 22 // number 4 / 8
	vGap     = 23 // number (Density) 16 / 8
	vTitle   = 24 // string
	vShow    = 25 // boolean
	vMixed   = 26 // color: alias of surface in Light, a literal in Dark
	vAlpha   = 27 // number 1 / 0.5
	vCycA    = 28
	vCycB    = 29
	vText    = 30 // a resolved type the editor does not have
	vOrphan  = 31 // belongs to a collection that is not in the file
	vDeep    = 32 // alias of bg: a chain
)

func variablesFixture() map[string]any {
	return map[string]any{"nodeChanges": []any{
		map[string]any{"guid": guid(1, 0), "type": "DOCUMENT", "name": "Document"},
		change(1, 0, "a", "CANVAS", "Page 1", nil),
		change(2, 0, "~", "CANVAS", "Internal", map[string]any{"internalOnly": true}),
		change(setTheme, 2, "a", "VARIABLE_SET", "Theme", map[string]any{"variableSetModes": setModes(modeDark, "Dark", "b", modeLight, "Light", "a")}),
		change(setDensity, 2, "b", "VARIABLE_SET", "Density", map[string]any{"variableSetModes": setModes(modeComfy, "Comfortable", "a", modeTight, "Compact", "b")}),
		variable(vSurface, "a", "color/surface", setTheme, "COLOR", modeValues(modeLight, colorData(1, 1, 1), modeDark, colorData(0, 0, 0))),
		variable(vBg, "b", "sem/bg", setTheme, "COLOR", modeValues(modeLight, aliasData(vSurface), modeDark, aliasData(vSurface))),
		variable(vRadius, "c", "radius", setTheme, "FLOAT", modeValues(modeLight, floatData(4), modeDark, floatData(8))),
		variable(vGap, "d", "gap", setDensity, "FLOAT", modeValues(modeComfy, floatData(16), modeTight, floatData(8))),
		variable(vTitle, "e", "title", setTheme, "STRING", modeValues(modeLight, textData("Hello"), modeDark, textData("Hi"))),
		variable(vShow, "f", "show", setTheme, "BOOLEAN", modeValues(modeLight, boolData(true), modeDark, boolData(false))),
		variable(vMixed, "g", "mixed", setTheme, "COLOR", modeValues(modeLight, aliasData(vSurface), modeDark, colorData(1, 0, 0))),
		variable(vAlpha, "h", "alpha", setTheme, "FLOAT", modeValues(modeLight, floatData(1), modeDark, floatData(0.5))),
		variable(vCycA, "i", "cycle/a", setTheme, "COLOR", modeValues(modeLight, aliasData(vCycB), modeDark, aliasData(vCycB))),
		variable(vCycB, "j", "cycle/b", setTheme, "COLOR", modeValues(modeLight, aliasData(vCycA), modeDark, aliasData(vCycA))),
		variable(vText, "k", "rich", setTheme, "TEXT_DATA", modeValues()),
		change(vOrphan, 2, "l", "VARIABLE", "library", map[string]any{"variableSetID": vref(99), "variableResolvedType": "COLOR", "variableDataValues": modeValues(modeLight, colorData(0, 1, 0))}),
		variable(vDeep, "m", "sem/deep", setTheme, "COLOR", modeValues(modeLight, aliasData(vBg), modeDark, aliasData(vBg))),

		// A card: bound fill and stroke, weight, gap and padding, opacity, visibility; pinned to Dark / Compact.
		change(40, 1, "a", "FRAME", "Card", map[string]any{
			"size": map[string]any{"x": 300, "y": 200}, "transform": mat(0, 0),
			"fillPaints":   []any{withVar(solid(1, 1, 1), vBg)},
			"strokePaints": []any{withVar(solid(0, 0, 0), vSurface)}, "strokeWeight": 2,
			"stackMode": "VERTICAL", "stackSpacing": 16, "stackPaddingLeft": 16,
			"variableConsumptionMap": consumption(
				bound("STROKE_WEIGHT", vRadius), bound("STACK_SPACING", vGap), bound("STACK_PADDING_LEFT", vGap),
				bound("OPACITY", vAlpha), bound("VISIBLE", vShow),
			),
			"variableModeBySetMap": modePins(vref(setTheme), modeDark, vref(setDensity), modeTight, vref(77), modeDark),
		}),
		// A rectangle: a hidden paint comes first, so fill index 1 in the file is fill 0 here.
		change(41, 40, "a", "RECTANGLE", "Box", map[string]any{
			"size": map[string]any{"x": 50, "y": 50}, "transform": mat(0, 0),
			"fillPaints": []any{map[string]any{"type": "SOLID", "visible": false, "opacity": 1, "color": map[string]any{"r": 1, "g": 1, "b": 1, "a": 1}}, withVar(solid(1, 0, 0), vMixed)},
			"variableConsumptionMap": consumption(
				bound("CORNER_RADIUS", vRadius), bound("WIDTH", vGap), bound("OPACITY", vSurface), bound("STACK_SPACING", vGap),
			),
		}),
		change(42, 40, "b", "TEXT", "Label", map[string]any{
			"size": map[string]any{"x": 80, "y": 20}, "transform": mat(0, 0), "textData": map[string]any{"characters": "Hello"}, "fontSize": 14,
			"variableConsumptionMap": consumption(bound("TEXT_DATA", vTitle), bound("FONT_SIZE", vGap), bound("CORNER_RADIUS", vRadius)),
		}),
	}}
}

func importVariables(t *testing.T) *Result {
	t.Helper()
	res, err := Import(buildCanvas(t, variablesFixture(), deflateRaw), Options{})
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func collByName(res *Result, name string) *opendesignerv1.VariableCollection {
	for _, c := range res.Collections {
		if c.Name == name {
			return c
		}
	}
	return nil
}

func varByName(res *Result, name string) *opendesignerv1.Variable {
	for _, v := range res.Variables {
		if v.Name == name {
			return v
		}
	}
	return nil
}

func TestImportsCollectionsModesAndVariables(t *testing.T) {
	res := importVariables(t)
	theme, density := collByName(res, "Theme"), collByName(res, "Density")
	if theme == nil || density == nil || len(res.Collections) != 2 {
		t.Fatalf("collections = %v", res.Collections)
	}
	// Modes come in the order of their sort position, not the order they were written in.
	if len(theme.Modes) != 2 || theme.Modes[0].Name != "Light" || theme.Modes[1].Name != "Dark" {
		t.Fatalf("theme modes = %v", theme.Modes)
	}
	light, dark := theme.Modes[0].Id, theme.Modes[1].Id

	surface := varByName(res, "color/surface")
	if surface == nil || surface.CollectionId != theme.Id || surface.Type != opendesignerv1.VariableType_VARIABLE_TYPE_COLOR {
		t.Fatalf("surface = %v", surface)
	}
	if surface.Values[light].GetColor().GetR() != 1 || surface.Values[dark].GetColor().GetR() != 0 {
		t.Fatalf("surface values = %v", surface.Values)
	}
	if r := varByName(res, "radius"); r.Type != opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER || r.Values[dark].GetNumber() != 8 {
		t.Fatalf("radius = %v", r)
	}
	if v := varByName(res, "title"); v.Type != opendesignerv1.VariableType_VARIABLE_TYPE_STRING || v.Values[light].GetText() != "Hello" {
		t.Fatalf("title = %v", v)
	}
	if v := varByName(res, "show"); v.Type != opendesignerv1.VariableType_VARIABLE_TYPE_BOOLEAN || v.Values[dark].GetBoolean() {
		t.Fatalf("show = %v", v)
	}
	if v := varByName(res, "gap"); v.CollectionId != density.Id || v.Values[density.Modes[1].Id].GetNumber() != 8 {
		t.Fatalf("gap = %v", v)
	}
	if varByName(res, "rich") != nil || varByName(res, "library") != nil {
		t.Fatal("a variable of an unsupported type or of a collection outside the file must be left out")
	}
}

func TestAliasesStayAliasesWhenEveryModeAgrees(t *testing.T) {
	res := importVariables(t)
	surface, bg, deep := varByName(res, "color/surface"), varByName(res, "sem/bg"), varByName(res, "sem/deep")
	if bg.AliasOf != surface.Id || len(bg.Values) != 0 || deep.AliasOf != bg.Id {
		t.Fatalf("bg = %v deep = %v", bg, deep)
	}
	// Targets before aliases, so the editor can create them in this order.
	pos := map[string]int{}
	for i, v := range res.Variables {
		pos[v.Id] = i
	}
	if !(pos[surface.Id] < pos[bg.Id] && pos[bg.Id] < pos[deep.Id]) {
		t.Fatalf("order = %v", pos)
	}
	// An alias in one mode only has no home in the editor's model: it keeps the values it resolves to.
	mixed := varByName(res, "mixed")
	theme := collByName(res, "Theme")
	if mixed.AliasOf != "" || mixed.Values[theme.Modes[0].Id].GetColor().GetR() != 1 || mixed.Values[theme.Modes[1].Id].GetColor().GetG() != 0 || mixed.Values[theme.Modes[1].Id].GetColor().GetR() != 1 {
		t.Fatalf("mixed = %v", mixed)
	}
	// A cycle is broken, never imported as one: the document would refuse it.
	a, b := varByName(res, "cycle/a"), varByName(res, "cycle/b")
	if a.AliasOf != "" && b.AliasOf != "" {
		t.Fatalf("a cycle survived: %v %v", a, b)
	}
}

func TestBindingsAndModesLandOnTheLayers(t *testing.T) {
	res := importVariables(t)
	theme, density := collByName(res, "Theme"), collByName(res, "Density")
	id := func(name string) string { return varByName(res, name).Id }

	card := find(res, "Card")
	want := map[string]string{
		"fills.0": id("sem/bg"), "strokes.0": id("color/surface"), "strokes.0.weight": id("radius"),
		"spacing": id("gap"), "padding_left": id("gap"), "opacity": id("alpha"), "visible": id("show"),
	}
	for k, v := range want {
		if card.Bindings[k] != v {
			t.Errorf("card.bindings[%q] = %q, want %q", k, card.Bindings[k], v)
		}
	}
	if card.Modes[theme.Id] != theme.Modes[1].Id || card.Modes[density.Id] != density.Modes[1].Id || len(card.Modes) != 2 {
		t.Fatalf("card modes = %v", card.Modes)
	}

	// The hidden paint dropped out, so the bound paint is fills.0; the corner radius binds on a rectangle.
	box := find(res, "Box")
	if box.Bindings["fills.0"] != id("mixed") || box.Bindings["corner_radius"] != id("radius") || len(box.Bindings) != 2 {
		t.Fatalf("box bindings = %v", box.Bindings)
	}
	label := find(res, "Label")
	if label.Bindings["text"] != id("title") || label.Bindings["font_size"] != id("gap") || len(label.Bindings) != 2 {
		t.Fatalf("label bindings = %v", label.Bindings)
	}
	// What cannot bind keeps its literal and is reported: width, a color on opacity, spacing off an auto
	// layout, a corner radius on text.
	joined := strings.Join(res.Warnings, "\n")
	for _, want := range []string{"4 variable bindings were not imported", "corner radius x1", "stack spacing x1", "width x1", "opacity x1",
		"variables belong to collections that are not in the file", "variables of a type this editor has no counterpart for (text_data)",
		"alias other variables in only some modes", "variable modes of collections that aren't in the file were skipped"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing warning %q in %v", want, res.Warnings)
		}
	}
	if box.Opacity != 1 || card.Width != 300 {
		t.Fatalf("literals changed: %v %v", box.Opacity, card.Width)
	}
}

// The whole result is accepted by the document, in the order given, and resolves per mode.
func TestImportedVariablesApplyToADocument(t *testing.T) {
	res := importVariables(t)
	doc := core.NewDocument("d", "d")
	apply := func(op *opendesignerv1.Op) {
		t.Helper()
		if err := core.Apply(doc, op); err != nil {
			t.Fatalf("%v: %v", op, err)
		}
	}
	for _, c := range res.Collections {
		apply(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetCollection{SetCollection: &opendesignerv1.SetCollection{Collection: c}}})
	}
	for _, v := range res.Variables {
		apply(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetVariable{SetVariable: &opendesignerv1.SetVariable{Variable: v}}})
	}
	for i, n := range res.Nodes {
		if i == 0 {
			n.ParentId = "page1"
		}
		apply(&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}})
		if err := core.ValidateBindings(doc, n.Bindings); err != nil {
			t.Fatalf("%s: %v", n.Name, err)
		}
	}
	card := core.ResolveNode(doc, doc.Nodes[find(res, "Card").Id])
	// Dark: the alias sem/bg reads surface's dark value (black); the gap is the Compact 8; opacity .5; hidden.
	if got := card.GetFills()[0].GetSolid().GetColor(); got.R != 0 || got.G != 0 {
		t.Fatalf("card fill = %v", got)
	}
	if card.Visible || card.Opacity != 0.5 || card.GetFrame().GetAutoLayout().Spacing != 8 {
		t.Fatalf("card = visible %v opacity %v spacing %v", card.Visible, card.Opacity, card.GetFrame().GetAutoLayout().Spacing)
	}
	if card.GetStrokes()[0].Weight != 8 {
		t.Fatalf("stroke weight = %v", card.GetStrokes()[0].Weight)
	}
	// The Box is not pinned, but inherits Dark from the card; its corner radius is the dark 8.
	box := core.ResolveNode(doc, doc.Nodes[find(res, "Box").Id])
	if box.GetRect().CornerRadius != 8 {
		t.Fatalf("box radius = %v", box.GetRect().CornerRadius)
	}
	if lab := core.ResolveNode(doc, doc.Nodes[find(res, "Label").Id]); lab.GetText().Content != "Hi" {
		t.Fatalf("label = %q", lab.GetText().Content)
	}
}

// A collection or a variable can be named by the asset key and version the file writes for library items.
func TestReferencesByAssetKey(t *testing.T) {
	msg := map[string]any{"nodeChanges": []any{
		map[string]any{"guid": guid(1, 0), "type": "DOCUMENT", "name": "Document"},
		change(1, 0, "a", "CANVAS", "Page 1", nil),
		change(2, 0, "~", "CANVAS", "Internal", map[string]any{"internalOnly": true}),
		change(10, 2, "a", "VARIABLE_SET", "Lib", map[string]any{"variableSetModes": setModes(90, "Only", "a"), "key": "lib-key", "version": "3"}),
		change(20, 2, "b", "VARIABLE", "size", map[string]any{
			"variableSetID": assetRef("lib-key", "3"), "variableResolvedType": "FLOAT", "variableDataValues": modeValues(90, floatData(12)),
		}),
		change(21, 2, "c", "VARIABLE", "gone", map[string]any{
			"variableSetID": assetRef("lib-key", "9"), "variableResolvedType": "FLOAT", "variableDataValues": modeValues(90, floatData(1)),
		}),
		change(40, 1, "a", "RECTANGLE", "R", map[string]any{
			"size": map[string]any{"x": 10, "y": 10}, "transform": mat(0, 0),
			"variableModeBySetMap": modePins(assetRef("lib-key", ""), 90),
		}),
	}}
	res, err := Import(buildCanvas(t, msg, deflateRaw), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Collections) != 1 || len(res.Variables) != 1 || res.Variables[0].Name != "size" {
		t.Fatalf("collections %v variables %v", res.Collections, res.Variables)
	}
	r := find(res, "R")
	if r.Modes[res.Collections[0].Id] != res.Collections[0].Modes[0].Id {
		t.Fatalf("modes = %v", r.Modes)
	}
}

func TestAFileWithoutVariablesHasNone(t *testing.T) {
	res, err := Import(buildCanvas(t, fixture(), deflateRaw), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Collections) != 0 || len(res.Variables) != 0 || strings.Contains(strings.Join(res.Warnings, " "), "variable") {
		t.Fatalf("collections %v variables %v warnings %v", res.Collections, res.Variables, res.Warnings)
	}
	for _, n := range res.Nodes {
		if len(n.Bindings) != 0 || len(n.Modes) != 0 {
			t.Fatalf("%s has bindings %v modes %v", n.Name, n.Bindings, n.Modes)
		}
	}
}
