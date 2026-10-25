package core

import (
	"errors"
	"fmt"
	"math"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// AUTO LAYOUT, GRID MODE -- the Go half (the authority) of web/src/store/layoutGrid.ts.
//
// A frame whose auto layout has mode GRID puts its children in the cells of `columns` x `rows`
// tracks instead of a row. Same contract as layout.go: the result is written into x/y (and
// width/height), and the TS twin performs the same operations in the same order (explicit
// float64() around every product, so no architecture fuses it into an FMA).
//
//   - A child's cell is Node.grid_cell: a 1-based column/row and a span of each. Children with
//     both a column and a row are placed first; the others flow row-major into the first free
//     cells (a child with only a column or only a row looks for the first free line along the
//     other axis). Nothing stops two explicit children from overlapping, as in CSS.
//   - Tracks that no definition covers (more columns or rows than declared) are HUG.
//   - FIXED tracks have their size; HUG tracks the biggest child that sits in them (a child
//     spanning several tracks widens the HUG ones among them by the missing amount, smallest
//     spans first); FR tracks share what is left, by weight (<= 0 counts as 1), and are as
//     small as their content when the frame hugs that axis. An FR track ignores its content.
//   - A child fills its cell on an axis when its layout sizing says so (min/max limits apply);
//     otherwise it keeps its size and is aligned in the cell: main_align horizontally and
//     cross_align vertically (center and end; anything else is the start), whatever the direction.
//   - A group child is one box of the union of its children (see groupBox) and never fills.

// ErrGridLayout: a grid definition or cell the core does not accept.
var ErrGridLayout = errors.New("core: invalid grid layout")

const maxGridTracks, maxGridIndex = 100, 1000

// validateGridLayout: the closed enums, finite non-negative sizes and gaps and a sane track count.
// Parity with web/src/store/layoutGrid.ts::isValidGridLayout.
func validateGridLayout(al *opendesignerv1.AutoLayout) error {
	if al == nil {
		return nil
	}
	if m := al.GetMode(); m < opendesignerv1.LayoutMode_LAYOUT_MODE_FLEX || m > opendesignerv1.LayoutMode_LAYOUT_MODE_GRID {
		return fmt.Errorf("%w: unknown mode %v", ErrGridLayout, m)
	}
	for _, g := range []float64{al.GetColumnGap(), al.GetRowGap()} {
		if math.IsNaN(g) || math.IsInf(g, 0) || g < 0 {
			return fmt.Errorf("%w: a gap must be finite and >= 0", ErrGridLayout)
		}
	}
	for _, tracks := range [][]*opendesignerv1.GridTrack{al.GetColumns(), al.GetRows()} {
		if len(tracks) > maxGridTracks {
			return fmt.Errorf("%w: at most %d tracks", ErrGridLayout, maxGridTracks)
		}
		for _, t := range tracks {
			if t.GetKind() < opendesignerv1.GridTrackKind_GRID_TRACK_KIND_FIXED || t.GetKind() > opendesignerv1.GridTrackKind_GRID_TRACK_KIND_FR {
				return fmt.Errorf("%w: unknown track kind %v", ErrGridLayout, t.GetKind())
			}
			if v := t.GetSize(); math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
				return fmt.Errorf("%w: a track size must be finite and >= 0", ErrGridLayout)
			}
		}
	}
	return nil
}

// validateGridCell: every number in 0..maxGridIndex.
func validateGridCell(c *opendesignerv1.GridPlacement) error {
	for _, v := range []int32{c.GetColumn(), c.GetColumnSpan(), c.GetRow(), c.GetRowSpan()} {
		if v < 0 || v > maxGridIndex {
			return fmt.Errorf("%w: cell numbers must be 0..%d", ErrGridLayout, maxGridIndex)
		}
	}
	return nil
}

func isGroupNode(n *opendesignerv1.Node) bool {
	_, ok := n.GetShape().(*opendesignerv1.Node_Group)
	return ok
}

type box struct{ minX, minY, maxX, maxY float64 }

// groupBox is the union of the visible children of group `id`, in the group's own (untranslated)
// space; ok is false for a group with nothing to show. Nested groups add their translation.
// Rotation is ignored (the unrotated boxes are unioned).
func groupBox(doc *opendesignerv1.Document, id string) (b box, ok bool) {
	for _, c := range ChildrenOf(doc, id) {
		if !c.GetVisible() {
			continue
		}
		cb := box{c.GetX(), c.GetY(), c.GetX() + c.GetWidth(), c.GetY() + c.GetHeight()}
		if isGroupNode(c) {
			in, has := groupBox(doc, c.GetId())
			if !has {
				continue
			}
			cb = box{c.GetX() + in.minX, c.GetY() + in.minY, c.GetX() + in.maxX, c.GetY() + in.maxY}
		}
		if !ok {
			b, ok = cb, true
			continue
		}
		b = box{math.Min(b.minX, cb.minX), math.Min(b.minY, cb.minY), math.Max(b.maxX, cb.maxX), math.Max(b.maxY, cb.maxY)}
	}
	return b, ok
}

