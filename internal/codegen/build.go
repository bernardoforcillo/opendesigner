package codegen

import (
	"fmt"
	"math"
	"regexp"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

// Document -> IR. Qui sta tutta la SEMANTICA del disegno (cosa disegna il
// canvas, e come lo si dice in CSS); i renderer in html.go e react.go non
// prendono nessuna decisione sul disegno, scrivono solo la sintassi.
//
// Convenzioni di layout:
//   - auto layout: il frame diventa flexbox (direzione, gap, padding, justify/
//     align) e i figli che il core dispone sono IN FLUSSO (position:relative,
//     flex-shrink:0); il core ha già scritto x/y nel documento, qui non si
//     ricalcola niente -- si dice a CSS di rifare la stessa disposizione;
//   - tutto il resto: contenitore position:relative/absolute con figli
//     position:absolute a left/top = x/y (coordinate relative al parent, come
//     nel modello). I figli in flusso sono position:relative perché CSS dipinge
//     i posizionati sopra i non posizionati a prescindere dall'ordine nel DOM,
//     e l'ordine di disegno del canvas è l'ordine dei fratelli.

// builder costruisce l'IR di UNA schermata.
type builder struct {
	doc    *opendesignerv1.Document
	assets AssetSource
	// files raccoglie gli asset copiati (percorso nell'output -> byte); è
	// condiviso fra le schermate, così lo stesso asset si scrive una volta sola.
	files map[string][]byte
	// fileDir/urlPrefix: dove si scrivono gli asset e con quale URL si
	// referenziano ("assets/" per html, "public/assets/" e "/assets/" per react).
	fileDir, urlPrefix string
	warnings           *[]string
	// triggers: le transizioni della schermata corrente, per id dell'elemento.
	triggers map[string][]Trigger
	// anim: le animazioni della schermata corrente per id del nodo (planAnimations).
	anim map[string]*ElemAnim
}

// bctx è lo stato che scende con la ricorsione.
type bctx struct {
	// root: la radice della schermata (in flusso, senza left/top).
	root bool
	// flowChild: il nodo è un figlio in flusso di un frame ad auto layout.
	flowChild bool
	// origin: il nodo si piazza a left:0/top:0 (radice del master di un'istanza:
	// la discesa dell'istanza sottrae l'origine del master).
	origin bool
	// overrides: gli override dell'istanza in cui si sta scendendo.
	overrides map[string]*opendesignerv1.InstanceOverride
	// idPrefix: percorso delle istanze attraversate, per data-node-id.
	idPrefix string
	// visited: componenti in corso di espansione su questo ramo (un master che
	// contiene un'istanza di sé stesso non deve ricorrere all'infinito).
	visited map[string]bool
}

func (c bctx) inInstance() bool { return c.idPrefix != "" }

// participates: i figli che il core dispone in fila (core/layout.go).
func participates(n *opendesignerv1.Node) bool {
	if !n.GetVisible() {
		return false
	}
	switch n.GetShape().(type) {
	case nil, *opendesignerv1.Node_Rect, *opendesignerv1.Node_Ellipse, *opendesignerv1.Node_Text,
		*opendesignerv1.Node_Image, *opendesignerv1.Node_Vector, *opendesignerv1.Node_Frame:
		return true
	}
	return false
}

func (b *builder) warn(format string, a ...any) {
	if b.warnings != nil {
		*b.warnings = append(*b.warnings, fmt.Sprintf(format, a...))
	}
}

// buildScreen costruisce l'albero IR della schermata `n`.
func (b *builder) buildScreen(n *opendesignerv1.Node) *Element {
	b.planAnimations(n)
	return b.element(n, bctx{root: true, visited: map[string]bool{}})
}

// element traduce un nodo (e il suo sottoalbero). nil = niente da emettere.
func (b *builder) element(n *opendesignerv1.Node, c bctx) *Element {
	if !n.GetVisible() {
		return nil
	}
	var el *Element
	switch n.GetShape().(type) {
	case *opendesignerv1.Node_Group:
		el = b.groupElement(n, c)
	case *opendesignerv1.Node_Instance:
		el = b.instanceElement(n, c)
	default:
		el = b.shapeElement(n, c)
	}
	if el == nil {
		return nil
	}
	el.NodeID = n.GetId()
	el.NodeName = n.GetName()
	el.Meta = n.GetMeta()
	id := c.idPrefix + n.GetId()
	el.Attrs = append([]Attr{{"data-node-id", id}}, el.Attrs...)
	if tid := n.GetMeta()["test.id"]; tid != "" && !c.inInstance() { // un test.id nel master si duplicherebbe in ogni istanza
		el.Attrs = insertAfterNodeID(el.Attrs, Attr{"data-testid", tid})
	}
	if !c.inInstance() {
		el.Triggers = b.triggers[n.GetId()]
		b.attachAnim(el, n)
	}
	return el
}

func insertAfterNodeID(attrs []Attr, a Attr) []Attr {
	out := make([]Attr, 0, len(attrs)+1)
	out = append(out, attrs[0], a)
	return append(out, attrs[1:]...)
}

// placement scrive position/left/top.
func placement(el *Element, n *opendesignerv1.Node, c bctx) {
	switch {
	case c.root:
		el.addStyle("position", "relative")
	case c.flowChild:
		el.addStyle("position", "relative")
		el.addStyle("flex-shrink", "0")
	default:
		el.addStyle("position", "absolute")
		if c.origin {
			el.addStyle("left", "0")
			el.addStyle("top", "0")
		} else {
			el.addStyle("left", px(n.GetX()))
			el.addStyle("top", px(n.GetY()))
		}
	}
}

func rotation(el *Element, n *opendesignerv1.Node) {
	if rotates(n.GetRotation()) {
		// CSS ruota in senso orario attorno al centro del box, come il canvas:
		// stessa convenzione, nessuna conversione.
		el.addStyle("transform", "rotate("+num(n.GetRotation())+"deg)")
	}
}

// children traduce i figli di `n` nell'ordine di disegno.
func (b *builder) children(el *Element, n *opendesignerv1.Node, c bctx) {
	al := n.GetFrame().GetAutoLayout()
	for _, k := range core.ChildrenOf(b.doc, n.GetId()) {
		cc := c
		cc.root, cc.origin = false, false
		cc.flowChild = al != nil && participates(k)
		if ce := b.element(k, cc); ce != nil {
			el.Children = append(el.Children, ce)
		}
	}
}

func hasVisibleKids(doc *opendesignerv1.Document, id string) bool {
	for _, k := range core.ChildrenOf(doc, id) {
		if k.GetVisible() {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// gruppi e istanze
// ---------------------------------------------------------------------------

// groupElement: un contenitore posizionato SENZA paint (un gruppo non si
// disegna). Ha width/height del nodo (di norma 0) perché la rotazione del
// canvas è attorno al centro di quel box.
func (b *builder) groupElement(n *opendesignerv1.Node, c bctx) *Element {
	el := &Element{Tag: "div"}
	placement(el, n, c)
	el.addStyle("width", px(n.GetWidth()))
	el.addStyle("height", px(n.GetHeight()))
	rotation(el, n)
	b.children(el, n, c)
	return el
}

// instanceElement espande il master dell'istanza INLINE (nessuna estrazione di
// componenti): un wrapper alla posizione dell'istanza con dentro il sottoalbero
// del master a origine 0,0, con gli override per nodo applicati.
func (b *builder) instanceElement(n *opendesignerv1.Node, c bctx) *Element {
	inst := n.GetInstance()
	comp := b.doc.GetComponents()[inst.GetComponentId()]
	master := b.doc.GetNodes()[comp.GetRootNodeId()]
	if comp == nil || master == nil || c.visited[inst.GetComponentId()] {
		// Come il canvas: componente o master assente (o ricorsivo) = niente.
		if comp == nil || master == nil {
			b.warn("istanza %q: componente %q o suo master non trovato, omessa", n.GetName(), inst.GetComponentId())
		}
		return nil
	}
	el := &Element{Tag: "div"}
	placement(el, n, c)
	el.addStyle("width", px(n.GetWidth()))
	el.addStyle("height", px(n.GetHeight()))
	rotation(el, n)

	ov := map[string]*opendesignerv1.InstanceOverride{}
	for _, o := range inst.GetOverrides() {
		ov[o.GetMasterNodeId()] = o
	}
	visited := map[string]bool{inst.GetComponentId(): true}
	for k := range c.visited {
		visited[k] = true
	}
	cc := bctx{origin: true, overrides: ov, idPrefix: c.idPrefix + n.GetId() + "/", visited: visited}
	if ce := b.element(master, cc); ce != nil {
		el.Children = append(el.Children, ce)
	}
	return el
}

// withOverride: il nodo del master con l'override dell'istanza applicato
// (canvasRenderer.ts::withOverride): fills se presenti e, per un testo, il
// contenuto. Mai la geometria.
func withOverride(n *opendesignerv1.Node, ov *opendesignerv1.InstanceOverride) *opendesignerv1.Node {
	if ov == nil {
		return n
	}
	eff := n
	if ov.GetFillsPresent() {
		eff = cloneShallow(eff)
		eff.Fills = ov.GetFills()
	}
	if ov.GetTextPresent() && eff.GetText() != nil {
		eff = cloneShallow(eff)
		eff.Shape = &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{Content: ov.GetText(), Style: eff.GetText().GetStyle()}}
	}
	return eff
}

// cloneShallow copia i campi che withOverride può cambiare. Non si usa
// proto.Clone: un nodo ha poco e la copia profonda di un Node con meta e
// vettori per ogni istanza costerebbe senza motivo.
func cloneShallow(n *opendesignerv1.Node) *opendesignerv1.Node {
	return &opendesignerv1.Node{
		Id: n.Id, ParentId: n.ParentId, OrderKey: n.OrderKey, Name: n.Name, Visible: n.Visible, Opacity: n.Opacity,
		X: n.X, Y: n.Y, Width: n.Width, Height: n.Height, Rotation: n.Rotation,
		Fills: n.Fills, Strokes: n.Strokes, Effects: n.Effects, Shape: n.Shape, Meta: n.Meta,
	}
}

// ---------------------------------------------------------------------------
// forme
// ---------------------------------------------------------------------------

// shapeElement: rect, ellisse, frame, testo, immagine, vettoriale.
func (b *builder) shapeElement(n *opendesignerv1.Node, c bctx) *Element {
	eff := withOverride(n, c.overrides[n.GetId()])
	switch eff.GetShape().(type) {
	case *opendesignerv1.Node_Text:
		return b.textElement(n, eff, c)
	case *opendesignerv1.Node_Vector:
		return b.vectorElement(n, eff, c)
	case *opendesignerv1.Node_Image:
		return b.imageElement(n, eff, c)
	}
	// rect / ellipse / frame. Un box con un lato <= 0 non lascia pixel (guard
	// di drawNode); un FRAME così resta comunque contenitore dei figli.
	_, isFrame := eff.GetShape().(*opendesignerv1.Node_Frame)
	_, isEllipse := eff.GetShape().(*opendesignerv1.Node_Ellipse)
	paintable := eff.GetWidth() > 0 && eff.GetHeight() > 0
	if !paintable && !isFrame {
		return nil
	}
	container := isFrame && hasVisibleKids(b.doc, n.GetId())
	// L'opacità si "cuoce" nei colori propri del nodo (mul) invece di scriverla
	// come `opacity` CSS in due casi:
	//  - contenitore: il canvas imposta globalAlpha PER NODO e non lo eredita,
	//    quindi l'opacità di un frame NON attenua i figli; con `opacity` CSS sì;
	//  - nodo con ombra: il canvas disegna la forma con alfa SOPRA l'ombra (che
	//    ha la stessa alfa), cioè l'ombra traspare dalla forma; con `opacity`
	//    CSS il filtro si applica prima e la forma opaca copre l'ombra.
	mul := 1.0
	bake := container || (firstShadow(eff.GetEffects()) != nil && eff.GetOpacity() != 1)
	if bake {
		mul = eff.GetOpacity()
	}

	el := &Element{Tag: "div"}
	placement(el, n, c)
	el.addStyle("width", sizeOf(eff, true))
	el.addStyle("height", sizeOf(eff, false))
	al := eff.GetFrame().GetAutoLayout()
	if al != nil {
		flexProps(el, al)
	}
	if isFrame && eff.GetFrame().GetClipsContent() {
		el.addStyle("overflow", "hidden")
	}
	rotation(el, eff)
	dropShadow := ""
	if paintable {
		dropShadow = boxPaint(el, eff, isFrame, isEllipse, mul, container)
	}
	if !bake && eff.GetOpacity() != 1 {
		el.addStyle("opacity", num(eff.GetOpacity()))
	}
	if paintable {
		setFilter(el, dropShadow, firstBlur(eff.GetEffects()))
	}
	b.children(el, n, c)
	return el
}

// sizeOf: "fit-content" per un asse hug di un frame ad auto layout, altrimenti
// la misura in px.
func sizeOf(n *opendesignerv1.Node, width bool) string {
	if al := n.GetFrame().GetAutoLayout(); al != nil {
		if width && al.GetHugWidth() || !width && al.GetHugHeight() {
			return "fit-content"
		}
	}
	if width {
		return px(n.GetWidth())
	}
	return px(n.GetHeight())
}

func flexProps(el *Element, al *opendesignerv1.AutoLayout) {
	el.addStyle("display", "flex")
	if al.GetDirection() == opendesignerv1.LayoutDirection_LAYOUT_DIRECTION_VERTICAL {
		el.addStyle("flex-direction", "column")
	}
	el.addStyle("justify-content", alignCSS(al.GetMainAlign(), true))
	el.addStyle("align-items", alignCSS(al.GetCrossAlign(), false))
	if al.GetSpacing() > 0 {
		el.addStyle("gap", px(al.GetSpacing()))
	}
	if p := paddingCSS(al); p != "" {
		el.addStyle("padding", p)
	}
}

func alignCSS(a opendesignerv1.LayoutAlign, main bool) string {
	switch a {
	case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_CENTER:
		return "center"
	case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_END:
		return "flex-end"
	case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_SPACE_BETWEEN:
		// Sull'asse trasversale SPACE_BETWEEN vale START (proto).
		if main {
			return "space-between"
		}
	}
	return "flex-start"
}

// paddingCSS: shorthand più corto che dice la stessa cosa; "" se tutto a zero.
func paddingCSS(al *opendesignerv1.AutoLayout) string {
	t, r, bo, l := al.GetPaddingTop(), al.GetPaddingRight(), al.GetPaddingBottom(), al.GetPaddingLeft()
	if t == 0 && r == 0 && bo == 0 && l == 0 {
		return ""
	}
	switch {
	case t == r && r == bo && bo == l:
		return px(t)
	case t == bo && l == r:
		return px(t) + " " + px(r)
	}
	return px(t) + " " + px(r) + " " + px(bo) + " " + px(l)
}

// setFilter scrive `filter`: prima l'eventuale drop-shadow, poi la sfocatura (la
// sfocatura del canvas vale anche per l'ombra).
func setFilter(el *Element, dropShadow string, bl *opendesignerv1.LayerBlur) {
	var parts []string
	if dropShadow != "" {
		parts = append(parts, dropShadow)
	}
	if bl != nil {
		parts = append(parts, "blur("+px(bl.GetRadius())+")")
	}
	if len(parts) > 0 {
		el.addStyle("filter", strings.Join(parts, " "))
	}
}

// dropShadowFilter: drop-shadow() CSS equivalente allo shadowBlur del canvas.
// Vuole la DEVIAZIONE STANDARD, cioè la metà dello shadowBlur.
func dropShadowFilter(s *opendesignerv1.DropShadow, mul float64) string {
	return fmt.Sprintf("drop-shadow(%s %s %s %s)", px(s.GetOffsetX()), px(s.GetOffsetY()), px(math.Max(0, s.GetBlur())/2), colorCSS(s.GetColor(), mul))
}

// translucent: il riempimento (o l'opacità del nodo) lascia passare lo sfondo.
func translucent(f fill, opacity float64) bool {
	if opacity < 1 || f.color.GetA() < 1 {
		return true
	}
	for _, st := range f.grad.GetStops() {
		if st.GetColor().GetA() < 1 {
			return true
		}
	}
	return false
}

// boxPaint: riempimento, raggio, tratti, ombra di rect/ellisse/frame. Ritorna il
// drop-shadow() da mettere nel `filter` quando l'ombra non può essere un
// box-shadow (vedi sotto), "" altrimenti.
func boxPaint(el *Element, n *opendesignerv1.Node, isFrame, isEllipse bool, mul float64, container bool) string {
	w, h := n.GetWidth(), n.GetHeight()
	switch {
	case isEllipse:
		el.addStyle("border-radius", "50%")
	case !isFrame:
		// Il raggio si clampa a metà del lato più corto, come roundRect.
		if r := math.Min(n.GetRect().GetCornerRadius(), math.Min(w/2, h/2)); r > 0 {
			el.addStyle("border-radius", px(r))
		}
	}
	// Un FRAME senza riempimento è trasparente: il grigio di default è per le forme.
	hasFill := !(isFrame && len(n.GetFills()) == 0)
	if hasFill {
		f := resolvedFill(n.GetFills())
		if f.grad != nil {
			if g, ok := gradientCSS(f.grad, f.radial, w, h, mul); ok {
				el.addStyle("background-image", g)
			} else {
				el.addStyle("background-color", colorCSS(f.color, mul))
			}
		} else {
			el.addStyle("background-color", colorCSS(f.color, mul))
		}
	}
	shadows := strokeRings(n.GetStrokes(), mul)
	dropShadow := ""
	// L'ombra segue il riempimento: senza, il canvas la farebbe dal solo
	// tratto, e box-shadow non sa farlo (ombreggia l'intero box). Documentato.
	if sh := firstShadow(n.GetEffects()); sh != nil && hasFill {
		// box-shadow non si dipinge MAI dentro il box, il canvas invece mostra
		// l'ombra attraverso un riempimento (o un nodo) traslucido: lì si usa
		// drop-shadow(), che ombreggia i pixel disegnati. Non per i
		// contenitori, dove il filtro colpirebbe anche i figli.
		if !container && translucent(resolvedFill(n.GetFills()), n.GetOpacity()) {
			dropShadow = dropShadowFilter(sh, 1)
		} else {
			shadows = append(shadows, shadowCSS(sh, mul))
		}
	}
	if len(shadows) > 0 {
		el.addStyle("box-shadow", strings.Join(shadows, ","))
	}
	return dropShadow
}

// ---------------------------------------------------------------------------
// testo
// ---------------------------------------------------------------------------

const (
	defaultFontFamily = "Inter, sans-serif"
	defaultFontWeight = "400"
	defaultFontSize   = 16.0
	defaultLineHeight = 1.2
)

var plainFamily = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9 -]*$`)

var genericFamilies = map[string]bool{
	"serif": true, "sans-serif": true, "monospace": true, "cursive": true, "fantasy": true,
	"system-ui": true, "ui-sans-serif": true, "ui-serif": true, "ui-monospace": true, "ui-rounded": true,
}

// fontFamilyCSS: la famiglia del documento più un fallback generico. Vuota =
// il default del renderer (Inter, sans-serif). Un elenco già scritto
// dall'utente si rispetta e si completa del generico se manca.
func fontFamilyCSS(f string) string {
	f = strings.TrimSpace(f)
	if f == "" {
		return defaultFontFamily
	}
	parts := strings.Split(f, ",")
	for i, p := range parts {
		p = strings.TrimSpace(p)
		p = strings.Trim(p, `"'`)
		if !genericFamilies[strings.ToLower(p)] && !plainFamily.MatchString(p) {
			p = "'" + strings.ReplaceAll(p, "'", `\'`) + "'"
		}
		parts[i] = p
	}
	last := strings.ToLower(strings.Trim(parts[len(parts)-1], `'"`))
	if !genericFamilies[last] {
		parts = append(parts, genericFor(parts[0]))
	}
	return strings.Join(parts, ", ")
}

