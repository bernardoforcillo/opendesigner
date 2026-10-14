package codegen

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

// DESIGN VARIABLES in the export. A paint bound to a variable is exported as a
// CSS custom property, so the generated code can be re-themed without touching
// the markup: `background-color: var(--color-brand)`, with `:root` holding the
// default mode's value and `[data-mode="dark"]` the other modes' overrides.
//
// How it works: before anything is built, bindVariables rewrites every variable
// paint of the (cloned) document into a plain solid paint with the DEFAULT
// mode's colour, so every consumer (strokes, shadows, SVG, gradients) already
// sees correct literal colours. For the FIRST fill of a node, which is what
// `background-color` and text `color` read, it also records the property name
// in the node's meta (metaFillVar) so those two sites emit var(--name).
//
// The same is done for strokes, by index, in metaStrokeVars. Limits: only the
// FIRST fill of a node uses the variable; a variable is not used where the colour
// is mixed with the node's opacity (the literal is, var() cannot express it); and
// gradient stops cannot be bound at all, because GradientStop holds a Color, not
// a Paint: that is a limit of the model, not of the export.

const (
	metaFillVar    = "code.fillVar"
	metaStrokeVars = "code.strokeVars" // custom property per stroke, "|"-separated, empty = literal
)

var nonIdent = regexp.MustCompile(`[^a-z0-9]+`)

// cssVar is a variable ready to print: its custom property, and either an alias
// target (custom property of the variable it points at) or one CSS value per mode.
type cssVar struct {
	name   string            // custom property, with the leading "--"
	alias  string            // target's custom property; "" when the variable holds values
	values map[string]string // mode id -> CSS value
}

const metaBindVars = "code.bindVars" // "prop=--name|prop=--name": number properties that export as var()

// cssVarName: "color/Brand Primary" -> "--color-brand-primary".
func cssVarName(name string) string {
	s := strings.Trim(nonIdent.ReplaceAllString(strings.ToLower(name), "-"), "-")
	if s == "" {
		s = "token"
	}
	return "--" + s
}

// variableNames assigns each variable a UNIQUE custom property name, in id order
// so the result is stable (two names that slug the same get -2, -3, ...).
func variableNames(d *opendesignerv1.Document) map[string]string {
	ids := make([]string, 0, len(d.GetVariables()))
	for id := range d.GetVariables() {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	used := map[string]bool{}
	out := map[string]string{}
	for _, id := range ids {
		base := cssVarName(d.GetVariables()[id].GetName())
		name := base
		for i := 2; used[name]; i++ {
			name = fmt.Sprintf("%s-%d", base, i)
		}
		used[name] = true
		out[id] = name
	}
	return out
}

// bindVariables: see the file comment. It mutates d (a clone owned by Generate)
// and returns the variables the document actually uses, for tokensCSS.
func bindVariables(d *opendesignerv1.Document) []cssVar {
	if len(d.GetVariables()) == 0 {
		return nil
	}
	names := variableNames(d)
	used := map[string]bool{}
	black := &opendesignerv1.Color{A: 1}
	note := func(n *opendesignerv1.Node, key, val string) {
		if n.Meta == nil {
			n.Meta = map[string]string{}
		}
		n.Meta[key] = val
	}
	rewrite := func(p *opendesignerv1.Paint) (string, bool) {
		ref, ok := p.GetKind().(*opendesignerv1.Paint_Variable)
		if !ok {
			return "", false
		}
		id := ref.Variable.GetVariableId()
		v := d.GetVariables()[id]
		if v == nil {
			// A dangling reference draws opaque black, as everywhere else.
			p.Kind = &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{Color: black}}
			return "", true
		}
		c, ok := core.ColorValue(d, v)
		if !ok {
			// Dangling alias or no value: black, and no custom property to point at.
			p.Kind = &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{Color: black}}
			return "", true
		}
		p.Kind = &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{Color: c}}
		used[id] = true
		return names[id], true
	}
	// A gradient stop bound to a variable exports as its default-mode colour:
	// stops are interpolated for alpha, which a custom property cannot follow.
	rewriteStops := func(p *opendesignerv1.Paint) {
		for _, g := range []*opendesignerv1.GradientPaint{p.GetLinear(), p.GetRadial()} {
			for _, st := range g.GetStops() {
				if id := st.GetVariableId(); id != "" {
					if c, ok := core.ColorValue(d, d.GetVariables()[id]); ok {
						st.Color = c
					}
				}
			}
		}
	}
	for _, n := range d.GetNodes() {
		// An instance's fill overrides are paints too. They export as the literal
		// default-mode colour: the override has no place to record a property name.
		for _, o := range n.GetInstance().GetOverrides() {
			for _, p := range o.GetFills() {
				rewrite(p)
				rewriteStops(p)
			}
		}
		for i, p := range n.GetFills() {
			rewriteStops(p)
			name, was := rewrite(p)
			if was && i == 0 && name != "" {
				note(n, metaFillVar, name)
			}
		}
		var strokeVars []string
		bound := false
		for _, s := range n.GetStrokes() {
			rewriteStops(s.GetPaint())
			name, _ := rewrite(s.GetPaint())
			strokeVars = append(strokeVars, name)
			bound = bound || name != ""
		}
		if bound {
			note(n, metaStrokeVars, strings.Join(strokeVars, "|"))
		}
		// Number and text bindings: the stored values may predate the variable
		// (a document built outside the server), so write them, then record the
		// number properties that export as var(). Text is exported literally.
		if len(n.GetBindings()) > 0 {
			core.ApplyBindings(d, n)
			var parts []string
			props := make([]string, 0, len(n.GetBindings()))
			for prop := range n.GetBindings() {
				props = append(props, prop)
			}
			sort.Strings(props)
			for _, prop := range props {
				id := n.GetBindings()[prop]
				if v := d.GetVariables()[id]; v != nil && prop != "text" {
					if _, ok := core.NumberValue(d, v); ok {
						used[id] = true
						parts = append(parts, prop+"="+names[id])
					}
				}
			}
			if len(parts) > 0 {
				note(n, metaBindVars, strings.Join(parts, "|"))
			}
		}
	}
	// The aliases of a used variable are used too: its custom property points at them.
	for changed := true; changed; {
		changed = false
		for id := range used {
			if t := d.GetVariables()[id].GetAliasOf(); t != "" && d.GetVariables()[t] != nil && !used[t] {
				used[t] = true
				changed = true
			}
		}
	}
	ids := make([]string, 0, len(used))
	for id := range used {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]cssVar, 0, len(ids))
	for _, id := range ids {
		out = append(out, toCSSVar(d, d.GetVariables()[id], names))
	}
	return out
}

