// Package samples costruisce documenti di esempio per i test dell'export di
// codice e per lo script di parità dei pixel (web/scripts/export-parity.mjs):
// una galleria che copre ogni cosa che il generatore sa dire in CSS e un flusso
// di tre schermate con test e2e.
//
// I documenti si costruiscono con core.Apply (CreateNode, SetFlow...), non
// scrivendo le strutture a mano: così l'auto layout è già disposto dal core e il
// documento è valido per costruzione, come quello che arriva dal server.
package samples

import (
	"fmt"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

// B è un costruttore di documenti.
type B struct {
	Doc *opendesignerv1.Document
	seq int
}

// New: documento vuoto con la pagina "page1".
func New(id, name string) *B { return &B{Doc: core.NewDocument(id, name)} }

func (b *B) must(op *opendesignerv1.Op) {
	if err := core.Apply(b.Doc, op); err != nil {
		panic(fmt.Sprintf("samples: %v", err))
	}
}

// Opt modifica un nodo prima della creazione.
type Opt func(*opendesignerv1.Node)

// Add crea un nodo (visibile, opacità 1, order_key crescente) e lo ritorna.
func (b *B) Add(id, parent, name string, x, y, w, h float64, opts ...Opt) *opendesignerv1.Node {
	b.seq++
	n := &opendesignerv1.Node{
		Id: id, ParentId: parent, OrderKey: fmt.Sprintf("a%05d", b.seq), Name: name,
		Visible: true, Opacity: 1, X: x, Y: y, Width: w, Height: h,
		Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}},
	}
	for _, o := range opts {
		o(n)
	}
	b.must(&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}})
	return b.Doc.Nodes[id]
}

// Flow e Transition: upsert tramite gli op.
func (b *B) Flow(id, name, start string) {
	b.must(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetFlow{SetFlow: &opendesignerv1.SetFlow{Flow: &opendesignerv1.Flow{Id: id, Name: name, StartId: start}}}})
}

func (b *B) Transition(t *opendesignerv1.Transition) {
	b.must(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetTransition{SetTransition: &opendesignerv1.SetTransition{Transition: t}}})
}

func (b *B) Component(id, root, name string) {
	b.must(&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateComponent{CreateComponent: &opendesignerv1.CreateComponent{ComponentId: id, RootNodeId: root, Name: name}}})
}

// ---------------------------------------------------------------------------
// colori e tinte
// ---------------------------------------------------------------------------

// C: colore opaco; CA: con alfa.
func C(r, g, b float32) *opendesignerv1.Color { return &opendesignerv1.Color{R: r, G: g, B: b, A: 1} }
func CA(r, g, b, a float32) *opendesignerv1.Color {
	return &opendesignerv1.Color{R: r, G: g, B: b, A: a}
}

func Solid(c *opendesignerv1.Color) *opendesignerv1.Paint {
	return &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{Color: c}}}
}

// Stop: un punto di gradiente.
type Stop struct {
	At float64
	C  *opendesignerv1.Color
}

// S: uno stop (posizione 0..1, colore).
func S(at float64, c *opendesignerv1.Color) Stop { return Stop{At: at, C: c} }

func grad(x1, y1, x2, y2 float64, stops []Stop) *opendesignerv1.GradientPaint {
	g := &opendesignerv1.GradientPaint{X1: x1, Y1: y1, X2: x2, Y2: y2}
	for _, s := range stops {
		g.Stops = append(g.Stops, &opendesignerv1.GradientStop{Color: s.C, Position: s.At})
	}
	return g
}

func Linear(x1, y1, x2, y2 float64, stops ...Stop) *opendesignerv1.Paint {
	return &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Linear{Linear: grad(x1, y1, x2, y2, stops)}}
}

func Radial(x1, y1, x2, y2 float64, stops ...Stop) *opendesignerv1.Paint {
	return &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Radial{Radial: grad(x1, y1, x2, y2, stops)}}
}