func genericFor(family string) string {
	l := strings.ToLower(family)
	switch {
	case strings.Contains(l, "mono") || strings.Contains(l, "code") || strings.Contains(l, "courier"):
		return "monospace"
	case !strings.Contains(l, "sans") && (strings.Contains(l, "serif") || strings.Contains(l, "georgia") ||
		strings.Contains(l, "times") || strings.Contains(l, "garamond") || strings.Contains(l, "merriweather") ||
		strings.Contains(l, "playfair") || strings.Contains(l, "lora")):
		return "serif"
	}
	return "sans-serif"
}

// textElement: un div con il testo. Stile e default come renderer/text.ts
// (Inter / 16 / 400 / interlinea 1.2), larghezza fissa = larghezza di wrap.
//
// DIFFERENZE DICHIARATE col canvas: il canvas misura i glifi e va a capo da sé,
// qui lo fa il browser (stesse regole di parola, metriche del font vero); la
// baseline del canvas è a 0.8em dal bordo superiore della riga, quella CSS
// dipende dalle metriche del font (per Inter ~1px a 16px).
func (b *builder) textElement(n, eff *opendesignerv1.Node, c bctx) *Element {
	t := eff.GetText()
	if t.GetContent() == "" {
		return nil // il canvas non disegna un testo vuoto
	}
	st := t.GetStyle()
	el := &Element{Tag: "div", Text: t.GetContent(), HasText: true}
	placement(el, n, c)
	f := resolvedFill(eff.GetFills())
	gradient := ""
	if f.grad != nil {
		if g, ok := gradientCSS(f.grad, f.radial, eff.GetWidth(), eff.GetHeight(), 1); ok {
			gradient = g
		}
	}
	if eff.GetWidth() > 0 {
		el.addStyle("width", px(eff.GetWidth()))
		el.addStyle("white-space", "pre-wrap")
		el.addStyle("overflow-wrap", "break-word")
	} else {
		// Larghezza di wrap nulla: il canvas non va a capo (riga unica per paragrafo).
		el.addStyle("white-space", "pre")
	}
	// Un testo in flusso porta la propria altezza (il core la usa per disporre);
	// con un gradiente il box del gradiente è quello del nodo, non quello delle righe.
	if c.flowChild || gradient != "" {
		el.addStyle("height", px(eff.GetHeight()))
	}
	size := st.GetFontSize()
	if !(size > 0) {
		size = defaultFontSize
	}
	weight := st.GetFontWeight()
	if weight == "" {
		weight = defaultFontWeight
	}
	lh := st.GetLineHeight()
	if !(lh > 0) {
		lh = defaultLineHeight
	}
	el.addStyle("font-family", fontFamilyCSS(st.GetFontFamily()))
	el.addStyle("font-size", px(size))
	el.addStyle("font-weight", weight)
	el.addStyle("line-height", num(lh))
	switch st.GetAlign() {
	case opendesignerv1.TextAlign_TEXT_ALIGN_CENTER:
		el.addStyle("text-align", "center")
	case opendesignerv1.TextAlign_TEXT_ALIGN_RIGHT:
		el.addStyle("text-align", "right")
	}
	if gradient != "" {
		el.addStyle("background-image", gradient)
		el.addStyle("background-clip", "text")
		el.addStyle("-webkit-background-clip", "text")
		el.addStyle("color", "transparent")
	} else {
		el.addStyle("color", colorCSS(f.color, 1))
	}
	// Il tratto di un testo è SEMPRE centrato sul contorno del glifo (come
	// strokeText nel canvas); CSS ne sa fare uno solo, il primo.
	for _, s := range eff.GetStrokes() {
		if s.GetWeight() > 0 {
			el.addStyle("-webkit-text-stroke", px(s.GetWeight())+" "+colorCSS(toFill(s.GetPaint()).color, 1))
			break
		}
	}
	if sh := firstShadow(eff.GetEffects()); sh != nil && gradient == "" {
		el.addStyle("text-shadow", shadowCSS(sh, 1))
	}
	rotation(el, eff)
	if eff.GetOpacity() != 1 {
		el.addStyle("opacity", num(eff.GetOpacity()))
	}
	if bl := firstBlur(eff.GetEffects()); bl != nil {
		el.addStyle("filter", "blur("+px(bl.GetRadius())+")")
	}
	b.children(el, n, c)
	return el
}

