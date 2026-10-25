package codegen

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

// COMPONENTS IN THE REACT TARGET. A component set exports as ONE file,
// `src/components/Button.tsx`, whose props are the set's axes (the variant to
// show) and the properties of its members; so does a single component that has
// properties (show/hide a layer, set a text, a number, swap a nested instance).
// An instance becomes `<Button size="L" label="Buy" />`, its variant_props and
// property_values travelling as props. Instances with overrides, or with animation
// or flow wiring inside, stay inline (see builder.instanceElement); so does
// everything in the HTML target.

type propKind int

const (
	pkBool propKind = iota
	pkText
	pkNumber
	pkSwap
)

// numberStyles: the React inline style a NUMBER property writes, by attribute.
var numberStyles = map[string]string{"opacity": "opacity", "corner_radius": "borderRadius", "font_size": "fontSize"}

// compProp is a COMPONENT PROPERTY exposed as a prop.
type compProp struct {
	name    string // the property's name in the design
	kind    propKind
	ident   string   // TS identifier
	def     string   // default: "true"/"false"; the text; the number; for a swap the default component id ("" = the nested one)
	options []string // text with an option list
	attr    string   // number: opacity | corner_radius | font_size
}

type compVariant struct {
	name    string
	variant map[string]string
	root    *Element
}

// compUnit is one exported React component: a component set, or a single
// component with properties.
type compUnit struct {
	key      string
	set      *opendesignerv1.ComponentSet // nil for a component outside any set
	name     string                       // PascalCase component name
	axes     []string                     // TS identifier per axis of the set, same order
	cprops   []*compProp
	variants []*compVariant
}

func (u *compUnit) property(name string) *compProp {
	for _, p := range u.cprops {
		if p.name == name {
			return p
		}
	}
	return nil
}

// identOf is the TS identifier of the component property called `name`.
func (u *compUnit) identOf(name string) string {
	if p := u.property(name); p != nil {
		return p.ident
	}
	return propIdent(name)
}

// regNaming: the type and identifier names a native target must not use.
type regNaming struct{ types, idents map[string]bool }

// ident renames a reserved identifier; a nil receiver (react) keeps it.
func (n *regNaming) ident(s string) string {
	if n != nil && n.idents[s] {
		return s + "Prop"
	}
	return s
}

type compRegistry struct {
	d     *opendesignerv1.Document
	b     *builder
	units map[string]*compUnit
	order []string
	// swapTrees: components that a swap value points at but that have no React
	// component of their own, expanded inline (component id -> IR).
	swapTrees map[string]*Element
}

var tsReserved = map[string]bool{
	"break": true, "case": true, "catch": true, "class": true, "const": true, "continue": true, "debugger": true, "default": true,
	"delete": true, "do": true, "else": true, "enum": true, "export": true, "extends": true, "false": true, "finally": true,
	"for": true, "function": true, "if": true, "import": true, "in": true, "instanceof": true, "new": true, "null": true,
	"return": true, "super": true, "switch": true, "this": true, "throw": true, "true": true, "try": true, "typeof": true,
	"var": true, "void": true, "while": true, "with": true, "yield": true, "let": true, "static": true, "await": true,
	"key": true, "ref": true, "children": true, "className": true, "style": true,
}

// propIdent: "Button size" -> "buttonSize"; never empty, never a reserved word.
func propIdent(name string) string {
	p := pascal(name)
	if p == "Screen" && len(words(name)) == 0 {
		p = "Prop"
	}
	s := strings.ToLower(p[:1]) + p[1:]
	if s[0] >= '0' && s[0] <= '9' {
		s = "p" + s
	}
	if tsReserved[s] {
		s += "Prop"
	}
	return s
}

