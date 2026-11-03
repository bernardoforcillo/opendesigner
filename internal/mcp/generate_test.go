package mcp_test

import (
	"context"
	"strings"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// kitSession builds a document with a "Button" component (a text property "Label"), the color variables
// "color/primary" and "color/surface" and a "Heading" text style.
func kitSession(t *testing.T) (*odmcp.Session, string) {
	t.Helper()
	url := serveInMemory(t)
	docID := newDoc(t, odmcp.NewClient(url))
	s := startSession(t, url, docID, "agent")
	ctx := context.Background()

	col, err := s.CreateCollection(ctx, odmcp.CreateCollectionInput{Name: "Theme"})
	if err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string]odmcp.ColorIO{"color/primary": {R: 1, G: 0, B: 0, A: 1}, "color/surface": {R: 1, G: 1, B: 1, A: 1}} {
		c := c
		if _, err := s.SetVariable(ctx, odmcp.SetVariableInput{CollectionId: col.CollectionId, Name: name, Type: "color", Values: map[string]odmcp.ValueIO{"Default": {Color: &c}}}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.SetTextStyle(ctx, odmcp.SetTextStyleInput{TextStyleBody: odmcp.TextStyleBody{Name: "Heading", FontSize: 28, FontWeight: "700"}}); err != nil {
		t.Fatal(err)
	}
	root := frame(t, s, "Button master")
	label, err := s.CreateText(ctx, odmcp.CreateTextInput{ParentId: root, Content: "Button", Width: 80, Height: 20})
	if err != nil {
		t.Fatal(err)
	}
	comp, err := s.CreateComponent(ctx, odmcp.CreateComponentInput{RootNodeId: root, Name: "Button"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetComponentDef(ctx, odmcp.SetComponentDefInput{ComponentId: comp.ComponentId, Properties: []odmcp.ComponentPropertyIO{{Name: "Label", Type: "text", DefaultValue: "Button", TargetNodeIds: []string{label.NodeId}}}}); err != nil {
		t.Fatal(err)
	}
	return s, comp.ComponentId
}

func TestDesignKitListsWhatTheDocumentHas(t *testing.T) {
	s, comp := kitSession(t)
	kit, err := s.GetDesignKit(context.Background(), struct{}{})
	if err != nil {
		t.Fatal(err)
	}
	if len(kit.Components) != 1 || kit.Components[0].Id != comp || kit.Components[0].Properties[0].Name != "Label" {
		t.Errorf("components = %+v", kit.Components)
	}
	if len(kit.ColorVariables) != 2 || kit.ColorVariables[0].Name != "color/primary" || kit.ColorVariables[0].Color != "#ff0000" {
		t.Errorf("colorVariables = %+v", kit.ColorVariables)
	}
	if len(kit.TextStyles) != 1 || kit.TextStyles[0].Name != "Heading" || kit.TextStyles[0].FontSize != 28 {
		t.Errorf("textStyles = %+v", kit.TextStyles)
	}
}

func TestGenerateScreenUsesOnlyTheKit(t *testing.T) {
	s, _ := kitSession(t)
	ctx := context.Background()
	out, err := s.GenerateScreen(ctx, odmcp.GenerateScreenInput{
		Name: "Sign in", Width: 393, Fill: "color/surface",
		AutoLayout: &odmcp.AutoLayoutSpec{Direction: "vertical", Spacing: 16, PaddingLeft: 24, PaddingRight: 24, PaddingTop: 24, PaddingBottom: 24},
		Nodes: []odmcp.GenNode{
			{Ref: "card", Kind: "frame", Name: "Card", Fill: "color/primary", AutoLayout: &odmcp.AutoLayoutSpec{Direction: "vertical", Spacing: 8}},
			{Parent: "card", Kind: "text", Name: "Title", Content: "Welcome back", TextStyle: "Heading", Color: "color/surface"},
			{Ref: "cta", Parent: "card", Kind: "instance", Name: "CTA", Component: "Button", Properties: map[string]string{"Label": "Sign in"}},
		},
	})
	if err != nil {
		t.Fatalf("GenerateScreen: %v", err)
	}
	if out.Created != 4 || out.Refs["card"] == "" || out.Refs["cta"] == "" {
		t.Fatalf("out = %+v", out)
	}
	byName := map[string]odmcp.NodeView{}
	nodes, _ := s.ListNodes(ctx, odmcp.ListNodesInput{})
	for _, n := range nodes.Nodes {
		byName[n.Name] = n
	}
	screen := byName["Sign in"]
	if screen.Id != out.ScreenId || screen.Width != 393 || screen.Bindings["fills.0"] == "" {
		t.Errorf("the screen must exist with its background bound to a variable: %+v", screen)
	}
	if card := byName["Card"]; card.ParentId != out.ScreenId || card.Bindings["fills.0"] == "" || card.Width != 393-48 {
		t.Errorf("card = %+v (a frame defaults to its parent's inner width)", card)
	}
	title := byName["Title"]
	if title.TextStyleId == "" || title.Bindings["fills.0"] == "" || title.ParentId != out.Refs["card"] || title.Text != "Welcome back" {
		t.Errorf("title = %+v", title)
	}
	if cta := byName["CTA"]; cta.Kind != "instance" || cta.ParentId != out.Refs["card"] {
		t.Errorf("cta = %+v", cta)
	}
}

func TestGenerateScreenRefusesInventedValuesAndCreatesNothing(t *testing.T) {
	s, _ := kitSession(t)
	ctx := context.Background()
	before, _ := s.ListNodes(ctx, odmcp.ListNodesInput{})
	_, err := s.GenerateScreen(ctx, odmcp.GenerateScreenInput{
		Name: "Bad", Width: 300, Fill: "color/neon",
		Nodes: []odmcp.GenNode{
			{Kind: "text", Content: "x", TextStyle: "Giant", Color: "color/primary"},
			{Kind: "instance", Component: "Carousel"},
			{Kind: "instance", Component: "Button", Properties: map[string]string{"Nope": "1"}},
			{Parent: "ghost", Kind: "rectangle"},
			{Kind: "hexagon"},
		},
	})
	if err == nil {
		t.Fatal("a screen with names the document does not have must be refused")
	}
	for _, want := range []string{"color/neon", `"color/primary"`, "Giant", `"Heading"`, "Carousel", `"Button"`, "Nope", "ghost", "hexagon", "nothing was created"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error should mention %s: %v", want, err)
		}
	}
	after, _ := s.ListNodes(ctx, odmcp.ListNodesInput{})
	if len(after.Nodes) != len(before.Nodes) {
		t.Errorf("nothing may be created: %d -> %d nodes", len(before.Nodes), len(after.Nodes))
	}
	if _, err := s.GenerateScreen(ctx, odmcp.GenerateScreenInput{Name: "Empty", Width: 100}); err == nil {
		t.Error("a screen with no parts must be refused")
	}
}