// ---------------------------------------------------------------------------
// immagini
// ---------------------------------------------------------------------------

// imageElement: <img> sul box del nodo, tirata (object-fit: fill = drawImage a
// quattro coordinate), oppure il SEGNAPOSTO del canvas se l'asset manca.
func (b *builder) imageElement(n, eff *opendesignerv1.Node, c bctx) *Element {
	if !(eff.GetWidth() > 0 && eff.GetHeight() > 0) {
		return nil
	}
	hash := eff.GetImage().GetAssetHash()
	url, ok := b.assetURL(hash)
	el := &Element{Tag: "img"}
	if !ok {
		el = &Element{Tag: "div"}
	}
	placement(el, n, c)
	el.addStyle("width", px(eff.GetWidth()))
	el.addStyle("height", px(eff.GetHeight()))
	rotation(el, eff)
	if ok {
		el.addAttr("src", url)
		el.addAttr("alt", n.GetName())
		el.addStyle("object-fit", "fill")
		el.addStyle("max-width", "none")
	} else {
		// Segnaposto: stessi colori del canvas (rgba(0,0,0,.06), bordo .35 di 1px
		// DENTRO il box) più la croce, che nel canvas distingue "manca" da
		// "in arrivo".
		el.addAttr("role", "img")
		el.addAttr("aria-label", n.GetName())
		el.addStyle("background-color", "rgba(0,0,0,0.06)")
		el.addStyle("box-shadow", "inset 0 0 0 1px rgba(0,0,0,0.35)")
		el.Children = append(el.Children, placeholderCross(eff.GetWidth(), eff.GetHeight()))
	}
	if eff.GetOpacity() != 1 {
		el.addStyle("opacity", num(eff.GetOpacity()))
	}
	// L'ombra di un'immagine segue i suoi pixel (anche l'alfa del PNG): per
	// questo drop-shadow() e non box-shadow.
	shadow := ""
	if sh := firstShadow(eff.GetEffects()); sh != nil {
		shadow = dropShadowFilter(sh, 1)
	}
	setFilter(el, shadow, firstBlur(eff.GetEffects()))
	return el
}

