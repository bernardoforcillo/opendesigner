// Package board draws whiteboard objects -- sticky notes, tables, kanban boards, mind maps and
// a few starting templates -- as plain document nodes (a group of rectangles, text and
// vectors), the same way internal/diagram draws a flowchart. They are not a new kind of node:
// after they are inserted they are edited, restyled, aligned and exported like anything else,
// and the root group's `board.kind` meta says what they started as.
//
// Pure: no access to the document. The RenderBoard RPC lets the editor insert the nodes in one
// gesture; the create_board_object MCP tool lets an agent do the same.
package board

import (
	"fmt"
	"math"
	"strings"

	"github.com/bernardoforcillo/opendesigner/internal/diagram"
)

// Kinds.
const (
	KindSticky          = "sticky"
	KindTable           = "table"
	KindKanban          = "kanban"
	KindMindMap         = "mindmap"
	KindBrainstorm      = "brainstorm"
	KindRetrospective   = "retrospective"
	KindUserFlow        = "user-flow"
	KindCustomerJourney = "customer-journey"
)

// Kinds lists them in the order the editor offers them.
var Kinds = []string{
	KindSticky, KindTable, KindKanban, KindMindMap,
	KindBrainstorm, KindRetrospective, KindUserFlow, KindCustomerJourney,
}

// MetaKind marks the root group of a whiteboard object.
const MetaKind = "board.kind"

// Params shape an object. Every field is optional.
type Params struct {
	// Items: sticky: the text; table: the header cells; kanban: the column titles; mindmap: the
	// center, then its branches. Templates ignore it.
	Items []string
	// Rows and Columns size a table (default 4 x 3; both at most 30).
	Rows, Columns int
	// Color of a sticky note: yellow (default), pink, green, blue, orange, purple.
	Color string
}

// Error is a problem with the request (not the server's): the caller shows it as is.
type Error struct{ Msg string }

func (e *Error) Error() string { return e.Msg }

func fail(format string, a ...any) error { return &Error{fmt.Sprintf(format, a...)} }

const (
	maxCells = 400
	maxItems = 60
	maxText  = 400
)

// Render draws an object of `kind`.
func Render(kind string, p Params) (*diagram.Result, error) {
	if len(p.Items) > maxItems {
		return nil, fail("too many items (at most %d)", maxItems)
	}
	for _, it := range p.Items {
		if len([]rune(it)) > maxText {
			return nil, fail("an item is too long (at most %d characters)", maxText)
		}
	}
	var sc *diagram.Scene
	var title string
	switch kind {
	case KindSticky:
		c, ok := stickyColors[strings.ToLower(orDefault(p.Color, "yellow"))]
		if !ok {
			return nil, fail("unknown sticky color %q (yellow, pink, green, blue, orange, purple)", p.Color)
		}
		sc, title = sticky(first(p.Items), c), "Sticky note"
	case KindTable:
		rows, cols := orInt(p.Rows, 4), orInt(p.Columns, 3)
		if rows < 1 || cols < 1 || rows*cols > maxCells {
			return nil, fail("a table has 1 or more rows and columns, at most %d cells", maxCells)
		}
		sc, title = table(rows, cols, p.Items), "Table"
	case KindKanban:
		cols := p.Items
		if len(cols) == 0 {
			cols = []string{"To do", "Doing", "Done"}
		}
		sc, title = kanban(cols), "Kanban board"
	case KindMindMap:
		center := orDefault(first(p.Items), "Main idea")
		var branches []string
		if len(p.Items) > 1 {
			branches = p.Items[1:]
		} else {
			branches = []string{"Idea", "Idea", "Idea", "Idea"}
		}
		sc, title = mindMap(center, branches), "Mind map"
	case KindBrainstorm:
		sc, title = brainstorm(), "Brainstorm"
	case KindRetrospective:
		sc, title = retrospective(), "Retrospective"
	case KindUserFlow:
		sc, title = userFlow(), "User flow"
	case KindCustomerJourney:
		sc, title = customerJourney(), "Customer journey"
	default:
		return nil, fail("unknown board object %q (%s)", kind, strings.Join(Kinds, ", "))
	}
	return diagram.BuildScene(sc, title, map[string]string{MetaKind: kind}), nil
}