// toCSSVar prints a variable's values as CSS: colours as colours, numbers
// unitless (the property that uses them adds the unit), text as a CSS string.
func toCSSVar(d *opendesignerv1.Document, v *opendesignerv1.Variable, names map[string]string) cssVar {
	cv := cssVar{name: names[v.GetId()], values: map[string]string{}}
	if t := v.GetAliasOf(); t != "" {
		if n, ok := names[t]; ok {
			cv.alias = n
		}
		return cv
	}
	for mode, c := range v.GetValues() {
		cv.values[mode] = colorCSS(c, 1)
	}
	for mode, x := range v.GetNumbers() {
		cv.values[mode] = num(x)
	}
	for mode, str := range v.GetStrings() {
		cv.values[mode] = strconv.Quote(str)
	}
	return cv
}

// propVar returns the custom property a node's number property is bound to, "".
func propVar(n *opendesignerv1.Node, prop string) string {
	for _, part := range strings.Split(n.GetMeta()[metaBindVars], "|") {
		if k, v, ok := strings.Cut(part, "="); ok && k == prop {
			return v
		}
	}
	return ""
}

// fillVar returns the custom property to use for a node's first fill, "" if none.
// With mul != 1 the colour is mixed with the node's opacity, which var() cannot
// express, so the literal wins.
func fillVar(n *opendesignerv1.Node, mul float64) string {
	if mul != 1 {
		return ""
	}
	return n.GetMeta()[metaFillVar]
}

// strokeVars: the custom property of each of the node's strokes ("" = literal),
// or nil when none is bound or the colour is mixed with opacity (mul != 1).
func strokeVars(n *opendesignerv1.Node, mul float64) []string {
	if mul != 1 {
		return nil
	}
	raw := n.GetMeta()[metaStrokeVars]
	if raw == "" {
		return nil
	}
	return strings.Split(raw, "|")
}

func varAt(vars []string, i int) string {
	if i < len(vars) {
		return vars[i]
	}
	return ""
}

func colorOrVar(f fill, name string, mul float64) string {
	if name != "" {
		return "var(" + name + ")"
	}
	return colorCSS(f.color, mul)
}

// tokensCSS renders the custom properties: the default mode (the first, or the
// variable's smallest key when the document defines no modes) and one
// `[data-mode="<id>"]` block per other mode holding only the values that
// differ, i.e. those the variable has for that mode. An alias is `var(--target)`
// and is re-declared in every mode block so it follows a mode switched on a
// wrapper element and not only on :root. Empty when no variable is used.
func tokensCSS(d *opendesignerv1.Document, vars []cssVar, tailwind bool) string {
	if len(vars) == 0 {
		return ""
	}
	def := ""
	if len(d.GetModes()) > 0 {
		def = d.GetModes()[0].GetId()
	}
	decl := func(v cssVar, mode string) string {
		if v.alias != "" {
			return fmt.Sprintf("%s:var(%s);", v.name, v.alias)
		}
		val, ok := v.values[mode]
		if !ok && mode == "" {
			keys := make([]string, 0, len(v.values))
			for k := range v.values {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			if len(keys) > 0 {
				val, ok = v.values[keys[0]]
			}
		}
		if !ok {
			return ""
		}
		return fmt.Sprintf("%s:%s;", v.name, val)
	}
	// With Tailwind, the `--color-*` tokens go in @theme: Tailwind then also
	// generates utilities for them (bg-brand, text-brand) and still emits them
	// as plain custom properties, which the [data-mode] blocks below override.
	// Any other name stays in :root, outside the theme namespaces.
	var theme, root strings.Builder
	for _, v := range vars {
		dst := &root
		if tailwind && strings.HasPrefix(v.name, "--color-") && v.alias == "" {
			dst = &theme
		}
		dst.WriteString(decl(v, def))
	}
	var b strings.Builder
	if theme.Len() > 0 {
		fmt.Fprintf(&b, "@theme{%s}\n", theme.String())
	}
	if root.Len() > 0 {
		fmt.Fprintf(&b, ":root{%s}\n", root.String())
	}
	for i, m := range d.GetModes() {
		if i == 0 {
			continue
		}
		var body strings.Builder
		for _, v := range vars {
			if v.alias != "" {
				body.WriteString(decl(v, m.GetId()))
			} else if _, ok := v.values[m.GetId()]; ok {
				body.WriteString(decl(v, m.GetId()))
			}
		}
		if body.Len() > 0 {
			fmt.Fprintf(&b, "[data-mode=%q]{%s}\n", m.GetId(), body.String())
		}
	}
	return b.String()
}
