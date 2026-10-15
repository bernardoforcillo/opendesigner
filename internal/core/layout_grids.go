package core

import (
	"fmt"
	"math"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// validateLayoutGrids: every grid has a known kind and sane numbers. Parity with
// web/src/store/layoutGrids.ts::areValidLayoutGrids.
func validateLayoutGrids(grids []*opendesignerv1.LayoutGrid) error {
	finite := func(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
	for i, g := range grids {
		if g == nil {
			return fmt.Errorf("%w: grid %d is empty", ErrLayoutGrid, i)
		}
		if !finite(g.GetSize()) || !finite(g.GetGutter()) || !finite(g.GetMargin()) {
			return fmt.Errorf("%w: grid %d has a non-finite number", ErrLayoutGrid, i)
		}
		switch g.GetKind() {
		case opendesignerv1.LayoutGridKind_LAYOUT_GRID_KIND_GRID:
			if !(g.GetSize() > 0) {
				return fmt.Errorf("%w: grid %d needs a size > 0", ErrLayoutGrid, i)
			}
		case opendesignerv1.LayoutGridKind_LAYOUT_GRID_KIND_COLUMNS, opendesignerv1.LayoutGridKind_LAYOUT_GRID_KIND_ROWS:
			if g.GetCount() < 1 || g.GetCount() > 1000 {
				return fmt.Errorf("%w: grid %d needs a count of 1..1000", ErrLayoutGrid, i)
			}
			if g.GetGutter() < 0 || g.GetMargin() < 0 {
				return fmt.Errorf("%w: grid %d has a negative gutter or margin", ErrLayoutGrid, i)
			}
		default:
			return fmt.Errorf("%w: grid %d has an unknown kind", ErrLayoutGrid, i)
		}
	}
	return nil
}
