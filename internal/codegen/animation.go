package codegen

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

// ANIMATIONS -- from the model (Document.clips) to the IR.
//
// A clip has a TARGET node (screen, group, SVG) and tracks on nodes inside it.
// The target is the ELEMENT that carries the trigger (mount, :hover,
// :active); the animated elements are its descendants (or itself). This
// file does the work common to the two renderers: it compiles each track into
// a neutral form (values already in the code target's space, clip times
// 0..1, normalised easings) and attaches it to the IR's Elements. react.go
// writes it as Motion variants, html.go as CSS @keyframes.
//
// Value space (the model's properties are ABSOLUTE, the animated code is
// RELATIVE to the base position that CSS/Tailwind have already written):
//
//	opacity   absolute                                opacity
//	x / y     delta from node.x / node.y              Motion x/y, CSS --od-x/--od-y
//	scale     multiplier                              scale
//	rotation  delta from node.rotation, in degrees    Motion rotate, CSS `rotate`
//	draw      0..1 of the path drawn                  Motion pathLength, CSS stroke-dasharray
//
// The nodes' base rotation comes out as `rotate-[Ndeg]` (CSS `rotate`
// property) or `transform: rotate()`: Motion's inline `transform` and CSS's
// `rotate` property COMPOSE with it, so the delta is right.

// Variant names per trigger. `manual` uses the clip's name.
const (
	variantInitial = "initial"
	variantAnimate = "animate"
	variantHover   = "hover"
	variantTap     = "tap"
)

// animProp is ONE compiled track.
type animProp struct {
	Prop string // opacity | x | y | scale | rotation | draw
	// Values/Times: the keyframes with the values in code space and the times
	// normalised to [0,1] of the clip's duration. If the first keyframe is not at
	// 0 (or the last is not at the end) "hold" endpoints are added.
	Values, Times []float64
	// Easings[i] is the easing of segment i -> i+1 (len = len(Values)-1), already
	// normalised ("linear", "easeIn", "easeOut", "easeInOut", "spring" or
	// "cubic-bezier(a,b,c,d)").
	Easings  []string
	Duration float64 // ms
	Delay    float64 // ms
	Repeat   int32   // extra repetitions; -1 = infinite
	Yoyo     bool
}

// constant: a track with a single value (a single keyframe) animates nothing.
func (p animProp) constant() bool {
	for _, v := range p.Values {
		if v != p.Values[0] {
			return false
		}
	}
	return true
}

type animItem struct {
	Trigger  string // enter | loop | hover | tap | manual
	Key      string // variant name (Motion) / start class (manual)
	ClipID   string
	ClipName string
	HostID   string // the clip's target (node id)
	animProp
}

// animHost: the element is the target of a clip with this trigger.
type animHost struct {
	Trigger  string
	Key      string
	ClipName string
}

// ElemAnim: what the clips say about ONE IR element.
type ElemAnim struct {
	Items []animItem // tracks that animate the element
	Hosts []animHost // clips whose target is the element
	// VarName: the name of the variants constant (assigned by the React renderer).
	VarName string
	// HasInitial: the constant has an `initial` variant.
	HasInitial bool
	// RestStyle: the resting values to write in `style={{...}}` (restStyle).
	RestStyle []string
}

func (a *ElemAnim) hasTrigger(t string) bool {
	for _, h := range a.Hosts {
		if h.Trigger == t {
			return true
		}
	}
	return false
}

// numN: like num but with `digits` decimals (normalised times and percentages
// need more precision than px).
func numN(v float64, digits int) string {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return "0"
	}
	p := math.Pow(10, float64(digits))
	v = math.Round(v*p) / p
	if v == 0 {
		return "0"
	}
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// camel: "Hover card" -> "hoverCard"; never starts with a digit.
func camel(name, fallback string) string {
	ws := words(name)
	if len(ws) == 0 {
		return fallback
	}
	var b strings.Builder
	for i, w := range ws {
		if i == 0 {
			b.WriteString(strings.ToLower(w))
		} else {
			b.WriteString(strings.ToUpper(w[:1]) + strings.ToLower(w[1:]))
		}
	}
	s := b.String()
	if s[0] >= '0' && s[0] <= '9' {
		return fallback + strings.ToUpper(s[:1]) + s[1:]
	}
	return s
}

// normEasing: "" -> "linear"; the rest stays as is (already validated by the core).
func normEasing(e string) string {
	if e == "" {
		return "linear"
	}
	if p, ok := core.ParseCubicBezier(e); ok {
		return "cubic-bezier(" + num(p[0]) + "," + num(p[1]) + "," + num(p[2]) + "," + num(p[3]) + ")"
	}
	return e
}

