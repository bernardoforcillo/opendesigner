package codegen

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// NATIVE TARGETS (SwiftUI, Jetpack Compose). They read the SAME IR as html and
// react: the CSS properties of an Element are parsed back into a small neutral
// model (nbox) that the two native renderers (swiftui.go, compose.go) write in
// their own syntax. Going through the IR keeps all the canvas semantics that
// build.go already encodes -- first fill, gradient geometry, stroke rings,
// opacity baking -- in ONE place instead of three.

// ncolor is an sRGB colour with 0-255 channels and a 0-1 alpha.
type ncolor struct {
	r, g, b int
	a       float64
}

type nstop struct {
	c   ncolor
	pos float64 // 0-1 along the gradient line
}

// ngrad is a parsed CSS gradient. Linear: deg (CSS angle). Radial: centre
// (cx, cy) and radius r in px.
type ngrad struct {
	radial     bool
	deg        float64
	cx, cy, r  float64
	stops      []nstop
	alphaSplit bool
}

type nfill struct {
	c ncolor
	g *ngrad // nil = flat colour
}

type nshadow struct {
	x, y, blur float64
	c          ncolor
}

// nstroke: a border ring read back from the box-shadow rings of strokeRings.
type nstroke struct {
	w     float64
	c     ncolor
	align string // inside | center | outside
}

// nbox is everything a native renderer needs from a container-like element.
type nbox struct {
	w, h          float64
	hasW, hasH    bool // a fixed size (otherwise hug / filled by the parent)
	x, y          float64
	absolute      bool
	flex          bool
	grid          *ngrid // a GRID auto layout (flex is then false)
	fillX         bool   // justify-self: stretch, a grid child filling its cell horizontally
	vertical      bool
	main, cross   string // start | center | end | between
	gap           float64
	pad           [4]float64 // top right bottom left
	grow, stretch bool       // fills the parent's main / cross axis
	wrap          bool
	clip          bool
	rotation      float64
	opacity       float64
	fill          *nfill
	radius        float64
	round         bool // border-radius: 50% (ellipse)
	shadows       []nshadow
	strokes       []nstroke
	inner         bool // has inner shadows (not exported)
	blur          float64
	blend         bool // has a blend mode (not exported)
	backdrop      bool // has a background blur (not exported)
}

// splitTop splits on `sep` outside of parentheses.
func splitTop(s string, sep rune) []string {
	var out []string
	depth, start := 0, 0
	for i, r := range s {
		switch {
		case r == '(':
			depth++
		case r == ')':
			depth--
		case r == sep && depth == 0:
			out = append(out, strings.TrimSpace(s[start:i]))
			start = i + 1
		}
	}
	return append(out, strings.TrimSpace(s[start:]))
}

// fieldsTop splits on spaces outside of parentheses.
func fieldsTop(s string) []string {
	var out []string
	depth, start := 0, -1
	for i, r := range s {
		switch {
		case r == '(':
			depth++
		case r == ')':
			depth--
		}
		if r == ' ' && depth == 0 {
			if start >= 0 {
				out = append(out, s[start:i])
				start = -1
			}
		} else if start < 0 {
			start = i
		}
	}
	if start >= 0 {
		out = append(out, s[start:])
	}
	return out
}

// cssNum reads "12px", "0", "1.5", "50%" (the % is dropped).
func cssNum(s string) (float64, bool) {
	s = strings.TrimSuffix(strings.TrimSuffix(strings.TrimSuffix(strings.TrimSpace(s), "px"), "deg"), "%")
	v, err := strconv.ParseFloat(s, 64)
	return v, err == nil
}