// newCompRegistry discovers every component the screens use (and the ones those
// use in turn), builds the IR of every member's master, and names things.
//
// naming adds the names a native target's language reserves (nil for react).
func newCompRegistry(d *opendesignerv1.Document, b *builder, screens []*Screen, naming *regNaming) *compRegistry {
	r := &compRegistry{d: d, b: b, units: map[string]*compUnit{}, swapTrees: map[string]*Element{}}
	for _, s := range screens {
		r.discover(s.Root)
	}
	sort.Slice(r.order, func(i, j int) bool {
		a, c := r.units[r.order[i]], r.units[r.order[j]]
		if a.title() != c.title() {
			return a.title() < c.title()
		}
		return a.key < c.key
	})
	used := map[string]bool{"App": true}
	if naming != nil {
		for t := range naming.types {
			used[t] = true
		}
	}
	for _, s := range screens {
		used[s.Name] = true
	}
	for _, key := range r.order {
		u := r.units[key]
		u.name = dedupe(used, pascal(u.title()), "")
		propUsed := map[string]bool{}
		for _, ax := range u.set.GetAxes() {
			u.axes = append(u.axes, dedupe(propUsed, naming.ident(propIdent(ax.GetName())), ""))
		}
		for _, p := range u.cprops {
			p.ident = dedupe(propUsed, naming.ident(propIdent(p.name)), "")
		}
	}
	return r
}

// title: the name a unit's component is derived from.
func (u *compUnit) title() string {
	if u.set != nil {
		return u.set.GetName()
	}
	if len(u.variants) > 0 {
		return u.variants[0].name
	}
	return "Component"
}

// discover walks an IR tree for component uses, without descending into the
// inline children of a use (they are not rendered in the React target).
func (r *compRegistry) discover(e *Element) {
	if e == nil {
		return
	}
	if e.Use != nil {
		if u := r.need(e.Use.UnitKey); u != nil {
			// A swap value points at another component: make sure it can be rendered.
			for _, pv := range r.values(u, e.Use) {
				if pv.p.kind == pkSwap {
					r.prepareSwap(pv.v)
				}
			}
			return
		}
		e.Use = nil // the component vanished: keep the inline children
	}
	for _, c := range e.Children {
		r.discover(c)
	}
}

// prepareSwap makes the component a swap value points at renderable: as a React
// component if it is one, otherwise as an inline tree.
func (r *compRegistry) prepareSwap(compID string) {
	comp := r.d.GetComponents()[compID]
	if comp == nil {
		return
	}
	if key := unitKey(comp, compID); key != "" && r.need(key) != nil {
		return
	}
	if _, ok := r.swapTrees[compID]; ok {
		return
	}
	master := r.d.GetNodes()[comp.GetRootNodeId()]
	if master == nil {
		return
	}
	savedAnim, savedTriggers := r.b.anim, r.b.triggers
	r.b.anim, r.b.triggers = nil, nil
	defer func() { r.b.anim, r.b.triggers = savedAnim, savedTriggers }()
	tree := r.b.element(master, bctx{origin: true, idPrefix: "swap-" + compID + "/", visited: map[string]bool{compID: true}})
	if tree == nil {
		return
	}
	r.swapTrees[compID] = tree
	r.discover(tree)
}