// springBezier is the cubic-bezier approximation of the engine's critically
// damped spring (web/src/animation/engine.ts::SPRING_BEZIER): Motion
// (per-segment ease) and CSS have no per-segment springs.
const springBezier = "cubic-bezier(0.32,0.66,0.1,1)"

// compileTrack translates a model track into code space.
func compileTrack(c *opendesignerv1.Clip, t *opendesignerv1.Track, n *opendesignerv1.Node) animProp {
	p := animProp{
		Prop: t.GetProp(), Duration: c.GetDuration(), Delay: c.GetDelay(),
		Repeat: c.GetRepeat(), Yoyo: c.GetYoyo(),
	}
	conv := func(v float64) float64 {
		switch t.GetProp() {
		case "x":
			return v - n.GetX()
		case "y":
			return v - n.GetY()
		case "rotation":
			return v - n.GetRotation()
		}
		return v
	}
	dur := c.GetDuration()
	type kf struct {
		t, v float64
		e    string
	}
	var ks []kf
	for _, k := range t.GetKeyframes() {
		ks = append(ks, kf{k.GetTime(), conv(k.GetValue()), normEasing(k.GetEasing())})
	}
	if len(ks) == 0 {
		return p
	}
	if len(ks) == 1 {
		p.Values = []float64{ks[0].v}
		p.Times = []float64{0}
		return p
	}
	if ks[0].t > 0 {
		ks = append([]kf{{0, ks[0].v, "linear"}}, ks...)
	}
	if last := ks[len(ks)-1]; last.t < dur {
		ks = append(ks, kf{dur, last.v, "linear"})
	}
	for i, k := range ks {
		p.Values = append(p.Values, k.v)
		p.Times = append(p.Times, math.Min(1, math.Max(0, k.t/dur)))
		if i < len(ks)-1 {
			p.Easings = append(p.Easings, k.e)
		}
	}
	return p
}

