package codegen

import (
	"fmt"
	"sort"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// VARIANT SETS AS REACT COMPONENTS. An instance of a variant component exports
// as `<Button size="L" state="Default" />`, and each set becomes ONE file,
// `src/components/Button.tsx`, whose props are the set's properties and which
// renders the master of the matching variant. Instances with overrides, or with
// animation or flow wiring inside, stay inline (see builder.instanceElement).

type compVariant struct {
	id      string // component id
	name    string
	variant map[string]string
	root    *Element
}

// compProp is a COMPONENT PROPERTY (show/hide a layer, set a text) exposed as a prop.
type compProp struct {
	name  string // the property's name in the design
	text  bool   // text property; otherwise boolean
	ident string // TS identifier
	def   string // default: "true"/"false" for a boolean, the text for a text
}

type compSet struct {
	id       string
	set      *opendesignerv1.ComponentSet
	name     string   // PascalCase component name
	props    []string // TS identifier per set property, same order
	cprops   []*compProp
	variants []*compVariant
}

// identOf is the TS identifier of the component property called `name`.
func (cs *compSet) identOf(name string) string {
	for _, p := range cs.cprops {
		if p.name == name {
			return p.ident
		}
	}
	return propIdent(name)
}

type compRegistry struct {
	d    *opendesignerv1.Document
	b    *builder
	sets map[string]*compSet
	// order: set ids in discovery order, then sorted for stable output.
	order []string
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

// newCompRegistry discovers every variant set the screens use (and the ones
// those use in turn), builds the IR of every member's master, and names things.
func newCompRegistry(d *opendesignerv1.Document, b *builder, screens []*Screen) *compRegistry {
	r := &compRegistry{d: d, b: b, sets: map[string]*compSet{}}
	for _, s := range screens {
		r.discover(s.Root)
	}
	sort.Slice(r.order, func(i, j int) bool {
		a, c := r.sets[r.order[i]], r.sets[r.order[j]]
		if a.set.GetName() != c.set.GetName() {
			return a.set.GetName() < c.set.GetName()
		}
		return a.id < c.id
	})
	used := map[string]bool{"App": true}
	for _, s := range screens {
		used[s.Name] = true
	}
	for _, id := range r.order {
		cs := r.sets[id]
		cs.name = dedupe(used, pascal(cs.set.GetName()), "")
		used[cs.name] = true
		propUsed := map[string]bool{}
		for _, p := range cs.set.GetProperties() {
			cs.props = append(cs.props, dedupe(propUsed, propIdent(p.GetName()), ""))
		}
		for _, p := range cs.cprops {
			p.ident = dedupe(propUsed, propIdent(p.name), "")
		}
	}
	return r
}

// discover walks an IR tree for component uses, without descending into the
// inline children of a use (they are not rendered in the React target).
func (r *compRegistry) discover(e *Element) {
	if e == nil {
		return
	}
	if e.Use != nil {
		if r.need(e.Use.SetID) {
			return
		}
		e.Use = nil // the set vanished: keep the inline children
	}
	for _, c := range e.Children {
		r.discover(c)
	}
}

// need registers a set and builds its variants; false if the set does not exist.
func (r *compRegistry) need(setID string) bool {
	if _, ok := r.sets[setID]; ok {
		return true
	}
	set := r.d.GetComponentSets()[setID]
	if set == nil || len(set.GetProperties()) == 0 {
		return false
	}
	cs := &compSet{id: setID, set: set}
	r.sets[setID] = cs
	r.order = append(r.order, setID)

	var ids []string
	for id, c := range r.d.GetComponents() {
		if c.GetSetId() == setID {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
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
		// and wrapped in `{prop && ...}`, a text layer prints `{prop}`.
		visible := map[string]bool{}
		bind := map[string]propBind{}
		for _, p := range comp.GetProperties() {
			cp := cs.property(p.GetName())
			isText := p.GetType() == opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_TEXT
			if cp == nil {
				cp = &compProp{name: p.GetName(), text: isText, def: p.GetDefaultValue()}
				if isText && cp.def == "" {
					cp.def = r.d.GetNodes()[p.GetNodeId()].GetText().GetContent() // empty default = the master's own text
				}
				cs.cprops = append(cs.cprops, cp)
			}
			if cp.text != isText {
				continue // the same name with another kind in another variant: first one wins
			}
			b := bind[p.GetNodeId()]
			if isText {
				b.text = p.GetName()
			} else {
				b.show = p.GetName()
				visible[p.GetNodeId()] = true
			}
			bind[p.GetNodeId()] = b
		}
		cc := bctx{origin: true, idPrefix: "cmp-" + id + "/", visited: map[string]bool{id: true}, visible: visible, bind: bind}
		root := r.b.element(master, cc)
		if root == nil {
			continue
		}
		cs.variants = append(cs.variants, &compVariant{id: id, name: comp.GetName(), variant: comp.GetVariant(), root: root})
	}
	for _, v := range cs.variants {
		r.discover(v.root)
	}
	if len(cs.variants) == 0 {
		delete(r.sets, setID)
		r.order = r.order[:len(r.order)-1]
		return false
	}
	return true
}

func (cs *compSet) property(name string) *compProp {
	for _, p := range cs.cprops {
		if p.name == name {
			return p
		}
	}
	return nil
}

func (r *compRegistry) known(u *ComponentUse) bool {
	_, ok := r.sets[u.SetID]
	return ok
}

// jsx is the call: <Button size="L" state="Default" />.
func (r *compRegistry) jsx(u *ComponentUse) string {
	cs := r.sets[u.SetID]
	var b strings.Builder
	b.WriteString("<" + cs.name)
	for i, p := range cs.set.GetProperties() {
		if v, ok := u.Variant[p.GetName()]; ok {
			fmt.Fprintf(&b, " %s=%s", cs.props[i], tsString(v))
		}
	}
	// The instance's component-property values, as props.
	for _, p := range cs.cprops {
		v, ok := u.Values[p.name]
		if !ok {
			continue
		}
		if p.text {
			fmt.Fprintf(&b, " %s=%s", p.ident, tsString(v))
		} else if v == "false" {
			fmt.Fprintf(&b, " %s={false}", p.ident)
		} else {
			b.WriteString(" " + p.ident)
		}
	}
	b.WriteString(" />")
	return b.String()
}

// usedBy: the component names an element tree calls, sorted, deduplicated.
func (r *compRegistry) usedBy(root *Element) []string {
	seen := map[string]bool{}
	var walk func(e *Element)
	walk = func(e *Element) {
		if e.Use != nil && r.known(e.Use) {
			seen[r.sets[e.Use.SetID].name] = true
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

// files writes one component file per set.
func (r *compRegistry) files(put func(path, content string)) {
	for _, id := range r.order {
		cs := r.sets[id]
		put("src/components/"+cs.name+".tsx", r.component(cs))
	}
}

func (r *compRegistry) component(cs *compSet) string {
	var b strings.Builder
	b.WriteString(tsHeader(r.d, "component \""+oneLine(cs.set.GetName())+"\" (variant set)"))
	imports := map[string]bool{}
	for _, v := range cs.variants {
		for _, n := range r.usedBy(v.root) {
			if n != cs.name {
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
	if len(names) > 0 {
		b.WriteString("\n")
	}

	// Props: one optional union of the property's values; a missing prop is the
	// property's first value.
	fmt.Fprintf(&b, "export type %sProps = {\n", cs.name)
	for i, p := range cs.set.GetProperties() {
		vals := make([]string, len(p.GetValues()))
		for j, v := range p.GetValues() {
			vals[j] = tsString(v)
		}
		fmt.Fprintf(&b, "  /** %s */\n  %s?: %s;\n", oneLine(p.GetName()), cs.props[i], strings.Join(vals, " | "))
	}
	for _, p := range cs.cprops {
		if p.text {
			fmt.Fprintf(&b, "  /** %s (text) */\n  %s?: string;\n", oneLine(p.name), p.ident)
		} else {
			fmt.Fprintf(&b, "  /** %s (show/hide) */\n  %s?: boolean;\n", oneLine(p.name), p.ident)
		}
	}
	b.WriteString("};\n\n")

	params := make([]string, 0, len(cs.props)+len(cs.cprops))
	for i, p := range cs.set.GetProperties() {
		params = append(params, fmt.Sprintf("%s = %s", cs.props[i], tsString(p.GetValues()[0])))
	}
	for _, p := range cs.cprops {
		if p.text {
			params = append(params, fmt.Sprintf("%s = %s", p.ident, tsString(p.def)))
		} else {
			params = append(params, fmt.Sprintf("%s = %v", p.ident, p.def != "false"))
		}
	}
	fmt.Fprintf(&b, "export function %s({ %s }: %sProps) {\n", cs.name, strings.Join(params, ", "), cs.name)

	// The variant key: the property values in set order, joined.
	keyParts := make([]string, len(cs.props))
	for i := range cs.props {
		keyParts[i] = "${" + cs.props[i] + "}"
	}
	fmt.Fprintf(&b, "  switch (`%s`) {\n", strings.Join(keyParts, "|"))
	for _, v := range cs.variants {
		vals := make([]string, len(cs.props))
		for i, p := range cs.set.GetProperties() {
			vals[i] = v.variant[p.GetName()]
		}
		fmt.Fprintf(&b, "    case %s:\n      // %s\n      return (\n", tsString(strings.Join(vals, "|")), oneLine(v.name))
		w := &jsxWriter{reg: r, propIdent: cs.identOf}
		if v.root.ShowIf != "" {
			// The master root itself is toggled: the component renders nothing when off.
			root := *v.root
			root.ShowIf = ""
			w.line(4, cs.identOf(v.root.ShowIf)+" ? (")
			w.element(&root, 5, false, r.d)
			w.line(4, ") : null")
		} else {
			w.element(v.root, 4, false, r.d)
		}
		b.WriteString(w.sb.String())
		b.WriteString("      );\n")
	}
	b.WriteString("    default:\n      return null; // this combination has no variant in the design\n  }\n}\n")
	return b.String()
}