// need registers a unit and builds its variants; nil if it cannot be built.
func (r *compRegistry) need(key string) *compUnit {
	if u, ok := r.units[key]; ok {
		return u
	}
	var set *opendesignerv1.ComponentSet
	var ids []string
	if strings.HasPrefix(key, "c:") {
		if r.d.GetComponents()[strings.TrimPrefix(key, "c:")] == nil {
			return nil
		}
		ids = []string{strings.TrimPrefix(key, "c:")}
	} else {
		set = r.d.GetComponentSets()[key]
		if set == nil || len(set.GetAxes()) == 0 {
			return nil
		}
		for id, c := range r.d.GetComponents() {
			if c.GetSetId() == key {
				ids = append(ids, id)
			}
		}
		sort.Strings(ids)
	}
	u := &compUnit{key: key, set: set}
	r.units[key] = u
	r.order = append(r.order, key)

	// A component's master is rendered once per variant, outside any screen: no
	// screen animation or wiring applies to it.
	savedAnim, savedTriggers := r.b.anim, r.b.triggers
	r.b.anim, r.b.triggers = nil, nil
	defer func() { r.b.anim, r.b.triggers = savedAnim, savedTriggers }()
	for _, id := range ids {
		comp := r.d.GetComponents()[id]
		master := r.d.GetNodes()[comp.GetRootNodeId()]
		if master == nil {
			continue
		}
		// The component's properties become props: a boolean layer is wrapped in
		// `{prop && ...}`, a text prints `{prop}`, a number drives an inline style, a
		// nested instance becomes a slot whose default is what the property's default shows.
		bind := map[string]propBind{}
		dyn := map[string][]DynStyle{}
		swapBind := map[string]string{}
		swap := map[string]string{}
		for _, p := range comp.GetProperties() {
			kind := kindOf(p.GetType())
			cp := u.property(p.GetName())
			if cp == nil {
				cp = newProp(p, kind)
				u.cprops = append(u.cprops, cp)
			}
			if cp.kind != kind {
				continue // the same name with another kind in another variant: first one wins
			}
			for _, node := range p.GetTargetNodeIds() {
				switch kind {
				case pkBool:
					pb := bind[node]
					pb.show = p.GetName()
					bind[node] = pb
				case pkText:
					pb := bind[node]
					pb.text = p.GetName()
					bind[node] = pb
				case pkNumber:
					dyn[node] = append(dyn[node], DynStyle{Style: numberStyles[cp.attr], Prop: p.GetName()})
				case pkSwap:
					swapBind[node] = p.GetName()
					if p.GetDefaultValue() != "" {
						swap[node] = p.GetDefaultValue()
					}
				}
			}
		}
		root := r.b.element(master, bctx{
			origin: true, idPrefix: "cmp-" + id + "/", visited: map[string]bool{id: true},
			bind: bind, dyn: dyn, swapBind: swapBind, swap: swap,
		})
		if root == nil {
			continue
		}
		u.variants = append(u.variants, &compVariant{name: comp.GetName(), variant: comp.GetVariant(), root: root})
	}
	for _, v := range u.variants {
		r.discover(v.root)
	}
	if len(u.variants) == 0 {
		delete(r.units, key)
		r.order = r.order[:len(r.order)-1]
		return nil
	}
	return u
}

func kindOf(t opendesignerv1.ComponentPropertyType) propKind {
	switch t {
	case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_TEXT:
		return pkText
	case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_NUMBER:
		return pkNumber
	case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_INSTANCE_SWAP:
		return pkSwap
	}
	return pkBool
}

// newProp: the prop a component property becomes, with its default read from
// the design.
func newProp(p *opendesignerv1.ComponentProperty, kind propKind) *compProp {
	return &compProp{name: p.GetName(), kind: kind, def: p.GetDefaultValue(), options: p.GetOptions(), attr: p.GetAttribute()}
}

func (r *compRegistry) known(u *ComponentUse) bool {
	_, ok := r.units[u.UnitKey]
	return ok
}

// propVal is a prop a call sets, with the design's value for it.
type propVal struct {
	p *compProp
	v string
}

// values: the props an instance sets, the ones whose value differs from the
// component's default (the rest fall back to it).
func (r *compRegistry) values(cu *compUnit, u *ComponentUse) []propVal {
	comp := r.d.GetComponents()[u.ComponentID]
	var out []propVal
	for _, cp := range cu.cprops {
		for _, p := range comp.GetProperties() {
			if p.GetName() != cp.name || kindOf(p.GetType()) != cp.kind {
				continue
			}
			if v := core.PropertyValue(r.d, u.Inst, p); !cp.isDefault(v) {
				out = append(out, propVal{cp, v})
			}
		}
	}
	return out
}

// isDefault: does `v` leave the prop at what the component defaults to?
func (p *compProp) isDefault(v string) bool {
	switch p.kind {
	case pkNumber:
		a, errA := strconv.ParseFloat(v, 64)
		b, errB := strconv.ParseFloat(p.def, 64)
		return errA == nil && errB == nil && a == b
	case pkSwap:
		return v == "" || v == p.def
	case pkBool:
		return (v != "false") == (p.def != "false")
	}
	return v == p.def
}