// GroupBounds is groupBox for other packages: minX, minY, maxX, maxY in the group's own space.
func GroupBounds(doc *opendesignerv1.Document, id string) (b [4]float64, ok bool) {
	g, ok := groupBox(doc, id)
	return [4]float64{g.minX, g.minY, g.maxX, g.maxY}, ok
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// gridCells assigns every child its 0-based column, row and spans, and returns the number of
// columns and rows the grid has.
func gridCells(kids []*opendesignerv1.Node, al *opendesignerv1.AutoLayout) (col, row, cs, rs []int, ncols, nrows int) {
	n := len(kids)
	col, row, cs, rs = make([]int, n), make([]int, n), make([]int, n), make([]int, n)
	ncols, nrows = maxInt(len(al.GetColumns()), 1), len(al.GetRows())
	for i, k := range kids {
		cs[i], rs[i] = maxInt(int(k.GetGridCell().GetColumnSpan()), 1), maxInt(int(k.GetGridCell().GetRowSpan()), 1)
		if c := int(k.GetGridCell().GetColumn()); c > 0 {
			ncols = maxInt(ncols, c-1+cs[i])
		}
	}
	occ := map[[2]int]bool{}
	mark := func(i int) {
		for r := row[i]; r < row[i]+rs[i]; r++ {
			for c := col[i]; c < col[i]+cs[i]; c++ {
				occ[[2]int{r, c}] = true
			}
		}
	}
	free := func(r0, c0, rspan, cspan int) bool {
		for r := r0; r < r0+rspan; r++ {
			for c := c0; c < c0+cspan; c++ {
				if occ[[2]int{r, c}] {
					return false
				}
			}
		}
		return true
	}
	placed := make([]bool, n)
	for i, k := range kids {
		if k.GetGridCell().GetColumn() > 0 && k.GetGridCell().GetRow() > 0 {
			col[i], row[i] = int(k.GetGridCell().GetColumn())-1, int(k.GetGridCell().GetRow())-1
			mark(i)
			placed[i] = true
		}
	}
	cr, cc := 0, 0
	for i, k := range kids {
		if placed[i] {
			continue
		}
		pc, pr := int(k.GetGridCell().GetColumn()), int(k.GetGridCell().GetRow())
		switch {
		case pc > 0:
			col[i] = pc - 1
			for !free(row[i], col[i], rs[i], cs[i]) {
				row[i]++
			}
		case pr > 0:
			row[i] = pr - 1
			cs[i] = minInt(cs[i], ncols)
			col[i] = 0
			for col[i]+cs[i] <= ncols && !free(row[i], col[i], rs[i], cs[i]) {
				col[i]++
			}
			if col[i]+cs[i] > ncols {
				col[i] = 0
			}
		default:
			cs[i] = minInt(cs[i], ncols)
			for {
				if cc+cs[i] > ncols {
					cc, cr = 0, cr+1
					continue
				}
				if free(cr, cc, rs[i], cs[i]) {
					break
				}
				cc++
			}
			col[i], row[i] = cc, cr
			cc += cs[i]
		}
		mark(i)
	}
	for i := range kids {
		nrows = maxInt(nrows, row[i]+rs[i])
	}
	return col, row, cs, rs, ncols, nrows
}

// spanExtent: the length of `span` tracks from `start` and the gaps between them.
func spanExtent(sizes []float64, start, span int, gap float64) float64 {
	var s float64
	for t := start; t < start+span; t++ {
		s += sizes[t]
	}
	if span > 1 {
		s += float64(gap * float64(span-1))
	}
	return s
}

// gridTrackSizes resolves the n tracks of one axis. `extents` are the children's sizes on this
// axis, `starts`/`spans` their tracks. `inner` is the room the tracks have (ignored when `hug`).
func gridTrackSizes(defs []*opendesignerv1.GridTrack, n int, starts, spans []int, extents []float64, gap, inner float64, hug bool) []float64 {
	size := make([]float64, n)
	content := make([]bool, n) // sized by its children
	fr := make([]float64, n)   // weight of an FR track, 0 for the others
	for t := 0; t < n; t++ {
		kind, v := opendesignerv1.GridTrackKind_GRID_TRACK_KIND_HUG, 0.0
		if t < len(defs) {
			kind, v = defs[t].GetKind(), defs[t].GetSize()
		}
		switch {
		case kind == opendesignerv1.GridTrackKind_GRID_TRACK_KIND_FIXED:
			size[t] = v
		case kind == opendesignerv1.GridTrackKind_GRID_TRACK_KIND_FR && !hug:
			fr[t] = v
			if !(v > 0) {
				fr[t] = 1
			}
		default:
			content[t] = true
		}
	}
	maxSpan := 1
	for _, s := range spans {
		maxSpan = maxInt(maxSpan, s)
	}
	for sp := 1; sp <= maxSpan; sp++ {
		for j := range starts {
			if spans[j] != sp {
				continue
			}
			var grow []int
			for t := starts[j]; t < starts[j]+sp; t++ {
				if content[t] {
					grow = append(grow, t)
				}
			}
			if need := extents[j] - spanExtent(size, starts[j], sp, gap); need > 0 && len(grow) > 0 {
				each := need / float64(len(grow))
				for _, t := range grow {
					size[t] += each
				}
			}
		}
	}
	var sumW float64
	for _, w := range fr {
		sumW += w
	}
	if sumW > 0 {
		free := inner - spanExtent(size, 0, n, gap)
		for t := 0; t < n; t++ {
			if fr[t] > 0 {
				if free > 0 {
					size[t] = float64(free*fr[t]) / sumW
				} else {
					size[t] = 0
				}
			}
		}
	}
	return size
}

// layoutGrid places `kids` in the cells of the grid and sizes the frame if it hugs.
func layoutGrid(kids []*opendesignerv1.Node, frame *opendesignerv1.Node, al *opendesignerv1.AutoLayout) {
	col, row, cs, rs, ncols, nrows := gridCells(kids, al)
	padL, padT, padR, padB := al.GetPaddingLeft(), al.GetPaddingTop(), al.GetPaddingRight(), al.GetPaddingBottom()
	colGap, rowGap := al.GetColumnGap(), al.GetRowGap()

	// The size a child asks for: its own, clamped to its limits.
	ws, hs := make([]float64, len(kids)), make([]float64, len(kids))
	for i, k := range kids {
		ws[i], hs[i] = clampWK(k, k.GetWidth()), clampHK(k, k.GetHeight())
	}

	colSizes := gridTrackSizes(al.GetColumns(), ncols, col, cs, ws, colGap, frame.GetWidth()-padL-padR, al.GetHugWidth())
	if al.GetHugWidth() {
		frame.Width = clampW(frame, padL+spanExtent(colSizes, 0, ncols, colGap)+padR)
	}
	rowSizes := gridTrackSizes(al.GetRows(), nrows, row, rs, hs, rowGap, frame.GetHeight()-padT-padB, al.GetHugHeight())
	if al.GetHugHeight() {
		frame.Height = clampH(frame, padT+spanExtent(rowSizes, 0, nrows, rowGap)+padB)
	}

	colPos, rowPos := make([]float64, ncols), make([]float64, nrows)
	pos := padL
	for t := 0; t < ncols; t++ {
		colPos[t] = pos
		pos = pos + colSizes[t] + colGap
	}
	pos = padT
	for t := 0; t < nrows; t++ {
		rowPos[t] = pos
		pos = pos + rowSizes[t] + rowGap
	}

	for i, k := range kids {
		aw, ah := spanExtent(colSizes, col[i], cs[i], colGap), spanExtent(rowSizes, row[i], rs[i], rowGap)
		w, h := ws[i], hs[i]
		if !isGroupNode(k) && k.GetLayoutSizingX() == opendesignerv1.LayoutSizing_LAYOUT_SIZING_FILL {
			w = clampWK(k, aw)
		}
		if !isGroupNode(k) && k.GetLayoutSizingY() == opendesignerv1.LayoutSizing_LAYOUT_SIZING_FILL {
			h = clampHK(k, ah)
		}
		x, y := colPos[col[i]], rowPos[row[i]]
		switch al.GetMainAlign() {
		case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_CENTER:
			x = x + (aw-w)/2
		case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_END:
			x = x + (aw - w)
		}
		switch al.GetCrossAlign() {
		case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_CENTER:
			y = y + (ah-h)/2
		case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_END:
			y = y + (ah - h)
		}
		k.X, k.Y, k.Width, k.Height = x, y, w, h
	}
}

// clampWK / clampHK: a group has no size limits of its own (its size is its children's).
func clampWK(n *opendesignerv1.Node, v float64) float64 {
	if isGroupNode(n) {
		return v
	}
	return clampW(n, v)
}

func clampHK(n *opendesignerv1.Node, v float64) float64 {
	if isGroupNode(n) {
		return v
	}
	return clampH(n, v)
}

// GridCell is a grid child's resolved cell: 0-based column and row and the spans, after the
// placement of gridCells (what codegen needs for targets that cannot auto-place).
type GridCell struct{ Col, Row, ColSpan, RowSpan int }

// GridCells resolves the cells of the in-flow children `kids` (document order) of a GRID auto layout,
// and the number of columns and rows the grid ends up with.
func GridCells(kids []*opendesignerv1.Node, al *opendesignerv1.AutoLayout) (cells []GridCell, ncols, nrows int) {
	col, row, cs, rs, ncols, nrows := gridCells(kids, al)
	cells = make([]GridCell, len(kids))
	for i := range kids {
		cells[i] = GridCell{col[i], row[i], cs[i], rs[i]}
	}
	return cells, ncols, nrows
}
