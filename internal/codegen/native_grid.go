package codegen

import (
	"fmt"
	"strconv"
	"strings"
)

// GRID MODE on the native targets. The CSS export (grid.go) hands auto-placement to the browser; the
// native targets read that CSS back (parseGrid) and the cells build.go resolved with the core's own
// placement (Element.Cell).
//
//   - Jetpack Compose: a small generated composable, DesignGrid (designGridKt), a custom Layout that
//     honours fixed, hug and fr tracks, the gaps, the spans and the in-cell alignment.
//   - SwiftUI: Grid / GridRow (iOS 16+) with gridCellColumns for the column spans; fixed tracks are a
//     frame on the cell, fr tracks a flexible frame (Grid shares the room equally, so different
//     weights are approximated). A grid Grid cannot say (row spans, overlapping cells) falls back to
//     the computed offsets of the core, with a warning.

type gtrack struct {
	kind byte // 'x' fixed, 'h' hug, 'f' fr
	size float64
}

// ngrid is a parsed GRID container: the tracks, the gaps and the in-cell alignment.
type ngrid struct {
	cols, rows     []gtrack
	colGap, rowGap float64
	h, v           string // start | center | end (justify-items, align-items)
}

// parseGridTracks reads a grid-template-columns / -rows value as gridTracksCSS writes it.
func parseGridTracks(s string) []gtrack {
	var out []gtrack
	for _, f := range strings.Fields(s) {
		switch {
		case f == "max-content":
			out = append(out, gtrack{kind: 'h'})
		case strings.HasSuffix(f, "fr"):
			w, _ := strconv.ParseFloat(strings.TrimSuffix(f, "fr"), 64)
			out = append(out, gtrack{'f', w})
		default:
			v, _ := cssNum(f)
			out = append(out, gtrack{'x', v})
		}
	}
	return out
}

func parseGrid(e *Element) *ngrid {
	g := &ngrid{cols: parseGridTracks(e.style("grid-template-columns")), rows: parseGridTracks(e.style("grid-template-rows")), h: "start", v: "start"}
	if f := strings.Fields(e.style("gap")); len(f) == 2 {
		g.rowGap, _ = cssNum(f[0])
		g.colGap, _ = cssNum(f[1])
	}
	if a := e.style("justify-items"); a == "center" || a == "end" {
		g.h = a
	}
	if a := e.style("align-items"); a == "center" || a == "end" {
		g.v = a
	}
	return g
}

// dims: the number of columns and rows, the declared tracks and every child's cell.
func (g *ngrid) dims(e *Element) (cols, rows int) {
	cols, rows = len(g.cols), len(g.rows)
	for _, c := range e.Children {
		if c.Cell != nil {
			cols, rows = max(cols, c.Cell.Col+c.Cell.ColSpan), max(rows, c.Cell.Row+c.Cell.RowSpan)
		}
	}
	return cols, rows
}

// track: the definition of track i (undeclared ones are HUG, as in the core).
func track(ts []gtrack, i int) gtrack {
	if i < len(ts) {
		return ts[i]
	}
	return gtrack{kind: 'h'}
}

// fills: the child stretches to its cell on an axis (justify-self / align-self: stretch).
func fills(c *Element) (x, y bool) {
	return c.style("justify-self") == "stretch", c.style("align-self") == "stretch"
}

// ---------------------------------------------------------------------------
// SwiftUI
// ---------------------------------------------------------------------------

