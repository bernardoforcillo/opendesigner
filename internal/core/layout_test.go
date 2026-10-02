package core

import (
	"errors"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

type al = opendesignerv1.AutoLayout

const (
	vert      = opendesignerv1.LayoutDirection_LAYOUT_DIRECTION_VERTICAL
	horiz     = opendesignerv1.LayoutDirection_LAYOUT_DIRECTION_HORIZONTAL
	alStart   = opendesignerv1.LayoutAlign_LAYOUT_ALIGN_START
	alCenter  = opendesignerv1.LayoutAlign_LAYOUT_ALIGN_CENTER
	alEnd     = opendesignerv1.LayoutAlign_LAYOUT_ALIGN_END
	alBetween = opendesignerv1.LayoutAlign_LAYOUT_ALIGN_SPACE_BETWEEN
)

func createNode(t *testing.T, doc *opendesignerv1.Document, n *opendesignerv1.Node) {
	t.Helper()
	if err := Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}}); err != nil {
		t.Fatalf("create %s: %v", n.Id, err)
	}
}

func layoutFrameNode(id, parent, key string, w, h float64, layout *al) *opendesignerv1.Node {
	return &opendesignerv1.Node{
		Id: id, ParentId: parent, OrderKey: key, Visible: true, Opacity: 1, Width: w, Height: h,
		Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{AutoLayout: layout}},
	}
}

func layoutBox(id, parent, key string, w, h float64) *opendesignerv1.Node {
	return &opendesignerv1.Node{
		Id: id, ParentId: parent, OrderKey: key, Visible: true, Opacity: 1, Width: w, Height: h,
		// Posizione di partenza di proposito sbagliata: è il layout a decidere.
		X: 999, Y: 999,
		Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}},
	}
}

func setProps(t *testing.T, doc *opendesignerv1.Document, id string, patch *opendesignerv1.Node, paths ...string) error {
	t.Helper()
	return Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: id, Patch: patch, Mask: &fieldmaskpb.FieldMask{Paths: paths},
	}}})
}

func posOf(doc *opendesignerv1.Document, id string) [2]float64 {
	n := doc.Nodes[id]
	return [2]float64{n.X, n.Y}
}

func sizeOf(doc *opendesignerv1.Document, id string) [2]float64 {
	n := doc.Nodes[id]
	return [2]float64{n.Width, n.Height}
}

// Tre rettangoli 20x10 in un frame 200x100, padding 5/7, spacing 10.
func row(t *testing.T, layout *al) *opendesignerv1.Document {
	t.Helper()
	doc := NewDocument("d", "t")
	layout.PaddingLeft, layout.PaddingTop, layout.PaddingRight, layout.PaddingBottom = 5, 7, 5, 7
	layout.Spacing = 10
	createNode(t, doc, layoutFrameNode("f", "page1", "a0", 200, 100, layout))
	for i, id := range []string{"a", "b", "c"} {
		createNode(t, doc, layoutBox(id, "f", string(rune('a'+i)), 20, 10))
	}
	return doc
}

func TestLayoutHorizontalStart(t *testing.T) {
	doc := row(t, &al{Direction: horiz})
	for id, want := range map[string][2]float64{"a": {5, 7}, "b": {35, 7}, "c": {65, 7}} {
		if got := posOf(doc, id); got != want {
			t.Errorf("%s at %v, want %v", id, got, want)
		}
	}
	if got := sizeOf(doc, "f"); got != [2]float64{200, 100} {
		t.Errorf("a non-hug frame changed size to %v", got)
	}
}

func TestLayoutMainAlign(t *testing.T) {
	// inner = 190, sum 60 + gaps 20 = 80, free = 110.
	for name, c := range map[string]struct {
		a    opendesignerv1.LayoutAlign
		want [3]float64
	}{
		"center":  {alCenter, [3]float64{60, 90, 120}},
		"end":     {alEnd, [3]float64{115, 145, 175}},
		"between": {alBetween, [3]float64{5, 90, 175}}, // passo = 20 + 10 + 110/2 = 85 fra le origini
	} {
		doc := row(t, &al{Direction: horiz, MainAlign: c.a})
		got := [3]float64{doc.Nodes["a"].X, doc.Nodes["b"].X, doc.Nodes["c"].X}
		if got != c.want {
			t.Errorf("%s: x = %v, want %v", name, got, c.want)
		}
	}
}

