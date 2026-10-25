package codegen

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Target compose: Kotlin sources for a Jetpack Compose app. Each screen is a
// `@Composable` in `screens/<Name>.kt`, a component set (or a component with
// properties) is a `@Composable` with parameters in `components/<Name>.kt`,
// and `MainActivity.kt` mounts the screens in a NavHost; flow transitions call
// `onNavigate("<Screen>")`.
//
// Like swiftui.go it is written from the IR (native.go parses the CSS back),
// so what the canvas draws is decided once, in build.go.

const composePkg = "design.generated"

var composeNaming = &regNaming{types: kotlinReservedTypes, idents: kotlinReservedIdents}

// kwWriter renders Elements as Compose calls.
type kwWriter struct {
	reg *compRegistry
	// ident: inside a component, the identifier of a component property.
	ident func(name string) string
	// rootMod: the modifier a root element starts from ("modifier" in a component).
	rootMod string
	unsup   map[string]bool
}

func kColor(c ncolor) string {
	a := int(math.Round(c.a * 255))
	if a > 255 {
		a = 255
	}
	return fmt.Sprintf("Color(0x%02X%02X%02X%02X)", a, c.r, c.g, c.b)
}

func dp(v float64) string { return lit(v) + ".dp" }

func (w *kwWriter) dyn(e *Element, style string) string {
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

func kShape(n *nbox, radius string) string {
	switch {
	case n.round && n.hasW && n.hasH && n.w != n.h:
		return "RoundedCornerShape(percent = 50)" // Compose has no ellipse shape: a pill is the closest
	case n.round:
		return "CircleShape"
	case radius != "":
		return "RoundedCornerShape(" + radius + ".dp)"
	case n.radius > 0:
		return "RoundedCornerShape(" + dp(n.radius) + ")"
	}
	return "RectangleShape"
}

// kBrush: the background brush / colour of a fill.
func kFill(f *nfill, n *nbox) (expr string, isBrush bool) {
	g := f.g
	if g == nil || len(g.stops) < 2 {
		return kColor(f.c), false
	}
	stops := make([]string, len(g.stops))
	for i, s := range g.stops {
		stops[i] = fmt.Sprintf("%sf to %s", lit(math.Round(s.pos*1000)/1000), kColor(s.c))
	}
	known := n.hasW && n.hasH && n.w > 0 && n.h > 0
	if g.radial {
		return fmt.Sprintf("Brush.radialGradient(%s, center = Offset(%sf, %sf), radius = %sf)", strings.Join(stops, ", "), lit(g.cx), lit(g.cy), lit(g.r)), true
	}
	if !known {
		return fmt.Sprintf("Brush.linearGradient(%s)", strings.Join(stops, ", ")), true
	}
	sx, sy, ex, ey := gradientPoints(g.deg, n.w, n.h)
	return fmt.Sprintf("Brush.linearGradient(%s, start = Offset(%sf, %sf), end = Offset(%sf, %sf))",
		strings.Join(stops, ", "), lit(sx), lit(sy), lit(ex), lit(ey)), true
}

func kBackground(f *nfill, n *nbox, shape string) string {
	expr, brush := kFill(f, n)
	if brush {
		return fmt.Sprintf(".background(brush = %s, shape = %s)", expr, shape)
	}
	return fmt.Sprintf(".background(%s, %s)", expr, shape)
}

// kcall writes `name(params, modifier = base.chain) { content }`.
func kcall(name string, params []string, base string, chain []string, content []string) []string {
	var args []string
	args = append(args, params...)
	if len(chain) > 0 || base != "Modifier" {
		if len(chain) == 0 {
			args = append(args, "modifier = "+base)
		} else {
			args = append(args, "modifier = "+base+"\n"+strings.Join(indentLines(chain, "    "), "\n"))
		}
	}
	var lines []string
	if len(args) == 0 {
		lines = []string{name + "()"}
	} else {
		lines = []string{name + "("}
		for i, a := range args {
			sep := ","
			if i == len(args)-1 {
				sep = ""
			}
			parts := strings.Split(a+sep, "\n")
			lines = append(lines, indentLines(parts, "    ")...)
		}
		lines = append(lines, ")")
	}
	if content != nil {
		lines[len(lines)-1] += " {"
		lines = append(lines, indentLines(content, "    ")...)
		lines = append(lines, "}")
	}
	return lines
}

func (w *kwWriter) view(e *Element, parent *nbox, root bool, extra []string) []string {
	if e.ShowIf != "" && w.ident != nil {
		inner := *e
		inner.ShowIf = ""
		body := w.view(&inner, parent, root, extra)
		out := append([]string{"if (" + w.ident(e.ShowIf) + ") {"}, indentLines(body, "    ")...)
		return append(out, "}")
	}
	n := parseNative(e)
	if n.blend {
		w.unsup["blend modes"] = true
	}
	if n.backdrop {
		w.unsup["background blur"] = true
	}
	if n.inner {
		w.unsup["inner shadows"] = true
	}
	base := "Modifier"
	if root && w.rootMod != "" {
		base = w.rootMod
	}
	var chain []string
	add := func(format string, a ...any) { chain = append(chain, "."+fmt.Sprintf(format, a...)) }
	if n.absolute && !root && (parent == nil || !parent.flex) && (n.x != 0 || n.y != 0) {
		add("offset(%s, %s)", dp(n.x), dp(n.y))
	}
	// Flow wiring: the element that fires a transition is clickable.
	var comments []string
	var trig *Trigger
	for i := range e.Triggers {
		comments = append(comments, flowComments(e.Triggers[i])...)
		if trig == nil && (e.Triggers[i].Dest != nil || e.Triggers[i].Kind == "back") {
			trig = &e.Triggers[i]
		}
	}
	shape := kShape(n, w.dyn(e, "borderRadius"))
	if e.HasText || e.Tag == "img" || e.Tag == "svg" {
		shape = "RectangleShape"
	}
	for _, s := range n.shadows {
		add("dropShadow(%s, Shadow(radius = %s, color = %s, offset = DpOffset(%s, %s)))", shape, dp(s.blur/2), kColor(s.c), dp(s.x), dp(s.y))
	}
	if n.opacity != 1 || w.dyn(e, "opacity") != "" {
		o := lit(n.opacity) + "f"
		if d := w.dyn(e, "opacity"); d != "" {
			o = d
		}
		add("alpha(%s)", o)
	}
	if n.blur > 0 {
		add("blur(%s)", dp(n.blur))
	}
	if n.rotation != 0 {
		add("rotate(%sf)", lit(n.rotation))
	}
	for _, x := range extra {
		chain = append(chain, x)
	}

	var core []string
	switch {
	case e.HasText:
		core = w.text(e, n, parent, base, chain, trig)
	case e.Tag == "img":
		core = w.image(e, n, base, chain, trig)
	case e.Tag == "svg":
		core = w.vector(e, n, base, chain, trig)
	default:
		core = w.box(e, n, parent, base, chain, shape, trig)
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

func clickable(trig *Trigger) string {
	if trig == nil {
		return ""
	}
	if trig.Kind == "back" {
		return ".clickable { onBack() }"
	}
	return ".clickable { onNavigate(" + quote(trig.Dest.Name, true) + ") }"
}

// sizeChain writes the size and the fill-the-parent modifiers.
func kSize(chain *[]string, n *nbox, parent *nbox, weightOK bool) {
	switch {
	case n.hasW && n.hasH:
		*chain = append(*chain, fmt.Sprintf(".size(%s, %s)", dp(n.w), dp(n.h)))
	case n.hasW:
		*chain = append(*chain, ".width("+dp(n.w)+")")
	case n.hasH:
		*chain = append(*chain, ".height("+dp(n.h)+")")
	}
	if parent != nil && parent.flex {
		fillW := (n.grow && !parent.vertical) || (n.stretch && parent.vertical)
		fillH := (n.grow && parent.vertical) || (n.stretch && !parent.vertical)
		if n.grow && weightOK {
			*chain = append(*chain, ".weight(1f)")
			fillW, fillH = n.stretch && parent.vertical, n.stretch && !parent.vertical
		}
		if fillW {
			*chain = append(*chain, ".fillMaxWidth()")
		}
		if fillH {
			*chain = append(*chain, ".fillMaxHeight()")
		}
	}
}

func (w *kwWriter) box(e *Element, n *nbox, parent *nbox, base string, chain []string, shape string, trig *Trigger) []string {
	var kids, abs []string
	useChild := e.Use != nil && w.reg != nil && w.reg.known(e.Use)
	grid := n.grid // the children carry their cells only when they are the element's own
	if useChild || (e.SwapProp != "" && w.ident != nil) {
		grid = nil
	}
	switch {
	case e.SwapProp != "" && w.ident != nil:
		sw := w.ident(e.SwapProp)
		kids = append(kids, "if ("+sw+" != null) {", "    "+sw+"()", "} else {")
		var def []string
		if useChild {
			def = strings.Split(w.call(e.Use), "\n")
		} else {
			for _, c := range e.Children {
				def = append(def, w.view(c, n, false, nil)...)
			}
		}
		kids = append(kids, indentLines(def, "    ")...)
		kids = append(kids, "}")
	case useChild:
		kids = strings.Split(w.call(e.Use), "\n")
	default:
		for _, c := range e.Children {
			if grid != nil && c.Cell == nil {
				abs = append(abs, w.view(c, n, false, nil)...) // out of the grid's flow
				continue
			}
			var extra []string
			if grid != nil {
				extra = gridModifier(c)
			}
			kids = append(kids, w.view(c, n, false, extra)...)
		}
	}
	if n.wrap {
		w.unsup["wrapping auto layout"] = true
	}
	// weight() needs a Row/Column scope, which the children of a flex container have.
	var out = chain
	kSize(&out, n, parent, parent != nil && parent.flex)
	if n.clip {
		out = append(out, ".clip("+shape+")")
	}
	if c := clickable(trig); c != "" {
		out = append(out, c)
	}
	if n.fill != nil {
		out = append(out, kBackground(n.fill, n, shape))
	}
	for _, s := range n.strokes {
		if s.align != "inside" {
			w.unsup["outside and centred strokes (drawn inside the box)"] = true
		}
		out = append(out, fmt.Sprintf(".border(%s, %s, %s)", dp(s.w), kColor(s.c), shape))
	}
	if p := n.pad; p != [4]float64{} && len(kids)+len(abs) > 0 {
		if p[0] == p[1] && p[1] == p[2] && p[2] == p[3] {
			out = append(out, ".padding("+dp(p[0])+")")
		} else {
			out = append(out, fmt.Sprintf(".padding(start = %s, top = %s, end = %s, bottom = %s)", dp(p[3]), dp(p[0]), dp(p[1]), dp(p[2])))
		}
	}
	if len(kids) == 0 && len(abs) == 0 {
		return kcall("Box", nil, base, out, nil)
	}
	if grid != nil {
		if len(kids) > 0 {
			return kGrid(grid, base, out, kids, abs)
		}
		kids = abs // only out-of-flow children: a plain Box
	}
	if !n.flex {
		return kcall("Box", nil, base, out, kids)
	}
	pos := func(a string, v [3]string) string { return v[alignIdx(a)] }
	var params []string
	if n.vertical {
		v := pos(n.main, [3]string{"Alignment.Top", "Alignment.CenterVertically", "Alignment.Bottom"})
		arr := "Arrangement.spacedBy(" + dp(n.gap) + ", " + v + ")"
		if n.main == "between" {
			arr = "Arrangement.SpaceBetween"
		} else if n.gap == 0 {
			arr = pos(n.main, [3]string{"Arrangement.Top", "Arrangement.Center", "Arrangement.Bottom"})
		}
		params = []string{"verticalArrangement = " + arr, "horizontalAlignment = " + pos(n.cross, [3]string{"Alignment.Start", "Alignment.CenterHorizontally", "Alignment.End"})}
		return kcall("Column", params, base, out, kids)
	}
	h := pos(n.main, [3]string{"Alignment.Start", "Alignment.CenterHorizontally", "Alignment.End"})
	arr := "Arrangement.spacedBy(" + dp(n.gap) + ", " + h + ")"
	if n.main == "between" {
		arr = "Arrangement.SpaceBetween"
	} else if n.gap == 0 {
		arr = pos(n.main, [3]string{"Arrangement.Start", "Arrangement.Center", "Arrangement.End"})
	}
	params = []string{"horizontalArrangement = " + arr, "verticalAlignment = " + pos(n.cross, [3]string{"Alignment.Top", "Alignment.CenterVertically", "Alignment.Bottom"})}
	return kcall("Row", params, base, out, kids)
}

func (w *kwWriter) text(e *Element, n *nbox, parent *nbox, base string, chain []string, trig *Trigger) []string {
	t := parseText(e)
	content := quote(e.Text, true)
	if e.TextProp != "" && w.ident != nil {
		content = w.ident(e.TextProp)
	}
	size := lit(t.size) + ".sp"
	if d := w.dyn(e, "fontSize"); d != "" {
		size = d + ".sp"
	}
	out := chain
	if t.hasWidth {
		out = append(out, ".width("+dp(t.width)+")")
	}
	if n.hasH {
		out = append(out, ".height("+dp(n.h)+")")
	}
	if parent != nil && parent.flex && n.grow {
		kSize(&out, &nbox{grow: n.grow, stretch: n.stretch}, parent, true)
	}
	if c := clickable(trig); c != "" {
		out = append(out, c)
	}
	params := []string{"text = " + content, "color = " + kColor(t.color), "fontSize = " + size}
	if t.weight != 400 {
		params = append(params, fmt.Sprintf("fontWeight = FontWeight(%d)", t.weight))
	}
	if t.italic {
		params = append(params, "fontStyle = FontStyle.Italic")
	}
	switch strings.ToLower(t.family) {
	case "monospace", "courier", "courier new", "menlo":
		params = append(params, "fontFamily = FontFamily.Monospace")
	case "serif", "georgia", "times new roman":
		params = append(params, "fontFamily = FontFamily.Serif")
	}
	if t.lineHeight != defaultLineHeight {
		params = append(params, fmt.Sprintf("lineHeight = %s.sp", lit(t.size*t.lineHeight)))
	}
	if t.align != "left" {
		params = append(params, "textAlign = TextAlign."+map[string]string{"center": "Center", "right": "End"}[t.align])
	}
	if t.shadow != nil {
		params = append(params, fmt.Sprintf("style = TextStyle(shadow = Shadow(color = %s, offset = Offset(%sf, %sf), blurRadius = %sf))", kColor(t.shadow.c), lit(t.shadow.x), lit(t.shadow.y), lit(t.shadow.blur)))
	}
	if t.gradientTxt {
		w.unsup["gradient text (first stop used)"] = true
	}
	return kcall("Text", params, base, out, nil)
}

func (w *kwWriter) image(e *Element, n *nbox, base string, chain []string, trig *Trigger) []string {
	out := append(chain, fmt.Sprintf(".size(%s, %s)", dp(n.w), dp(n.h)))
	if c := clickable(trig); c != "" {
		out = append(out, c)
	}
	params := []string{
		"painter = painterResource(R.drawable." + nativeAssetName(e.attr("src")) + ")",
		"contentDescription = " + quote(e.attr("alt"), true),
		"contentScale = ContentScale.FillBounds",
	}
	return kcall("Image", params, base, out, nil)
}

func (w *kwWriter) vector(e *Element, n *nbox, base string, chain []string, trig *Trigger) []string {
	out := append(chain, fmt.Sprintf(".size(%s, %s)", dp(n.w), dp(n.h)))
	if c := clickable(trig); c != "" {
		out = append(out, c)
	}
	var body []string
	var draws []string
	for i, p := range e.Children {
		if p.Tag != "path" {
			continue
		}
		name := "p" + strconv.Itoa(i)
		body = append(body, fmt.Sprintf("val %s = PathParser().parsePathString(%s).toPath()", name, quote(p.attr("d"), true)))
		alpha := ""
		if o := p.attr("opacity"); o != "" {
			alpha = ", alpha = " + o + "f"
		}
		if p.attr("stroke") != "" && p.attr("fill") == "none" {
			c, _ := parseColor(p.attr("stroke"))
			sw, _ := cssNum(p.attr("stroke-width"))
			style := fmt.Sprintf("Stroke(width = %sf, cap = StrokeCap.%s, join = StrokeJoin.%s", lit(sw), capName(p.attr("stroke-linecap")), joinName(p.attr("stroke-linejoin")))
			if ml := p.attr("stroke-miterlimit"); ml != "" {
				style += ", miter = " + ml + "f"
			}
			if da := p.attr("stroke-dasharray"); da != "" {
				f := strings.Fields(da)
				for j := range f {
					f[j] += "f"
				}
				phase := "0f"
				if off := p.attr("stroke-dashoffset"); off != "" {
					phase = off + "f"
				}
				style += ", pathEffect = PathEffect.dashPathEffect(floatArrayOf(" + strings.Join(f, ", ") + "), " + phase + ")"
			}
			draws = append(draws, fmt.Sprintf("drawPath(%s, %s%s, style = %s)", name, kColor(c), alpha, style+")"))
		} else {
			c, ok := svgPaint(e, p.attr("fill"))
			if !ok {
				c = ncolor{0, 0, 0, 1}
			}
			if strings.HasPrefix(p.attr("fill"), "url(#") {
				w.unsup["vector gradient fills (first stop used)"] = true
			}
			if p.attr("fill-rule") != "nonzero" {
				body = append(body, name+".fillType = PathFillType.EvenOdd")
			}
			draws = append(draws, fmt.Sprintf("drawPath(%s, %s%s)", name, kColor(c), alpha))
		}
	}
	// The path data is in dp (1 unit = 1 design px): scale it to device pixels.
	content := append(body, "scale(density, Offset.Zero) {")
	content = append(content, indentLines(draws, "    ")...)
	content = append(content, "}")
	lines := kcall("Canvas", nil, base, out, []string{})
	// kcall opened the lambda with no content; splice the body in.
	return append(lines[:len(lines)-1], append(indentLines(content, "    "), "}")...)
}

func capName(v string) string {
	switch v {
	case "round":
		return "Round"
	case "square":
		return "Square"
	}
	return "Butt"
}

func joinName(v string) string {
	switch v {
	case "round":
		return "Round"
	case "bevel":
		return "Bevel"
	}
	return "Miter"
}

// call is the component call of an instance: Button(size = "L", label = "Buy").
func (w *kwWriter) call(u *ComponentUse) string {
	r := w.reg
	cu := r.units[u.UnitKey]
	comp := r.d.GetComponents()[u.ComponentID]
	var args []string
	for i, ax := range cu.set.GetAxes() {
		if v, ok := comp.GetVariant()[ax.GetName()]; ok && len(ax.GetOptions()) > 0 && v != ax.GetOptions()[0] {
			args = append(args, cu.axes[i]+" = "+quote(v, true))
		}
	}
	for _, pv := range r.values(cu, u) {
		p, v := pv.p, pv.v
		switch p.kind {
		case pkText:
			args = append(args, p.ident+" = "+quote(v, true))
		case pkNumber:
			if f, err := strconv.ParseFloat(v, 64); err == nil {
				args = append(args, p.ident+" = "+lit(f)+"f")
			}
		case pkSwap:
			if sw := w.swap(v); sw != "" {
				args = append(args, p.ident+" = "+sw)
			}
		default:
			args = append(args, p.ident+" = "+strconv.FormatBool(v != "false"))
		}
	}
	return cu.name + "(" + strings.Join(args, ", ") + ")"
}

func (w *kwWriter) swap(compID string) string {
	r := w.reg
	comp := r.d.GetComponents()[compID]
	if comp == nil {
		return ""
	}
	if key := unitKey(comp, compID); key != "" {
		if _, ok := r.units[key]; ok {
			return "{ " + w.call(&ComponentUse{UnitKey: key, ComponentID: compID, Inst: &opendesignerv1.InstanceNode{ComponentId: compID}}) + " }"
		}
	}
	if tree := r.swapTrees[compID]; tree != nil {
		sub := &kwWriter{reg: r, unsup: w.unsup}
		body := sub.view(tree, nil, true, nil)
		return "{\n" + strings.Join(indentLines(body, "    "), "\n") + "\n}"
	}
	return ""
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

const composeImports = `import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
`

func kotlinScreen(d *opendesignerv1.Document, s *Screen, reg *compRegistry, unsup map[string]bool) string {
	w := &kwWriter{reg: reg, unsup: unsup}
	var extra []string
	var acts []string
	for _, t := range s.Root.NavTriggers {
		if t.Kind != "auto" && (t.Dest != nil || t.Kind == "back") {
			act := "onBack()"
			if t.Kind != "back" {
				act = "onNavigate(" + quote(t.Dest.Name, true) + ")"
			}
			acts = append(acts, fmt.Sprintf("CustomAccessibilityAction(%s) { %s; true }", quote(t.Label+" ("+t.TransitionID+")", true), act))
		}
	}
	if len(acts) > 0 {
		extra = append(extra, ".semantics { customActions = listOf("+strings.Join(acts, ", ")+") }")
	}
	body := w.view(s.Root, nil, true, extra)
	var b strings.Builder
	b.WriteString(tsHeader(d, "screen \""+oneLine(d.GetNodes()[s.NodeID].GetName())+"\" (route "+s.Route+")"))
	b.WriteString("package " + composePkg + ".screens\n\n")
	b.WriteString(composeImports)
	fmt.Fprintf(&b, "import %s.R\nimport %s.components.*\n\n", composePkg, composePkg)
	for _, t := range s.Root.KeyTriggers {
		fmt.Fprintf(&b, "// %s (key %s): wire with Modifier.onKeyEvent\n", flowComment(t), oneLine(t.Label))
	}
	for _, t := range s.Root.NavTriggers {
		if t.Kind == "auto" {
			fmt.Fprintf(&b, "// %s (auto trigger: to be wired, e.g. with LaunchedEffect + delay)\n", flowComment(t))
		}
	}
	fmt.Fprintf(&b, "@Composable\nfun %s(onNavigate: (String) -> Unit = {}, onBack: () -> Unit = {}) {\n", s.Name)
	for _, l := range body {
		b.WriteString("    " + l + "\n")
	}
	b.WriteString("}\n")
	return b.String()
}

func kotlinComponent(r *compRegistry, u *compUnit, unsup map[string]bool) string {
	var b strings.Builder
	what := "component \"" + oneLine(u.title()) + "\""
	if u.set != nil {
		what = "component \"" + oneLine(u.set.GetName()) + "\" (variant set)"
	}
	b.WriteString(tsHeader(r.d, what))
	b.WriteString("package " + composePkg + ".components\n\n")
	b.WriteString(composeImports)
	fmt.Fprintf(&b, "import %s.R\n\n", composePkg)
	var params []string
	params = append(params, "modifier: Modifier = Modifier")
	for i, ax := range u.set.GetAxes() {
		params = append(params, fmt.Sprintf("%s: String = %s", u.axes[i], quote(ax.GetOptions()[0], true)))
	}
	for _, p := range u.cprops {
		switch p.kind {
		case pkText:
			params = append(params, fmt.Sprintf("%s: String = %s", p.ident, quote(p.def, true)))
		case pkNumber:
			def := "0f"
			if f, err := strconv.ParseFloat(p.def, 64); err == nil {
				def = lit(f) + "f"
			}
			params = append(params, fmt.Sprintf("%s: Float = %s", p.ident, def))
		case pkSwap:
			params = append(params, fmt.Sprintf("%s: (@Composable () -> Unit)? = null", p.ident))
		default:
			params = append(params, fmt.Sprintf("%s: Boolean = %v", p.ident, p.def != "false"))
		}
	}
	// KDoc: the design name of each parameter.
	b.WriteString("/**\n")
	for i, ax := range u.set.GetAxes() {
		fmt.Fprintf(&b, " * @param %s %s: %s\n", u.axes[i], oneLine(ax.GetName()), oneLine(strings.Join(ax.GetOptions(), " | ")))
	}
	for _, p := range u.cprops {
		kind := map[propKind]string{pkText: "text", pkNumber: strings.ReplaceAll(p.attr, "_", " "), pkSwap: "replaces a nested component; null keeps the default", pkBool: "show/hide"}[p.kind]
		fmt.Fprintf(&b, " * @param %s %s (%s)\n", p.ident, oneLine(p.name), kind)
	}
	b.WriteString(" */\n@Composable\nfun " + u.name + "(\n")
	for i, p := range params {
		sep := ","
		if i == len(params)-1 {
			sep = ""
		}
		b.WriteString("    " + p + sep + "\n")
	}
	b.WriteString(") {\n")
	w := &kwWriter{reg: r, ident: u.identOf, rootMod: "modifier", unsup: unsup}
	if u.set == nil {
		for _, l := range w.view(u.variants[0].root, nil, true, nil) {
			b.WriteString("    " + l + "\n")
		}
		b.WriteString("}\n")
		return b.String()
	}
	keyParts := make([]string, len(u.axes))
	for i := range u.axes {
		keyParts[i] = "${" + u.axes[i] + "}"
	}
	fmt.Fprintf(&b, "    when (\"%s\") {\n", strings.Join(keyParts, "|"))
	for _, v := range u.variants {
		vals := make([]string, len(u.axes))
		for i, ax := range u.set.GetAxes() {
			vals[i] = v.variant[ax.GetName()]
		}
		fmt.Fprintf(&b, "        %s -> {\n            // %s\n", quote(strings.Join(vals, "|"), true), oneLine(v.name))
		for _, l := range w.view(v.root, nil, true, nil) {
			b.WriteString("            " + l + "\n")
		}
		b.WriteString("        }\n")
	}
	b.WriteString("        else -> Unit // this combination has no variant in the design\n    }\n}\n")
	return b.String()
}

func renderCompose(d *opendesignerv1.Document, b *builder, screens []*Screen, opts Options, files map[string][]byte, warnings *[]string) {
	put := func(path, content string) { files[path] = []byte(content) }
	const src = "app/src/main/kotlin/design/generated/"
	reg := newCompRegistry(d, b, screens, composeNaming)
	unsup := map[string]bool{}
	for _, key := range reg.order {
		u := reg.units[key]
		put(src+"components/"+u.name+".kt", kotlinComponent(reg, u, unsup))
	}
	anim := false
	for _, s := range screens {
		put(src+"screens/"+s.Name+".kt", kotlinScreen(d, s, reg, unsup))
		anim = anim || hasAnimation(s.Root)
	}
	for _, c := range files {
		if strings.Contains(string(c), "DesignGrid(") {
			put(src+"components/DesignGrid.kt", tsHeader(d, "grid layout helper")+designGridKt)
			break
		}
	}
	moveNativeAssets(files, func(name, ext string, data []byte) map[string][]byte {
		return map[string][]byte{"app/src/main/res/drawable-nodpi/" + name + ext: data}
	})

	home := homeScreen(d, screens, opts)
	var m strings.Builder
	m.WriteString(tsHeader(d, "app entry point"))
	m.WriteString("package " + composePkg + "\n\n")
	m.WriteString("import android.os.Bundle\nimport androidx.activity.ComponentActivity\nimport androidx.activity.compose.setContent\nimport androidx.compose.runtime.Composable\nimport androidx.navigation.compose.NavHost\nimport androidx.navigation.compose.composable\nimport androidx.navigation.compose.rememberNavController\n")
	m.WriteString("import " + composePkg + ".screens.*\n\n")
	m.WriteString("class MainActivity : ComponentActivity() {\n    override fun onCreate(savedInstanceState: Bundle?) {\n        super.onCreate(savedInstanceState)\n        setContent { DesignApp() }\n    }\n}\n\n")
	m.WriteString("// One destination per screen; flow transitions call onNavigate(\"<Screen>\"), \"back\" transitions call onBack().\n@Composable\nfun DesignApp() {\n    val nav = rememberNavController()\n")
	fmt.Fprintf(&m, "    NavHost(navController = nav, startDestination = %s) {\n", quote(home.Name, true))
	for _, s := range screens {
		fmt.Fprintf(&m, "        composable(%s) { %s(onNavigate = { nav.navigate(it) }, onBack = { nav.popBackStack() }) } // %s\n", quote(s.Name, true), s.Name, s.Route)
	}
	m.WriteString("    }\n}\n")
	put(src+"MainActivity.kt", m.String())

	put("README.md", nativeReadme(d, screens, opts, home, reg, anim, unsup, "compose"))
	nativeWarnings(unsup, anim, "Compose", warnings)
}