// jsx is the call: <Button size="L" label="Buy" />. Axes at the set's first option
// and properties at their defaults are left out.
func (r *compRegistry) jsx(u *ComponentUse) string {
	cu := r.units[u.UnitKey]
	comp := r.d.GetComponents()[u.ComponentID]
	var b strings.Builder
	b.WriteString("<" + cu.name)
	for i, ax := range cu.set.GetAxes() {
		if v, ok := comp.GetVariant()[ax.GetName()]; ok && len(ax.GetOptions()) > 0 && v != ax.GetOptions()[0] {
			fmt.Fprintf(&b, " %s=%s", cu.axes[i], tsString(v))
		}
	}
	for _, pv := range r.values(cu, u) {
		p, v := pv.p, pv.v
		switch p.kind {
		case pkText:
			fmt.Fprintf(&b, " %s=%s", p.ident, tsString(v))
		case pkNumber:
			if f, err := strconv.ParseFloat(v, 64); err == nil {
				fmt.Fprintf(&b, " %s={%s}", p.ident, num(f))
			}
		case pkSwap:
			if sw := r.swapJSX(v); sw != "" {
				fmt.Fprintf(&b, " %s={%s}", p.ident, sw)
			}
		default:
			if v == "false" {
				fmt.Fprintf(&b, " %s={false}", p.ident)
			} else {
				b.WriteString(" " + p.ident)
			}
		}
	}
	b.WriteString(" />")
	return b.String()
}

// swapJSX is the content a swap prop receives for component `compID`.
func (r *compRegistry) swapJSX(compID string) string {
	comp := r.d.GetComponents()[compID]
	if comp == nil {
		return ""
	}
	if key := unitKey(comp, compID); key != "" {
		if _, ok := r.units[key]; ok {
			return r.jsx(&ComponentUse{UnitKey: key, ComponentID: compID, Inst: &opendesignerv1.InstanceNode{ComponentId: compID}})
		}
	}
	if tree := r.swapTrees[compID]; tree != nil {
		w := &jsxWriter{reg: r}
		w.element(tree, 1, false, r.d)
		return "(\n" + strings.TrimRight(w.sb.String(), "\n") + "\n)"
	}
	return ""
}