func TestLayoutSpaceBetweenNeverShrinksBelowSpacingAndSingleChildStaysAtStart(t *testing.T) {
	doc := NewDocument("d", "t")
	createNode(t, doc, layoutFrameNode("f", "page1", "a0", 30, 100, &al{Direction: horiz, Spacing: 10, MainAlign: alBetween}))
	for i, id := range []string{"a", "b", "c"} {
		createNode(t, doc, layoutBox(id, "f", string(rune('a'+i)), 20, 10)) // 60 + 20 > 30: no free space
	}
	if a, b := doc.Nodes["a"].X, doc.Nodes["b"].X; b-a != 30 {
		t.Errorf("gap shrank: a=%v b=%v, want a 30-wide step (20 + spacing 10)", a, b)
	}
	doc2 := NewDocument("d", "t")
	createNode(t, doc2, layoutFrameNode("f", "page1", "a0", 200, 100, &al{Direction: horiz, MainAlign: alBetween}))
	createNode(t, doc2, layoutBox("a", "f", "a", 20, 10))
	if doc2.Nodes["a"].X != 0 {
		t.Errorf("single child at %v, want the start", doc2.Nodes["a"].X)
	}
}

func TestLayoutCrossAlign(t *testing.T) {
	// inner cross = 100 - 14 = 86; child 10 tall.
	for name, c := range map[string]struct {
		a    opendesignerv1.LayoutAlign
		want float64
	}{"start": {alStart, 7}, "center": {alCenter, 7 + 38}, "end": {alEnd, 7 + 76}, "between-is-start": {alBetween, 7}} {
		doc := row(t, &al{Direction: horiz, CrossAlign: c.a})
		if got := doc.Nodes["a"].Y; got != c.want {
			t.Errorf("%s: y = %v, want %v", name, got, c.want)
		}
	}
}

func TestLayoutVertical(t *testing.T) {
	doc := row(t, &al{Direction: vert})
	for id, want := range map[string][2]float64{"a": {5, 7}, "b": {5, 27}, "c": {5, 47}} {
		if got := posOf(doc, id); got != want {
			t.Errorf("%s at %v, want %v", id, got, want)
		}
	}
	// L'allineamento trasversale è orizzontale: inner = 200 - 10 = 190; figlio 20.
	doc = row(t, &al{Direction: vert, CrossAlign: alEnd})
	if got := doc.Nodes["a"].X; got != 5+170 {
		t.Errorf("cross end x = %v, want 175", got)
	}
}

func TestLayoutHug(t *testing.T) {
	doc := row(t, &al{Direction: horiz, HugWidth: true, HugHeight: true})
	// larghezza: 5 + (60 + 20) + 5 = 90; altezza: 7 + 10 + 7 = 24.
	if got := sizeOf(doc, "f"); got != [2]float64{90, 24} {
		t.Errorf("hug size = %v, want 90x24", got)
	}
	// Solo larghezza: l'altezza resta quella scritta.
	doc = row(t, &al{Direction: horiz, HugWidth: true})
	if got := sizeOf(doc, "f"); got != [2]float64{90, 100} {
		t.Errorf("hug-width size = %v, want 90x100", got)
	}
	// Hug indipendente dalla direzione: verticale, hug sulla larghezza.
	doc = row(t, &al{Direction: vert, HugWidth: true})
	if got := sizeOf(doc, "f"); got != [2]float64{30, 100} {
		t.Errorf("vertical hug-width size = %v, want 30x100", got)
	}
}