// parseColor reads what colorCSS writes: #rgb, #rrggbb, rgba(r,g,b,a), "transparent".
func parseColor(s string) (ncolor, bool) {
	s = strings.TrimSpace(s)
	switch {
	case s == "transparent":
		return ncolor{0, 0, 0, 0}, true
	case strings.HasPrefix(s, "#"):
		h := s[1:]
		if len(h) == 3 {
			h = string([]byte{h[0], h[0], h[1], h[1], h[2], h[2]})
		}
		if len(h) != 6 {
			return ncolor{}, false
		}
		v, err := strconv.ParseUint(h, 16, 32)
		if err != nil {
			return ncolor{}, false
		}
		return ncolor{int(v >> 16), int(v >> 8 & 255), int(v & 255), 1}, true
	case strings.HasPrefix(s, "rgba(") && strings.HasSuffix(s, ")"):
		p := strings.Split(s[5:len(s)-1], ",")
		if len(p) != 4 {
			return ncolor{}, false
		}
		var c ncolor
		var err error
		for i, dst := range []*int{&c.r, &c.g, &c.b} {
			if *dst, err = strconv.Atoi(strings.TrimSpace(p[i])); err != nil {
				return ncolor{}, false
			}
		}
		if c.a, err = strconv.ParseFloat(strings.TrimSpace(p[3]), 64); err != nil {
			return ncolor{}, false
		}
		return c, true
	}
	return ncolor{}, false
}

// parseGradient reads linear-gradient(<deg>,stops) and radial-gradient(circle Rpx at Xpx Ypx,stops).
func parseGradient(s string) *ngrad {
	radial := strings.HasPrefix(s, "radial-gradient(")
	if !radial && !strings.HasPrefix(s, "linear-gradient(") {
		return nil
	}
	i := strings.Index(s, "(")
	if !strings.HasSuffix(s, ")") {
		return nil
	}
	parts := splitTop(s[i+1:len(s)-1], ',')
	if len(parts) < 3 {
		return nil
	}
	g := &ngrad{radial: radial}
	if radial {
		f := strings.Fields(parts[0]) // circle 50px at 50px 40px
		if len(f) != 5 || f[0] != "circle" || f[2] != "at" {
			return nil
		}
		var ok [3]bool
		g.r, ok[0] = cssNum(f[1])
		g.cx, ok[1] = cssNum(f[3])
		g.cy, ok[2] = cssNum(f[4])
		if !ok[0] || !ok[1] || !ok[2] {
			return nil
		}
	} else {
		var ok bool
		if g.deg, ok = cssNum(parts[0]); !ok {
			return nil
		}
	}
	for _, p := range parts[1:] {
		f := fieldsTop(p)
		if len(f) != 2 {
			return nil
		}
		c, ok := parseColor(f[0])
		pos, ok2 := cssNum(f[1])
		if !ok || !ok2 {
			return nil
		}
		g.stops = append(g.stops, nstop{c, pos / 100})
	}
	return g
}

// parseShadows reads a box-shadow / drop-shadow list: rings (strokes) are told
// apart from real shadows.
func (n *nbox) parseShadows(v string) {
	type ring struct {
		inset bool
		w     float64
		c     ncolor
	}
	var rings []ring
	for _, ent := range splitTop(v, ',') {
		f := fieldsTop(ent)
		inset := false
		if len(f) > 0 && f[0] == "inset" {
			inset, f = true, f[1:]
		}
		if len(f) < 4 {
			continue
		}
		c, ok := parseColor(f[len(f)-1])
		if !ok {
			continue
		}
		var nums []float64
		for _, t := range f[:len(f)-1] {
			x, ok := cssNum(t)
			if !ok {
				nums = nil
				break
			}
			nums = append(nums, x)
		}
		switch {
		case len(nums) == 4 && nums[0] == 0 && nums[1] == 0 && nums[2] == 0:
			rings = append(rings, ring{inset, nums[3], c})
		case inset:
			n.inner = true
		case len(nums) == 3:
			n.shadows = append(n.shadows, nshadow{nums[0], nums[1], nums[2], c})
		}
	}
	// A centred stroke is an outside ring followed by an inside ring of the same
	// width and colour (strokeRings writes them side by side).
	for i := 0; i < len(rings); i++ {
		r := rings[i]
		if !r.inset && i+1 < len(rings) && rings[i+1].inset && rings[i+1].w == r.w && rings[i+1].c == r.c {
			n.strokes = append(n.strokes, nstroke{r.w * 2, r.c, "center"})
			i++
			continue
		}
		al := "outside"
		if r.inset {
			al = "inside"
		}
		n.strokes = append(n.strokes, nstroke{r.w, r.c, al})
	}
}

