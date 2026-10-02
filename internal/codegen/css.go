package codegen

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Funzioni PURE che traducono i valori del modello (colori float, gradienti
// normalizzati, ombre) in valori CSS. Riproducono la semantica del canvas
// (web/src/renderer/canvasRenderer.ts), non quella "tipica" di un editor di
// design: dove canvas e CSS divergono lo dice il commento.

// num formatta un numero con al più 3 decimali, senza zeri in coda e senza
// "-0": il file generato non deve contenere le code della virgola mobile.
func num(v float64) string {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return "0"
	}
	v = math.Round(v*1000) / 1000
	if v == 0 {
		return "0"
	}
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// px: "0" per lo zero (valido in CSS senza unità e più idiomatico in Tailwind),
// altrimenti "<n>px".
func px(v float64) string {
	s := num(v)
	if s == "0" {
		return "0"
	}
	return s + "px"
}

func channel(v float32) int {
	f := math.Round(math.Min(1, math.Max(0, float64(v))) * 255)
	return int(f)
}

// colorCSS: "#rgb"/"#rrggbb" se opaco, "rgba(r,g,b,a)" altrimenti (senza spazi:
// il valore finisce anche dentro classi Tailwind, dove gli spazi sono `_`).
// `mul` moltiplica l'alfa: serve a "cuocere" l'opacità di un contenitore nei
// suoi colori (vedi build.go::bakeOpacity).
func colorCSS(c *opendesignerv1.Color, mul float64) string {
	r, g, b := channel(c.GetR()), channel(c.GetG()), channel(c.GetB())
	a := float64(c.GetA()) * mul
	if a >= 0.9995 {
		if r>>4 == r&15 && g>>4 == g&15 && b>>4 == b&15 {
			return fmt.Sprintf("#%x%x%x", r&15, g&15, b&15)
		}
		return fmt.Sprintf("#%02x%02x%02x", r, g, b)
	}
	if a < 0 {
		a = 0
	}
	return fmt.Sprintf("rgba(%d,%d,%d,%s)", r, g, b, num(a))
}

// fill è una tinta già risolta: il colore piatto (per un gradiente: il primo
// stop, come FillLite nel client) e, se c'è, il gradiente.
type fill struct {
	color  *opendesignerv1.Color
	grad   *opendesignerv1.GradientPaint
	radial bool
}

var defaultGrey = &opendesignerv1.Color{R: 0.8, G: 0.8, B: 0.8, A: 1}
var black = &opendesignerv1.Color{R: 0, G: 0, B: 0, A: 1}

// toFill traduce un Paint come web/src/store/types.ts::toFillLite: un paint
// assente o senza `kind` è nero opaco.
func toFill(p *opendesignerv1.Paint) fill {
	switch k := p.GetKind().(type) {
	case *opendesignerv1.Paint_Linear:
		return gradFill(k.Linear, false)
	case *opendesignerv1.Paint_Radial:
		return gradFill(k.Radial, true)
	case *opendesignerv1.Paint_Solid:
		if c := k.Solid.GetColor(); c != nil {
			return fill{color: c}
		}
	}
	return fill{color: black}
}

func gradFill(g *opendesignerv1.GradientPaint, radial bool) fill {
	first := black
	if len(g.GetStops()) > 0 && g.GetStops()[0].GetColor() != nil {
		first = g.GetStops()[0].GetColor()
	}
	return fill{color: first, grad: g, radial: radial}
}

// resolvedFill: la tinta con cui un nodo si riempie, DEFAULT COMPRESO (grigio
// chiaro): è la stessa decisione di canvasRenderer.ts::resolvedFill.
func resolvedFill(fills []*opendesignerv1.Paint) fill {
	if len(fills) == 0 {
		return fill{color: defaultGrey}
	}
	return toFill(fills[0])
}

// gradientCSS traduce un gradiente nel linear-gradient()/radial-gradient() CSS
// che disegna gli stessi pixel del canvas sul box w x h. ok=false per un
// gradiente degenere (meno di due stop, asse o raggio nulli): il canvas ripiega
// sul colore piatto, e così deve fare chi chiama.
//
// GEOMETRIA. Il modello dà l'asse in coordinate normalizzate: P1=(x1*w,y1*h),
// P2=(x2*w,y2*h). Il canvas colora ogni punto in base alla sua proiezione
// sull'asse, e fuori da [P1,P2] estende i colori estremi. CSS fa lo stesso ma
// con una retta fissata dall'ANGOLO che passa per il CENTRO del box e la cui
// lunghezza è quella che tocca gli angoli: |w*sin| + |h*cos|. Basta quindi
// ricavare l'angolo dalla direzione dell'asse e riscrivere le posizioni degli
// stop come percentuali di QUELLA lunghezza, spostate dello scarto fra P1 e il
// centro proiettato sull'asse. Non è "to bottom right": su un box non quadrato
// la diagonale CSS non ha la direzione (w,h) che il canvas userebbe.
//
// RADIALE: centro P1, raggio |P2-P1| in px (cerchio, non ellisse), stop in
// percentuale del raggio.
func gradientCSS(g *opendesignerv1.GradientPaint, radial bool, w, h, mul float64) (string, bool) {
	stops := g.GetStops()
	if len(stops) < 2 {
		return "", false
	}
	x1, y1 := g.GetX1()*w, g.GetY1()*h
	x2, y2 := g.GetX2()*w, g.GetY2()*h
	length := math.Hypot(x2-x1, y2-y1)
	if !(length > 0) {
		return "", false
	}
	clamp := func(p float64) float64 { return math.Min(1, math.Max(0, p)) }
	pts := expandStops(stops, clamp)
	var parts []string
	if radial {
		for _, st := range pts {
			parts = append(parts, colorCSS(st.c, mul)+" "+pct(st.pos*100))
		}
		return fmt.Sprintf("radial-gradient(circle %s at %s %s,%s)", px(length), px(x1), px(y1), strings.Join(parts, ",")), true
	}
	dx, dy := (x2-x1)/length, (y2-y1)/length
	// Angolo CSS: 0deg punta in alto, cresce in senso orario.
	deg := math.Atan2(dx, -dy) * 180 / math.Pi
	if deg < 0 {
		deg += 360
	}
	lcss := math.Abs(w*dx) + math.Abs(h*dy)
	if !(lcss > 0) {
		return "", false
	}
	// Posizione di P1 lungo l'asse, misurata dal centro del box.
	t1 := (x1-w/2)*dx + (y1-h/2)*dy
	for _, st := range pts {
		at := (t1+st.pos*length)/lcss + 0.5
		parts = append(parts, colorCSS(st.c, mul)+" "+pct(at*100))
	}
	return fmt.Sprintf("linear-gradient(%sdeg,%s)", num(round3(deg)), strings.Join(parts, ",")), true
}

type stopPoint struct {
	pos float64
	c   *opendesignerv1.Color
}

// alphaSubdivisions: in quanti tratti si spezza un segmento con alfa diverse.
const alphaSubdivisions = 8

// expandStops porta gli stop del modello in punti CSS. Il canvas interpola i
// colori NON premoltiplicati: da giallo opaco a rosa TRASPARENTE passa per
// gialli-rosati con alfa decrescente. CSS interpola premoltiplicato, e lo
// stesso gradiente resterebbe giallo che sfuma. Dove due stop vicini hanno alfa
// diverse il segmento si spezza in tratti con i colori già interpolati alla
// maniera del canvas: fra due punti vicini la differenza fra i due metodi è
// sotto la soglia del visibile.
func expandStops(stops []*opendesignerv1.GradientStop, clamp func(float64) float64) []stopPoint {
	var out []stopPoint
	for i, st := range stops {
		p := clamp(st.GetPosition())
		if i > 0 {
			prev := stops[i-1]
			pp := clamp(prev.GetPosition())
			if prev.GetColor().GetA() != st.GetColor().GetA() && p > pp {
				for k := 1; k < alphaSubdivisions; k++ {
					t := float64(k) / alphaSubdivisions
					out = append(out, stopPoint{pp + (p-pp)*t, lerpColor(prev.GetColor(), st.GetColor(), float32(t))})
				}
			}
		}
		out = append(out, stopPoint{p, st.GetColor()})
	}
	return out
}

func lerpColor(a, b *opendesignerv1.Color, t float32) *opendesignerv1.Color {
	l := func(x, y float32) float32 { return x + (y-x)*t }
	return &opendesignerv1.Color{R: l(a.GetR(), b.GetR()), G: l(a.GetG(), b.GetG()), B: l(a.GetB(), b.GetB()), A: l(a.GetA(), b.GetA())}
}

func round3(v float64) float64 { return math.Round(v*1000) / 1000 }

func pct(v float64) string {
	s := num(v)
	if s == "0" {
		return "0%"
	}
	return s + "%"
}

// rotationDeg: la rotazione che il renderer applica davvero (multipli di 360
// non ruotano, come canvas/transform.ts::isUnrotated).
func rotates(deg float64) bool { return math.Mod(deg, 360) != 0 }

// shadowCSS: "dx dy blur color" per box-shadow e text-shadow. Lo shadowBlur del
// canvas ha la stessa definizione del blur-radius CSS (deviazione standard =
// metà), quindi il valore passa invariato.
func shadowCSS(s *opendesignerv1.DropShadow, mul float64) string {
	return fmt.Sprintf("%s %s %s %s", px(s.GetOffsetX()), px(s.GetOffsetY()), px(math.Max(0, s.GetBlur())), colorCSS(s.GetColor(), mul))
}

// firstShadow / firstBlur: il canvas disegna la PRIMA ombra e la PRIMA
// sfocatura con raggio > 0 (canvasRenderer.ts::firstShadow/firstBlur).
func firstShadow(effects []*opendesignerv1.Effect) *opendesignerv1.DropShadow {
	for _, e := range effects {
		if s := e.GetDropShadow(); s != nil {
			return s
		}
	}
	return nil
}

func firstBlur(effects []*opendesignerv1.Effect) *opendesignerv1.LayerBlur {
	for _, e := range effects {
		if b := e.GetLayerBlur(); b != nil && b.GetRadius() > 0 {
			return b
		}
	}
	return nil
}

// strokeAlign: UNSPECIFIED collassa su CENTER (store/types.ts::toStrokeLite).
func strokeAlign(a opendesignerv1.StrokeAlign) opendesignerv1.StrokeAlign {
	if a == opendesignerv1.StrokeAlign_STROKE_ALIGN_INSIDE || a == opendesignerv1.StrokeAlign_STROKE_ALIGN_OUTSIDE {
		return a
	}
	return opendesignerv1.StrokeAlign_STROKE_ALIGN_CENTER
}

// strokeRings traduce i tratti di un box in anelli di box-shadow, nell'ordine
// in cui CSS li sovrappone (il PRIMO della lista sta in cima, quindi l'ultimo
// tratto del modello -- disegnato per ultimo dal canvas -- va per primo).
//
//	inside   inset 0 0 0 Wpx   (fascia interna, sopra al riempimento e sotto ai figli)
//	outside  0 0 0 Wpx         (fascia esterna: box-shadow non si dipinge MAI
//	                            dentro il box, quindi non copre il riempimento)
//	center   i due anelli da W/2 affiancati
//
// Un tratto con peso <= 0 non è un tratto (stessa regola del canvas). Un
// tratto con gradiente ripiega sul primo colore: un anello di box-shadow non
// può essere sfumato.
func strokeRings(strokes []*opendesignerv1.Stroke, mul float64) []string {
	var rings []string
	for i := len(strokes) - 1; i >= 0; i-- {
		s := strokes[i]
		if !(s.GetWeight() > 0) {
			continue
		}
		col := colorCSS(toFill(s.GetPaint()).color, mul)
		w := s.GetWeight()
		switch strokeAlign(s.GetAlign()) {
		case opendesignerv1.StrokeAlign_STROKE_ALIGN_INSIDE:
			rings = append(rings, fmt.Sprintf("inset 0 0 0 %s %s", px(w), col))
		case opendesignerv1.StrokeAlign_STROKE_ALIGN_OUTSIDE:
			rings = append(rings, fmt.Sprintf("0 0 0 %s %s", px(w), col))
		default:
			rings = append(rings,
				fmt.Sprintf("0 0 0 %s %s", px(w/2), col),
				fmt.Sprintf("inset 0 0 0 %s %s", px(w/2), col))
		}
	}
	return rings
}