func TestLayoutRerunsOnEveryChange(t *testing.T) {
	doc := row(t, &al{Direction: horiz})
	// Un figlio che cresce sposta i successivi.
	if err := setProps(t, doc, "a", &opendesignerv1.Node{Width: 50}, "width"); err != nil {
		t.Fatal(err)
	}
	if got := posOf(doc, "b"); got != [2]float64{65, 7} {
		t.Errorf("after a grew, b at %v, want x=65", got)
	}
	// Un figlio spostato a mano torna al suo posto: il layout comanda.
	if err := setProps(t, doc, "b", &opendesignerv1.Node{X: 500, Y: 500}, "x", "y"); err != nil {
		t.Fatal(err)
	}
	if got := posOf(doc, "b"); got != [2]float64{65, 7} {
		t.Errorf("a hand-moved child stayed at %v", got)
	}
	// Nascosto: esce dalla fila.
	if err := setProps(t, doc, "b", &opendesignerv1.Node{Visible: false}, "visible"); err != nil {
		t.Fatal(err)
	}
	if got := posOf(doc, "c"); got != [2]float64{5 + 50 + 10, 7} {
		t.Errorf("after hiding b, c at %v, want it right after a", got)
	}
	// Cancellato: idem.
	if err := Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteNode{DeleteNode: &opendesignerv1.DeleteNode{Id: "a"}}}); err != nil {
		t.Fatal(err)
	}
	if got := posOf(doc, "c"); got != [2]float64{5, 7} {
		t.Errorf("after deleting a, c at %v, want the start", got)
	}
	// Nuovo figlio: si accoda.
	createNode(t, doc, layoutBox("d", "f", "z", 20, 10))
	if got := posOf(doc, "d"); got != [2]float64{35, 7} {
		t.Errorf("new child at %v, want x=35", got)
	}
}

