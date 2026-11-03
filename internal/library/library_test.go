package library

import (
	"errors"
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

var (
	hashFont  = strings.Repeat("ab", 32)
	hashImage = strings.Repeat("cd", 32)
)

const (
	kindComponent = opendesignerv1.LibraryItemKind_LIBRARY_ITEM_KIND_COMPONENT
	kindText      = opendesignerv1.LibraryItemKind_LIBRARY_ITEM_KIND_TEXT_STYLE
)

func apply(t *testing.T, doc *opendesignerv1.Document, kinds ...any) {
	t.Helper()
	for _, k := range kinds {
		var op *opendesignerv1.Op
		switch v := k.(type) {
		case *opendesignerv1.CreateNode:
			op = &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: v}}
		case *opendesignerv1.CreateComponent:
			op = &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateComponent{CreateComponent: v}}
		case *opendesignerv1.SetCollection:
			op = &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetCollection{SetCollection: v}}
		case *opendesignerv1.SetVariable:
			op = &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetVariable{SetVariable: v}}
		case *opendesignerv1.SetTextStyleDef:
			op = &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetTextStyleDef{SetTextStyleDef: v}}
		case *opendesignerv1.SetComponentSet:
			op = &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComponentSet{SetComponentSet: v}}
		case *opendesignerv1.SetComponentDef:
			op = &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComponentDef{SetComponentDef: v}}
		case *opendesignerv1.SetFont:
			op = &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetFont{SetFont: v}}
		default:
			t.Fatalf("unhandled %T", k)
		}
		if err := core.Apply(doc, op); err != nil {
			t.Fatalf("apply %T: %v", k, err)
		}
	}
}

func frame(id, parent, key string) *opendesignerv1.Node {
	return &opendesignerv1.Node{Id: id, ParentId: parent, OrderKey: key, Visible: true, Opacity: 1, Width: 100, Height: 40,
		Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}}
}

func text(id, parent, key, style string) *opendesignerv1.Node {
	return &opendesignerv1.Node{Id: id, ParentId: parent, OrderKey: key, Visible: true, Opacity: 1, Width: 50, Height: 10, TextStyleId: style,
		Shape: &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{Content: "Hi"}}}
}