// gridStack writes the children (kids[i] is the view of e.Children[i]) of a grid frame.
func (w *swWriter) gridStack(e *Element, n *nbox, kids [][]string) []string {
	g := n.grid
	ncols, nrows := g.dims(e)
	origin := map[[2]int]int{}
	occ := map[[2]int]bool{}
	plain := true
	var flow, abs []int
	for i, c := range e.Children {
		if c.Cell == nil {
			abs = append(abs, i)
			continue
		}
		flow = append(flow, i)
		origin[[2]int{c.Cell.Row, c.Cell.Col}] = i
		plain = plain && c.Cell.RowSpan <= 1
		for r := c.Cell.Row; r < c.Cell.Row+c.Cell.RowSpan; r++ {
			for cc := c.Cell.Col; cc < c.Cell.Col+c.Cell.ColSpan; cc++ {
				plain = plain && !occ[[2]int{r, cc}]
				occ[[2]int{r, cc}] = true
			}
		}
	}

	var lines []string
	if !plain {
		// Grid has no row spans and no overlapping cells: place the children where the core put them.
		w.unsup["grid row spans and overlapping cells (children placed at computed offsets)"] = true
		lines = append(lines, "ZStack(alignment: .topLeading) {")
		for _, i := range flow {
			c, m := e.Children[i].Cell, mods{}
			fx, fy := fills(e.Children[i])
			var dims []string
			if fx {
				dims = append(dims, "width: "+lit(c.W))
			}
			if fy {
				dims = append(dims, "height: "+lit(c.H))
			}
			if len(dims) > 0 {
				m.add("frame(%s, alignment: .topLeading)", strings.Join(dims, ", "))
			}
			m.add("offset(x: %s, y: %s)", lit(c.X), lit(c.Y))
			lines = append(lines, indentLines(withMods(kids[i], m), "    ")...)
		}
		for _, i := range abs {
			lines = append(lines, indentLines(kids[i], "    ")...)
		}
		return append(lines, "}")
	}

	hAl, vAl := alignIdx(g.h), alignIdx(g.v)
	al := swAlign(hAl, vAl)
	body := []string{fmt.Sprintf("Grid(alignment: %s, horizontalSpacing: %s, verticalSpacing: %s) {", al, lit(g.colGap), lit(g.rowGap))}
	for _, ts := range [][]gtrack{g.cols, g.rows} {
		weights := map[float64]bool{}
		for _, t := range ts {
			if t.kind == 'f' {
				weights[max(t.size, 1)] = true // a weight <= 0 counts as 1
			}
		}
		if len(weights) > 1 {
			w.unsup["grid fr tracks with different weights (shared equally)"] = true
		}
	}
	for r := 0; r < nrows; r++ {
		row := []string{"GridRow {"}
		for c := 0; c < ncols; {
			i, ok := origin[[2]int{r, c}]
			span := 1
			var cell []string
			ct, rt := track(g.cols, c), track(g.rows, r)
			var m, flex mods
			if ok {
				span = e.Children[i].Cell.ColSpan
				cell = kids[i]
				if span > 1 {
					m.add("gridCellColumns(%d)", span)
					for k := c; k < c+span; k++ {
						if t := track(g.cols, k); t.kind != 'h' {
							w.unsup["grid cells spanning fixed or fr tracks (sized by their content)"] = true
						}
					}
				}
			} else {
				// An empty cell: it only holds the track's size, a hug track is not grown by it.
				cell = []string{"Color.clear"}
				if ct.kind == 'h' {
					m.add("gridCellUnsizedAxes(.horizontal)")
				}
				if rt.kind == 'h' {
					m.add("gridCellUnsizedAxes(.vertical)")
				}
			}
			if span == 1 {
				var fixed []string
				if ct.kind == 'x' {
					fixed = append(fixed, "width: "+lit(ct.size))
				}
				if rt.kind == 'x' {
					fixed = append(fixed, "height: "+lit(rt.size))
				}
				if len(fixed) > 0 {
					flex.add("frame(%s, alignment: %s)", strings.Join(fixed, ", "), al)
				}
				var grow []string
				if ct.kind == 'f' {
					grow = append(grow, "maxWidth: .infinity")
				}
				if rt.kind == 'f' {
					grow = append(grow, "maxHeight: .infinity")
				}
				if len(grow) > 0 {
					flex.add("frame(%s, alignment: %s)", strings.Join(grow, ", "), al)
				}
			}
			row = append(row, indentLines(withMods(cell, append(flex, m...)), "    ")...)
			c += span
		}
		body = append(body, indentLines(append(row, "}"), "    ")...)
	}
	body = append(body, "}")
	if len(abs) == 0 {
		return body
	}
	lines = append(lines, "ZStack(alignment: .topLeading) {")
	lines = append(lines, indentLines(body, "    ")...)
	for _, i := range abs {
		lines = append(lines, indentLines(kids[i], "    ")...)
	}
	return append(lines, "}")
}

// ---------------------------------------------------------------------------
// Jetpack Compose
// ---------------------------------------------------------------------------

func kTracks(ts []gtrack) string {
	if len(ts) == 0 {
		return "emptyList()"
	}
	parts := make([]string, len(ts))
	for i, t := range ts {
		switch t.kind {
		case 'x':
			parts[i] = "GridTrack.Fixed(" + dp(t.size) + ")"
		case 'f':
			parts[i] = "GridTrack.Fr(" + lit(max(t.size, 1)) + "f)"
		default:
			parts[i] = "GridTrack.Hug"
		}
	}
	return "listOf(" + strings.Join(parts, ", ") + ")"
}

