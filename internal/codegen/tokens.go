package codegen

import (
	"fmt"
	"sort"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

// DESIGN TOKENS AS CSS CUSTOM PROPERTIES (HTML target).
//
// The model resolves a variable to the value of the node's active mode, and by default the export writes that
// literal. With tokens on, a property bound to a variable keeps its value as a fallback but reads the variable:
//
//	background-color: var(--colors-brand, #2563eb);
//
// and the stylesheet defines each variable once per mode, so the page changes mode without regenerating:
//
//	:root { --colors-brand: #2563eb }                  /* the collection's first mode */
//	[data-mode-theme="dark"] { --colors-brand: #60a5fa }   /* any element carrying the attribute */
//
// A subtree pinned to a mode in the document (`Node.modes`) carries that attribute, so it stays in its mode when
// the page switches. Bound today: a fill's colour (shapes and text), opacity, corner radius and font size.
// Spacing and padding bindings stay literal (their CSS is a shorthand built from several values).

type tokenUnit int

const (
	tokenColor tokenUnit = iota
	tokenPx
	tokenNumber
)

type token struct {
	name  string // the custom property, "--colors-brand"
	varID string
	unit  tokenUnit
}

// tokenSlug lowercases a name into a CSS identifier part.
func tokenSlug(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(s) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			dash = false
		default:
			if !dash && b.Len() > 0 {
				b.WriteByte('-')
			}
			dash = true
		}
	}
	return strings.Trim(b.String(), "-")
}

// tokenName is the custom property of variable v used as `unit`: collection and variable name, and a suffix when
// the same variable is read as two kinds of value (a number bound to both a radius and an opacity).
func (b *builder) tokenName(v *opendesignerv1.Variable, unit tokenUnit) string {
	col := b.doc.GetCollections()[v.GetCollectionId()]
	name := "--" + tokenSlug(col.GetName()) + "-" + tokenSlug(v.GetName())
	if tokenSlug(col.GetName()) == "" {
		name = "--" + tokenSlug(v.GetName())
	}
	if name == "--" || strings.HasSuffix(name, "-") {
		name += "var"
	}
	for _, t := range b.tokens {
		if t.varID == v.GetId() && t.unit != unit && t.name == name {
			if unit == tokenNumber {
				return name + "-num"
			}
			return name + "-px"
		}
	}
	return name
}

// useToken registers the variable and returns its custom property.
func (b *builder) useToken(varID string, unit tokenUnit) (string, bool) {
	v := b.doc.GetVariables()[varID]
	if v == nil {
		return "", false
	}
	switch v.GetType() {
	case opendesignerv1.VariableType_VARIABLE_TYPE_COLOR:
		if unit != tokenColor {
			return "", false
		}
	case opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER:
		if unit == tokenColor {
			return "", false
		}
	default:
		return "", false
	}
	name := b.tokenName(v, unit)
	if b.tokens == nil {
		b.tokens = map[string]token{}
	}
	b.tokens[name] = token{name: name, varID: varID, unit: unit}
	return name, true
}

