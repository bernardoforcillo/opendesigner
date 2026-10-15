package codegen

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

// COMPONENTS IN THE REACT TARGET. A component that has variants (a ComponentSet),
// or component properties, exports as ONE file, `src/components/Button.tsx`: its
// props are the set's properties (the variant to show) and the component's
// properties (show/hide a layer, set a text, a number, swap a nested instance),
// and an instance becomes `<Button size="L" label="Buy" />`. Instances with
// overrides, or with animation or flow wiring inside, stay inline (see
// builder.instanceElement); so does everything in the HTML target.

type propKind int

const (
	pkBool propKind = iota
	pkText
	pkNumber
	pkSwap
)

// compProp is a COMPONENT PROPERTY exposed as a prop.
type compProp struct {
	name    string // the property's name in the design
	kind    propKind
	ident   string   // TS identifier
	def     string   // default: "true"/"false"; the text; the number; "" for a swap (the nested content)
	options []string // text with an option list
	attr    string   // number: opacity | corner_radius | font_size
}

type compVariant struct {
	id      string // component id
	name    string
	variant map[string]string
	root    *Element
}

// compUnit is one exported React component: a variant set, or a single component
// with properties.
type compUnit struct {
	key      string
	set      *opendesignerv1.ComponentSet // nil for a component outside any set
	name     string                       // PascalCase component name
	props    []string                     // TS identifier per set property, same order
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

type compRegistry struct {
	d     *opendesignerv1.Document
	b     *builder
	units map[string]*compUnit
	order []string
	// swapTrees: components that a swap value points at but that have no React
	// component of their own, expanded inline (component id -> IR).
	swapTrees map[string]*Element
	needNode  bool // some prop is a ReactNode (swap): the component files import its type
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
func newCompRegistry(d *opendesignerv1.Document, b *builder, screens []*Screen) *compRegistry {
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
	for _, s := range screens {
		used[s.Name] = true
	}
	for _, key := range r.order {
		u := r.units[key]
		u.name = dedupe(used, pascal(u.title()), "")
		used[u.name] = true
		propUsed := map[string]bool{}
		for _, p := range u.set.GetProperties() {
			u.props = append(u.props, dedupe(propUsed, propIdent(p.GetName()), ""))
		}
		for _, p := range u.cprops {
			p.ident = dedupe(propUsed, propIdent(p.name), "")
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
		if u := r.need(e.Use.SetID); u != nil {
			// A swap value points at another component: make sure it can be rendered.
			for name, v := range e.Use.Values {
				if cp := u.property(name); cp != nil && cp.kind == pkSwap {
					r.prepareSwap(v)
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
		if set == nil || len(set.GetProperties()) == 0 {
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
		// The component's properties become props: a boolean layer is built (shown)
		// and wrapped in `{prop && ...}`, a text prints `{prop}`, a number drives an
		// inline style, a nested instance becomes a slot.
		visible := map[string]bool{}
		bind := map[string]propBind{}
		dyn := map[string][]DynStyle{}
		swapBind := map[string]string{}
		for _, p := range comp.GetProperties() {
			cp := u.property(p.GetName())
			kind := kindOf(p.GetType())
			if cp == nil {
				cp = r.newProp(p, kind)
				u.cprops = append(u.cprops, cp)
			}
			if cp.kind != kind {
				continue // the same name with another kind in another variant: first one wins
			}
			node := p.GetNodeId()
			switch kind {
			case pkBool:
				b := bind[node]
				b.show = p.GetName()
				bind[node] = b
				visible[node] = true
			case pkText:
				b := bind[node]
				b.text = p.GetName()
				bind[node] = b
			case pkNumber:
				dyn[node] = append(dyn[node], DynStyle{Style: map[string]string{"opacity": "opacity", "corner_radius": "borderRadius", "font_size": "fontSize"}[cp.attr], Prop: p.GetName()})
			case pkSwap:
				swapBind[node] = p.GetName()
				r.needNode = true
			}
		}
		// The default content of a swap slot is what the property's default shows.
		fx := coreEffects(comp)
		cc := bctx{
			origin: true, idPrefix: "cmp-" + id + "/", visited: map[string]bool{id: true},
			visible: visible, bind: bind, dyn: dyn, swapBind: swapBind, swap: fx.Swap,
		}
		root := r.b.element(master, cc)
		if root == nil {
			continue
		}
		u.variants = append(u.variants, &compVariant{id: id, name: comp.GetName(), variant: comp.GetVariant(), root: root})
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
// the design (an empty default is the master's own value).
func (r *compRegistry) newProp(p *opendesignerv1.ComponentProperty, kind propKind) *compProp {
	cp := &compProp{name: p.GetName(), kind: kind, def: p.GetDefaultValue(), options: p.GetOptions(), attr: p.GetAttribute()}
	node := r.d.GetNodes()[p.GetNodeId()]
	switch kind {
	case pkText:
		if cp.def == "" {
			cp.def = node.GetText().GetContent()
		}
		if len(cp.options) > 0 && cp.def == "" {
			cp.def = cp.options[0]
		}
	case pkNumber:
		if cp.def == "" {
			switch cp.attr {
			case "opacity":
				cp.def = num(node.GetOpacity())
			case "corner_radius":
				cp.def = num(node.GetRect().GetCornerRadius())
			case "font_size":
				cp.def = num(node.GetText().GetStyle().GetFontSize())
			}
		}
	case pkSwap:
		cp.def = ""
	}
	return cp
}

func (r *compRegistry) known(u *ComponentUse) bool {
	_, ok := r.units[u.SetID]
	return ok
}

// jsx is the call: <Button size="L" label="Buy" />.
func (r *compRegistry) jsx(u *ComponentUse) string {
	cu := r.units[u.SetID]
	var b strings.Builder
	b.WriteString("<" + cu.name)
	for i, p := range cu.set.GetProperties() {
		if v, ok := u.Variant[p.GetName()]; ok {
			fmt.Fprintf(&b, " %s=%s", cu.props[i], tsString(v))
		}
	}
	// The instance's component-property values, as props.
	for _, p := range cu.cprops {
		v, ok := u.Values[p.name]
		if !ok {
			continue
		}
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
			return r.jsx(&ComponentUse{SetID: key, ComponentID: compID, Variant: comp.GetVariant()})
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
			cu := r.units[e.Use.SetID]
			seen[cu.name] = true
			// Swap values call other components.
			for name, v := range e.Use.Values {
				if p := cu.property(name); p != nil && p.kind == pkSwap {
					if comp := r.d.GetComponents()[v]; comp != nil {
						if k := unitKey(comp, v); k != "" {
							if tu, ok := r.units[k]; ok {
								seen[tu.name] = true
							}
						} else if t := r.swapTrees[v]; t != nil {
							for _, n := range r.usedBy(t) {
								seen[n] = true
							}
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
	what := "component"
	if u.set != nil {
		what = "component \"" + oneLine(u.set.GetName()) + "\" (variant set)"
	} else {
		what = "component \"" + oneLine(u.title()) + "\""
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

	// Props: the set's properties as optional unions (a missing prop is the first
	// value), then the component's properties.
	fmt.Fprintf(&b, "export type %sProps = {\n", u.name)
	for i, p := range u.set.GetProperties() {
		vals := make([]string, len(p.GetValues()))
		for j, v := range p.GetValues() {
			vals[j] = tsString(v)
		}
		fmt.Fprintf(&b, "  /** %s */\n  %s?: %s;\n", oneLine(p.GetName()), u.props[i], strings.Join(vals, " | "))
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

	params := make([]string, 0, len(u.props)+len(u.cprops))
	for i, p := range u.set.GetProperties() {
		params = append(params, fmt.Sprintf("%s = %s", u.props[i], tsString(p.GetValues()[0])))
	}
	for _, p := range u.cprops {
		switch p.kind {
		case pkText:
			params = append(params, fmt.Sprintf("%s = %s", p.ident, tsString(p.def)))
		case pkNumber:
			if p.def != "" {
				params = append(params, fmt.Sprintf("%s = %s", p.ident, p.def))
			} else {
				params = append(params, p.ident)
			}
		case pkSwap:
			params = append(params, p.ident) // undefined: the default content shows
		default:
			params = append(params, fmt.Sprintf("%s = %v", p.ident, p.def != "false"))
		}
	}
	destructure := "{ " + strings.Join(params, ", ") + " }"
	if len(params) == 0 {
		destructure = "_: " + u.name + "Props"
		fmt.Fprintf(&b, "export function %s(%s) {\n", u.name, destructure)
	} else {
		fmt.Fprintf(&b, "export function %s(%s: %sProps) {\n", u.name, destructure, u.name)
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

	if u.set == nil || len(u.set.GetProperties()) == 0 {
		// One master, nothing to switch on.
		b.WriteString("  return (\n" + body(u.variants[0], 2) + "  );\n}\n")
		return b.String()
	}
	// The variant key: the property values in set order, joined.
	keyParts := make([]string, len(u.props))
	for i := range u.props {
		keyParts[i] = "${" + u.props[i] + "}"
	}
	fmt.Fprintf(&b, "  switch (`%s`) {\n", strings.Join(keyParts, "|"))
	for _, v := range u.variants {
		vals := make([]string, len(u.props))
		for i, p := range u.set.GetProperties() {
			vals[i] = v.variant[p.GetName()]
		}
		fmt.Fprintf(&b, "    case %s:\n      // %s\n      return (\n", tsString(strings.Join(vals, "|")), oneLine(v.name))
		b.WriteString(body(v, 4))
		b.WriteString("      );\n")
	}
	b.WriteString("    default:\n      return null; // this combination has no variant in the design\n  }\n}\n")
	return b.String()
}

// coreEffects: the effects of a component's properties at their defaults.
func coreEffects(comp *opendesignerv1.Component) core.InstanceEffects {
	return core.EffectsWith(comp, nil)
}
