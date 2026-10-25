package codegen

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Target swiftui: Swift sources for an iOS / macOS app. Each screen is a
// `Sources/Screens/<Name>.swift` View, a component set (or a component with
// properties) is a View with parameters in `Sources/Components/<Name>.swift`,
// `Router.swift` + `App.swift` mount the screens in a NavigationStack and the
// flow transitions call `router.go(...)`.
//
// The views are written from the SAME IR as html/react (native.go parses the
// CSS back), so the canvas semantics -- first fill, gradient geometry, stroke
// alignment, baked opacity -- are not restated here. Declared differences are
// in docs/codegen.md.

var swiftNaming = &regNaming{types: swiftReservedTypes, idents: swiftReservedIdents}

// swWriter renders Elements as SwiftUI view expressions.
type swWriter struct {
	reg *compRegistry
	// ident: inside a component, the identifier of a component property.
	ident func(name string) string
	// usesRouter: a navigation call was written (the screen needs the Router).
	usesRouter bool
	unsup      map[string]bool
}

func swColor(c ncolor) string {
	s := fmt.Sprintf("Color(red: %s, green: %s, blue: %s", chanf(c.r), chanf(c.g), chanf(c.b))
	if c.a < 0.9995 {
		s += ", opacity: " + lit(c.a)
	}
	return s + ")"
}

func swUnit(v float64) string { return lit(math.Round(v*1000) / 1000) }

// swFill: the ShapeStyle expression of a fill for a w x h box (hasSize false:
// the box is hug / filled, so the gradient is laid out on the unit square).
func swFill(f *nfill, n *nbox) string {
	g := f.g
	if g == nil || len(g.stops) < 2 {
		return swColor(f.c)
	}
	stops := make([]string, len(g.stops))
	for i, s := range g.stops {
		stops[i] = fmt.Sprintf("Gradient.Stop(color: %s, location: %s)", swColor(s.c), swUnit(s.pos))
	}
	w, h := n.w, n.h
	known := n.hasW && n.hasH && w > 0 && h > 0
	if !known {
		w, h = 1, 1
	}
	if g.radial {
		cx, cy, r := g.cx/w, g.cy/h, g.r
		if !known {
			cx, cy, r = 0.5, 0.5, 100
		}
		return fmt.Sprintf("RadialGradient(stops: [%s], center: UnitPoint(x: %s, y: %s), startRadius: 0, endRadius: %s)",
			strings.Join(stops, ", "), swUnit(cx), swUnit(cy), lit(r))
	}
	sx, sy, ex, ey := gradientPoints(g.deg, w, h)
	return fmt.Sprintf("LinearGradient(stops: [%s], startPoint: UnitPoint(x: %s, y: %s), endPoint: UnitPoint(x: %s, y: %s))",
		strings.Join(stops, ", "), swUnit(sx/w), swUnit(sy/h), swUnit(ex/w), swUnit(ey/h))
}

func (w *swWriter) dyn(e *Element, style string) string {
	if w.ident == nil {
		return ""
	}
	for _, d := range e.Dyn {
		if d.Style == style {
			return w.ident(d.Prop)
		}
	}
	return ""
}

func swShape(n *nbox, radius string) string {
	switch {
	case n.round:
		return "Ellipse()"
	case radius != "":
		return "RoundedRectangle(cornerRadius: " + radius + ")"
	case n.radius > 0:
		return "RoundedRectangle(cornerRadius: " + lit(n.radius) + ")"
	}
	return "Rectangle()"
}

// swAlign: a frame Alignment from a horizontal (0 leading, 1 centre, 2 trailing)
// and a vertical (0 top, 1 centre, 2 bottom) position.
func swAlign(h, v int) string {
	names := [3][3]string{{".topLeading", ".top", ".topTrailing"}, {".leading", ".center", ".trailing"}, {".bottomLeading", ".bottom", ".bottomTrailing"}}
	return names[v][h]
}

