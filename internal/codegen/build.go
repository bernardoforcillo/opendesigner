package codegen

import (
	"fmt"
	"math"
	"regexp"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

// Document -> IR. All the drawing SEMANTICS live here (what the canvas
// draws, and how to say it in CSS); the renderers in html.go and react.go make
// no drawing decisions, they only write the syntax.
//
// Layout conventions:
//   - auto layout: the frame becomes flexbox (direction, gap, padding, justify/
//     align) and the children that the core lays out are IN FLOW
//     (position:relative, flex-shrink:0); the core has already written x/y in
//     the document, nothing is recomputed here -- CSS is told to redo the same
//     arrangement;
//   - everything else: position:relative/absolute container with
//     position:absolute children at left/top = x/y (coordinates relative to the
//     parent, as in the model). In-flow children are position:relative because
//     CSS paints positioned elements above non-positioned ones regardless of
//     DOM order, and the canvas drawing order is the siblings' order.

// builder builds the IR of ONE screen.
type builder struct {
	doc    *opendesignerv1.Document
	assets AssetSource
	// files collects the copied assets (output path -> bytes); it is
	// shared between screens, so the same asset is written only once.
	files map[string][]byte
	// fileDir/urlPrefix: where assets are written and with which URL they are
	// referenced ("assets/" for html, "public/assets/" and "/assets/" for react).
	fileDir, urlPrefix string
	warnings           *[]string
	// triggers: the current screen's transitions, by element id.
	triggers map[string][]Trigger
	// anim: the current screen's animations by node id (planAnimations).
	anim map[string]*ElemAnim
}

// bctx is the state that descends through the recursion.
type bctx struct {
	// root: the screen's root (in flow, without left/top).
	root bool
	// flowChild: the node is an in-flow child of an auto layout frame.
	flowChild bool
	// origin: the node is placed at left:0/top:0 (root of an instance's master:
	// descending into the instance subtracts the master's origin).
	origin bool
	// overrides: the overrides of the instance being descended into.
	overrides map[string]*opendesignerv1.InstanceOverride
	// idPrefix: path of the instances traversed, for data-node-id.
	idPrefix string
	// visited: components being expanded on this branch (a master that
	// contains an instance of itself must not recurse forever).
	visited map[string]bool
}

func (c bctx) inInstance() bool { return c.idPrefix != "" }

// participates: the children that the core lays out in a row (core/layout.go).
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

// buildScreen builds the IR tree of screen `n`.
func (b *builder) buildScreen(n *opendesignerv1.Node) *Element {
	b.planAnimations(n)
	return b.element(n, bctx{root: true, visited: map[string]bool{}})
}

// element translates a node (and its subtree). nil = nothing to emit.
func (b *builder) element(n *opendesignerv1.Node, c bctx) *Element {
	// Variables: what is exported is what the canvas draws, so a bound property
	// takes the value of the node's active mode. (A master descended into through
	// an instance resolves in the master's own modes, not the instance's.)
	n = core.ResolveNode(b.doc, n)
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
	if tid := n.GetMeta()["test.id"]; tid != "" && !c.inInstance() { // a test.id in the master would be duplicated in every instance
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

// placement writes position/left/top.
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
		// CSS rotates clockwise around the box centre, like the canvas:
		// same convention, no conversion.
		el.addStyle("transform", "rotate("+num(n.GetRotation())+"deg)")
	}
}

// children translates `n`'s children in drawing order.
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
// groups and instances
// ---------------------------------------------------------------------------

// groupElement: a positioned container WITHOUT paint (a group is not
// drawn). It has the node's width/height (normally 0) because the canvas
// rotation is around the centre of that box.
func (b *builder) groupElement(n *opendesignerv1.Node, c bctx) *Element {
	el := &Element{Tag: "div"}
	placement(el, n, c)
	el.addStyle("width", px(n.GetWidth()))
	el.addStyle("height", px(n.GetHeight()))
	rotation(el, n)
	b.children(el, n, c)
	return el
}

// instanceElement expands the instance's master INLINE (no component
// extraction): a wrapper at the instance's position containing the master's
// subtree at origin 0,0, with the per-node overrides applied.
func (b *builder) instanceElement(n *opendesignerv1.Node, c bctx) *Element {
	inst := n.GetInstance()
	comp := b.doc.GetComponents()[inst.GetComponentId()]
	master := b.doc.GetNodes()[comp.GetRootNodeId()]
	if comp == nil || master == nil || c.visited[inst.GetComponentId()] {
		// Like the canvas: missing (or recursive) component or master = nothing.
		if comp == nil || master == nil {
			b.warn("instance %q: component %q or its master not found, omitted", n.GetName(), inst.GetComponentId())
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

// withOverride: the master's node with the instance's override applied
// (canvasRenderer.ts::withOverride): fills if present and, for a text, the
// content. Never the geometry.
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

// cloneShallow copies the fields that withOverride can change. proto.Clone is
// not used: a node has little and a deep copy of a Node with meta and
// vectors for every instance would cost for no reason.
func cloneShallow(n *opendesignerv1.Node) *opendesignerv1.Node {
	return &opendesignerv1.Node{
		Id: n.Id, ParentId: n.ParentId, OrderKey: n.OrderKey, Name: n.Name, Visible: n.Visible, Opacity: n.Opacity,
		X: n.X, Y: n.Y, Width: n.Width, Height: n.Height, Rotation: n.Rotation,
		Fills: n.Fills, Strokes: n.Strokes, Effects: n.Effects, Shape: n.Shape, Meta: n.Meta,
	}
}

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

// shapeElement: rect, ellipse, frame, text, image, vector.
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
	// rect / ellipse / frame. A box with a side <= 0 leaves no pixels (guard
	// of drawNode); a FRAME like that still stays a container of its children.
	_, isFrame := eff.GetShape().(*opendesignerv1.Node_Frame)
	_, isEllipse := eff.GetShape().(*opendesignerv1.Node_Ellipse)
	paintable := eff.GetWidth() > 0 && eff.GetHeight() > 0
	if !paintable && !isFrame {
		return nil
	}
	container := isFrame && hasVisibleKids(b.doc, n.GetId())
	// Opacity is "baked" into the node's own colours (mul) instead of being written
	// as CSS `opacity` in two cases:
	//  - container: the canvas sets globalAlpha PER NODE and does not inherit it,
	//    so a frame's opacity does NOT dim its children; with CSS `opacity` it does;
	//  - node with a shadow: the canvas draws the shape with alpha OVER the shadow
	//    (which has the same alpha), i.e. the shadow shows through the shape; with
	//    CSS `opacity` the filter applies first and the opaque shape covers the shadow.
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

// sizeOf: "fit-content" for a hug axis of an auto layout frame, otherwise
// the size in px.
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
		// On the cross axis SPACE_BETWEEN behaves as START (proto).
		if main {
			return "space-between"
		}
	}
	return "flex-start"
}

// paddingCSS: the shortest shorthand that says the same thing; "" if all zero.
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

// setFilter writes `filter`: first any drop-shadow, then the blur (the canvas
// blur also applies to the shadow).
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

// dropShadowFilter: CSS drop-shadow() equivalent to the canvas shadowBlur.
// It wants the STANDARD DEVIATION, i.e. half of shadowBlur.
func dropShadowFilter(s *opendesignerv1.DropShadow, mul float64) string {
	return fmt.Sprintf("drop-shadow(%s %s %s %s)", px(s.GetOffsetX()), px(s.GetOffsetY()), px(math.Max(0, s.GetBlur())/2), colorCSS(s.GetColor(), mul))
}

// translucent: the fill (or the node's opacity) lets the background show through.
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

// boxPaint: fill, radius, strokes, shadow of rect/ellipse/frame. It returns the
// drop-shadow() to put in the `filter` when the shadow cannot be a
// box-shadow (see below), "" otherwise.
func boxPaint(el *Element, n *opendesignerv1.Node, isFrame, isEllipse bool, mul float64, container bool) string {
	w, h := n.GetWidth(), n.GetHeight()
	switch {
	case isEllipse:
		el.addStyle("border-radius", "50%")
	case !isFrame:
		// The radius is clamped to half the shorter side, like roundRect.
		if r := math.Min(n.GetRect().GetCornerRadius(), math.Min(w/2, h/2)); r > 0 {
			el.addStyle("border-radius", px(r))
		}
	}
	// A FRAME without a fill is transparent: the default grey is for shapes.
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
	// The shadow follows the fill: without one, the canvas would cast it from the
	// stroke alone, and box-shadow cannot do that (it shades the whole box). Documented.
	if sh := firstShadow(n.GetEffects()); sh != nil && hasFill {
		// box-shadow is NEVER painted inside the box, while the canvas shows
		// the shadow through a translucent fill (or node): there drop-shadow() is
		// used, which shades the drawn pixels. Not for
		// containers, where the filter would also hit the children.
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
// text
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

// fontFamilyCSS: the document's family plus a generic fallback. Empty =
// the renderer's default (Inter, sans-serif). A list already written by the
// user is respected and completed with the generic if missing.
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

// textElement: a div with the text. Style and defaults as in renderer/text.ts
// (Inter / 16 / 400 / line height 1.2), fixed width = wrap width.
//
// DECLARED DIFFERENCES from the canvas: the canvas measures glyphs and wraps
// by itself, here the browser does it (same word rules, real font metrics); the
// canvas baseline is at 0.8em from the top edge of the line, the CSS one
// depends on the font metrics (for Inter ~1px at 16px).
func (b *builder) textElement(n, eff *opendesignerv1.Node, c bctx) *Element {
	t := eff.GetText()
	if t.GetContent() == "" {
		return nil // the canvas does not draw empty text
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
		// Zero wrap width: the canvas does not wrap (a single line per paragraph).
		el.addStyle("white-space", "pre")
	}
	// An in-flow text carries its own height (the core uses it for layout);
	// with a gradient the gradient box is the node's, not the lines'.
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
	// A text's stroke is ALWAYS centred on the glyph outline (like
	// strokeText in the canvas); CSS can only do one, the first.
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
// images
// ---------------------------------------------------------------------------

// imageElement: <img> on the node's box, stretched (object-fit: fill = four-
// coordinate drawImage), or the canvas PLACEHOLDER if the asset is missing.
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
		// Placeholder: same colours as the canvas (rgba(0,0,0,.06), .35 border of 1px
		// INSIDE the box) plus the cross, which in the canvas distinguishes "missing"
		// from "loading".
		el.addAttr("role", "img")
		el.addAttr("aria-label", n.GetName())
		el.addStyle("background-color", "rgba(0,0,0,0.06)")
		el.addStyle("box-shadow", "inset 0 0 0 1px rgba(0,0,0,0.35)")
		el.Children = append(el.Children, placeholderCross(eff.GetWidth(), eff.GetHeight()))
	}
	if eff.GetOpacity() != 1 {
		el.addStyle("opacity", num(eff.GetOpacity()))
	}
	// An image's shadow follows its pixels (including the PNG's alpha): hence
	// drop-shadow() and not box-shadow.
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

// assetURL copies the asset's bytes into the output and returns the URL used
// to reference it. ok=false if the asset is not there (or the source is unavailable).
func (b *builder) assetURL(hash string) (string, bool) {
	if hash == "" || b.assets == nil {
		if hash != "" {
			b.warn("asset %q: no asset source, placeholder", shortHash(hash))
		}
		return "", false
	}
	data, err := b.assets.Asset(hash)
	if err != nil || len(data) == 0 {
		b.warn("asset %q not found, placeholder", shortHash(hash))
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

// sniffExt recognises the container from the magic bytes (the same four
// the editor accepts: store/assets.go), ".bin" otherwise.
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
// vectors
// ---------------------------------------------------------------------------

var unsafeID = regexp.MustCompile(`[^A-Za-z0-9_-]`)

// vectorElement: an inline <svg> on the node's box, with the anchors'
// coordinates in local px (no viewBox: 1 unit = 1px, like the canvas).
//
// The in_/out_ handles are OFFSETS RELATIVE to the anchor (see proto): A's
// outgoing control is A+out, B's incoming one is B+in, and a (0,0) handle
// coincides with the anchor = straight segment, with no special branches.
//
// Like the canvas: fill of closed outlines with >= 2 anchors only
// (even-odd, unless `vector.fillRule` in the meta), and for EVERY outline either
// the REAL STROKE -- a node `stroke` with weight > 0, with its own colour/weight
// and caps/joins/dashes from the meta (`stroke.cap|join|miter|dash|dashOffset`,
// nodes imported from SVG) -- or the 1.5px hairline (round caps and joins) in
// the fill colour, which exists only to make a path with no other ink visible
// (`vector.hairline = "0"` turns it off).
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
	// Opacity goes on the individual paths and not on the <svg>: the canvas draws
	// fill and stroke ONE AFTER THE OTHER, each with its own alpha, and where
	// they overlap they compose; a group `opacity` would flatten them.
	// The drop-shadow() shadow already has the alpha of the drawn pixels (as in the canvas).
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

// pick: `v` if it is one of the allowed values, otherwise the default (the first).
func pick(v string, allowed ...string) string {
	for _, a := range allowed {
		if v == a {
			return v
		}
	}
	return allowed[0]
}

// subpathData: the `d` of an outline. A single anchor = zero-length segment
// (with a round cap it is the pen tool's dot).
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
		// Without (0,0) handles the controls coincide with the endpoints: the curve
		// is exactly the straight segment.
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

// vectorGradient: <defs> with the gradient in local coordinates (userSpaceOnUse),
// like export/svg.ts::gradientRef.
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