func first(l []string) string {
	if len(l) == 0 {
		return ""
	}
	return l[0]
}

func orDefault(s, d string) string {
	if strings.TrimSpace(s) == "" {
		return d
	}
	return s
}

func orInt(v, d int) int {
	if v == 0 {
		return d
	}
	return v
}

// --- colors and primitives ----------------------------------------------------------------

type rgb = diagram.RGB

var (
	ink    = rgb{R: 0.12, G: 0.14, B: 0.19}
	muted  = rgb{R: 0.40, G: 0.44, B: 0.52}
	line   = rgb{R: 0.80, G: 0.82, B: 0.86}
	white  = rgb{R: 1, G: 1, B: 1}
	column = rgb{R: 0.95, G: 0.96, B: 0.98}
	head   = rgb{R: 0.88, G: 0.91, B: 0.98}
	accent = rgb{R: 0.31, G: 0.27, B: 0.90}

	stickyColors = map[string]rgb{
		"yellow": {R: 1, G: 0.92, B: 0.45}, "pink": {R: 1, G: 0.74, B: 0.82}, "green": {R: 0.70, G: 0.93, B: 0.65},
		"blue": {R: 0.66, G: 0.84, B: 1}, "orange": {R: 1, G: 0.78, B: 0.50}, "purple": {R: 0.82, G: 0.74, B: 1},
	}
)

func box(x, y, w, h, radius float64, fill, stroke *rgb, name string) diagram.Box {
	return diagram.Box{X: x, Y: y, W: w, H: h, Shape: diagram.ShapeRect, Radius: radius, Fill: fill, Stroke: stroke, StrokeW: 1, Name: name}
}

func text(x, y, w, h float64, s string, size float64, bold bool, align string, c rgb, name string) diagram.Text {
	return diagram.Text{X: x, Y: y, W: w, H: h, Content: s, Size: size, Bold: bold, Align: align, Color: c, Name: name}
}

func ptr(c rgb) *rgb { return &c }

func shade(c rgb, k float64) rgb {
	return rgb{R: math.Max(0, c.R*k), G: math.Max(0, c.G*k), B: math.Max(0, c.B*k)}
}

// --- objects ------------------------------------------------------------------------------

const stickySize = 160.0

// stickyAt adds a sticky note at (x, y) into the scene.
func stickyAt(sc *diagram.Scene, x, y float64, s string, c rgb) {
	sc.Add(box(x, y, stickySize, stickySize, 3, ptr(c), ptr(shade(c, 0.85)), "Sticky"))
	sc.Add(text(x+12, y+12, stickySize-24, stickySize-24, s, 16, false, "left", ink, "Sticky text"))
}

func sticky(s string, c rgb) *diagram.Scene {
	sc := &diagram.Scene{W: stickySize, H: stickySize}
	stickyAt(sc, 0, 0, orDefault(s, "Note"), c)
	return sc
}

const (
	cellW, cellH = 140.0, 44.0
)

func table(rows, cols int, headers []string) *diagram.Scene {
	sc := &diagram.Scene{W: float64(cols) * cellW, H: float64(rows) * cellH}
	for r := 0; r < rows; r++ {
		for c := 0; c < cols; c++ {
			x, y := float64(c)*cellW, float64(r)*cellH
			fill := ptr(white)
			if r == 0 {
				fill = ptr(head)
			}
			sc.Add(box(x, y, cellW, cellH, 0, fill, ptr(line), fmt.Sprintf("Cell %d,%d", r+1, c+1)))
			label := ""
			if r == 0 {
				label = fmt.Sprintf("Column %d", c+1)
				if c < len(headers) && strings.TrimSpace(headers[c]) != "" {
					label = headers[c]
				}
			}
			sc.Add(text(x+10, y+12, cellW-20, cellH-24, label, 14, r == 0, "left", ink, fmt.Sprintf("Cell text %d,%d", r+1, c+1)))
		}
	}
	return sc
}

