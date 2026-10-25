package core

import (
	"errors"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// GRID mode and groups as auto layout children. The TS twin is web/src/store/layoutGrid.test.ts and
// testdata/golden/layout_grid.json / layout_group.json run both on the same numbers.

func fixedT(s float64) *opendesignerv1.GridTrack {
	return &opendesignerv1.GridTrack{Kind: opendesignerv1.GridTrackKind_GRID_TRACK_KIND_FIXED, Size: s}
}
func frT(w float64) *opendesignerv1.GridTrack {
	return &opendesignerv1.GridTrack{Kind: opendesignerv1.GridTrackKind_GRID_TRACK_KIND_FR, Size: w}
}
func hugT() *opendesignerv1.GridTrack {
	return &opendesignerv1.GridTrack{Kind: opendesignerv1.GridTrackKind_GRID_TRACK_KIND_HUG}
}

func gridDoc(t *testing.T, w, h float64, layout *al) *opendesignerv1.Document {
	layout.Mode = opendesignerv1.LayoutMode_LAYOUT_MODE_GRID
	t.Helper()
	doc := NewDocument("d", "t")
	createNode(t, doc, layoutFrameNode("f", "page1", "a0", w, h, layout))
	return doc
}

func cellNode(id string, w, h float64, cell *opendesignerv1.GridPlacement) *opendesignerv1.Node {
	n := layoutBox(id, "f", id, w, h)
	n.GridCell = cell
	return n
}

func TestGridFixedAndFrTracksFlowRowByRow(t *testing.T) {
	doc := gridDoc(t, 250, 100, &al{
		Columns: []*opendesignerv1.GridTrack{fixedT(50), frT(1), frT(3)}, Rows: []*opendesignerv1.GridTrack{fixedT(30)},
		ColumnGap: 10, RowGap: 5,
	})
	for _, id := range []string{"a", "b", "c", "d"} {
		createNode(t, doc, cellNode(id, 20, 10, nil))
	}
	// fr share: 250 - 50 - 20 = 180 -> 45 and 135.
	for id, want := range map[string][2]float64{"a": {0, 0}, "b": {60, 0}, "c": {115, 0}, "d": {0, 35}} {
		if got := posOf(doc, id); got != want {
			t.Errorf("%s at %v, want %v", id, got, want)
		}
	}
}

func TestGridExplicitCellsSpansFillAndAlignment(t *testing.T) {
	doc := gridDoc(t, 200, 100, &al{
		Columns: []*opendesignerv1.GridTrack{fixedT(40), fixedT(60)}, Rows: []*opendesignerv1.GridTrack{fixedT(20), fixedT(20)},
		MainAlign: alEnd, CrossAlign: alCenter,
	})
	createNode(t, doc, cellNode("a", 10, 10, &opendesignerv1.GridPlacement{Column: 2, Row: 2}))
	b := cellNode("b", 10, 10, &opendesignerv1.GridPlacement{Column: 1, Row: 1, ColumnSpan: 2})
	b.LayoutSizingX, b.LayoutSizingY = opendesignerv1.LayoutSizing_LAYOUT_SIZING_FILL, opendesignerv1.LayoutSizing_LAYOUT_SIZING_FILL
	createNode(t, doc, b)
	if got := posOf(doc, "a"); got != [2]float64{90, 25} {
		t.Errorf("a at %v, want end of column 2 and the middle of row 2", got)
	}
	if got, pos := sizeOf(doc, "b"), posOf(doc, "b"); got != [2]float64{100, 20} || pos != [2]float64{0, 0} {
		t.Errorf("b is %v at %v, want the 100x20 area of its two columns", got, pos)
	}
}

func TestGridAutoPlacementSkipsTakenCells(t *testing.T) {
	doc := gridDoc(t, 100, 100, &al{Columns: []*opendesignerv1.GridTrack{fixedT(50), fixedT(50)}, Rows: []*opendesignerv1.GridTrack{fixedT(10), fixedT(10)}})
	createNode(t, doc, cellNode("a", 5, 5, nil))
	createNode(t, doc, cellNode("b", 5, 5, &opendesignerv1.GridPlacement{Column: 2, Row: 1}))
	createNode(t, doc, cellNode("c", 5, 5, nil))
	if got := posOf(doc, "c"); got != [2]float64{0, 10} {
		t.Errorf("c at %v, want the first row's free cell to be skipped: {0 10}", got)
	}
}

func TestGridHugFrameAndHugTracks(t *testing.T) {
	doc := gridDoc(t, 10, 10, &al{
		Columns: []*opendesignerv1.GridTrack{hugT(), frT(1)}, Rows: []*opendesignerv1.GridTrack{hugT()}, ColumnGap: 4,
		HugWidth: true, HugHeight: true, PaddingLeft: 3, PaddingTop: 3, PaddingRight: 3, PaddingBottom: 3,
	})
	createNode(t, doc, cellNode("a", 30, 12, nil))
	createNode(t, doc, cellNode("b", 20, 18, nil))
	if got := sizeOf(doc, "f"); got != [2]float64{3 + 30 + 4 + 20 + 3, 3 + 18 + 3} {
		t.Errorf("f is %v, want fr to hug too: {60 24}", got)
	}
}

func TestGridRejectsBadDefinitions(t *testing.T) {
	doc := gridDoc(t, 100, 100, &al{})
	createNode(t, doc, cellNode("a", 5, 5, nil))
	for name, layout := range map[string]*al{
		"unknown kind":  {Mode: opendesignerv1.LayoutMode_LAYOUT_MODE_GRID, Columns: []*opendesignerv1.GridTrack{{Kind: 9}}},
		"negative size": {Columns: []*opendesignerv1.GridTrack{fixedT(-1)}},
		"negative gap":  {RowGap: -1},
		"unknown mode":  {Mode: 7},
	} {
		err := setProps(t, doc, "f", &opendesignerv1.Node{Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{AutoLayout: layout}}}, "auto_layout")
		if !errors.Is(err, ErrGridLayout) {
			t.Errorf("%s: err = %v, want ErrGridLayout", name, err)
		}
	}
	if err := setProps(t, doc, "a", &opendesignerv1.Node{GridCell: &opendesignerv1.GridPlacement{Column: 1001}}, "grid_cell"); !errors.Is(err, ErrGridLayout) {
		t.Errorf("cell out of range: err = %v", err)
	}
	if err := setProps(t, doc, "a", &opendesignerv1.Node{GridCell: &opendesignerv1.GridPlacement{Row: -1}}, "grid_cell"); !errors.Is(err, ErrGridLayout) {
		t.Errorf("negative cell: err = %v", err)
	}
}