// ---------------------------------------------------------------------------
// opzioni
// ---------------------------------------------------------------------------

func Fill(ps ...*opendesignerv1.Paint) Opt { return func(n *opendesignerv1.Node) { n.Fills = ps } }
func Rot(deg float64) Opt                  { return func(n *opendesignerv1.Node) { n.Rotation = deg } }
func Opacity(o float64) Opt                { return func(n *opendesignerv1.Node) { n.Opacity = o } }
func Hidden() Opt                          { return func(n *opendesignerv1.Node) { n.Visible = false } }

func Meta(kv ...string) Opt {
	return func(n *opendesignerv1.Node) {
		n.Meta = map[string]string{}
		for i := 0; i+1 < len(kv); i += 2 {
			n.Meta[kv[i]] = kv[i+1]
		}
	}
}

func Rect(radius float64) Opt {
	return func(n *opendesignerv1.Node) {
		n.Shape = &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{CornerRadius: radius}}
	}
}

func Ellipse() Opt {
	return func(n *opendesignerv1.Node) {
		n.Shape = &opendesignerv1.Node_Ellipse{Ellipse: &opendesignerv1.EllipseNode{}}
	}
}

func Group() Opt {
	return func(n *opendesignerv1.Node) {
		n.Shape = &opendesignerv1.Node_Group{Group: &opendesignerv1.GroupNode{}}
	}
}

// Frame: contenitore; clips = ritaglio, al = auto layout (nil = nessuno).
func Frame(clips bool, al *opendesignerv1.AutoLayout) Opt {
	return func(n *opendesignerv1.Node) {
		n.Shape = &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{ClipsContent: clips, AutoLayout: al}}
	}
}

// Text: stile con i soli campi che servono (famiglia "", peso "", interlinea 0 = default).
func Text(content string, size float64, weight string, align opendesignerv1.TextAlign) Opt {
	return func(n *opendesignerv1.Node) {
		n.Shape = &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{
			Content: content,
			Style:   &opendesignerv1.TextStyle{FontSize: size, FontWeight: weight, Align: align},
		}}
	}
}

// TextStyled: stile completo.
func TextStyled(content string, st *opendesignerv1.TextStyle) Opt {
	return func(n *opendesignerv1.Node) {
		n.Shape = &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{Content: content, Style: st}}
	}
}

func Image(hash string) Opt {
	return func(n *opendesignerv1.Node) {
		n.Shape = &opendesignerv1.Node_Image{Image: &opendesignerv1.ImageNode{AssetHash: hash}}
	}
}

// Vector: contorni dati come lista di (closed, anchors...). Un ancoraggio è
// {x, y, inX, inY, outX, outY}.
type Anchor = opendesignerv1.Anchor

func Vector(subs ...*opendesignerv1.SubPath) Opt {
	return func(n *opendesignerv1.Node) {
		n.Shape = &opendesignerv1.Node_Vector{Vector: &opendesignerv1.VectorNode{Subpaths: subs}}
	}
}

func Sub(closed bool, anchors ...*opendesignerv1.Anchor) *opendesignerv1.SubPath {
	return &opendesignerv1.SubPath{Closed: closed, Anchors: anchors}
}

// Pt: ancoraggio con maniglie relative.
func Pt(x, y, inX, inY, outX, outY float64) *opendesignerv1.Anchor {
	return &opendesignerv1.Anchor{X: x, Y: y, InX: inX, InY: inY, OutX: outX, OutY: outY}
}

func Instance(componentID string, overrides ...*opendesignerv1.InstanceOverride) Opt {
	return func(n *opendesignerv1.Node) {
		n.Shape = &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: componentID, Overrides: overrides}}
	}
}

func OverrideFill(masterID string, p *opendesignerv1.Paint) *opendesignerv1.InstanceOverride {
	return &opendesignerv1.InstanceOverride{MasterNodeId: masterID, Fills: []*opendesignerv1.Paint{p}, FillsPresent: true}
}

