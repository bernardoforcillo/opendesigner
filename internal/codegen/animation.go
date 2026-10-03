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

// ANIMAZIONI -- dal modello (Document.clips) all'IR.
//
// Una clip ha un nodo TARGET (schermata, gruppo, SVG) e tracce su nodi che gli
// stanno dentro. Il target è l'ELEMENTO che porta il trigger (mount, :hover,
// :active); gli elementi animati sono i suoi discendenti (o lui stesso). Questo
// file fa il lavoro comune ai due renderer: compila ogni traccia in una forma
// neutra (valori già nello spazio del target di codice, tempi 0..1 della clip,
// easing normalizzati) e la aggancia agli Element dell'IR. react.go la scrive
// come varianti di Motion, html.go come @keyframes CSS.
//
// Spazio dei valori (le proprietà del modello sono ASSOLUTE, il codice animato
// è RELATIVO alla posizione di base che CSS/Tailwind hanno già scritto):
//
//	opacity   assoluta                                  opacity
//	x / y     delta da node.x / node.y                  Motion x/y, CSS --od-x/--od-y
//	scale     moltiplicatore                            scale
//	rotation  delta da node.rotation, in gradi          Motion rotate, CSS `rotate`
//	draw      0..1 di tracciato disegnato               Motion pathLength, CSS stroke-dasharray
//
// La rotazione di base dei nodi esce come `rotate-[Ndeg]` (proprietà CSS
// `rotate`) o `transform: rotate()`: il `transform` inline di Motion e la
// proprietà `rotate` di CSS COMPONGONO con essa, quindi il delta è giusto.

// Nomi delle varianti per trigger. `manual` ha il nome della clip.
const (
	variantInitial = "initial"
	variantAnimate = "animate"
	variantHover   = "hover"
	variantTap     = "tap"
)

// animProp è UNA traccia compilata.
type animProp struct {
	Prop string // opacity | x | y | scale | rotation | draw
	// Values/Times: i keyframe con i valori nello spazio del codice e i tempi
	// normalizzati su [0,1] della durata della clip. Se il primo keyframe non è a
	// 0 (o l'ultimo non è alla fine) si aggiungono gli estremi di "hold".
	Values, Times []float64
	// Easings[i] è l'easing del segmento i -> i+1 (len = len(Values)-1), già
	// normalizzato ("linear", "easeIn", "easeOut", "easeInOut", "spring" o
	// "cubic-bezier(a,b,c,d)").
	Easings  []string
	Duration float64 // ms
	Delay    float64 // ms
	Repeat   int32   // ripetizioni extra; -1 = infinito
	Yoyo     bool
}

// constant: una traccia con un solo valore (un solo keyframe) non anima nulla.
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
	Key      string // nome della variante (Motion) / classe di avvio (manual)
	ClipID   string
	ClipName string
	HostID   string // il target della clip (id del nodo)
	animProp
}

// animHost: l'elemento è il target di una clip con questo trigger.
type animHost struct {
	Trigger  string
	Key      string
	ClipName string
}

// ElemAnim: ciò che le clip dicono di UN elemento dell'IR.
type ElemAnim struct {
	Items []animItem // tracce che animano l'elemento
	Hosts []animHost // clip di cui l'elemento è il target
	// VarName: il nome della costante delle varianti (assegnato dal renderer React).
	VarName string
	// HasInitial: la costante ha una variante `initial`.
	HasInitial bool
	// RestStyle: i valori a riposo da scrivere in `style={{...}}` (restStyle).
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

// numN: come num ma con `digits` decimali (i tempi normalizzati e le percentuali
// vogliono più precisione dei px).
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

// camel: "Hover card" -> "hoverCard"; non comincia mai con una cifra.
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

// normEasing: "" -> "linear"; il resto resta com'è (già validato dal core).
func normEasing(e string) string {
	if e == "" {
		return "linear"
	}
	if p, ok := core.ParseCubicBezier(e); ok {
		return "cubic-bezier(" + num(p[0]) + "," + num(p[1]) + "," + num(p[2]) + "," + num(p[3]) + ")"
	}
	return e
}

// springBezier è l'approssimazione cubic-bezier della molla smorzata
// criticamente del motore (web/src/animation/engine.ts::SPRING_BEZIER): Motion
// (ease per segmento) e CSS non hanno molle per segmento.
const springBezier = "cubic-bezier(0.32,0.66,0.1,1)"

// compileTrack traduce una traccia del modello nello spazio del codice.
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

// planAnimations legge le clip del documento che appartengono alla schermata
// `screen` (il target è la schermata o un suo discendente) e prepara, per id di
// nodo, l'animazione di ogni elemento. Ordine deterministico: clip per id, poi
// tracce nell'ordine della clip.
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
				b.warn("clip %q: la traccia %s di %q non è dentro il target %q: ignorata (la clip anima solo il target e i suoi discendenti)", label, t.GetProp(), nameOrID(d, n.GetId()), nameOrID(d, target.GetId()))
				continue
			}
			if t.GetProp() == "draw" {
				if _, isVec := n.GetShape().(*opendesignerv1.Node_Vector); !isVec {
					b.warn("clip %q: draw su %q, che non è un vettoriale (il codice disegna rect/ellisse/frame come box, senza tracciato): ignorata", label, nameOrID(d, n.GetId()))
					continue
				}
			}
			p := compileTrack(c, t, n)
			if len(p.Values) == 0 {
				continue
			}
			if trigger == "loop" {
				p.Repeat = -1 // "loop" è per definizione senza fine
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

// attachAnim aggancia l'animazione pianificata all'elemento `el` del nodo `n`.
// Le tracce `draw` di un vettoriale vanno sul SUO path del tratto (un
// <path> dentro l'<svg>), le altre sull'elemento.
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
				ch.NodeName = el.NodeName + " tratto" // nome della costante/classe: "firmaTrattoVariants"
			}
		}
	}
}

