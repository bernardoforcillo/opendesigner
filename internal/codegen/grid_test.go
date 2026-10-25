package codegen_test

import (
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
	. "github.com/bernardoforcillo/opendesigner/internal/codegen/samples"
)

// GRID mode exports as display:grid, and a group in the flow of an auto layout frame as one box.

func cell(c, r, cs, rs int32) Opt {
	return func(n *opendesignerv1.Node) {
		n.GridCell = &opendesignerv1.GridPlacement{Column: c, Row: r, ColumnSpan: cs, RowSpan: rs}
	}
}

func TestGridExportsAsCSSGrid(t *testing.T) {
	layout := &opendesignerv1.AutoLayout{
		Mode: opendesignerv1.LayoutMode_LAYOUT_MODE_GRID, ColumnGap: 8, RowGap: 4, PaddingLeft: 6, PaddingRight: 6, PaddingTop: 6, PaddingBottom: 6,
		MainAlign: opendesignerv1.LayoutAlign_LAYOUT_ALIGN_CENTER,
		Columns: []*opendesignerv1.GridTrack{
			{Kind: opendesignerv1.GridTrackKind_GRID_TRACK_KIND_FIXED, Size: 80},
			{Kind: opendesignerv1.GridTrackKind_GRID_TRACK_KIND_FR, Size: 2},
			{Kind: opendesignerv1.GridTrackKind_GRID_TRACK_KIND_HUG},
		},
		Rows: []*opendesignerv1.GridTrack{{Kind: opendesignerv1.GridTrackKind_GRID_TRACK_KIND_FIXED, Size: 40}},
	}
	doc := screenDoc(func(b *B, s string) {
		b.Add("g", s, "Grid", 0, 0, 300, 120, Frame(false, layout), Fill(Solid(C(0.9, 0.9, 0.9))))
		b.Add("a", "g", "a", 0, 0, 20, 20, Fill(Solid(C(1, 0, 0))))
		b.Add("b", "g", "b", 0, 0, 20, 20, Fill(Solid(C(0, 1, 0))), cell(2, 2, 2, 0))
		c := b.Add("c", "g", "c", 0, 0, 20, 20, Fill(Solid(C(0, 0, 1))))
		c.LayoutSizingX = opendesignerv1.LayoutSizing_LAYOUT_SIZING_FILL
	})
	html := string(file(t, gen(t, doc, codegen.TargetHTML, nil), "screen.html"))
	for _, want := range []string{
		"display: grid;",
		"grid-template-columns: 80px 2fr max-content;",
		"grid-template-rows: 40px;",
		"gap: 4px 8px;",
		"justify-items: center;",
		"grid-column: 2 / span 2;",
		"grid-row: 2;",
		"justify-self: stretch;",
	} {
		if !strings.Contains(html, want) {
			t.Errorf("the grid export is missing %q", want)
		}
	}
	if strings.Contains(html, "display: flex") && strings.Contains(html, "flex: 1 1 0") {
		t.Error("a grid child was exported with flex fill")
	}
}

func TestGroupInFlowExportsAsABox(t *testing.T) {
	layout := &opendesignerv1.AutoLayout{Direction: opendesignerv1.LayoutDirection_LAYOUT_DIRECTION_HORIZONTAL, Spacing: 10}
	doc := screenDoc(func(b *B, s string) {
		b.Add("r", s, "Row", 0, 0, 300, 80, Frame(false, layout))
		b.Add("grp", "r", "group", 0, 0, 0, 0, Group())
		b.Add("g1", "grp", "g1", 5, 7, 30, 10, Fill(Solid(C(1, 0, 0))))
		b.Add("g2", "grp", "g2", 50, 30, 20, 10, Fill(Solid(C(0, 0, 1))))
	})
	html := string(file(t, gen(t, doc, codegen.TargetHTML, nil), "screen.html"))
	// The box is the union (65 x 33) in the flow; its children hang from an anchor at (-5, -7).
	for _, want := range []string{"width: 65px;", "height: 33px;", "left: -5px;", "top: -7px;"} {
		if !strings.Contains(html, want) {
			t.Errorf("the group export is missing %q", want)
		}
	}
}