func alignIdx(a string) int {
	switch a {
	case "center":
		return 1
	case "end":
		return 2
	}
	return 0
}

// mods collects `.modifier(...)` lines.
type mods []string

func (m *mods) add(format string, a ...any) { *m = append(*m, "."+fmt.Sprintf(format, a...)) }

// view renders one element as view-expression lines. root: the screen's (or
// component's) root, which sits at the origin; parent: its in-flow container.
func (w *swWriter) view(e *Element, parent *nbox, root bool) []string {
	if e.ShowIf != "" && w.ident != nil {
		inner := *e
		inner.ShowIf = ""
		body := w.view(&inner, parent, root)
		out := append([]string{"if " + w.ident(e.ShowIf) + " {"}, indentLines(body, "    ")...)
		return append(out, "}")
	}
	n := parseNative(e)
	var core []string
	switch {
	case e.HasText:
		core = w.text(e, n, parent)
	case e.Tag == "img":
		core = w.image(e, n)
	case e.Tag == "svg":
		core = w.vector(e, n)
	default:
		core = w.box(e, n, parent)
	}
	if n.blend {
		w.unsup["blend modes"] = true
	}
	if n.backdrop {
		w.unsup["background blur"] = true
	}
	if n.inner {
		w.unsup["inner shadows"] = true
	}
	var m mods
	for _, s := range n.shadows {
		m.add("shadow(color: %s, radius: %s, x: %s, y: %s)", swColor(s.c), lit(s.blur/2), lit(s.x), lit(s.y))
	}
	if n.opacity != 1 || w.dyn(e, "opacity") != "" {
		o := lit(n.opacity)
		if d := w.dyn(e, "opacity"); d != "" {
			o = d
		}
		m.add("opacity(%s)", o)
	}
	if n.blur > 0 {
		m.add("blur(radius: %s)", lit(n.blur))
	}
	if n.rotation != 0 {
		m.add("rotationEffect(.degrees(%s))", lit(n.rotation))
	}
	core = withMods(core, m)

	// Flow wiring: the element that fires a transition is a plain Button.
	var comments []string
	var trig *Trigger
	for i := range e.Triggers {
		comments = append(comments, flowComments(e.Triggers[i])...)
		if trig == nil && (e.Triggers[i].Dest != nil || e.Triggers[i].Kind == "back") {
			trig = &e.Triggers[i]
		}
	}
	if trig != nil {
		w.usesRouter = true
		act := "router.back()"
		if trig.Kind != "back" {
			act = "router.go(." + lowerFirst(trig.Dest.Name) + ")"
		}
		wrapped := []string{"Button(action: { " + act + " }) {"}
		wrapped = append(wrapped, indentLines(core, "    ")...)
		wrapped = append(wrapped, "}", ".buttonStyle(.plain)")
		if trig.Label != "" {
			wrapped = append(wrapped, ".accessibilityLabel("+quote(trig.Label, false)+")")
		}
		// The modifiers above sit at the Button's level, like a container's.
		core = wrapped
	}
	if n.absolute && !root && (parent == nil || !parent.flex) && (n.x != 0 || n.y != 0) {
		core = withMods(core, mods{fmt.Sprintf(".offset(x: %s, y: %s)", lit(n.x), lit(n.y))})
	}
	head := []string{"// " + nodeLabel(e)}
	for _, n := range e.Notes {
		head = append(head, "// "+n)
	}
	for _, c := range comments {
		head = append(head, "// "+c)
	}
	return append(head, core...)
}

// withMods appends modifier lines to a view: aligned with a closing brace
// (Xcode's style for a container), indented one level under a plain expression.
func withMods(core []string, m []string) []string {
	if len(m) == 0 {
		return core
	}
	first := 0
	for first < len(core)-1 && strings.HasPrefix(core[first], "//") {
		first++
	}
	if strings.HasSuffix(core[first], "{") || strings.HasPrefix(core[first], "if ") {
		return append(core, m...)
	}
	return append(core, indentLines(m, "    ")...)
}

