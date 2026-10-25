// Exported by opendesigner (opendesigner export): grid layout helper of document "Test" (doc). DO NOT edit by hand:
// regenerate with `opendesigner export`. The data-node-id attribute ties every element to its design node.
package design.generated.components

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