func placeholderCross(w, h float64) *Element {
	svg := &Element{Tag: "svg"}
	svg.addAttr("width", num(w))
	svg.addAttr("height", num(h))
	svg.addAttr("aria-hidden", "true")
	svg.addStyle("position", "absolute")
	svg.addStyle("left", "0")
	svg.addStyle("top", "0")
	svg.addStyle("max-width", "none")
	path := &Element{Tag: "path"}
	path.addAttr("d", fmt.Sprintf("M0 0L%s %sM%s 0L0 %s", num(w), num(h), num(w), num(h)))
	path.addAttr("fill", "none")
	path.addAttr("stroke", "rgba(0,0,0,0.35)")
	svg.Children = []*Element{path}
	return svg
}

// assetURL copia i byte dell'asset nell'output e ritorna l'URL con cui si
// referenzia. ok=false se l'asset non c'è (o la sorgente non è disponibile).
func (b *builder) assetURL(hash string) (string, bool) {
	if hash == "" || b.assets == nil {
		if hash != "" {
			b.warn("asset %q: nessuna sorgente di asset, segnaposto", shortHash(hash))
		}
		return "", false
	}
	data, err := b.assets.Asset(hash)
	if err != nil || len(data) == 0 {
		b.warn("asset %q non trovato, segnaposto", shortHash(hash))
		return "", false
	}
	name := hash + sniffExt(data)
	b.files[b.fileDir+name] = data
	return b.urlPrefix + name, true
}

