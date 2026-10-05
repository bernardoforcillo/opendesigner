package diagram

import (
	"fmt"
	"math"
	"strings"
)

// La SCENA è il livello intermedio fra i parser (che sanno di Mermaid e di UML)
// e i nodi del documento (che sanno di rect, vettori e testo): i primi
// producono primitive geometriche, `build.go` le traduce in nodi. Così ogni
// tipo di diagramma disegna con lo stesso vocabolario e nessuno conosce
// protobuf.

// Pt è un punto nello spazio del diagramma (origine in alto a sinistra).
type Pt struct{ X, Y float64 }

// RGB è un colore opaco 0..1.
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

// Shape è la forma di un Box.
type Shape int

const (
	ShapeRect Shape = iota
	ShapeRound
	ShapeStadium
	ShapeEllipse
	ShapeDiamond
)

// Box è una forma chiusa con riempimento e contorno.
type Box struct {
	X, Y, W, H float64
	Shape      Shape
	Radius     float64 // solo ShapeRect/ShapeRound
	Fill       *RGB    // nil = nessun riempimento
	Stroke     *RGB    // nil = nessun contorno
	StrokeW    float64
	Name       string
}

// Text è un blocco di testo. X/Y/W/H è il box; Align decide dove cade il testo.
type Text struct {
	X, Y, W, H float64
	Content    string
	Size       float64
	Bold       bool
	Align      string // left | center | right
	Color      RGB
	Name       string
}

// HeadKind è la decorazione all'estremità di una linea.
type HeadKind int

const (
	HeadNone          HeadKind = iota
	HeadArrow                  // triangolo pieno (messaggi, transizioni)
	HeadOpen                   // freccia aperta a V (associazione, async)
	HeadTriangle               // triangolo vuoto (ereditarietà, realizzazione)
	HeadDiamond                // rombo vuoto (aggregazione)
	HeadDiamondFilled          // rombo pieno (composizione)
	HeadCross                  // croce (messaggio perso)
)

// Line è una spezzata con decorazioni agli estremi.
type Line struct {
	Pts    []Pt
	Weight float64
	Dashed bool
	Color  RGB
	Start  HeadKind // sul primo punto
	End    HeadKind // sull'ultimo
	Name   string
}

// Poly è un poligono chiuso (frecce, rombi, attori, sfondi non rettangolari).
type Poly struct {
	Pts    []Pt
	Fill   *RGB
	Stroke *RGB
	W      float64
	Name   string
}

// Scene è un diagramma disegnato: elementi in ordine di sovrapposizione
// (il primo sta sotto).
type Scene struct {
	W, H  float64
	Items []any
}

func (s *Scene) add(it ...any) { s.Items = append(s.Items, it...) }

func rgb(c RGB) *RGB { return &c }

// --- misura del testo ---------------------------------------------------------

const (
	fontSize = 14.0
	lineMul  = 1.2
	charW    = 0.54 // larghezza media di un carattere, in multipli del corpo
)

// textW stima la larghezza della riga più lunga a corpo `size`. Il server non ha
// font: la stima è larga di proposito (meglio un po' d'aria che un testo che va
// a capo da solo).
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

// --- geometria di base --------------------------------------------------------

// clipRect: dove il segmento centro -> toward esce dal rettangolo.
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

// midpointOf: il punto a metà della lunghezza di una spezzata.
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

// shift trasla tutti gli elementi.
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