// bgImage: the gradient string the native targets parse (NativeBG, else background-image).
func (e *Element) bgImage() string {
	if e.NativeBG != "" {
		return e.NativeBG
	}
	return e.style("background-image")
}

// parseNative reads an element's CSS back into an nbox.
func parseNative(e *Element) *nbox {
	n := &nbox{opacity: 1, main: "start", cross: "start"}
	if v := e.style("width"); v != "" && v != "fit-content" {
		n.w, n.hasW = cssNum(v)
	}
	if v := e.style("height"); v != "" && v != "fit-content" {
		n.h, n.hasH = cssNum(v)
	}
	n.absolute = e.style("position") == "absolute"
	n.x, _ = cssNum(e.style("left"))
	n.y, _ = cssNum(e.style("top"))
	if e.style("display") == "flex" {
		n.flex = true
		n.vertical = e.style("flex-direction") == "column"
		al := map[string]string{"flex-start": "start", "center": "center", "flex-end": "end", "space-between": "between"}
		n.main, n.cross = al[e.style("justify-content")], al[e.style("align-items")]
		if n.main == "" {
			n.main = "start"
		}
		if n.cross == "" || n.cross == "between" {
			n.cross = "start"
		}
	}
	if e.style("display") == "grid" {
		n.grid = parseGrid(e)
	}
	n.fillX = e.style("justify-self") == "stretch"
	n.wrap = e.style("flex-wrap") == "wrap"
	if g := e.style("gap"); g != "" {
		f := strings.Fields(g)
		// "row col": the gap between children along the main axis is the column one for a row.
		pick := f[len(f)-1]
		if n.vertical {
			pick = f[0]
		}
		n.gap, _ = cssNum(pick)
	}
	if p := strings.Fields(e.style("padding")); len(p) > 0 {
		v := make([]float64, len(p))
		for i, s := range p {
			v[i], _ = cssNum(s)
		}
		switch len(v) {
		case 1:
			n.pad = [4]float64{v[0], v[0], v[0], v[0]}
		case 2:
			n.pad = [4]float64{v[0], v[1], v[0], v[1]}
		case 4:
			n.pad = [4]float64{v[0], v[1], v[2], v[3]}
		}
	}
	n.grow = strings.HasPrefix(e.style("flex"), "1 ")
	n.stretch = e.style("align-self") == "stretch"
	n.clip = e.style("overflow") == "hidden"
	if t := e.style("transform"); strings.HasPrefix(t, "rotate(") {
		n.rotation, _ = cssNum(strings.TrimSuffix(strings.TrimPrefix(t, "rotate("), ")"))
	}
	if o := e.style("opacity"); o != "" {
		n.opacity, _ = cssNum(o)
	}
	if r := e.style("border-radius"); r == "50%" {
		n.round = true
	} else if r != "" {
		n.radius, _ = cssNum(r)
	}
	if g := parseGradient(e.bgImage()); g != nil {
		n.fill = &nfill{g: g}
		if len(g.stops) > 0 {
			n.fill.c = g.stops[0].c
		}
	} else if c, ok := parseColor(e.style("background-color")); ok {
		n.fill = &nfill{c: c}
	}
	n.parseShadows(e.style("box-shadow"))
	// filter: drop-shadow(...) blur(...)
	for _, f := range fieldsTop(e.style("filter")) {
		switch {
		case strings.HasPrefix(f, "drop-shadow(") && strings.HasSuffix(f, ")"):
			if p := fieldsTop(f[len("drop-shadow(") : len(f)-1]); len(p) == 4 {
				x, _ := cssNum(p[0])
				y, _ := cssNum(p[1])
				b, _ := cssNum(p[2])
				if c, ok := parseColor(p[3]); ok {
					n.shadows = append(n.shadows, nshadow{x, y, b, c})
				}
			}
		case strings.HasPrefix(f, "blur(") && strings.HasSuffix(f, ")"):
			n.blur, _ = cssNum(f[5 : len(f)-1])
		}
	}
	n.blend = e.style("mix-blend-mode") != ""
	n.backdrop = e.style("backdrop-filter") != ""
	return n
}