func kanban(cols []string) *diagram.Scene {
	const w, pad, cardH, gap = 240.0, 12.0, 72.0, 10.0
	cards := 2
	h := 56 + float64(cards)*(cardH+gap) + pad
	sc := &diagram.Scene{W: float64(len(cols))*(w+16) - 16, H: h}
	for i, title := range cols {
		x := float64(i) * (w + 16)
		sc.Add(box(x, 0, w, h, 8, ptr(column), ptr(line), "Column "+title))
		sc.Add(text(x+pad, 14, w-2*pad, 24, title, 15, true, "left", ink, "Column title"))
		for k := 0; k < cards; k++ {
			y := 52 + float64(k)*(cardH+gap)
			sc.Add(box(x+pad, y, w-2*pad, cardH, 6, ptr(white), ptr(line), "Card"))
			sc.Add(text(x+pad+10, y+10, w-2*pad-20, cardH-20, "Task", 14, false, "left", ink, "Card text"))
		}
	}
	return sc
}

func mindMap(center string, branches []string) *diagram.Scene {
	const cw, ch, bw, bh, hgap, vgap = 180.0, 64.0, 150.0, 40.0, 90.0, 18.0
	right := (len(branches) + 1) / 2
	left := len(branches) - right
	rows := math.Max(float64(right), float64(left))
	h := math.Max(ch, rows*(bh+vgap)-vgap)
	w := 2*(bw+hgap) + cw
	sc := &diagram.Scene{W: w, H: h}
	cx, cy := w/2, h/2
	place := func(side, i, n int, s string) {
		span := float64(n)*(bh+vgap) - vgap
		y := cy - span/2 + float64(i)*(bh+vgap)
		var x, from, to float64
		if side > 0 {
			x, from, to = cx+cw/2+hgap, cx+cw/2, cx+cw/2+hgap
		} else {
			x, from, to = cx-cw/2-hgap-bw, cx-cw/2, cx-cw/2-hgap
		}
		mid := (from + to) / 2
		sc.Add(diagram.Line{Pts: []diagram.Pt{{X: from, Y: cy}, {X: mid, Y: cy}, {X: mid, Y: y + bh/2}, {X: to, Y: y + bh/2}}, Weight: 2, Color: accent, Name: "Branch line"})
		sc.Add(diagram.Box{X: x, Y: y, W: bw, H: bh, Shape: diagram.ShapeStadium, Fill: ptr(head), Stroke: ptr(accent), StrokeW: 1, Name: "Branch"})
		sc.Add(text(x+12, y+10, bw-24, bh-20, s, 14, false, "center", ink, "Branch text"))
	}
	for i := 0; i < right; i++ {
		place(1, i, right, branches[i])
	}
	for i := 0; i < left; i++ {
		place(-1, i, left, branches[right+i])
	}
	sc.Add(diagram.Box{X: cx - cw/2, Y: cy - ch/2, W: cw, H: ch, Shape: diagram.ShapeStadium, Fill: ptr(accent), Name: "Center"})
	sc.Add(text(cx-cw/2+14, cy-12, cw-28, 24, center, 16, true, "center", white, "Center text"))
	return sc
}

// --- templates ----------------------------------------------------------------------------

func zone(sc *diagram.Scene, x, y, w, h float64, title string, c rgb, notes ...string) {
	sc.Add(box(x, y, w, h, 8, ptr(column), ptr(line), "Zone "+title))
	sc.Add(text(x+16, y+14, w-32, 24, title, 16, true, "left", ink, "Zone title"))
	for i, n := range notes {
		stickyAt(sc, x+16+float64(i%2)*(stickySize+12), y+52+float64(i/2)*(stickySize+12), n, c)
	}
}