func shortHash(h string) string {
	if len(h) > 12 {
		return h[:12]
	}
	return h
}

// sniffExt riconosce il contenitore dai magic byte (gli stessi quattro che
// l'editor accetta: store/assets.go), ".bin" altrimenti.
func sniffExt(b []byte) string {
	switch {
	case len(b) >= 8 && string(b[:8]) == "\x89PNG\r\n\x1a\n":
		return ".png"
	case len(b) >= 3 && b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff:
		return ".jpg"
	case len(b) >= 6 && (string(b[:6]) == "GIF87a" || string(b[:6]) == "GIF89a"):
		return ".gif"
	case len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return ".webp"
	}
	return ".bin"
}

// ---------------------------------------------------------------------------
// vettoriali
// ---------------------------------------------------------------------------

var unsafeID = regexp.MustCompile(`[^A-Za-z0-9_-]`)

// vectorElement: un <svg> inline sul box del nodo, con le coordinate degli
// ancoraggi in px locali (nessun viewBox: 1 unità = 1px, come il canvas).
//
// Le maniglie in_/out_ sono OFFSET RELATIVI all'ancoraggio (vedi proto): il
// controllo uscente di A è A+out, quello entrante di B è B+in, e una maniglia
// (0,0) coincide con l'ancoraggio = segmento retto, senza rami speciali.
//
// Come il canvas: riempimento dei soli contorni chiusi con >= 2 ancoraggi
// (even-odd, salvo `vector.fillRule` nei meta), e per OGNI contorno o il TRATTO
// VERO -- un `stroke` del nodo con peso > 0, di colore/peso propri e con
// capi/giunti/tratteggio dai meta (`stroke.cap|join|miter|dash|dashOffset`, i
// nodi importati da SVG) -- oppure il filo di 1.5px (capi e giunti tondi) nel
// colore del riempimento, che esiste solo per rendere visibile un path senza
// altro inchiostro (`vector.hairline = "0"` lo spegne).
func (b *builder) vectorElement(n, eff *opendesignerv1.Node, c bctx) *Element {
	subs := eff.GetVector().GetSubpaths()
	has := false
	for _, sp := range subs {
		if len(sp.GetAnchors()) > 0 {
			has = true
		}
	}
	if !has {
		return nil
	}
	w, h := eff.GetWidth(), eff.GetHeight()
	el := &Element{Tag: "svg"}
	placement(el, n, c)
	el.addStyle("width", px(w))
	el.addStyle("height", px(h))
	el.addStyle("overflow", "visible")
	el.addStyle("max-width", "none")
	rotation(el, eff)
	// L'opacità sta sui singoli path e non sull'<svg>: il canvas disegna
	// riempimento e tratto UNO DOPO L'ALTRO, ciascuno con la propria alfa, e dove
	// si sovrappongono si compongono; un `opacity` di gruppo li appiattirebbe.
	// L'ombra di drop-shadow() ha già l'alfa dei pixel disegnati (come nel canvas).
	shadow := ""
	if sh := firstShadow(eff.GetEffects()); sh != nil {
		shadow = dropShadowFilter(sh, 1)
	}
	setFilter(el, shadow, firstBlur(eff.GetEffects()))
	el.addAttr("width", num(w))
	el.addAttr("height", num(h))

	f := resolvedFill(eff.GetFills())
	paint := colorCSS(f.color, 1)
	if f.grad != nil {
		if def, ref := vectorGradient("g-"+unsafeID.ReplaceAllString(c.idPrefix+n.GetId(), "_"), f, w, h); def != nil {
			el.Children = append(el.Children, def)
			paint = ref
		}
	}
	var fillD, strokeD []string
	for _, sp := range subs {
		if len(sp.GetAnchors()) == 0 {
			continue
		}
		d := subpathData(sp)
		strokeD = append(strokeD, d)
		if sp.GetClosed() && len(sp.GetAnchors()) >= 2 {
			fillD = append(fillD, d)
		}
	}
	if len(fillD) > 0 {
		p := &Element{Tag: "path"}
		p.addAttr("d", strings.Join(fillD, " "))
		p.addAttr("fill", paint)
		rule := "evenodd"
		if r := eff.GetMeta()["vector.fillRule"]; r == "nonzero" || r == "evenodd" {
			rule = r
		}
		p.addAttr("fill-rule", rule)
		if eff.GetOpacity() != 1 {
			p.addAttr("opacity", num(eff.GetOpacity()))
		}
		el.Children = append(el.Children, p)
	}
	real := false
	for _, st := range eff.GetStrokes() {
		if st.GetWeight() > 0 {
			real = true
		}
	}
	meta := eff.GetMeta()
	if real {
		for _, st := range eff.GetStrokes() {
			if !(st.GetWeight() > 0) {
				continue
			}
			p := &Element{Tag: "path", StrokePath: true}
			if eff.GetOpacity() != 1 {
				p.addAttr("opacity", num(eff.GetOpacity()))
			}
			p.addAttr("d", strings.Join(strokeD, " "))
			p.addAttr("fill", "none")
			p.addAttr("stroke", colorCSS(toFill(st.GetPaint()).color, 1))
			p.addAttr("stroke-width", num(st.GetWeight()))
			p.addAttr("stroke-linecap", pick(meta["stroke.cap"], "butt", "round", "square"))
			p.addAttr("stroke-linejoin", pick(meta["stroke.join"], "miter", "round", "bevel"))
			if m := meta["stroke.miter"]; m != "" && m != "10" {
				p.addAttr("stroke-miterlimit", m)
			}
			if d := meta["stroke.dash"]; d != "" {
				p.addAttr("stroke-dasharray", strings.ReplaceAll(d, ",", " "))
				if o := meta["stroke.dashOffset"]; o != "" && o != "0" {
					p.addAttr("stroke-dashoffset", o)
				}
			}
			el.Children = append(el.Children, p)
		}
		return el
	}
	if meta["vector.hairline"] == "0" {
		return el
	}
	p := &Element{Tag: "path", StrokePath: true}
	if eff.GetOpacity() != 1 {
		p.addAttr("opacity", num(eff.GetOpacity()))
	}
	p.addAttr("d", strings.Join(strokeD, " "))
	p.addAttr("fill", "none")
	p.addAttr("stroke", colorCSS(f.color, 1))
	p.addAttr("stroke-width", "1.5")
	p.addAttr("stroke-linecap", "round")
	p.addAttr("stroke-linejoin", "round")
	el.Children = append(el.Children, p)
	return el
}