// nodeLabel: the traceability comment written above every element.
func nodeLabel(e *Element) string {
	if e.NodeID == "" {
		return "element"
	}
	return fmt.Sprintf("%s (data-node-id=%q)", oneLine(e.NodeName), attrOf(e, "data-node-id"))
}

func attrOf(e *Element, name string) string {
	if v := e.attr(name); v != "" {
		return v
	}
	return e.NodeID
}

func lowerFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToLower(s[:1]) + s[1:]
}

// frameMods writes the size of an element: fixed sides as .frame(width:height:),
// filled axes as .frame(max...: .infinity).
func frameMods(m *mods, n *nbox, parent *nbox, align string) {
	var parts []string
	if n.hasW {
		parts = append(parts, "width: "+lit(n.w))
	}
	if n.hasH {
		parts = append(parts, "height: "+lit(n.h))
	}
	if len(parts) > 0 {
		m.add("frame(%s, alignment: %s)", strings.Join(parts, ", "), align)
	}
	if parent != nil && parent.grid != nil {
		// A grid child that fills its cell (the Grid itself places and sizes the cell).
		switch {
		case n.fillX && n.stretch:
			m.add("frame(maxWidth: .infinity, maxHeight: .infinity, alignment: %s)", align)
		case n.fillX:
			m.add("frame(maxWidth: .infinity, alignment: %s)", align)
		case n.stretch:
			m.add("frame(maxHeight: .infinity, alignment: %s)", align)
		}
	}
	if parent != nil && parent.flex {
		fillW := (n.grow && !parent.vertical) || (n.stretch && parent.vertical)
		fillH := (n.grow && parent.vertical) || (n.stretch && !parent.vertical)
		switch {
		case fillW && fillH:
			m.add("frame(maxWidth: .infinity, maxHeight: .infinity, alignment: %s)", align)
		case fillW:
			m.add("frame(maxWidth: .infinity, alignment: %s)", align)
		case fillH:
			m.add("frame(maxHeight: .infinity, alignment: %s)", align)
		}
	}
}