// libraryDoc: Button (a master with a text in the "Body" style, a fill bound to a variable and an image
// fill), a Card whose master holds an instance of Button, and a two-variant set.
func libraryDoc(t *testing.T) *opendesignerv1.Document {
	doc := core.NewDocument("lib", "Kit")
	apply(t, doc,
		&opendesignerv1.SetCollection{Collection: &opendesignerv1.VariableCollection{Id: "col", Name: "Brand", Modes: []*opendesignerv1.VariableMode{{Id: "m", Name: "Default"}}}},
		&opendesignerv1.SetVariable{Variable: &opendesignerv1.Variable{Id: "primary", CollectionId: "col", Name: "color/primary", Type: opendesignerv1.VariableType_VARIABLE_TYPE_COLOR,
			Values: map[string]*opendesignerv1.VariableValue{"m": {Kind: &opendesignerv1.VariableValue_Color{Color: &opendesignerv1.Color{R: 1, A: 1}}}}}},
		&opendesignerv1.SetVariable{Variable: &opendesignerv1.Variable{Id: "accent", CollectionId: "col", Name: "color/accent", Type: opendesignerv1.VariableType_VARIABLE_TYPE_COLOR, AliasOf: "primary"}},
		&opendesignerv1.SetFont{Font: &opendesignerv1.FontFace{Id: "f1", Family: "Inter Kit", Weight: "400", Style: "normal", AssetHash: hashFont}},
		&opendesignerv1.SetTextStyleDef{TextStyle: &opendesignerv1.TextStyleDef{Id: "body", Name: "Text/Body", Style: &opendesignerv1.TextStyle{FontFamily: "Inter Kit", FontSize: 14}}},
		&opendesignerv1.SetTextStyleDef{TextStyle: &opendesignerv1.TextStyleDef{Id: "unused", Name: "Text/Unused", Style: &opendesignerv1.TextStyle{FontSize: 20}}},
	)
	btn := frame("btn", "page1", "a")
	btn.Bindings = map[string]string{"fill": "accent"}
	btn.Fills = []*opendesignerv1.Paint{{Kind: &opendesignerv1.Paint_Image{Image: &opendesignerv1.ImagePaint{AssetHash: hashImage}}}}
	card := frame("card", "page1", "b")
	inst := &opendesignerv1.Node{Id: "card-btn", ParentId: "card", OrderKey: "a", Visible: true, Opacity: 1, Width: 10, Height: 10,
		Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: "button"}}}
	apply(t, doc,
		&opendesignerv1.CreateNode{Node: btn}, &opendesignerv1.CreateNode{Node: text("btn-label", "btn", "a", "body")},
		&opendesignerv1.CreateComponent{ComponentId: "button", RootNodeId: "btn", Name: "Controls/Button"},
		&opendesignerv1.CreateNode{Node: card}, &opendesignerv1.CreateNode{Node: inst},
		&opendesignerv1.CreateComponent{ComponentId: "card", RootNodeId: "card", Name: "Card"},
		&opendesignerv1.CreateNode{Node: frame("v1", "page1", "c")}, &opendesignerv1.CreateNode{Node: frame("v2", "page1", "d")},
		&opendesignerv1.CreateComponent{ComponentId: "chip-on", RootNodeId: "v1", Name: "Chip on"},
		&opendesignerv1.CreateComponent{ComponentId: "chip-off", RootNodeId: "v2", Name: "Chip off"},
		&opendesignerv1.SetComponentSet{ComponentSet: &opendesignerv1.ComponentSet{Id: "chips", Name: "Chip", Axes: []*opendesignerv1.VariantAxis{{Name: "State", Options: []string{"on", "off"}}}}},
		&opendesignerv1.SetComponentDef{ComponentId: "chip-on", SetId: "chips", Variant: map[string]string{"State": "on"}},
		&opendesignerv1.SetComponentDef{ComponentId: "chip-off", SetId: "chips", Variant: map[string]string{"State": "off"}},
	)
	return doc
}

func ids(items []*opendesignerv1.LibraryItem) map[string]bool {
	m := map[string]bool{}
	for _, i := range items {
		m[i.Id] = true
	}
	return m
}

func applyPlan(t *testing.T, dst *opendesignerv1.Document, plan *Plan) {
	t.Helper()
	for _, op := range plan.Ops {
		if err := core.Apply(dst, op); err != nil {
			t.Fatal(err)
		}
	}
}

func TestItemsListsEverythingTheLibraryOffers(t *testing.T) {
	items := Items(libraryDoc(t))
	got := ids(items)
	for _, id := range []string{"button", "card", "chip-on", "chip-off", "body", "unused", "col"} {
		if !got[id] {
			t.Errorf("missing %s in %v", id, items)
		}
	}
	for _, i := range items {
		if i.Id == "button" && i.Group != "Controls" {
			t.Errorf("group of Controls/Button = %q", i.Group)
		}
	}
}