func TestLayoutReparentRelaysBothFrames(t *testing.T) {
	doc := NewDocument("d", "t")
	createNode(t, doc, layoutFrameNode("f1", "page1", "a0", 200, 50, &al{Direction: horiz, Spacing: 10}))
	createNode(t, doc, layoutFrameNode("f2", "page1", "a1", 200, 50, &al{Direction: horiz, Spacing: 10}))
	createNode(t, doc, layoutBox("a", "f1", "a", 20, 10))
	createNode(t, doc, layoutBox("b", "f1", "b", 20, 10))
	createNode(t, doc, layoutBox("c", "f2", "a", 20, 10))
	err := Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_ReparentNode{ReparentNode: &opendesignerv1.ReparentNode{
		Id: "a", NewParentId: "f2", OrderKey: "b",
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if got := posOf(doc, "b"); got != [2]float64{0, 0} {
		t.Errorf("b in the old frame at %v, want it closed up to the start", got)
	}
	if got := posOf(doc, "a"); got != [2]float64{30, 0} {
		t.Errorf("a in the new frame at %v, want it after c", got)
	}
}

func TestLayoutNestedHugPropagates(t *testing.T) {
	doc := NewDocument("d", "t")
	createNode(t, doc, layoutFrameNode("outer", "page1", "a0", 500, 500, &al{Direction: horiz, Spacing: 10, HugWidth: true, HugHeight: true}))
	createNode(t, doc, layoutFrameNode("inner", "outer", "a", 1, 1, &al{Direction: vert, HugWidth: true, HugHeight: true}))
	createNode(t, doc, layoutBox("x", "outer", "b", 40, 40))
	createNode(t, doc, layoutBox("p", "inner", "a", 20, 10))
	createNode(t, doc, layoutBox("q", "inner", "b", 30, 10))
	if got := sizeOf(doc, "inner"); got != [2]float64{30, 20} {
		t.Fatalf("inner = %v, want 30x20", got)
	}
	// outer: 30 + 10 + 40 = 80 di larghezza, max(20, 40) = 40 di altezza.
	if got := sizeOf(doc, "outer"); got != [2]float64{80, 40} {
		t.Fatalf("outer = %v, want 80x40", got)
	}
	if got := posOf(doc, "x"); got != [2]float64{40, 0} {
		t.Errorf("x at %v, want it after the inner frame", got)
	}
	// Un figlio dell'interno cresce: la misura risale fino a outer.
	if err := setProps(t, doc, "q", &opendesignerv1.Node{Width: 100}, "width"); err != nil {
		t.Fatal(err)
	}
	if got := sizeOf(doc, "outer"); got != [2]float64{150, 40} {
		t.Errorf("after q grew, outer = %v, want 150x40", got)
	}
}

func TestLayoutIgnoresGroupsAndInstances(t *testing.T) {
	doc := NewDocument("d", "t")
	createNode(t, doc, layoutFrameNode("f", "page1", "a0", 200, 50, &al{Direction: horiz, Spacing: 10}))
	g := &opendesignerv1.Node{
		Id: "g", ParentId: "f", OrderKey: "a", Visible: true, Opacity: 1, X: 77, Y: 88,
		Shape: &opendesignerv1.Node_Group{Group: &opendesignerv1.GroupNode{}},
	}
	createNode(t, doc, g)
	createNode(t, doc, layoutBox("a", "f", "b", 20, 10))
	if got := posOf(doc, "g"); got != [2]float64{77, 88} {
		t.Errorf("a group was moved to %v; it has no box of its own to lay out", got)
	}
	if got := posOf(doc, "a"); got != [2]float64{0, 0} {
		t.Errorf("a at %v, want the start (the group takes no space)", got)
	}
}

func TestSetAutoLayoutOnFrameLaysOutImmediatelyAndClearingKeepsPositions(t *testing.T) {
	doc := NewDocument("d", "t")
	createNode(t, doc, layoutFrameNode("f", "page1", "a0", 200, 100, nil))
	createNode(t, doc, layoutBox("a", "f", "a", 20, 10))
	createNode(t, doc, layoutBox("b", "f", "b", 20, 10))
	if got := posOf(doc, "a"); got != [2]float64{999, 999} {
		t.Fatalf("without auto layout a child must stay where it is, got %v", got)
	}
	on := &opendesignerv1.Node{Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{AutoLayout: &al{Direction: vert, Spacing: 4}}}}
	if err := setProps(t, doc, "f", on, "auto_layout"); err != nil {
		t.Fatal(err)
	}
	if got := posOf(doc, "b"); got != [2]float64{0, 14} {
		t.Errorf("b at %v after turning layout on, want y=14", got)
	}
	off := &opendesignerv1.Node{}
	if err := setProps(t, doc, "f", off, "auto_layout"); err != nil {
		t.Fatal(err)
	}
	if doc.Nodes["f"].GetFrame().GetAutoLayout() != nil {
		t.Error("an empty patch must turn auto layout off")
	}
	if got := posOf(doc, "b"); got != [2]float64{0, 14} {
		t.Errorf("turning layout off moved b to %v; it keeps the last computed position", got)
	}
}

func TestAutoLayoutMaskIsFrameOnlyAndWholeOpRejected(t *testing.T) {
	doc := NewDocument("d", "t")
	createNode(t, doc, layoutBox("r", "page1", "a0", 20, 10))
	patch := &opendesignerv1.Node{X: 1, Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{AutoLayout: &al{}}}}
	err := setProps(t, doc, "r", patch, "x", "auto_layout")
	if !errors.Is(err, ErrNotFrameNode) {
		t.Fatalf("err = %v, want ErrNotFrameNode", err)
	}
	if doc.Nodes["r"].X != 999 {
		t.Errorf("a rejected mixed mask still moved x to %v", doc.Nodes["r"].X)
	}
}

func TestLayoutIsIdempotent(t *testing.T) {
	doc := row(t, &al{Direction: horiz, MainAlign: alCenter, CrossAlign: alEnd, HugHeight: true})
	before := map[string][2]float64{"a": posOf(doc, "a"), "b": posOf(doc, "b"), "c": posOf(doc, "c"), "f": sizeOf(doc, "f")}
	relayout(doc, []string{"f"}, nil)
	relayout(doc, []string{"f"}, nil)
	for id, want := range before {
		got := posOf(doc, id)
		if id == "f" {
			got = sizeOf(doc, id)
		}
		if got != want {
			t.Errorf("%s changed on a second pass: %v -> %v", id, want, got)
		}
	}
}