// pick: `v` se è uno dei valori ammessi, altrimenti il default (il primo).
func pick(v string, allowed ...string) string {
	for _, a := range allowed {
		if v == a {
			return v
		}
	}
	return allowed[0]
}

// subpathData: il `d` di un contorno. Un solo ancoraggio = segmento di
// lunghezza nulla (con capo tondo è il pallino del pen tool).
func subpathData(sp *opendesignerv1.SubPath) string {
	as := sp.GetAnchors()
	var sb strings.Builder
	fmt.Fprintf(&sb, "M%s %s", num(as[0].GetX()), num(as[0].GetY()))
	if len(as) == 1 {
		fmt.Fprintf(&sb, "L%s %s", num(as[0].GetX()), num(as[0].GetY()))
		return sb.String()
	}
	segs := len(as) - 1
	if sp.GetClosed() {
		segs = len(as)
	}
	for i := 0; i < segs; i++ {
		a, bb := as[i], as[(i+1)%len(as)]
		// Senza maniglie (0,0) i controlli coincidono con gli estremi: la curva
		// è esattamente il segmento retto.
		if a.GetOutX() == 0 && a.GetOutY() == 0 && bb.GetInX() == 0 && bb.GetInY() == 0 {
			fmt.Fprintf(&sb, "L%s %s", num(bb.GetX()), num(bb.GetY()))
			continue
		}
		fmt.Fprintf(&sb, "C%s %s %s %s %s %s",
			num(a.GetX()+a.GetOutX()), num(a.GetY()+a.GetOutY()),
			num(bb.GetX()+bb.GetInX()), num(bb.GetY()+bb.GetInY()),
			num(bb.GetX()), num(bb.GetY()))
	}
	if sp.GetClosed() {
		sb.WriteString("Z")
	}
	return sb.String()
}