func brainstorm() *diagram.Scene {
	const w, h = 380.0, 380.0
	sc := &diagram.Scene{W: 2*w + 24, H: h + 56}
	sc.Add(text(0, 0, 2*w+24, 36, "Brainstorm: what is the question?", 22, true, "left", ink, "Title"))
	zone(sc, 0, 56, w, h, "Ideas", stickyColors["yellow"], "Idea", "Idea")
	zone(sc, w+24, 56, w, h, "Wild ideas", stickyColors["pink"], "Idea", "Idea")
	return sc
}

func retrospective() *diagram.Scene {
	const w, h = 380.0, 420.0
	sc := &diagram.Scene{W: 3*w + 48, H: h + 56}
	sc.Add(text(0, 0, 3*w, 36, "Retrospective", 22, true, "left", ink, "Title"))
	zone(sc, 0, 56, w, h, "Went well", stickyColors["green"], "Note", "Note")
	zone(sc, w+24, 56, w, h, "To improve", stickyColors["orange"], "Note", "Note")
	zone(sc, 2*(w+24), 56, w, h, "Actions", stickyColors["blue"], "Action", "Action")
	return sc
}

func userFlow() *diagram.Scene {
	steps := []string{"Land", "Sign up", "Onboarding", "Home", "Done"}
	const bw, bh, gap = 150.0, 70.0, 60.0
	sc := &diagram.Scene{W: float64(len(steps))*bw + float64(len(steps)-1)*gap, H: bh + 56}
	sc.Add(text(0, 0, sc.W, 36, "User flow", 22, true, "left", ink, "Title"))
	for i, s := range steps {
		x := float64(i) * (bw + gap)
		shape := diagram.ShapeRound
		if i == 0 || i == len(steps)-1 {
			shape = diagram.ShapeStadium
		}
		sc.Add(diagram.Box{X: x, Y: 56, W: bw, H: bh, Shape: shape, Radius: 8, Fill: ptr(head), Stroke: ptr(accent), StrokeW: 1.5, Name: "Step " + s})
		sc.Add(text(x+10, 56+bh/2-11, bw-20, 22, s, 15, true, "center", ink, "Step text"))
		if i < len(steps)-1 {
			sc.Add(diagram.Line{Pts: []diagram.Pt{{X: x + bw, Y: 56 + bh/2}, {X: x + bw + gap, Y: 56 + bh/2}}, Weight: 2, Color: accent, End: diagram.HeadArrow, Name: "Arrow"})
		}
	}
	return sc
}

func customerJourney() *diagram.Scene {
	stages := []string{"Awareness", "Consideration", "Purchase", "Use", "Loyalty"}
	rows := []string{"Actions", "Thoughts", "Pain points", "Opportunities"}
	const labelW, cw, rh, hh = 130.0, 170.0, 90.0, 40.0
	sc := &diagram.Scene{W: labelW + float64(len(stages))*cw, H: 56 + hh + float64(len(rows))*rh}
	sc.Add(text(0, 0, sc.W, 36, "Customer journey", 22, true, "left", ink, "Title"))
	for c, st := range stages {
		x := labelW + float64(c)*cw
		sc.Add(box(x, 56, cw, hh, 0, ptr(head), ptr(line), "Stage "+st))
		sc.Add(text(x+10, 56+10, cw-20, 20, st, 14, true, "center", ink, "Stage text"))
	}
	for r, label := range rows {
		y := 56 + hh + float64(r)*rh
		sc.Add(box(0, y, labelW, rh, 0, ptr(column), ptr(line), "Row "+label))
		sc.Add(text(10, y+10, labelW-20, 22, label, 14, true, "left", ink, "Row label"))
		for c := range stages {
			sc.Add(box(labelW+float64(c)*cw, y, cw, rh, 0, ptr(white), ptr(line), fmt.Sprintf("Cell %d,%d", r+1, c+1)))
		}
	}
	return sc
}
