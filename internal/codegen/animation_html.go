package codegen

import (
	"fmt"
	"sort"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

// htmlAnim is the animation emission state of ONE html page.
type htmlAnim struct {
	kf        strings.Builder     // the @keyframes
	kfNames   map[string]bool     // names of the @keyframes already used
	hostClass map[string]string   // target node id -> its class
	pending   []htmlPending       // the :hover/:active/manual rules, written at the end of the page
	needXY    bool                // --od-x/--od-y must be registered
	base      map[string][]string // element class -> animation: of enter/loop
}

// htmlPending: a rule that depends on a trigger of the TARGET (its class
// is only known once the target has been written, hence at the end of the page).
type htmlPending struct {
	class   string // the animated element
	hostID  string
	trigger string // hover | tap | manual
	key     string
	own     []string // animation: of the clips of THIS trigger
	hover   []string // for tap: the hover animations (the user is also over it)
}

// animate writes the @keyframes of `e`'s items and returns the completed style
// and attributes. Enter/loop are the element's `animation:`; hover, tap and
// manual ones are rules on the target (finishAnim).
//
// Every rule repeats the "base" animations (enter/loop) in addition to its own:
// changing an element's `animation` list RESTARTS those that are no longer in
// the list, so removing the hover would replay the entrance from scratch.
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
	hover := map[string][]string{} // host -> hover animations
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

// finishAnim adds to the page's CSS the trigger rules, the @keyframes and
// the registration of the x/y variables.
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

// animationReadme: the "Animations" section of the react project's README.
func animationReadme(d *opendesignerv1.Document, screens []*Screen) string {
	in := map[string]bool{}
	for _, s := range screens {
		in[s.NodeID] = true
	}
	// the screen that contains the node (manual variant keys are
	// deduplicated per screen, as in planAnimations)
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
	b.WriteString("## Animations\n\n")
	b.WriteString("The design's **clips** become animations with [Motion](https://motion.dev) (`import { motion } from \"motion/react\"`): every element with tracks is a `motion.div` (or `motion.svg`/`motion.path`) with a `<name>Variants` constant, and its **target** carries the labels that fire them on descendants.\n\n")
	b.WriteString("- `enter` -> `initial=\"initial\" animate=\"animate\"` (starts on mount); `loop` -> like enter but with `repeat: Infinity` (`repeatType: \"reverse\"` if yoyo); `hover` -> `whileHover=\"hover\"`; `tap` -> `whileTap=\"tap\"`.\n")
	b.WriteString("- `x`/`y` are **deltas** from the design position, `rotate` is a delta in degrees (composes with the base rotation), `scale` is a multiplier, `opacity` is absolute, `draw` -> `pathLength` (0..1) of a vector's stroke.\n")
	b.WriteString("- Each property has its own keyframes (`[..]`), `times` (0..1 of the clip) and one `ease` per segment; `spring` is approximated by a Bézier curve.\n")
	b.WriteString("- A **manual** clip does not start on its own: it has a variant with the name given in the table; to start it set `animate=\"<variant>\"` on the target element (usually from React state) or drive it with `useAnimate`.\n\n")
	b.WriteString("| Clip | Trigger | Target | Duration | Variant |\n|---|---|---|---|---|\n")
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