// ntext is the style of a text element.
type ntext struct {
	family      string
	size        float64
	weight      int
	italic      bool
	lineHeight  float64
	align       string // left | center | right
	color       ncolor
	width       float64
	hasWidth    bool
	shadow      *nshadow
	gradientTxt bool
}

func parseText(e *Element) ntext {
	t := ntext{size: defaultFontSize, weight: 400, lineHeight: defaultLineHeight, align: "left", color: ncolor{0, 0, 0, 1}}
	fam := strings.Split(e.style("font-family"), ",")[0]
	t.family = strings.Trim(strings.TrimSpace(fam), `'"`)
	if v, ok := cssNum(e.style("font-size")); ok {
		t.size = v
	}
	if v, err := strconv.Atoi(e.style("font-weight")); err == nil {
		t.weight = v
	}
	t.italic = e.style("font-style") == "italic"
	if v, ok := cssNum(e.style("line-height")); ok {
		t.lineHeight = v
	}
	if a := e.style("text-align"); a != "" {
		t.align = a
	}
	if w := e.style("width"); w != "" {
		t.width, t.hasWidth = cssNum(w)
	}
	if g := parseGradient(e.bgImage()); g != nil && len(g.stops) > 0 {
		t.color, t.gradientTxt = g.stops[0].c, true
	} else if c, ok := parseColor(e.style("color")); ok {
		t.color = c
	}
	if sh := e.style("text-shadow"); sh != "" {
		f := fieldsTop(sh)
		if len(f) == 4 {
			x, _ := cssNum(f[0])
			y, _ := cssNum(f[1])
			b, _ := cssNum(f[2])
			if c, ok := parseColor(f[3]); ok {
				t.shadow = &nshadow{x, y, b, c}
			}
		}
	}
	return t
}

// gradientPoints: the start and end of a CSS linear gradient line, in px of a
// w x h box (CSS: the line crosses the centre at `deg` and its length is
// |w sin| + |h cos|, which is also what the stop percentages refer to).
func gradientPoints(deg, w, h float64) (sx, sy, ex, ey float64) {
	a := deg * math.Pi / 180
	dx, dy := math.Sin(a), -math.Cos(a)
	l := math.Abs(w*dx) + math.Abs(h*dy)
	cx, cy := w/2, h/2
	return cx - dx*l/2, cy - dy*l/2, cx + dx*l/2, cy + dy*l/2
}

// weightName: the CSS weight as the 100-900 scale's name (shared by both targets).
func weightName(w int) string {
	switch {
	case w <= 150:
		return "thin"
	case w <= 250:
		return "ultraLight"
	case w <= 350:
		return "light"
	case w <= 450:
		return "regular"
	case w <= 550:
		return "medium"
	case w <= 650:
		return "semibold"
	case w <= 750:
		return "bold"
	case w <= 850:
		return "heavy"
	}
	return "black"
}

// lit formats a number for source (at most 3 decimals, no trailing zeros).
func lit(v float64) string { return num(v) }

// nativeAssetName: the resource name of an image asset (a lowercase identifier
// valid as an Android drawable and an Xcode image set).
func nativeAssetName(src string) string {
	base := strings.TrimSuffix(src, "."+strings.TrimPrefix(extOf(src), "."))
	base = strings.ToLower(base)
	var sb strings.Builder
	for _, r := range base {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			sb.WriteRune(r)
		}
	}
	s := sb.String()
	if len(s) > 12 {
		s = s[:12]
	}
	return "img_" + s
}

func extOf(p string) string {
	if i := strings.LastIndex(p, "."); i >= 0 {
		return p[i:]
	}
	return ""
}