func OverrideText(masterID, text string) *opendesignerv1.InstanceOverride {
	return &opendesignerv1.InstanceOverride{MasterNodeId: masterID, Text: text, TextPresent: true}
}

// StrokeOpt aggiunge un tratto (se ne possono aggiungere più d'uno).
func StrokeOpt(weight float64, align opendesignerv1.StrokeAlign, p *opendesignerv1.Paint) Opt {
	return func(n *opendesignerv1.Node) {
		n.Strokes = append(n.Strokes, &opendesignerv1.Stroke{Paint: p, Weight: weight, Align: align})
	}
}

const (
	Center  = opendesignerv1.StrokeAlign_STROKE_ALIGN_CENTER
	Inside  = opendesignerv1.StrokeAlign_STROKE_ALIGN_INSIDE
	Outside = opendesignerv1.StrokeAlign_STROKE_ALIGN_OUTSIDE

	AlignLeft   = opendesignerv1.TextAlign_TEXT_ALIGN_LEFT
	AlignCenter = opendesignerv1.TextAlign_TEXT_ALIGN_CENTER
	AlignRight  = opendesignerv1.TextAlign_TEXT_ALIGN_RIGHT
)

// Shadow e Blur aggiungono effetti (si possono combinare).
func Shadow(c *opendesignerv1.Color, dx, dy, blur float64) Opt {
	return func(n *opendesignerv1.Node) {
		n.Effects = append(n.Effects, &opendesignerv1.Effect{Kind: &opendesignerv1.Effect_DropShadow{DropShadow: &opendesignerv1.DropShadow{Color: c, OffsetX: dx, OffsetY: dy, Blur: blur}}})
	}
}

func Blur(radius float64) Opt {
	return func(n *opendesignerv1.Node) {
		n.Effects = append(n.Effects, &opendesignerv1.Effect{Kind: &opendesignerv1.Effect_LayerBlur{LayerBlur: &opendesignerv1.LayerBlur{Radius: radius}}})
	}
}

// Layout: un AutoLayout in una riga.
func Layout(vertical bool, spacing, pl, pt, pr, pb float64, main, cross opendesignerv1.LayoutAlign, hugW, hugH bool) *opendesignerv1.AutoLayout {
	d := opendesignerv1.LayoutDirection_LAYOUT_DIRECTION_HORIZONTAL
	if vertical {
		d = opendesignerv1.LayoutDirection_LAYOUT_DIRECTION_VERTICAL
	}
	return &opendesignerv1.AutoLayout{
		Direction: d, Spacing: spacing, PaddingLeft: pl, PaddingTop: pt, PaddingRight: pr, PaddingBottom: pb,
		MainAlign: main, CrossAlign: cross, HugWidth: hugW, HugHeight: hugH,
	}
}

const (
	AStart   = opendesignerv1.LayoutAlign_LAYOUT_ALIGN_START
	ACenter  = opendesignerv1.LayoutAlign_LAYOUT_ALIGN_CENTER
	AEnd     = opendesignerv1.LayoutAlign_LAYOUT_ALIGN_END
	ABetween = opendesignerv1.LayoutAlign_LAYOUT_ALIGN_SPACE_BETWEEN
)

// Clip registra una clip di animazione (SetClip passa dal core: valida anche
// qui che i riferimenti esistano).
func (b *B) Clip(c *opendesignerv1.Clip) {
	b.must(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetClip{SetClip: &opendesignerv1.SetClip{Clip: c}}})
}

// KF: un keyframe (tempo in ms, valore, easing).
func KF(t, v float64, easing string) *opendesignerv1.Keyframe {
	return &opendesignerv1.Keyframe{Time: t, Value: v, Easing: easing}
}

// Tr: una traccia (nodo, proprietà) con i suoi keyframe.
func Tr(node, prop string, kfs ...*opendesignerv1.Keyframe) *opendesignerv1.Track {
	return &opendesignerv1.Track{NodeId: node, Prop: prop, Keyframes: kfs}
}