func (w *swWriter) box(e *Element, n *nbox, parent *nbox) []string {
	radius := w.dyn(e, "borderRadius")
	shape := swShape(n, radius)
	var kids [][]string
	useChild := e.Use != nil && w.reg != nil && w.reg.known(e.Use)
	switch {
	case e.SwapProp != "" && w.ident != nil:
		var def []string
		if useChild {
			def = strings.Split(w.call(e.Use), "\n")
		} else {
			for _, c := range e.Children {
				def = append(def, w.view(c, n, false)...)
			}
		}
		sw := w.ident(e.SwapProp)
		body := append([]string{"if let " + sw + " = " + sw + " {", "    " + sw, "} else {"}, indentLines(def, "    ")...)
		kids = append(kids, append(body, "}"))
	case useChild:
		kids = append(kids, strings.Split(w.call(e.Use), "\n"))
	default:
		for _, c := range e.Children {
			kids = append(kids, w.view(c, n, false))
		}
	}
	if n.wrap {
		w.unsup["wrapping auto layout"] = true
	}

	var lines []string
	var m mods
	switch {
	case n.grid != nil && !useChild && e.SwapProp == "" && len(kids) > 0 && len(kids) == len(e.Children):
		lines = w.gridStack(e, n, kids)
	case n.flex && len(kids) > 0:
		spacing := ""
		if n.gap > 0 {
			spacing = ", spacing: " + lit(n.gap)
		}
		var stack string
		if n.vertical {
			stack = fmt.Sprintf("VStack(alignment: %s%s) {", [3]string{".leading", ".center", ".trailing"}[alignIdx(n.cross)], spacing)
		} else {
			stack = fmt.Sprintf("HStack(alignment: %s%s) {", [3]string{".top", ".center", ".bottom"}[alignIdx(n.cross)], spacing)
		}
		lines = append(lines, stack)
		for i, k := range kids {
			if n.main == "between" && i > 0 {
				lines = append(lines, "    Spacer(minLength: 0)")
			}
			lines = append(lines, indentLines(k, "    ")...)
		}
		lines = append(lines, "}")
	case len(kids) > 0:
		lines = append(lines, "ZStack(alignment: .topLeading) {")
		for _, k := range kids {
			lines = append(lines, indentLines(k, "    ")...)
		}
		lines = append(lines, "}")
	default:
		if n.fill != nil {
			lines = append(lines, shape+".fill("+swFill(n.fill, n)+")")
		} else {
			lines = append(lines, "Color.clear")
		}
	}
	filled := len(kids) > 0 // a container paints through background(); a leaf already is the shape

	if len(kids) > 0 {
		if p := n.pad; p != [4]float64{} {
			if p[0] == p[1] && p[1] == p[2] && p[2] == p[3] {
				m.add("padding(%s)", lit(p[0]))
			} else {
				m.add("padding(EdgeInsets(top: %s, leading: %s, bottom: %s, trailing: %s))", lit(p[0]), lit(p[3]), lit(p[2]), lit(p[1]))
			}
		}
	}
	align := ".topLeading"
	if n.flex {
		hAl, vAl := alignIdx(n.cross), alignIdx(n.main)
		if !n.vertical {
			hAl, vAl = alignIdx(n.main), alignIdx(n.cross)
		}
		if n.main == "between" {
			if n.vertical {
				vAl = 0
			} else {
				hAl = 0
			}
		}
		align = swAlign(hAl, vAl)
	}
	frameMods(&m, n, parent, align)
	if filled && n.fill != nil {
		m.add("background(%s.fill(%s))", shape, swFill(n.fill, n))
	}
	for _, s := range n.strokes {
		col := swColor(s.c)
		switch s.align {
		case "inside":
			m.add("overlay(%s.strokeBorder(%s, lineWidth: %s))", shape, col, lit(s.w))
		case "outside":
			m.add("overlay(%s.stroke(%s, lineWidth: %s).padding(-%s))", shape, col, lit(s.w), lit(s.w/2))
		default:
			m.add("overlay(%s.stroke(%s, lineWidth: %s))", shape, col, lit(s.w))
		}
	}
	if n.clip {
		m.add("clipShape(%s)", shape)
	}
	return withMods(lines, m)
}

func (w *swWriter) text(e *Element, n *nbox, parent *nbox) []string {
	t := parseText(e)
	content := quote(e.Text, false)
	if e.TextProp != "" && w.ident != nil {
		content = "verbatim: " + w.ident(e.TextProp)
	}
	size := lit(t.size)
	if d := w.dyn(e, "fontSize"); d != "" {
		size = d
	}
	font := fmt.Sprintf(".custom(%s, size: %s)", quote(t.family, false), size)
	if t.family == "" {
		font = fmt.Sprintf(".system(size: %s)", size)
	}
	lines := []string{"Text(" + content + ")"}
	var m mods
	m.add("font(%s.weight(.%s))", font, weightName(t.weight))
	if t.italic {
		m.add("italic()")
	}
	if t.gradientTxt {
		w.unsup["gradient text (first stop used)"] = true
	}
	m.add("foregroundColor(%s)", swColor(t.color))
	al := map[string]string{"left": ".leading", "center": ".center", "right": ".trailing"}[t.align]
	if al == "" {
		al = ".leading"
	}
	if t.align != "left" {
		m.add("multilineTextAlignment(%s)", al)
	}
	if ls := t.size * (t.lineHeight - defaultLineHeight); math.Abs(ls) > 0.01 {
		m.add("lineSpacing(%s)", lit(ls))
	}
	if t.hasWidth {
		hAl := map[string]int{"left": 0, "center": 1, "right": 2}[t.align]
		if n.hasH {
			m.add("frame(width: %s, height: %s, alignment: %s)", lit(t.width), lit(n.h), swAlign(hAl, 0))
		} else {
			m.add("fixedSize(horizontal: false, vertical: true)")
			m.add("frame(width: %s, alignment: %s)", lit(t.width), swAlign(hAl, 1))
		}
	} else {
		m.add("fixedSize()")
	}
	if t.shadow != nil {
		m.add("shadow(color: %s, radius: %s, x: %s, y: %s)", swColor(t.shadow.c), lit(t.shadow.blur/2), lit(t.shadow.x), lit(t.shadow.y))
	}
	if len(e.Children) > 0 { // text strokes / masks are not drawn
		w.unsup["children of text"] = true
	}
	return withMods(lines, m)
}