// planAnimations reads the document's clips that belong to the screen
// `screen` (the target is the screen or one of its descendants) and prepares,
// per node id, each element's animation. Deterministic order: clips by id, then
// tracks in the clip's order.
func (b *builder) planAnimations(screen *opendesignerv1.Node) {
	b.anim = map[string]*ElemAnim{}
	d := b.doc
	ids := make([]string, 0, len(d.GetClips()))
	for id := range d.GetClips() {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	usedKeys := map[string]bool{variantInitial: true, variantAnimate: true, variantHover: true, variantTap: true}
	for _, id := range ids {
		c := d.GetClips()[id]
		target := d.GetNodes()[c.GetTargetId()]
		if target == nil || !(target.GetId() == screen.GetId() || core.IsAncestorOf(d, screen.GetId(), target.GetId())) {
			continue
		}
		trigger := c.GetTrigger()
		if trigger == "" {
			trigger = "manual"
		}
		label := c.GetName()
		if label == "" {
			label = c.GetId()
		}
		key := ""
		switch trigger {
		case "enter", "loop":
			key = variantAnimate
		case "hover":
			key = variantHover
		case "tap":
			key = variantTap
		default:
			key = dedupe(usedKeys, camel(c.GetName(), "clip"), "")
		}
		added := 0
		for _, t := range c.GetTracks() {
			n := d.GetNodes()[t.GetNodeId()]
			if n == nil {
				continue
			}
			if !(n.GetId() == target.GetId() || core.IsAncestorOf(d, target.GetId(), n.GetId())) {
				b.warn("clip %q: track %s of %q is not inside the target %q: ignored (the clip only animates the target and its descendants)", label, t.GetProp(), nameOrID(d, n.GetId()), nameOrID(d, target.GetId()))
				continue
			}
			if t.GetProp() == "draw" {
				if _, isVec := n.GetShape().(*opendesignerv1.Node_Vector); !isVec {
					b.warn("clip %q: draw on %q, which is not a vector (the code draws rect/ellipse/frame as boxes, with no path): ignored", label, nameOrID(d, n.GetId()))
					continue
				}
			}
			p := compileTrack(c, t, n)
			if len(p.Values) == 0 {
				continue
			}
			if trigger == "loop" {
				p.Repeat = -1 // "loop" is endless by definition
			}
			a := b.anim[n.GetId()]
			if a == nil {
				a = &ElemAnim{}
				b.anim[n.GetId()] = a
			}
			a.Items = append(a.Items, animItem{Trigger: trigger, Key: key, ClipID: c.GetId(), ClipName: label, HostID: target.GetId(), animProp: p})
			added++
		}
		if added > 0 {
			h := b.anim[target.GetId()]
			if h == nil {
				h = &ElemAnim{}
				b.anim[target.GetId()] = h
			}
			h.Hosts = append(h.Hosts, animHost{Trigger: trigger, Key: key, ClipName: label})
		}
	}
}

// attachAnim attaches the planned animation to the element `el` of node `n`.
// The `draw` tracks of a vector go on ITS stroke path (a <path> inside the
// <svg>), the others on the element.
func (b *builder) attachAnim(el *Element, n *opendesignerv1.Node) {
	a := b.anim[n.GetId()]
	if a == nil {
		return
	}
	var own, draw []animItem
	for _, it := range a.Items {
		if it.Prop == "draw" {
			draw = append(draw, it)
		} else {
			own = append(own, it)
		}
	}
	if len(own) > 0 || len(a.Hosts) > 0 {
		el.Anim = &ElemAnim{Items: own, Hosts: a.Hosts}
	}
	if len(draw) > 0 {
		for _, ch := range el.Children {
			if ch.StrokePath {
				ch.Anim = &ElemAnim{Items: draw}
				ch.NodeName = el.NodeName + " stroke" // name of the constant/class: "signatureStrokeVariants"
			}
		}
	}
}

// animSetVariants: the emission order of an element's variants.
func (a *ElemAnim) variantKeys(hasInitial bool) []string {
	var keys []string
	seen := map[string]bool{}
	add := func(k string) {
		if !seen[k] {
			seen[k] = true
			keys = append(keys, k)
		}
	}
	if hasInitial {
		add(variantInitial)
	}
	for _, k := range []string{variantAnimate, variantHover, variantTap} {
		for _, it := range a.Items {
			if it.Key == k {
				add(k)
			}
		}
	}
	for _, it := range a.Items {
		if it.Trigger == "manual" {
			add(it.Key)
		}
	}
	return keys
}

// collectAnimated: the tree's animated elements, in pre-order.
func collectAnimated(root *Element) []*Element {
	var out []*Element
	root.walk(func(e *Element) {
		if e.Anim != nil {
			out = append(out, e)
		}
	})
	return out
}

// ---------------------------------------------------------------------------
// React / Motion
// ---------------------------------------------------------------------------

// motionProp: the property name in Motion.
func motionProp(p string) string {
	switch p {
	case "rotation":
		return "rotate"
	case "draw":
		return "pathLength"
	}
	return p
}

// motionEase: a segment's easing in Motion syntax.
func motionEase(e string) string {
	switch e {
	case "linear", "easeIn", "easeOut", "easeInOut":
		return `"` + e + `"`
	case "spring":
		e = springBezier
	}
	if p, ok := core.ParseCubicBezier(e); ok {
		return "[" + num(p[0]) + ", " + num(p[1]) + ", " + num(p[2]) + ", " + num(p[3]) + "]"
	}
	return `"linear"`
}

func motionNums(vs []float64, digits int) string {
	parts := make([]string, len(vs))
	for i, v := range vs {
		parts[i] = numN(v, digits)
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// motionValue: the value to animate: a number if constant, otherwise the
// keyframe array.
func motionValue(p animProp) string {
	if p.constant() {
		return numN(p.Values[0], 3)
	}
	return motionNums(p.Values, 3)
}

// motionTransition: `{ duration: .., delay: .., repeat: .., times: [..], ease: .. }`
// of ONE property. Each property's duration is the clip's: the `times`
// normalise the keyframes over it.
func motionTransition(p animProp) string {
	parts := []string{"duration: " + numN(p.Duration/1000, 4)}
	if p.Delay > 0 {
		parts = append(parts, "delay: "+numN(p.Delay/1000, 4))
	}
	if p.Repeat != 0 {
		if p.Repeat < 0 {
			parts = append(parts, "repeat: Infinity")
		} else {
			parts = append(parts, "repeat: "+strconv.Itoa(int(p.Repeat)))
		}
		if p.Yoyo {
			parts = append(parts, `repeatType: "reverse"`)
		} else {
			parts = append(parts, `repeatType: "loop"`)
		}
	}
	if len(p.Values) > 2 || (len(p.Values) == 2 && (p.Times[0] != 0 || p.Times[1] != 1)) {
		parts = append(parts, "times: "+motionNums(p.Times, 4))
	}
	eases := make([]string, len(p.Easings))
	same := true
	for i, e := range p.Easings {
		eases[i] = motionEase(e)
		if eases[i] != eases[0] {
			same = false
		}
	}
	switch {
	case len(eases) == 0:
	case same:
		parts = append(parts, "ease: "+eases[0])
	default:
		parts = append(parts, "ease: ["+strings.Join(eases, ", ")+"]")
	}
	return "{ " + strings.Join(parts, ", ") + " }"
}

// restValue: a property's resting value (the design's: deltas are 0, scale
// is 1, the path is fully drawn, opacity is the one written in the element's
// style).
func restValue(prop string, e *Element) string {
	switch prop {
	case "opacity":
		if v := e.style("opacity"); v != "" {
			return v
		}
		return "1"
	case "scale", "draw":
		return "1"
	}
	return "0"
}

// initialValues: an element's `initial` variant: the first keyframe of the
// enter/loop clips (the state before they start).
func initialValues(e *Element) (props []string, vals map[string]string) {
	vals = map[string]string{}
	for _, it := range e.Anim.Items {
		if it.Key == variantAnimate {
			if _, dup := vals[it.Prop]; !dup {
				props = append(props, it.Prop)
			}
			vals[it.Prop] = numN(it.Values[0], 3)
		}
	}
	return props, vals
}

// restStyle: the resting value of properties animated ONLY by hover/tap/
// manual clips, as `style={{...}}`. When a gesture ends, Motion brings every
// value back to its rest (animate, initial or style): without it, hover would
// never go back. `style` is used and NOT `initial="initial"` on the child: an
// `initial` prop makes the element a variants controller of its own, which
// stops inheriting the target's labels (hover, animate).
func restStyle(e *Element) []string {
	inAnimate := map[string]bool{}
	for _, it := range e.Anim.Items {
		if it.Key == variantAnimate {
			inAnimate[it.Prop] = true
		}
	}
	var out []string
	seen := map[string]bool{}
	for _, it := range e.Anim.Items {
		if it.Key == variantAnimate || inAnimate[it.Prop] || seen[it.Prop] {
			continue
		}
		seen[it.Prop] = true
		out = append(out, motionProp(it.Prop)+": "+restValue(it.Prop, e))
	}
	return out
}

// reactVariants writes the constant `const <name>: Variants = {...}` of an
// animated element: ONE variant per trigger (initial/animate/hover/tap, plus
// one per manual clip), merging the clips that touch the element. If two clips
// with the same trigger animate the SAME property the last one (by id) wins.
func reactVariants(e *Element) (string, []string) {
	a := e.Anim
	initProps, initVals := initialValues(e)
	a.HasInitial = len(initProps) > 0
	a.RestStyle = restStyle(e)
	var warns []string
	var b strings.Builder
	clips := []string{}
	seenClip := map[string]bool{}
	for _, it := range a.Items {
		if !seenClip[it.ClipID] {
			seenClip[it.ClipID] = true
			clips = append(clips, fmt.Sprintf("clip %q (%s)", it.ClipName, it.Trigger))
		}
	}
	fmt.Fprintf(&b, "// %s\n", strings.Join(clips, ", "))
	fmt.Fprintf(&b, "const %s: Variants = {\n", a.VarName)
	for _, key := range a.variantKeys(a.HasInitial) {
		if key == variantInitial {
			var kv []string
			for _, p := range initProps {
				kv = append(kv, motionProp(p)+": "+initVals[p])
			}
			fmt.Fprintf(&b, "  initial: { %s },\n", strings.Join(kv, ", "))
			continue
		}
		// the variant's properties, the last clip wins per property
		var props []animProp
		idx := map[string]int{}
		for _, it := range a.Items {
			if it.Key != key {
				continue
			}
			if i, dup := idx[it.Prop]; dup {
				props[i] = it.animProp
				warns = append(warns, fmt.Sprintf("several %s clips animate %s of the same element: %q wins", it.Trigger, it.Prop, it.ClipName))
				continue
			}
			idx[it.Prop] = len(props)
			props = append(props, it.animProp)
		}
		fmt.Fprintf(&b, "  %s: {\n", tsKey(key))
		for _, p := range props {
			fmt.Fprintf(&b, "    %s: %s,\n", motionProp(p.Prop), motionValue(p))
		}
		var trans []string
		for _, p := range props {
			if !p.constant() {
				trans = append(trans, fmt.Sprintf("      %s: %s,\n", motionProp(p.Prop), motionTransition(p)))
			}
		}
		if len(trans) > 0 {
			b.WriteString("    transition: {\n" + strings.Join(trans, "") + "    },\n")
		}
		b.WriteString("  },\n")
	}
	b.WriteString("};\n")
	return b.String(), warns
}

// tsKey: the key of a TS object (simple identifier or string).
func tsKey(k string) string {
	for i, r := range k {
		ok := r == '_' || r == '$' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (i > 0 && r >= '0' && r <= '9')
		if !ok {
			return tsString(k)
		}
	}
	return k
}

// hostLabels: the JSX props with which the TARGET fires its children's variants.
func hostLabels(a *ElemAnim) (labels []string, comments []string) {
	if a == nil {
		return nil, nil
	}
	if a.hasTrigger("enter") || a.hasTrigger("loop") {
		labels = append(labels, `initial="initial"`, `animate="animate"`)
	}
	if a.hasTrigger("hover") {
		labels = append(labels, `whileHover="hover"`)
	}
	if a.hasTrigger("tap") {
		labels = append(labels, `whileTap="tap"`)
	}
	for _, h := range a.Hosts {
		if h.Trigger == "manual" {
			comments = append(comments, fmt.Sprintf("manual clip %q: to start it set animate=%s on this element", oneLine(h.ClipName), tsString(h.Key)))
		}
	}
	return labels, comments
}

// reactAnimations assigns the constant names to the animated elements of a
// screen and returns the constants' code (empty if there are none).
func reactAnimations(root *Element) (code string, warns []string) {
	used := map[string]bool{}
	var sb strings.Builder
	for _, e := range collectAnimated(root) {
		if len(e.Anim.Items) == 0 {
			continue
		}
		base := e.NodeName
		if base == "" {
			base = e.Tag
		}
		e.Anim.VarName = dedupe(used, camel(base, "el")+"Variants", "")
		c, w := reactVariants(e)
		warns = append(warns, w...)
		sb.WriteString(c + "\n")
	}
	return sb.String(), warns
}

// ---------------------------------------------------------------------------
// HTML / CSS
// ---------------------------------------------------------------------------

// cssEase: a segment's easing as `animation-timing-function`.
func cssEase(e string) string {
	switch e {
	case "linear":
		return "linear"
	case "easeIn":
		return "ease-in"
	case "easeOut":
		return "ease-out"
	case "easeInOut":
		return "ease-in-out"
	case "spring":
		return springBezier
	}
	return e
}

// cssDecl: the declaration of a value in the @keyframes.
func cssDecl(prop string, v float64) string {
	switch prop {
	case "opacity":
		return "opacity:" + numN(v, 3)
	case "scale":
		return "scale:" + numN(v, 3)
	case "rotation":
		return "rotate:" + numN(v, 3) + "deg"
	case "x":
		return "--od-x:" + numN(v, 3) + "px"
	case "y":
		return "--od-y:" + numN(v, 3) + "px"
	case "draw":
		return "stroke-dasharray:" + numN(v, 3) + " 1"
	}
	return ""
}

// cssKeyframes writes `@keyframes <name> { ... }`: percentages of the clip's
// duration, the segment's easing in the keyframe that opens it. Keyframes at
// the same time (a jump) are spaced 0.0001% apart: two blocks with the same
// percentage would merge and the jump would be lost.
func cssKeyframes(name string, p animProp) string {
	var b strings.Builder
	fmt.Fprintf(&b, "@keyframes %s {\n", name)
	values, times := p.Values, p.Times
	if len(values) == 1 { // constant: 0% and 100%
		values, times = []float64{values[0], values[0]}, []float64{0, 1}
	}
	prev := -1.0
	for i, v := range values {
		pc := times[i] * 100
		if pc <= prev {
			pc = prev + 0.0001
		}
		prev = pc
		decl := cssDecl(p.Prop, v)
		if i < len(p.Easings) {
			decl += ";animation-timing-function:" + cssEase(p.Easings[i])
		}
		fmt.Fprintf(&b, "  %s%% { %s }\n", numN(pc, 4), decl)
	}
	b.WriteString("}\n")
	return b.String()
}

// cssAnimation: an item of the `animation:` list.
func cssAnimation(name string, p animProp) string {
	count := "1"
	switch {
	case p.Repeat < 0:
		count = "infinite"
	case p.Repeat > 0:
		count = strconv.Itoa(int(p.Repeat) + 1)
	}
	dir := "normal"
	if p.Yoyo {
		dir = "alternate"
	}
	return fmt.Sprintf("%s %sms linear %sms %s %s both", name, numN(p.Duration, 3), numN(p.Delay, 3), count, dir)
}
