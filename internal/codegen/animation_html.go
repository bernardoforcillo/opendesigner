package codegen

import (
	"fmt"
	"sort"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

// htmlAnim è lo stato di emissione delle animazioni di UNA pagina html.
type htmlAnim struct {
	kf        strings.Builder     // i @keyframes
	kfNames   map[string]bool     // nomi dei @keyframes già usati
	hostClass map[string]string   // id del nodo target -> la sua classe
	pending   []htmlPending       // le regole :hover/:active/manuali, scritte a fine pagina
	needXY    bool                // serve registrare --od-x/--od-y
	base      map[string][]string // classe dell'elemento -> animation: di enter/loop
}

// htmlPending: una regola che dipende da un trigger del TARGET (la sua classe
// si conosce solo quando il target è stato scritto, quindi a fine pagina).
type htmlPending struct {
	class   string // l'elemento animato
	hostID  string
	trigger string // hover | tap | manual
	key     string
	own     []string // animation: delle clip di QUESTO trigger
	hover   []string // per tap: le animazioni di hover (l'utente sta anche sopra)
}

// animate scrive i @keyframes degli item di `e` e ritorna lo stile e gli
// attributi completati. Enter/loop sono `animation:` dell'elemento; hover, tap e
// manuali sono regole sul target (finishAnim).
//
// Ogni regola ripete le animazioni "di base" (enter/loop) oltre alle proprie:
// cambiare la lista `animation` di un elemento FA RIPARTIRE quelle che non sono
// più nella lista, quindi togliere l'hover rilancerebbe l'entrata da capo.
func (w *htmlWriter) animate(e *Element, class string, style []Prop, attrs []Attr) ([]Prop, []Attr) {
	a := &w.anim
	if a.kfNames == nil {
		a.kfNames = map[string]bool{}
		a.hostClass = map[string]string{}
		a.base = map[string][]string{}
	}
	if len(e.Anim.Hosts) > 0 && e.NodeID != "" {
		a.hostClass[e.NodeID] = class
	}
	var baseList []string
	type group struct{ trigger, host, key string }
	var order []group
	own := map[group][]string{}
	hover := map[string][]string{} // host -> animazioni di hover
	hasXY, hasDraw := false, false
	for _, it := range e.Anim.Items {
		name := dedupe(a.kfNames, class+"-"+it.Key+"-"+it.Prop, "")
		a.kf.WriteString(cssKeyframes(name, it.animProp))
		anim := cssAnimation(name, it.animProp)
		switch it.Prop {
		case "x", "y":
			hasXY = true
		case "draw":
			hasDraw = true
		}
		switch it.Trigger {
		case "enter", "loop":
			baseList = append(baseList, anim)
		default:
			g := group{it.Trigger, it.HostID, it.Key}
			if _, ok := own[g]; !ok {
				order = append(order, g)
			}
			own[g] = append(own[g], anim)
			if it.Trigger == "hover" {
				hover[it.HostID] = append(hover[it.HostID], anim)
			}
		}
	}
	if hasXY {
		a.needXY = true
		style = append(style, Prop{"translate", "var(--od-x) var(--od-y)"})
	}
	if hasDraw && e.StrokePath {
		attrs = append(attrs, Attr{"pathLength", "1"})
	}
	if len(baseList) > 0 {
		style = append(style, Prop{"animation", strings.Join(baseList, ", ")})
		a.base[class] = baseList
	}
	for _, g := range order {
		p := htmlPending{class: class, hostID: g.host, trigger: g.trigger, key: g.key, own: own[g]}
		if g.trigger == "tap" {
			p.hover = hover[g.host]
		}
		a.pending = append(a.pending, p)
	}
	return style, attrs
}

// finishAnim aggiunge al CSS della pagina le regole dei trigger, i @keyframes e
// la registrazione delle variabili di x/y.
func (w *htmlWriter) finishAnim() {
	a := &w.anim
	for _, p := range a.pending {
		host, ok := a.hostClass[p.hostID]
		if !ok {
			continue
		}
		sel := "." + host
		switch p.trigger {
		case "hover":
			sel += ":hover"
		case "tap":
			sel += ":active"
		default:
			sel += "." + p.key
		}
		if p.class != host {
			sel += " ." + p.class
		}
		list := append([]string(nil), a.base[p.class]...)
		list = append(list, p.hover...)
		list = append(list, p.own...)
		fmt.Fprintf(&w.css, "%s {\n  animation: %s;\n}\n", sel, strings.Join(list, ", "))
	}
	if a.needXY {
		for _, v := range []string{"--od-x", "--od-y"} {
			fmt.Fprintf(&w.css, "@property %s {\n  syntax: \"<length>\";\n  inherits: false;\n  initial-value: 0px;\n}\n", v)
		}
	}
	w.css.WriteString(a.kf.String())
}

// ---------------------------------------------------------------------------
// README
// ---------------------------------------------------------------------------

// animationReadme: la sezione "Animazioni" del README del progetto react.
func animationReadme(d *opendesignerv1.Document, screens []*Screen) string {
	in := map[string]bool{}
	for _, s := range screens {
		in[s.NodeID] = true
	}
	// la schermata che contiene il nodo (le chiavi delle varianti manuali si
	// deduplicano per schermata, come in planAnimations)
	screenOf := func(id string) string {
		if in[id] {
			return id
		}
		for _, s := range screens {
			if core.IsAncestorOf(d, s.NodeID, id) {
				return s.NodeID
			}
		}
		return ""
	}
	ids := make([]string, 0, len(d.GetClips()))
	for id := range d.GetClips() {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var b strings.Builder
	b.WriteString("## Animazioni\n\n")
	b.WriteString("Le **clip** del design diventano animazioni con [Motion](https://motion.dev) (`import { motion } from \"motion/react\"`): ogni elemento con tracce è un `motion.div` (o `motion.svg`/`motion.path`) con una costante `<nome>Variants` e il suo **target** porta le etichette che le innescano sui discendenti.\n\n")
	b.WriteString("- `enter` -> `initial=\"initial\" animate=\"animate\"` (parte al mount); `loop` -> come enter ma con `repeat: Infinity` (`repeatType: \"reverse\"` se yoyo); `hover` -> `whileHover=\"hover\"`; `tap` -> `whileTap=\"tap\"`.\n")
	b.WriteString("- `x`/`y` sono **delta** dalla posizione del design, `rotate` un delta in gradi (compone con la rotazione di base), `scale` un moltiplicatore, `opacity` assoluta, `draw` -> `pathLength` (0..1) del tratto di un vettoriale.\n")
	b.WriteString("- Ogni proprietà ha i suoi keyframe (`[..]`), i `times` (0..1 della clip) e un `ease` per segmento; `spring` è approssimata da una curva di Bézier.\n")
	b.WriteString("- Una clip **manuale** non parte da sola: ha una variante col nome indicato in tabella; per avviarla imposta `animate=\"<variante>\"` sull'elemento target (di norma da uno stato React) oppure pilotala con `useAnimate`.\n\n")
	b.WriteString("| Clip | Trigger | Target | Durata | Variante |\n|---|---|---|---|---|\n")
	usedKeys := map[string]map[string]bool{}
	for _, id := range ids {
		c := d.GetClips()[id]
		sc := screenOf(c.GetTargetId())
		if sc == "" {
			continue
		}
		if usedKeys[sc] == nil {
			usedKeys[sc] = map[string]bool{variantInitial: true, variantAnimate: true, variantHover: true, variantTap: true}
		}
		trig := c.GetTrigger()
		if trig == "" {
			trig = "manual"
		}
		variant := map[string]string{"enter": "animate", "loop": "animate", "hover": "hover", "tap": "tap"}[trig]
		if trig == "manual" {
			variant = dedupe(usedKeys[sc], camel(c.GetName(), "clip"), "")
		}
		fmt.Fprintf(&b, "| %s | %s | `%s` | %s ms | `%s` |\n", strings.ReplaceAll(oneLine(c.GetName()), "|", "\\|"), trig, c.GetTargetId(), num(c.GetDuration()), variant)
	}
	b.WriteString("\n")
	return b.String()
}