// usedBy: the component names an element tree calls, sorted, deduplicated.
func (r *compRegistry) usedBy(root *Element) []string {
	seen := map[string]bool{}
	var walk func(e *Element)
	walk = func(e *Element) {
		if e.Use != nil && r.known(e.Use) {
			cu := r.units[e.Use.UnitKey]
			seen[cu.name] = true
			// Swap values call other components.
			for _, pv := range r.values(cu, e.Use) {
				if pv.p.kind != pkSwap {
					continue
				}
				if comp := r.d.GetComponents()[pv.v]; comp != nil {
					if k := unitKey(comp, pv.v); k != "" {
						if tu, ok := r.units[k]; ok {
							seen[tu.name] = true
						}
					} else if t := r.swapTrees[pv.v]; t != nil {
						for _, n := range r.usedBy(t) {
							seen[n] = true
						}
					}
				}
			}
			return
		}
		for _, c := range e.Children {
			walk(c)
		}
	}
	walk(root)
	out := make([]string, 0, len(seen))
	for n := range seen {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

// files writes one component file per unit.
func (r *compRegistry) files(put func(path, content string)) {
	for _, key := range r.order {
		u := r.units[key]
		put("src/components/"+u.name+".tsx", r.component(u))
	}
}

func (r *compRegistry) component(u *compUnit) string {
	var b strings.Builder
	what := "component \"" + oneLine(u.title()) + "\""
	if u.set != nil {
		what = "component \"" + oneLine(u.set.GetName()) + "\" (variant set)"
	}
	b.WriteString(tsHeader(r.d, what))
	hasSwap := false
	for _, p := range u.cprops {
		hasSwap = hasSwap || p.kind == pkSwap
	}
	if hasSwap {
		b.WriteString("import type { ReactNode } from \"react\";\n")
	}
	imports := map[string]bool{}
	for _, v := range u.variants {
		for _, n := range r.usedBy(v.root) {
			if n != u.name {
				imports[n] = true
			}
		}
	}
	names := make([]string, 0, len(imports))
	for n := range imports {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		fmt.Fprintf(&b, "import { %s } from \"./%s\";\n", n, n)
	}
	if hasSwap || len(names) > 0 {
		b.WriteString("\n")
	}

	// Props: the set's axes as optional unions (a missing prop is the first option),
	// then the component's properties.
	fmt.Fprintf(&b, "export type %sProps = {\n", u.name)
	for i, ax := range u.set.GetAxes() {
		vals := make([]string, len(ax.GetOptions()))
		for j, v := range ax.GetOptions() {
			vals[j] = tsString(v)
		}
		fmt.Fprintf(&b, "  /** %s */\n  %s?: %s;\n", oneLine(ax.GetName()), u.axes[i], strings.Join(vals, " | "))
	}
	for _, p := range u.cprops {
		switch p.kind {
		case pkText:
			typ := "string"
			if len(p.options) > 0 {
				opts := make([]string, len(p.options))
				for i, o := range p.options {
					opts[i] = tsString(o)
				}
				typ = strings.Join(opts, " | ")
			}
			fmt.Fprintf(&b, "  /** %s (text) */\n  %s?: %s;\n", oneLine(p.name), p.ident, typ)
		case pkNumber:
			fmt.Fprintf(&b, "  /** %s (%s) */\n  %s?: number;\n", oneLine(p.name), strings.ReplaceAll(p.attr, "_", " "), p.ident)
		case pkSwap:
			fmt.Fprintf(&b, "  /** %s (replaces a nested component) */\n  %s?: ReactNode;\n", oneLine(p.name), p.ident)
		default:
			fmt.Fprintf(&b, "  /** %s (show/hide) */\n  %s?: boolean;\n", oneLine(p.name), p.ident)
		}
	}
	b.WriteString("};\n\n")

	params := make([]string, 0, len(u.axes)+len(u.cprops))
	for i, ax := range u.set.GetAxes() {
		params = append(params, fmt.Sprintf("%s = %s", u.axes[i], tsString(ax.GetOptions()[0])))
	}
	for _, p := range u.cprops {
		switch p.kind {
		case pkText:
			params = append(params, fmt.Sprintf("%s = %s", p.ident, tsString(p.def)))
		case pkNumber:
			if f, err := strconv.ParseFloat(p.def, 64); err == nil {
				params = append(params, fmt.Sprintf("%s = %s", p.ident, num(f)))
			} else {
				params = append(params, p.ident)
			}
		case pkSwap:
			params = append(params, p.ident) // undefined: the default content shows
		default:
			params = append(params, fmt.Sprintf("%s = %v", p.ident, p.def != "false"))
		}
	}
	if len(params) == 0 {
		fmt.Fprintf(&b, "export function %s(_: %sProps) {\n", u.name, u.name)
	} else {
		fmt.Fprintf(&b, "export function %s({ %s }: %sProps) {\n", u.name, strings.Join(params, ", "), u.name)
	}

	body := func(v *compVariant, depth int) string {
		w := &jsxWriter{reg: r, propIdent: u.identOf}
		root := v.root
		if root.ShowIf != "" {
			// The master root itself is toggled: the component renders nothing when off.
			cp := *root
			cp.ShowIf = ""
			w.line(depth, u.identOf(root.ShowIf)+" ? (")
			w.element(&cp, depth+1, false, r.d)
			w.line(depth, ") : null")
		} else {
			w.element(root, depth, false, r.d)
		}
		return w.sb.String()
	}

	if u.set == nil {
		// One master, nothing to switch on.
		b.WriteString("  return (\n" + body(u.variants[0], 2) + "  );\n}\n")
		return b.String()
	}
	// The variant key: the axes' values in set order, joined.
	keyParts := make([]string, len(u.axes))
	for i := range u.axes {
		keyParts[i] = "${" + u.axes[i] + "}"
	}
	fmt.Fprintf(&b, "  switch (`%s`) {\n", strings.Join(keyParts, "|"))
	for _, v := range u.variants {
		vals := make([]string, len(u.axes))
		for i, ax := range u.set.GetAxes() {
			vals[i] = v.variant[ax.GetName()]
		}
		fmt.Fprintf(&b, "    case %s:\n      // %s\n      return (\n", tsString(strings.Join(vals, "|")), oneLine(v.name))
		b.WriteString(body(v, 4))
		b.WriteString("      );\n")
	}
	b.WriteString("    default:\n      return null; // this combination has no variant in the design\n  }\n}\n")
	return b.String()
}