// gridModifier is the chain entry that tells DesignGrid where a child sits.
func gridModifier(c *Element) []string {
	if c.Cell == nil {
		return nil
	}
	fx, fy := fills(c)
	return []string{fmt.Sprintf(".gridCell(%d, %d, %d, %d, %v, %v)", c.Cell.Col, c.Cell.Row, c.Cell.ColSpan, c.Cell.RowSpan, fx, fy)}
}

// kGrid writes the DesignGrid of an element; the children out of the flow (absolute) sit over it.
func kGrid(g *ngrid, base string, chain []string, kids, abs []string) []string {
	pos := func(a string, v [3]string) string { return v[alignIdx(a)] }
	params := []string{"columns = " + kTracks(g.cols), "rows = " + kTracks(g.rows)}
	if g.colGap > 0 {
		params = append(params, "columnGap = "+dp(g.colGap))
	}
	if g.rowGap > 0 {
		params = append(params, "rowGap = "+dp(g.rowGap))
	}
	params = append(params,
		"horizontalAlignment = "+pos(g.h, [3]string{"Alignment.Start", "Alignment.CenterHorizontally", "Alignment.End"}),
		"verticalAlignment = "+pos(g.v, [3]string{"Alignment.Top", "Alignment.CenterVertically", "Alignment.Bottom"}))
	if len(abs) == 0 {
		return kcall("DesignGrid", params, base, chain, kids)
	}
	return kcall("Box", nil, base, chain, append(kcall("DesignGrid", params, "Modifier", nil, kids), abs...))
}