// animSetVariants: l'ordine di emissione delle varianti di un elemento.
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

// collectAnimated: gli elementi animati dell'albero, in pre-ordine.
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

// motionProp: il nome della proprietà in Motion.
func motionProp(p string) string {
	switch p {
	case "rotation":
		return "rotate"
	case "draw":
		return "pathLength"
	}
	return p
}

// motionEase: l'easing di un segmento nella sintassi di Motion.
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

// motionValue: il valore da animare: un numero se costante, altrimenti l'array
// dei keyframe.
func motionValue(p animProp) string {
	if p.constant() {
		return numN(p.Values[0], 3)
	}
	return motionNums(p.Values, 3)
}

// motionTransition: `{ duration: .., delay: .., repeat: .., times: [..], ease: .. }`
// di UNA proprietà. La durata di ogni proprietà è quella della clip: i `times`
// normalizzano i keyframe su di essa.
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

// restValue: il valore a riposo di una proprietà (quello del design: i delta
// valgono 0, la scala 1, il tracciato è tutto disegnato, l'opacità è quella
// scritta nello stile dell'elemento).
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

// initialValues: la variante `initial` di un elemento: il primo keyframe delle
// clip enter/loop (lo stato prima che partano).
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

// restStyle: il valore a riposo delle proprietà animate SOLO da hover/tap/
// manuali, come `style={{...}}`. Motion, quando un gesto finisce, riporta ogni
// valore al suo riposo (animate, initial o style): senza, l'hover non tornerebbe
// mai indietro. Si usa `style` e NON `initial="initial"` sul figlio: una prop
// `initial` fa dell'elemento un controllore di varianti a sé, che smette di
// ereditare le etichette (hover, animate) del target.
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

// reactVariants scrive la costante `const <name>: Variants = {...}` di un
// elemento animato: UNA variante per trigger (initial/animate/hover/tap, più
// una per clip manuale), che unisce le clip che toccano l'elemento. Se due clip
// con lo stesso trigger animano la STESSA proprietà vince l'ultima (per id).
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
		// le proprietà della variante, l'ultima clip vince per proprietà
		var props []animProp
		idx := map[string]int{}
		for _, it := range a.Items {
			if it.Key != key {
				continue
			}
			if i, dup := idx[it.Prop]; dup {
				props[i] = it.animProp
				warns = append(warns, fmt.Sprintf("più clip %s animano %s dello stesso elemento: vince %q", it.Trigger, it.Prop, it.ClipName))
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

// tsKey: la chiave di un oggetto TS (identificatore semplice o stringa).
func tsKey(k string) string {
	for i, r := range k {
		ok := r == '_' || r == '$' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (i > 0 && r >= '0' && r <= '9')
		if !ok {
			return tsString(k)
		}
	}
	return k
}

// hostLabels: le prop JSX con cui il TARGET innesca le varianti dei figli.
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
			comments = append(comments, fmt.Sprintf("clip manuale %q: per avviarla imposta animate=%s su questo elemento", oneLine(h.ClipName), tsString(h.Key)))
		}
	}
	return labels, comments
}

// reactAnimations assegna i nomi delle costanti agli elementi animati di una
// schermata e ritorna il codice delle costanti (vuoto se non ce ne sono).
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

// cssEase: l'easing di un segmento come `animation-timing-function`.
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

// cssDecl: la dichiarazione di un valore nei @keyframes.
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

// cssKeyframes scrive `@keyframes <name> { ... }`: percentuali della durata
// della clip, easing del segmento nel keyframe che lo apre. Keyframe allo stesso
// tempo (scatto) si distanziano di 0.0001%: due blocchi con la stessa percentuale
// si fonderebbero e lo scatto andrebbe perso.
func cssKeyframes(name string, p animProp) string {
	var b strings.Builder
	fmt.Fprintf(&b, "@keyframes %s {\n", name)
	values, times := p.Values, p.Times
	if len(values) == 1 { // costante: 0% e 100%
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

// cssAnimation: un elemento della lista `animation:`.
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