// vectorGradient: <defs> con il gradiente in coordinate locali (userSpaceOnUse),
// come export/svg.ts::gradientRef.
func vectorGradient(id string, f fill, w, h float64) (*Element, string) {
	g := f.grad
	if len(g.GetStops()) < 2 {
		return nil, ""
	}
	x1, y1 := g.GetX1()*w, g.GetY1()*h
	x2, y2 := g.GetX2()*w, g.GetY2()*h
	length := math.Hypot(x2-x1, y2-y1)
	if !(length > 0) {
		return nil, ""
	}
	gr := &Element{Tag: "linearGradient"}
	gr.addAttr("id", id)
	if f.radial {
		gr.Tag = "radialGradient"
		gr.addAttr("cx", num(x1))
		gr.addAttr("cy", num(y1))
		gr.addAttr("r", num(length))
	} else {
		gr.addAttr("x1", num(x1))
		gr.addAttr("y1", num(y1))
		gr.addAttr("x2", num(x2))
		gr.addAttr("y2", num(y2))
	}
	gr.addAttr("gradientUnits", "userSpaceOnUse")
	for _, st := range g.GetStops() {
		s := &Element{Tag: "stop"}
		s.addAttr("offset", num(math.Min(1, math.Max(0, st.GetPosition()))))
		s.addAttr("stop-color", colorCSS(st.GetColor(), 1))
		gr.Children = append(gr.Children, s)
	}
	defs := &Element{Tag: "defs", Children: []*Element{gr}}
	return defs, "url(#" + id + ")"
}