// designGridKt is the generated grid composable (components/DesignGrid.kt), written when a screen or
// component uses it. NOT COMPILED: there is no Kotlin toolchain here.
const designGridKt = `package design.generated.components

import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.ParentDataModifier
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

// A grid track: Fixed has its size, Hug is as big as the biggest cell in it, Fr shares what is left
// (after the fixed and hug tracks and the gaps) by weight. Tracks beyond the declared ones are Hug.
sealed class GridTrack {
    data class Fixed(val size: Dp) : GridTrack()
    object Hug : GridTrack()
    data class Fr(val weight: Float) : GridTrack()
}

// A cell: 0-based column and row, the spans, and whether the child stretches to its cell.
private data class GridCellData(val column: Int, val row: Int, val columnSpan: Int, val rowSpan: Int, val fillX: Boolean, val fillY: Boolean)

private class GridCellModifier(val cell: GridCellData) : ParentDataModifier {
    override fun Density.modifyParentData(parentData: Any?): Any = cell
}

fun Modifier.gridCell(column: Int, row: Int, columnSpan: Int = 1, rowSpan: Int = 1, fillX: Boolean = false, fillY: Boolean = false): Modifier =
    this.then(GridCellModifier(GridCellData(column, row, columnSpan, rowSpan, fillX, fillY)))

// The grid of a "grid" auto layout frame. Children are placed by Modifier.gridCell; a child keeps its
// size (or fills its cell) and is aligned in it. The tracks do not stretch to a bigger frame.
@Composable
fun DesignGrid(
    columns: List<GridTrack>,
    rows: List<GridTrack>,
    modifier: Modifier = Modifier,
    columnGap: Dp = 0.dp,
    rowGap: Dp = 0.dp,
    horizontalAlignment: Alignment.Horizontal = Alignment.Start,
    verticalAlignment: Alignment.Vertical = Alignment.Top,
    content: @Composable () -> Unit,
) {
    Layout(content = content, modifier = modifier) { measurables, constraints ->
        val cells = measurables.map { (it.parentData as? GridCellData) ?: GridCellData(0, 0, 1, 1, false, false) }
        val columnCount = maxOf(columns.size, cells.maxOfOrNull { it.column + it.columnSpan } ?: 0)
        val rowCount = maxOf(rows.size, cells.maxOfOrNull { it.row + it.rowSpan } ?: 0)
        val columnGapPx = columnGap.roundToPx()
        val rowGapPx = rowGap.roundToPx()

        val columnSizes = trackSizes(
            columns, columnCount, columnGapPx, if (constraints.hasBoundedWidth) constraints.maxWidth else null,
            cells.map { it.column }, cells.map { it.columnSpan },
            measurables.map { it.maxIntrinsicWidth(Constraints.Infinity) },
        )
        val rowSizes = trackSizes(
            rows, rowCount, rowGapPx, if (constraints.hasBoundedHeight) constraints.maxHeight else null,
            cells.map { it.row }, cells.map { it.rowSpan },
            measurables.mapIndexed { i, m -> m.maxIntrinsicHeight(extent(columnSizes, cells[i].column, cells[i].columnSpan, columnGapPx)) },
        )
        val columnStarts = starts(columnSizes, columnGapPx)
        val rowStarts = starts(rowSizes, rowGapPx)

        val placeables = measurables.mapIndexed { i, m ->
            val cw = extent(columnSizes, cells[i].column, cells[i].columnSpan, columnGapPx)
            val ch = extent(rowSizes, cells[i].row, cells[i].rowSpan, rowGapPx)
            m.measure(
                Constraints(
                    minWidth = if (cells[i].fillX) cw else 0,
                    maxWidth = if (cells[i].fillX) cw else Constraints.Infinity,
                    minHeight = if (cells[i].fillY) ch else 0,
                    maxHeight = if (cells[i].fillY) ch else Constraints.Infinity,
                ),
            )
        }
        val width = columnSizes.sum() + columnGapPx * maxOf(columnCount - 1, 0)
        val height = rowSizes.sum() + rowGapPx * maxOf(rowCount - 1, 0)
        layout(constraints.constrainWidth(width), constraints.constrainHeight(height)) {
            placeables.forEachIndexed { i, p ->
                val cw = extent(columnSizes, cells[i].column, cells[i].columnSpan, columnGapPx)
                val ch = extent(rowSizes, cells[i].row, cells[i].rowSpan, rowGapPx)
                p.place(
                    columnStarts[cells[i].column] + horizontalAlignment.align(p.width, cw, layoutDirection),
                    rowStarts[cells[i].row] + verticalAlignment.align(p.height, ch),
                )
            }
        }
    }
}

// The length of span tracks from first and the gaps between them.
private fun extent(sizes: IntArray, first: Int, span: Int, gap: Int): Int {
    val last = minOf(first + span, sizes.size)
    var total = gap * (span - 1)
    for (t in first until last) total += sizes[t]
    return total
}

private fun starts(sizes: IntArray, gap: Int): IntArray {
    val out = IntArray(sizes.size)
    var at = 0
    for (t in sizes.indices) {
        out[t] = at
        at += sizes[t] + gap
    }
    return out
}

// Track sizes along one axis. natural: what each child asks for; free: the room (null = unbounded, so
// fr tracks hug). A cell spanning several hug tracks widens them by what is missing, smallest span first.
private fun Density.trackSizes(
    tracks: List<GridTrack>, count: Int, gap: Int, free: Int?,
    firsts: List<Int>, spans: List<Int>, natural: List<Int>,
): IntArray {
    val sizes = IntArray(count)
    fun track(i: Int): GridTrack = tracks.getOrNull(i) ?: GridTrack.Hug
    fun hugs(i: Int) = track(i) is GridTrack.Hug || (free == null && track(i) is GridTrack.Fr)
    for (i in 0 until count) (track(i) as? GridTrack.Fixed)?.let { sizes[i] = it.size.roundToPx() }
    for (c in firsts.indices.sortedBy { spans[it] }) {
        val covered = (firsts[c] until minOf(firsts[c] + spans[c], count)).filter { hugs(it) }
        val missing = natural[c] - extent(sizes, firsts[c], spans[c], gap)
        if (covered.isEmpty() || missing <= 0) continue
        for (t in covered) sizes[t] += missing / covered.size
        sizes[covered.last()] += missing % covered.size
    }
    val frs = (0 until count).filter { track(it) is GridTrack.Fr && free != null }
    if (frs.isNotEmpty() && free != null) {
        fun weight(i: Int) = (track(i) as GridTrack.Fr).weight.let { if (it > 0f) it else 1f }
        val left = maxOf(free - sizes.sum() - gap * maxOf(count - 1, 0), 0)
        val total = frs.sumOf { weight(it).toDouble() }
        var given = 0
        for (t in frs) {
            sizes[t] = (left * weight(t) / total).toInt()
            given += sizes[t]
        }
        sizes[frs.last()] += left - given
    }
    return sizes
}
`