func layoutGroup(id, parent, key string) *opendesignerv1.Node {
	return &opendesignerv1.Node{Id: id, ParentId: parent, OrderKey: key, Visible: true, Opacity: 1, Shape: &opendesignerv1.Node_Group{Group: &opendesignerv1.GroupNode{}}}
}

func boxAt(id, parent, key string, x, y, w, h float64) *opendesignerv1.Node {
	n := layoutBox(id, parent, key, w, h)
	n.X, n.Y = x, y
	return n
}

func TestGroupIsOneBoxInARow(t *testing.T) {
	doc := NewDocument("d", "t")
	createNode(t, doc, layoutFrameNode("f", "page1", "a0", 300, 60, &al{Direction: horiz, Spacing: 10}))
	createNode(t, doc, boxAt("a", "f", "a", 0, 0, 20, 10))
	createNode(t, doc, layoutGroup("g", "f", "b"))
	createNode(t, doc, boxAt("g1", "g", "a", 5, 7, 30, 10))
	createNode(t, doc, boxAt("g2", "g", "b", 50, 30, 20, 10))
	createNode(t, doc, boxAt("c", "f", "c", 0, 0, 20, 10))
	// The union is x 5..70, y 7..40: 65 x 33, it starts at 30, so the group is translated by 25 and -7.
	if got, pos := sizeOf(doc, "g"), posOf(doc, "g"); got != [2]float64{65, 33} || pos != [2]float64{25, -7} {
		t.Errorf("g is %v at %v, want 65x33 at {25 -7}", got, pos)
	}
	if got := posOf(doc, "c"); got[0] != 105 {
		t.Errorf("c at %v, want x=105", got)
	}
	if got := posOf(doc, "g1"); got != [2]float64{5, 7} {
		t.Errorf("g1 moved inside its group: %v", got)
	}

	// Growing, hiding and removing a child of the group move what follows it.
	if err := setProps(t, doc, "g2", &opendesignerv1.Node{Width: 40}, "width"); err != nil {
		t.Fatal(err)
	}
	if got := posOf(doc, "c"); got[0] != 125 {
		t.Errorf("after growing g2, c at %v, want x=125", got)
	}
	if err := setProps(t, doc, "g2", &opendesignerv1.Node{Visible: false}, "visible"); err != nil {
		t.Fatal(err)
	}
	if got := posOf(doc, "c"); got[0] != 70 {
		t.Errorf("after hiding g2, c at %v, want x=70 (30 + 30 + 10)", got)
	}
}

func TestEmptyGroupStaysAndGroupNeverFills(t *testing.T) {
	doc := NewDocument("d", "t")
	createNode(t, doc, layoutFrameNode("f", "page1", "a0", 300, 60, &al{Direction: horiz}))
	empty := layoutGroup("e", "f", "a")
	empty.X, empty.Y = 7, 8
	createNode(t, doc, empty)
	g := layoutGroup("g", "f", "b")
	g.LayoutSizingX = opendesignerv1.LayoutSizing_LAYOUT_SIZING_FILL
	createNode(t, doc, g)
	createNode(t, doc, boxAt("g1", "g", "a", 0, 0, 30, 10))
	if got := posOf(doc, "e"); got != [2]float64{7, 8} {
		t.Errorf("the empty group moved to %v", got)
	}
	if got := sizeOf(doc, "g")[0]; got != 30 {
		t.Errorf("a group that asks to fill is %v wide, want its content's 30", got)
	}
}