// applyTokens rewrites the bound properties of `el` to read their custom property. `orig` is the node as the
// document has it (with its bindings), `res` the node resolved in its active mode, which is what `el` was built from.
func (b *builder) applyTokens(orig, res *opendesignerv1.Node, el *Element) {
	if !b.tokensOn || len(orig.GetBindings()) == 0 {
		return
	}
	keys := make([]string, 0, len(orig.GetBindings()))
	for k := range orig.GetBindings() {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, key := range keys {
		id := orig.GetBindings()[key]
		switch key {
		case "fills.0":
			if len(res.GetFills()) == 0 {
				continue
			}
			prop := "background-color"
			if res.GetText() != nil {
				prop = "color"
			}
			c := res.GetFills()[0].GetSolid().GetColor()
			if c == nil {
				continue
			}
			if name, ok := b.useToken(id, tokenColor); ok {
				el.rewriteStyle(prop, colorCSS(c, 1), name)
			}
		case "opacity":
			if name, ok := b.useToken(id, tokenNumber); ok {
				el.rewriteStyle("opacity", num(res.GetOpacity()), name)
			}
		case "corner_radius":
			r := res.GetRect().GetCornerRadius()
			if name, ok := b.useToken(id, tokenPx); ok && r > 0 {
				el.rewriteStyle("border-radius", px(r), name)
			}
		case "font_size":
			if t := res.GetText(); t != nil && t.GetStyle() != nil {
				if name, ok := b.useToken(id, tokenPx); ok {
					el.rewriteStyle("font-size", px(t.GetStyle().GetFontSize()), name)
				}
			}
		}
	}
	// A subtree pinned to a mode keeps it when the page switches.
	if len(orig.GetModes()) > 0 {
		cols := make([]string, 0, len(orig.GetModes()))
		for cid := range orig.GetModes() {
			cols = append(cols, cid)
		}
		sort.Strings(cols)
		for _, cid := range cols {
			col := b.doc.GetCollections()[cid]
			for _, m := range col.GetModes() {
				if m.GetId() == orig.GetModes()[cid] {
					el.Attrs = append(el.Attrs, Attr{"data-mode-" + tokenSlug(col.GetName()), tokenSlug(m.GetName())})
				}
			}
		}
	}
}

// rewriteStyle makes the first declaration of `prop` whose value is `old` read `var(name, old)`; anything else
// (the value was computed differently, say with the fill's opacity folded in) stays literal.
func (e *Element) rewriteStyle(prop, old, name string) {
	for i, p := range e.Style {
		if p.Name == prop && p.Value == old {
			e.Style[i].Value = "var(" + name + ", " + old + ")"
			return
		}
	}
}

// tokenCSS is the stylesheet of the custom properties in use: the first mode of each collection on :root, then a
// rule per mode for the attribute that selects it.
func (b *builder) tokenCSS() string {
	if len(b.tokens) == 0 {
		return ""
	}
	names := make([]string, 0, len(b.tokens))
	for n := range b.tokens {
		names = append(names, n)
	}
	sort.Strings(names)
	// Group the tokens by collection, in the order of the collections' ids.
	byCol := map[string][]token{}
	for _, n := range names {
		t := b.tokens[n]
		cid := b.doc.GetVariables()[t.varID].GetCollectionId()
		byCol[cid] = append(byCol[cid], t)
	}
	cids := make([]string, 0, len(byCol))
	for cid := range byCol {
		cids = append(cids, cid)
	}
	sort.Strings(cids)

	var root strings.Builder
	var modes strings.Builder
	for _, cid := range cids {
		col := b.doc.GetCollections()[cid]
		for i, m := range col.GetModes() {
			var decls strings.Builder
			for _, t := range byCol[cid] {
				val := core.VariableValueIn(b.doc, b.doc.GetVariables()[t.varID], m.GetId())
				if css, ok := tokenValue(val, t.unit); ok {
					fmt.Fprintf(&decls, "%s:%s;", t.name, css)
				}
			}
			if decls.Len() == 0 {
				continue
			}
			if i == 0 {
				root.WriteString(decls.String())
			}
			fmt.Fprintf(&modes, "[data-mode-%s=\"%s\"]{%s}\n", tokenSlug(col.GetName()), tokenSlug(m.GetName()), decls.String())
		}
	}
	if root.Len() == 0 && modes.Len() == 0 {
		return ""
	}
	return ":root{" + root.String() + "}\n" + modes.String()
}

func tokenValue(v *opendesignerv1.VariableValue, unit tokenUnit) (string, bool) {
	switch k := v.GetKind().(type) {
	case *opendesignerv1.VariableValue_Color:
		if unit == tokenColor && k.Color != nil {
			return colorCSS(k.Color, 1), true
		}
	case *opendesignerv1.VariableValue_Number:
		switch unit {
		case tokenPx:
			return px(k.Number), true
		case tokenNumber:
			return num(k.Number), true
		}
	}
	return "", false
}