func (w *swWriter) image(e *Element, n *nbox) []string {
	lines := []string{fmt.Sprintf("Image(%s)", quote(nativeAssetName(e.attr("src")), false)), "    .resizable()"}
	var m mods
	m.add("frame(width: %s, height: %s)", lit(n.w), lit(n.h))
	if alt := e.attr("alt"); alt != "" {
		m.add("accessibilityLabel(%s)", quote(alt, false))
	}
	return withMods(lines, m)
}

var svgTok = regexp.MustCompile(`[MLCZ]|-?[0-9]*\.?[0-9]+(?:e-?[0-9]+)?`)

// swPath: SVG path data (M/L/C/Z with absolute numbers, as subpathData writes it) as Path code.
func swPath(d string) []string {
	toks := svgTok.FindAllString(d, -1)
	lines := []string{"Path { p in"}
	pt := func(i int) string { return fmt.Sprintf("CGPoint(x: %s, y: %s)", toks[i], toks[i+1]) }
	for i := 0; i < len(toks); {
		switch toks[i] {
		case "M":
			if i+2 < len(toks) {
				lines = append(lines, "    p.move(to: "+pt(i+1)+")")
			}
			i += 3
		case "L":
			if i+2 < len(toks) {
				lines = append(lines, "    p.addLine(to: "+pt(i+1)+")")
			}
			i += 3
		case "C":
			if i+6 < len(toks) {
				lines = append(lines, fmt.Sprintf("    p.addCurve(to: %s, control1: %s, control2: %s)", pt(i+5), pt(i+1), pt(i+3)))
			}
			i += 7
		case "Z":
			lines = append(lines, "    p.closeSubpath()")
			i++
		default:
			i++
		}
	}
	return append(lines, "}")
}

// svgPaint: the colour a path attribute paints with; a gradient reference falls
// back to the first stop of its definition.
func svgPaint(svg *Element, v string) (ncolor, bool) {
	if strings.HasPrefix(v, "url(#") {
		id := strings.TrimSuffix(strings.TrimPrefix(v, "url(#"), ")")
		var found ncolor
		ok := false
		svg.walk(func(g *Element) {
			if !ok && (g.Tag == "linearGradient" || g.Tag == "radialGradient") && g.attr("id") == id && len(g.Children) > 0 {
				found, ok = parseColor(g.Children[0].attr("stop-color"))
			}
		})
		return found, ok
	}
	return parseColor(v)
}

