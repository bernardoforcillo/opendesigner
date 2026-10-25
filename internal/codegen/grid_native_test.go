package codegen_test

import (
	"strings"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
	. "github.com/bernardoforcillo/opendesigner/internal/codegen/samples"
)

// GRID mode on the native targets (native_grid.go): Compose gets the generated DesignGrid layout,
// SwiftUI a Grid of GridRows, or computed offsets (with a warning) where Grid cannot say it.

// gridNativeDoc: fixed, fr and hug columns, a fixed row, a child spanning two columns (and `rowSpan`
// rows) and one filling its cell.
func gridNativeDoc(rowSpan int32) *opendesignerv1.Document {
	layout := &opendesignerv1.AutoLayout{
		Mode: opendesignerv1.LayoutMode_LAYOUT_MODE_GRID, ColumnGap: 8, RowGap: 4,
		Columns: []*opendesignerv1.GridTrack{
			{Kind: opendesignerv1.GridTrackKind_GRID_TRACK_KIND_FIXED, Size: 80},
			{Kind: opendesignerv1.GridTrackKind_GRID_TRACK_KIND_FR, Size: 1},
			{Kind: opendesignerv1.GridTrackKind_GRID_TRACK_KIND_HUG},
		},
		Rows: []*opendesignerv1.GridTrack{{Kind: opendesignerv1.GridTrackKind_GRID_TRACK_KIND_FIXED, Size: 40}},
	}
	return screenDoc(func(b *B, s string) {
		b.Add("g", s, "Grid", 0, 0, 300, 120, Frame(false, layout), Fill(Solid(C(0.9, 0.9, 0.9))))
		b.Add("a", "g", "a", 0, 0, 20, 20, Fill(Solid(C(1, 0, 0))))
		b.Add("b", "g", "b", 0, 0, 20, 20, Fill(Solid(C(0, 1, 0))), cell(2, 0, 2, rowSpan))
		c := b.Add("c", "g", "c", 0, 0, 20, 20, Fill(Solid(C(0, 0, 1))))
		c.LayoutSizingX = opendesignerv1.LayoutSizing_LAYOUT_SIZING_FILL
	})
}

func gridWarnings(out *codegen.Output) (grid []string) {
	for _, w := range out.Warnings {
		if strings.Contains(w, "grid") {
			grid = append(grid, w)
		}
	}
	return grid
}

func TestGridSwiftUI(t *testing.T) {
	out := gen(t, gridNativeDoc(0), codegen.TargetSwiftUI, nil)
	src := string(file(t, out, "Sources/Screens/Screen.swift"))
	checkGolden(t, "native/Grid.swift", []byte(src))
	mustContain(t, "Grid.swift", src,
		"Grid(alignment: .topLeading, horizontalSpacing: 8, verticalSpacing: 4) {",
		"GridRow {",
		".gridCellColumns(2)",
		".frame(width: 80, height: 40, alignment: .topLeading)", // the fixed column and row
		".frame(maxWidth: .infinity, alignment: .topLeading)",   // the fr column
	)
	// b spans the fr and the hug column: the Grid sizes it by its content, and says so.
	if w := gridWarnings(out); len(w) != 1 || !strings.Contains(w[0], "grid cells spanning fixed or fr tracks") {
		t.Errorf("expected the spanning-fr warning only, got %v", w)
	}
}

func TestGridSwiftUIFallback(t *testing.T) {
	out := gen(t, gridNativeDoc(2), codegen.TargetSwiftUI, nil)
	src := string(file(t, out, "Sources/Screens/Screen.swift"))
	checkGolden(t, "native/GridSpan.swift", []byte(src))
	mustContain(t, "GridSpan.swift", src, "ZStack(alignment: .topLeading) {", ".offset(x:")
	if strings.Contains(src, "Grid(alignment") {
		t.Error("a row span was exported as a Grid")
	}
	found := false
	for _, w := range out.Warnings {
		found = found || strings.Contains(w, "SwiftUI: not exported: grid row spans and overlapping cells")
	}
	if !found {
		t.Errorf("missing the fallback warning: %v", out.Warnings)
	}
}

func TestGridCompose(t *testing.T) {
	out := gen(t, gridNativeDoc(2), codegen.TargetCompose, nil)
	src := string(file(t, out, "app/src/main/kotlin/design/generated/screens/Screen.kt"))
	checkGolden(t, "native/Grid.kt", []byte(src))
	mustContain(t, "Grid.kt", src,
		"DesignGrid(",
		"columns = listOf(GridTrack.Fixed(80.dp), GridTrack.Fr(1f), GridTrack.Hug)",
		"rows = listOf(GridTrack.Fixed(40.dp))",
		"columnGap = 8.dp",
		"rowGap = 4.dp",
		".gridCell(1, 0, 2, 2, false, false)", // the cell the core resolved
		".gridCell(0, 0, 1, 1, false, false)",
	)
	helper := string(file(t, out, "app/src/main/kotlin/design/generated/components/DesignGrid.kt"))
	checkGolden(t, "native/DesignGrid.kt", []byte(helper))
	mustContain(t, "DesignGrid.kt", helper, "fun DesignGrid(", "sealed class GridTrack", "fun Modifier.gridCell(")
	if w := gridWarnings(out); len(w) > 0 {
		t.Errorf("Compose warned about a grid: %v", w)
	}
	plain := gen(t, nativeDoc(), codegen.TargetCompose, nil)
	for _, f := range plain.Files {
		if strings.HasSuffix(f.Path, "DesignGrid.kt") {
			t.Error("the grid helper was written for a document without a grid")
		}
	}
}