// nativeReserved: type names the native languages and UI frameworks already
// use; a screen or component called like that gets a suffix.
var swiftReservedTypes = setOf("Button", "Text", "Image", "Label", "List", "Toggle", "Slider", "Picker", "Form", "Section", "Link", "Menu",
	"Color", "Shape", "Path", "Circle", "Rectangle", "Ellipse", "Capsule", "Group", "Spacer", "Divider", "Stepper", "TextField", "VStack",
	"HStack", "ZStack", "View", "Canvas", "Table", "Grid", "Gauge", "ProgressView", "TabView", "ScrollView", "NavigationStack", "Router",
	"Route", "App", "Scene", "Font", "Animation", "Binding", "State", "Environment", "Never", "Any", "Set", "Array", "Dictionary", "String",
	"Int", "Double", "Bool", "Date", "Data", "URL", "Result", "Optional", "Self", "Type", "Protocol")
var kotlinReservedTypes = setOf("Button", "Text", "Image", "Icon", "Box", "Row", "Column", "Spacer", "Surface", "Scaffold", "Card", "Divider",
	"Modifier", "Color", "Brush", "Shape", "Path", "Canvas", "Dp", "Alignment", "Arrangement", "TextAlign", "FontWeight", "FontStyle",
	"FontFamily", "Offset", "Shadow", "Composable", "MainActivity", "Navigator", "NavHost", "Any", "Unit", "String", "Int", "Float",
	"Double", "Boolean", "List", "Map", "Set", "Array", "Pair", "Nothing", "Object", "Result", "Screens")
var swiftReservedIdents = setOf("in", "is", "as", "var", "let", "func", "class", "struct", "enum", "protocol", "extension", "init", "self", "Self",
	"super", "return", "if", "else", "for", "while", "switch", "case", "default", "break", "continue", "do", "try", "throw", "throws",
	"true", "false", "nil", "import", "static", "public", "private", "internal", "where", "some", "any", "body", "operator", "subscript",
	"typealias", "defer", "guard", "repeat", "inout", "associatedtype", "rethrows", "fileprivate", "open", "Type", "Any", "router")
var kotlinReservedIdents = setOf("in", "is", "as", "var", "val", "fun", "class", "object", "interface", "typealias", "package", "import",
	"return", "if", "else", "for", "while", "when", "do", "try", "throw", "break", "continue", "true", "false", "null", "this", "super",
	"typeof", "by", "constructor", "init", "get", "set", "modifier", "navigate", "onNavigate", "onBack")

func setOf(s ...string) map[string]bool {
	m := make(map[string]bool, len(s))
	for _, x := range s {
		m[x] = true
	}
	return m
}

// indentLines prefixes every line with n copies of `pad`.
func indentLines(lines []string, pad string) []string {
	out := make([]string, len(lines))
	for i, l := range lines {
		if l == "" {
			out[i] = l
		} else {
			out[i] = pad + l
		}
	}
	return out
}

// quote writes a string as a Swift / Kotlin literal: both use the same escapes,
// and `$` is escaped only in Kotlin (a template marker).
func quote(s string, kotlin bool) string {
	var sb strings.Builder
	sb.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			sb.WriteString(`\"`)
		case '\\':
			sb.WriteString(`\\`)
		case '\n':
			sb.WriteString(`\n`)
		case '\r':
			sb.WriteString(`\r`)
		case '\t':
			sb.WriteString(`\t`)
		case '$':
			if kotlin {
				sb.WriteString(`\$`)
			} else {
				sb.WriteRune(r)
			}
		default:
			sb.WriteRune(r)
		}
	}
	sb.WriteByte('"')
	return sb.String()
}

// hasAnimation reports whether any element of the tree carries animations.
func hasAnimation(root *Element) bool {
	found := false
	root.walk(func(e *Element) {
		if e.Anim != nil {
			found = true
		}
	})
	return found
}

func chanf(v int) string { return fmt.Sprintf("%d/255", v) }