func (w *swWriter) vector(e *Element, n *nbox) []string {
	lines := []string{"ZStack(alignment: .topLeading) {"}
	for _, p := range e.Children {
		if p.Tag != "path" {
			continue
		}
		var m mods
		d := p.attr("d")
		if p.attr("stroke") != "" && p.attr("fill") == "none" {
			c, _ := parseColor(p.attr("stroke"))
			sw, _ := cssNum(p.attr("stroke-width"))
			style := fmt.Sprintf("lineWidth: %s, lineCap: .%s, lineJoin: .%s", lit(sw), p.attr("stroke-linecap"), p.attr("stroke-linejoin"))
			if ml := p.attr("stroke-miterlimit"); ml != "" {
				style += ", miterLimit: " + ml
			}
			if da := p.attr("stroke-dasharray"); da != "" {
				style += ", dash: [" + strings.Join(strings.Fields(da), ", ") + "]"
				if off := p.attr("stroke-dashoffset"); off != "" {
					style += ", dashPhase: " + off
				}
			}
			m.add("stroke(%s, style: StrokeStyle(%s))", swColor(c), style)
		} else {
			c, ok := svgPaint(e, p.attr("fill"))
			if !ok {
				c = ncolor{0, 0, 0, 1}
			}
			if strings.HasPrefix(p.attr("fill"), "url(#") {
				w.unsup["vector gradient fills (first stop used)"] = true
			}
			m.add("fill(%s, style: FillStyle(eoFill: %v))", swColor(c), p.attr("fill-rule") != "nonzero")
		}
		if o := p.attr("opacity"); o != "" {
			m.add("opacity(%s)", o)
		}
		lines = append(lines, indentLines(swPath(d), "    ")...)
		lines = append(lines, indentLines(m, "    ")...)
	}
	lines = append(lines, "}")
	var m mods
	m.add("frame(width: %s, height: %s, alignment: .topLeading)", lit(n.w), lit(n.h))
	return withMods(lines, m)
}

// call is the component call of an instance: Button(size: "L", label: "Buy").
func (w *swWriter) call(u *ComponentUse) string {
	r := w.reg
	cu := r.units[u.UnitKey]
	comp := r.d.GetComponents()[u.ComponentID]
	var args []string
	for i, ax := range cu.set.GetAxes() {
		if v, ok := comp.GetVariant()[ax.GetName()]; ok && len(ax.GetOptions()) > 0 && v != ax.GetOptions()[0] {
			args = append(args, cu.axes[i]+": "+quote(v, false))
		}
	}
	for _, pv := range r.values(cu, u) {
		p, v := pv.p, pv.v
		switch p.kind {
		case pkText:
			args = append(args, p.ident+": "+quote(v, false))
		case pkNumber:
			if f, err := strconv.ParseFloat(v, 64); err == nil {
				args = append(args, p.ident+": "+lit(f))
			}
		case pkSwap:
			if sw := w.swap(v); sw != "" {
				args = append(args, p.ident+": "+sw)
			}
		default:
			args = append(args, p.ident+": "+strconv.FormatBool(v != "false"))
		}
	}
	return cu.name + "(" + strings.Join(args, ", ") + ")"
}