func TestImportComponentBringsItsDependencies(t *testing.T) {
	src, dst := libraryDoc(t), core.NewDocument("app", "App")
	plan, err := BuildImport(src, dst, "lib", []*opendesignerv1.LibraryItem{{Kind: kindComponent, Id: "card"}})
	if err != nil {
		t.Fatal(err)
	}
	applyPlan(t, dst, plan)
	for _, id := range []string{"card", "button"} { // the nested one comes along
		if dst.Components[id] == nil {
			t.Errorf("component %s not imported", id)
		}
	}
	if dst.TextStyles["body"] == nil || dst.TextStyles["unused"] != nil {
		t.Errorf("text styles = %v: want body only", dst.TextStyles)
	}
	if dst.Fonts["f1"] == nil || dst.Variables["accent"] == nil || dst.Variables["primary"] == nil || dst.Collections["col"] == nil {
		t.Errorf("font / variables not imported")
	}
	want := map[string]bool{hashFont: true, hashImage: true}
	for _, h := range plan.Assets {
		delete(want, h)
	}
	if len(want) != 0 {
		t.Errorf("assets %v not listed (got %v)", want, plan.Assets)
	}
	if plan.PageID == "" || dst.Nodes["btn"].GetParentId() != plan.PageID {
		t.Errorf("masters not on the library page: %q", dst.Nodes["btn"].GetParentId())
	}
	// Masters sit side by side, not on top of each other.
	if dst.Nodes["btn"].GetX() == dst.Nodes["card"].GetX() {
		t.Error("masters overlap")
	}
}

func TestImportSetBringsAllItsVariants(t *testing.T) {
	src, dst := libraryDoc(t), core.NewDocument("app", "App")
	plan, err := BuildImport(src, dst, "lib", []*opendesignerv1.LibraryItem{{Kind: kindComponent, Id: "chip-on"}})
	if err != nil {
		t.Fatal(err)
	}
	applyPlan(t, dst, plan)
	if dst.Components["chip-off"] == nil || dst.ComponentSets["chips"] == nil || dst.Components["chip-off"].GetSetId() != "chips" {
		t.Errorf("set not complete: %v %v", dst.Components, dst.ComponentSets)
	}
}

func TestReimportSkipsExistingComponentsAndKeepsEdits(t *testing.T) {
	src, dst := libraryDoc(t), core.NewDocument("app", "App")
	want := []*opendesignerv1.LibraryItem{{Kind: kindComponent, Id: "button"}}
	plan, err := BuildImport(src, dst, "lib", want)
	if err != nil {
		t.Fatal(err)
	}
	applyPlan(t, dst, plan)
	// The importer edits the master, the library changes a style, then it is imported again.
	dst.Nodes["btn"].Name = "edited"
	src.TextStyles["body"].Style.FontSize = 18
	plan, err = BuildImport(src, dst, "lib", append(want, &opendesignerv1.LibraryItem{Kind: kindText, Id: "body"}))
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Skipped) != 1 || plan.Skipped[0].Id != "button" || plan.PageID != "" {
		t.Errorf("skipped = %v page = %q", plan.Skipped, plan.PageID)
	}
	applyPlan(t, dst, plan)
	if dst.Nodes["btn"].GetName() != "edited" {
		t.Error("an existing component was overwritten")
	}
	if dst.TextStyles["body"].GetStyle().GetFontSize() != 18 {
		t.Error("the style was not updated in place")
	}
}

func TestImportRemapsNodeIdsThatAreTaken(t *testing.T) {
	src, dst := libraryDoc(t), core.NewDocument("app", "App")
	apply(t, dst, &opendesignerv1.CreateNode{Node: frame("btn", "page1", "a")})
	plan, err := BuildImport(src, dst, "lib", []*opendesignerv1.LibraryItem{{Kind: kindComponent, Id: "button"}})
	if err != nil {
		t.Fatal(err)
	}
	applyPlan(t, dst, plan)
	root := dst.Components["button"].GetRootNodeId()
	if root == "btn" || dst.Nodes[root] == nil || len(core.ChildrenOf(dst, root)) != 1 {
		t.Errorf("remap failed: root %q", root)
	}
}

func TestImportErrors(t *testing.T) {
	src, dst := libraryDoc(t), core.NewDocument("app", "App")
	if _, err := BuildImport(src, dst, "lib", nil); !errors.Is(err, ErrNoItems) {
		t.Errorf("no items: %v", err)
	}
	_, err := BuildImport(src, dst, "lib", []*opendesignerv1.LibraryItem{{Kind: kindComponent, Id: "ghost"}})
	if !errors.Is(err, ErrItemNotFound) {
		t.Errorf("ghost: %v", err)
	}
}
