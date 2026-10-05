package diagram

import (
	"fmt"
	"math"
	"strings"
)

// The SCENE is the intermediate level between the parsers (which know about Mermaid and UML)
// and the document nodes (which know about rect, vectors and text): the former
// produce geometric primitives, `build.go` translates them into nodes. This way every
// diagram kind draws with the same vocabulary and nobody knows about
// protobuf.

// Pt is a point in the diagram's space (origin at the top left).
type Pt struct{ X, Y float64 }

// RGB is an opaque 0..1 color.
type RGB struct{ R, G, B float64 }

var (
	colInk      = RGB{0.122, 0.161, 0.216}
	colMuted    = RGB{0.392, 0.455, 0.545}
	colLine     = RGB{0.278, 0.333, 0.412}
	colNodeFill = RGB{0.933, 0.949, 1}
	colNodeLine = RGB{0.310, 0.275, 0.898}
	colHeader   = RGB{0.859, 0.878, 0.992}
	colWhite    = RGB{1, 1, 1}
	colNote     = RGB{1, 0.973, 0.8}
	colNoteLine = RGB{0.78, 0.65, 0.2}
	colFrag     = RGB{0.97, 0.97, 0.98}
)

// Shape is the shape of a Box.
type Shape int

const (
	ShapeRect Shape = iota
	ShapeRound
	ShapeStadium
	ShapeEllipse
	ShapeDiamond
)

// Box is a closed shape with fill and outline.
type Box struct {
	X, Y, W, H float64
	Shape      Shape
	Radius     float64 // ShapeRect/ShapeRound only
	Fill       *RGB    // nil = no fill
	Stroke     *RGB    // nil = no outline
	StrokeW    float64
	Name       string
}

// Text is a block of text. X/Y/W/H is the box; Align decides where the text falls.
type Text struct {
	X, Y, W, H float64
	Content    string
	Size       float64
	Bold       bool
	Align      string // left | center | right
	Color      RGB
	Name       string
}

// HeadKind is the decoration at the end of a line.
type HeadKind int

const (
	HeadNone          HeadKind = iota
	HeadArrow                  // filled triangle (messages, transitions)
	HeadOpen                   // open V-shaped arrow (association, async)
	HeadTriangle               // hollow triangle (inheritance, realization)
	HeadDiamond                // hollow diamond (aggregation)
	HeadDiamondFilled          // filled diamond (composition)
	HeadCross                  // cross (lost message)
)

// Line is a polyline with decorations at the ends.
type Line struct {
	Pts    []Pt
	Weight float64
	Dashed bool
	Color  RGB
	Start  HeadKind // on the first point
	End    HeadKind // on the last
	Name   string
}

// Poly is a closed polygon (arrows, diamonds, actors, non-rectangular backgrounds).
type Poly struct {
	Pts    []Pt
	Fill   *RGB
	Stroke *RGB
	W      float64
	Name   string
}

// Scene is a drawn diagram: elements in stacking order
// (the first is at the bottom).
type Scene struct {
	W, H  float64
	Items []any
}

func (s *Scene) add(it ...any) { s.Items = append(s.Items, it...) }

func rgb(c RGB) *RGB { return &c }

// --- text measurement ---------------------------------------------------------

const (
	fontSize = 14.0
	lineMul  = 1.2
	charW    = 0.54 // average width of a character, in multiples of the font size
)

// textW estimates the width of the longest line at font size `size`. The server has no
// fonts: the estimate is deliberately generous (better a bit of air than a text that
// wraps on its own).
func textW(s string, size float64) float64 {
	m := 0
	for _, l := range strings.Split(s, "\n") {
		if n := len([]rune(l)); n > m {
			m = n
		}
	}
	return float64(m) * size * charW * 1.06
}

func textH(s string, size float64) float64 {
	return float64(len(strings.Split(s, "\n"))) * size * lineMul
}

func r2(v float64) float64 { return math.Round(v*100)/100 + 0 }

func name(prefix, label string) string {
	l := strings.TrimSpace(strings.SplitN(label, "\n", 2)[0])
	if l == "" {
		return prefix
	}
	if r := []rune(l); len(r) > 40 {
		l = string(r[:40])
	}
	return fmt.Sprintf("%s %s", prefix, l)
}

// --- basic geometry -----------------------------------------------------------

// clipRect: where the segment center -> toward exits the rectangle.
func clipRect(x, y, w, h float64, toward Pt) Pt {
	cx, cy := x+w/2, y+h/2
	dx, dy := toward.X-cx, toward.Y-cy
	if dx == 0 && dy == 0 {
		return Pt{cx, cy}
	}
	t := 1 / math.Max(math.Abs(dx)/(w/2), math.Abs(dy)/(h/2))
	return Pt{cx + dx*t, cy + dy*t}
}

func clipDiamond(x, y, w, h float64, toward Pt) Pt {
	cx, cy := x+w/2, y+h/2
	dx, dy := toward.X-cx, toward.Y-cy
	if dx == 0 && dy == 0 {
		return Pt{cx, cy}
	}
	t := 1 / (math.Abs(dx)/(w/2) + math.Abs(dy)/(h/2))
	return Pt{cx + dx*t, cy + dy*t}
}

func clipEllipse(x, y, w, h float64, toward Pt) Pt {
	cx, cy := x+w/2, y+h/2
	dx, dy := toward.X-cx, toward.Y-cy
	if dx == 0 && dy == 0 {
		return Pt{cx, cy}
	}
	t := 1 / math.Hypot(dx/(w/2), dy/(h/2))
	return Pt{cx + dx*t, cy + dy*t}
}

// midpointOf: the point at half the length of a polyline.
func midpointOf(pts []Pt) Pt {
	total := 0.0
	for i := 1; i < len(pts); i++ {
		total += math.Hypot(pts[i].X-pts[i-1].X, pts[i].Y-pts[i-1].Y)
	}
	left := total / 2
	for i := 1; i < len(pts); i++ {
		seg := math.Hypot(pts[i].X-pts[i-1].X, pts[i].Y-pts[i-1].Y)
		if left <= seg && seg > 0 {
			t := left / seg
			return Pt{pts[i-1].X + (pts[i].X-pts[i-1].X)*t, pts[i-1].Y + (pts[i].Y-pts[i-1].Y)*t}
		}
		left -= seg
	}
	return pts[0]
}

// shift translates all the elements.
func (s *Scene) shift(dx, dy float64) {
	for i, it := range s.Items {
		switch x := it.(type) {
		case Box:
			x.X, x.Y = x.X+dx, x.Y+dy
			s.Items[i] = x
		case Text:
			x.X, x.Y = x.X+dx, x.Y+dy
			s.Items[i] = x
		case Line:
			pts := make([]Pt, len(x.Pts))
			for k, p := range x.Pts {
				pts[k] = Pt{p.X + dx, p.Y + dy}
			}
			x.Pts = pts
			s.Items[i] = x
		case Poly:
			pts := make([]Pt, len(x.Pts))
			for k, p := range x.Pts {
				pts[k] = Pt{p.X + dx, p.Y + dy}
			}
			x.Pts = pts
			s.Items[i] = x
		}
	}
}