// swap is the content a swap property receives for component `compID`.
func (w *swWriter) swap(compID string) string {
	r := w.reg
	comp := r.d.GetComponents()[compID]
	if comp == nil {
		return ""
	}
	if key := unitKey(comp, compID); key != "" {
		if _, ok := r.units[key]; ok {
			return "AnyView(" + w.call(&ComponentUse{UnitKey: key, ComponentID: compID, Inst: &opendesignerv1.InstanceNode{ComponentId: compID}}) + ")"
		}
	}
	if tree := r.swapTrees[compID]; tree != nil {
		sub := &swWriter{reg: r, unsup: w.unsup}
		body := sub.view(tree, nil, true)
		return "AnyView(Group {\n" + strings.Join(indentLines(body, "    "), "\n") + "\n})"
	}
	return ""
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

func swiftScreen(d *opendesignerv1.Document, s *Screen, reg *compRegistry, unsup map[string]bool) string {
	w := &swWriter{reg: reg, unsup: unsup}
	body := w.view(s.Root, nil, true)
	var m mods
	for _, t := range s.Root.NavTriggers {
		if t.Kind != "auto" && (t.Dest != nil || t.Kind == "back") {
			w.usesRouter = true
			act := "router.back()"
			if t.Kind != "back" {
				act = "router.go(." + lowerFirst(t.Dest.Name) + ")"
			}
			m.add("accessibilityAction(named: %s) { %s }", quote(t.Label+" ("+t.TransitionID+")", false), act)
		}
	}
	var b strings.Builder
	b.WriteString(tsHeader(d, "screen \""+oneLine(d.GetNodes()[s.NodeID].GetName())+"\" (route "+s.Route+")"))
	b.WriteString("import SwiftUI\n\n")
	for _, t := range s.Root.KeyTriggers {
		fmt.Fprintf(&b, "// %s (key %s): wire with .onKeyPress / a keyboard shortcut\n", flowComment(t), oneLine(t.Label))
	}
	for _, t := range s.Root.NavTriggers {
		if t.Kind == "auto" {
			fmt.Fprintf(&b, "// %s (auto trigger: to be wired, e.g. with a timer)\n", flowComment(t))
		}
	}
	fmt.Fprintf(&b, "struct %s: View {\n", s.Name)
	if w.usesRouter {
		b.WriteString("    @EnvironmentObject private var router: Router\n\n")
	}
	b.WriteString("    var body: some View {\n")
	for _, l := range withMods(body, m) {
		b.WriteString("        " + l + "\n")
	}
	b.WriteString("    }\n}\n\n")
	if w.usesRouter {
		fmt.Fprintf(&b, "#Preview {\n    %s()\n        .environmentObject(Router())\n}\n", s.Name)
	} else {
		fmt.Fprintf(&b, "#Preview {\n    %s()\n}\n", s.Name)
	}
	return b.String()
}

func swiftComponent(r *compRegistry, u *compUnit, unsup map[string]bool) string {
	var b strings.Builder
	what := "component \"" + oneLine(u.title()) + "\""
	if u.set != nil {
		what = "component \"" + oneLine(u.set.GetName()) + "\" (variant set)"
	}
	b.WriteString(tsHeader(r.d, what))
	b.WriteString("import SwiftUI\n\n")
	fmt.Fprintf(&b, "struct %s: View {\n", u.name)
	for i, ax := range u.set.GetAxes() {
		opts := make([]string, len(ax.GetOptions()))
		for j, o := range ax.GetOptions() {
			opts[j] = o
		}
		fmt.Fprintf(&b, "    /// %s: %s\n    var %s: String = %s\n", oneLine(ax.GetName()), oneLine(strings.Join(opts, " | ")), u.axes[i], quote(ax.GetOptions()[0], false))
	}
	for _, p := range u.cprops {
		switch p.kind {
		case pkText:
			doc := oneLine(p.name) + " (text)"
			if len(p.options) > 0 {
				doc += ": " + oneLine(strings.Join(p.options, " | "))
			}
			fmt.Fprintf(&b, "    /// %s\n    var %s: String = %s\n", doc, p.ident, quote(p.def, false))
		case pkNumber:
			def := "0"
			if f, err := strconv.ParseFloat(p.def, 64); err == nil {
				def = lit(f)
			}
			fmt.Fprintf(&b, "    /// %s (%s)\n    var %s: Double = %s\n", oneLine(p.name), strings.ReplaceAll(p.attr, "_", " "), p.ident, def)
		case pkSwap:
			fmt.Fprintf(&b, "    /// %s (replaces a nested component; nil keeps the default)\n    var %s: AnyView? = nil\n", oneLine(p.name), p.ident)
		default:
			fmt.Fprintf(&b, "    /// %s (show/hide)\n    var %s: Bool = %v\n", oneLine(p.name), p.ident, p.def != "false")
		}
	}
	if len(u.axes)+len(u.cprops) > 0 {
		b.WriteString("\n")
	}
	b.WriteString("    var body: some View {\n")
	w := &swWriter{reg: r, ident: u.identOf, unsup: unsup}
	if u.set == nil {
		for _, l := range w.view(u.variants[0].root, nil, true) {
			b.WriteString("        " + l + "\n")
		}
		b.WriteString("    }\n}\n")
		return b.String()
	}
	keyParts := make([]string, len(u.axes))
	for i := range u.axes {
		keyParts[i] = `\(` + u.axes[i] + `)`
	}
	fmt.Fprintf(&b, "        switch \"%s\" {\n", strings.Join(keyParts, "|"))
	for _, v := range u.variants {
		vals := make([]string, len(u.axes))
		for i, ax := range u.set.GetAxes() {
			vals[i] = v.variant[ax.GetName()]
		}
		fmt.Fprintf(&b, "        case %s:\n            // %s\n", quote(strings.Join(vals, "|"), false), oneLine(v.name))
		for _, l := range w.view(v.root, nil, true) {
			b.WriteString("            " + l + "\n")
		}
	}
	b.WriteString("        default:\n            EmptyView() // this combination has no variant in the design\n        }\n    }\n}\n")
	return b.String()
}

func renderSwiftUI(d *opendesignerv1.Document, b *builder, screens []*Screen, opts Options, files map[string][]byte, warnings *[]string) {
	put := func(path, content string) { files[path] = []byte(content) }
	reg := newCompRegistry(d, b, screens, swiftNaming)
	unsup := map[string]bool{}
	for _, key := range reg.order {
		u := reg.units[key]
		put("Sources/Components/"+u.name+".swift", swiftComponent(reg, u, unsup))
	}
	anim := false
	for _, s := range screens {
		put("Sources/Screens/"+s.Name+".swift", swiftScreen(d, s, reg, unsup))
		anim = anim || hasAnimation(s.Root)
	}
	moveNativeAssets(files, func(name, ext string, data []byte) map[string][]byte {
		dir := "Sources/Resources/Assets.xcassets/" + name + ".imageset/"
		return map[string][]byte{
			"Sources/Resources/Assets.xcassets/Contents.json": []byte("{\n  \"info\" : { \"author\" : \"opendesigner\", \"version\" : 1 }\n}\n"),
			dir + name + ext:      data,
			dir + "Contents.json": []byte("{\n  \"images\" : [ { \"filename\" : \"" + name + ext + "\", \"idiom\" : \"universal\" } ],\n  \"info\" : { \"author\" : \"opendesigner\", \"version\" : 1 }\n}\n"),
		}
	})

	home := homeScreen(d, screens, opts)
	var r strings.Builder
	r.WriteString(tsHeader(d, "navigation"))
	r.WriteString("import SwiftUI\n\n// Route: one case per screen. Flow transitions call router.go(.screen); \"back\" transitions call router.back().\nenum Route: Hashable {\n")
	for _, s := range screens {
		fmt.Fprintf(&r, "    case %s // %s\n", lowerFirst(s.Name), s.Route)
	}
	r.WriteString("}\n\nfinal class Router: ObservableObject {\n    @Published var path: [Route] = []\n\n    func go(_ route: Route) { path.append(route) }\n    func back() { _ = path.popLast() }\n}\n")
	put("Sources/Router.swift", r.String())

	var a strings.Builder
	a.WriteString(tsHeader(d, "app entry point"))
	a.WriteString("import SwiftUI\n\n@main\nstruct DesignApp: App {\n    @StateObject private var router = Router()\n\n    var body: some Scene {\n        WindowGroup {\n            NavigationStack(path: $router.path) {\n")
	fmt.Fprintf(&a, "                %s()\n                    .navigationDestination(for: Route.self) { route in\n                        switch route {\n", home.Name)
	for _, s := range screens {
		fmt.Fprintf(&a, "                        case .%s: %s()\n", lowerFirst(s.Name), s.Name)
	}
	a.WriteString("                        }\n                    }\n            }\n            .environmentObject(router)\n        }\n    }\n}\n")
	put("Sources/App.swift", a.String())

	put("README.md", nativeReadme(d, screens, opts, home, reg, anim, unsup, "swiftui"))
	nativeWarnings(unsup, anim, "SwiftUI", warnings)
}

// nativeWarnings reports what the native targets approximate or leave out.
func nativeWarnings(unsup map[string]bool, anim bool, target string, warnings *[]string) {
	var names []string
	for k := range unsup {
		names = append(names, k)
	}
	sort.Strings(names)
	for _, k := range names {
		*warnings = append(*warnings, fmt.Sprintf("%s: not exported: %s", target, k))
	}
	if anim {
		*warnings = append(*warnings, target+": animation clips are not exported")
	}
}
