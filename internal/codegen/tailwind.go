package codegen

import (
	"strconv"
	"strings"
)

// CSS Prop -> Tailwind v4 class mapping. It lives in a file of its own, driven
// by tables, because it is the part that changes most often (a new utility, a
// name renamed between versions) and must be tested line by line
// (tailwind_test.go).
//
// Rule: where a clean, stable utility exists it is used
// (`flex flex-col justify-between rounded-[12px] bg-[#fff] w-[320px]`);
// otherwise an arbitrary property `[prop:value]` with the value's spaces
// written as `_` (and real `_` as `\_`). Never classes that depend on the
// theme's spacing scale: the design values are exact px, and `p-4` would mean
// "1rem" only as long as nobody changes --spacing.

// arb fixes a value for use inside `[...]`: spaces become `_`.
func arb(v string) string {
	v = strings.ReplaceAll(v, "_", `\_`)
	return strings.ReplaceAll(v, " ", "_")
}

// arbProp: the arbitrary property `[name:value]`.
func arbProp(p Prop) string { return "[" + p.Name + ":" + arb(p.Value) + "]" }

// valued: `prefix-0` for zero, otherwise `prefix-[v]`.
func valued(prefix, v string) string {
	if v == "0" {
		return prefix + "-0"
	}
	return prefix + "-[" + arb(v) + "]"
}

// keyword: value -> utility tables for closed-vocabulary properties.
var keyword = map[string]map[string]string{
	"position":        {"absolute": "absolute", "relative": "relative", "static": "static", "fixed": "fixed", "sticky": "sticky"},
	"display":         {"flex": "flex", "block": "block", "inline-block": "inline-block", "inline": "inline", "grid": "grid", "none": "hidden"},
	"flex-direction":  {"column": "flex-col", "row": "flex-row"},
	"justify-content": {"flex-start": "justify-start", "center": "justify-center", "flex-end": "justify-end", "space-between": "justify-between"},
	"align-items":     {"flex-start": "items-start", "center": "items-center", "flex-end": "items-end", "stretch": "items-stretch"},
	"overflow":        {"hidden": "overflow-hidden", "visible": "overflow-visible"},
	"object-fit":      {"fill": "object-fill", "cover": "object-cover", "contain": "object-contain"},
	"max-width":       {"none": "max-w-none"},
	"text-align":      {"left": "text-left", "center": "text-center", "right": "text-right"},
	"white-space":     {"pre-wrap": "whitespace-pre-wrap", "pre": "whitespace-pre", "nowrap": "whitespace-nowrap"},
	"overflow-wrap":   {"break-word": "break-words"},
	"cursor":          {"pointer": "cursor-pointer"},
	"flex-shrink":     {"0": "shrink-0", "1": "shrink"},
	"background-clip": {"text": "bg-clip-text"},
	"color":           {"transparent": "text-transparent"},
}

// weights: the weight utility names.
var weights = map[string]string{
	"100": "font-thin", "200": "font-extralight", "300": "font-light", "400": "font-normal",
	"500": "font-medium", "600": "font-semibold", "700": "font-bold", "800": "font-extrabold", "900": "font-black",
}

// prefixed: properties whose value goes in `prefix-[value]` (or `prefix-0`).
var prefixed = map[string]string{
	"left": "left", "top": "top", "right": "right", "bottom": "bottom",
	"gap": "gap", "font-size": "text", "line-height": "leading",
}

// tailwindFor translates ONE property; it returns several classes only for the
// shorthands that Tailwind decomposes (padding).
func tailwindFor(p Prop) []string {
	if m, ok := keyword[p.Name]; ok {
		if c, ok := m[p.Value]; ok {
			return []string{c}
		}
	}
	switch p.Name {
	case "-webkit-background-clip":
		// bg-clip-text already emits the -webkit- prefix where needed.
		return nil
	case "width", "height":
		pre := "w"
		if p.Name == "height" {
			pre = "h"
		}
		switch p.Value {
		case "fit-content":
			return []string{pre + "-fit"}
		case "100%":
			return []string{pre + "-full"}
		}
		return []string{valued(pre, p.Value)}
	case "padding":
		return paddingClasses(p.Value)
	case "font-weight":
		if c, ok := weights[p.Value]; ok {
			return []string{c}
		}
		if _, err := strconv.Atoi(p.Value); err == nil {
			return []string{"font-[" + p.Value + "]"}
		}
	case "border-radius":
		return []string{"rounded-[" + arb(p.Value) + "]"}
	case "background-color":
		return []string{"bg-[" + arb(p.Value) + "]"}
	case "background-image":
		if strings.Contains(p.Value, "-gradient(") {
			return []string{"bg-[" + arb(p.Value) + "]"}
		}
	case "box-shadow":
		return []string{"shadow-[" + arb(p.Value) + "]"}
	case "color":
		return []string{"text-[" + arb(p.Value) + "]"}
	case "transform":
		if v, ok := unwrap(p.Value, "rotate("); ok && !strings.ContainsAny(v, "() ") {
			return []string{"rotate-[" + v + "]"}
		}
	case "filter":
		if v, ok := unwrap(p.Value, "blur("); ok && !strings.ContainsAny(v, "() ") {
			return []string{"blur-[" + v + "]"}
		}
	case "opacity":
		if f, err := strconv.ParseFloat(p.Value, 64); err == nil && f > 0 && f < 1 {
			if pc := f * 100; pc == float64(int(pc)) {
				return []string{"opacity-" + strconv.Itoa(int(pc))}
			}
		}
		return []string{"opacity-[" + arb(p.Value) + "]"}
	}
	if pre, ok := prefixed[p.Name]; ok {
		return []string{valued(pre, p.Value)}
	}
	return []string{arbProp(p)}
}

// unwrap: "rotate(30deg)" with prefix "rotate(" -> "30deg".
func unwrap(v, prefix string) (string, bool) {
	if strings.HasPrefix(v, prefix) && strings.HasSuffix(v, ")") {
		return v[len(prefix) : len(v)-1], true
	}
	return "", false
}

// paddingClasses decomposes the 1-, 2- or 4-value shorthand into the p/py+px/
// pt+pr+pb+pl utilities.
func paddingClasses(v string) []string {
	f := strings.Fields(v)
	switch len(f) {
	case 1:
		return []string{valued("p", f[0])}
	case 2:
		return []string{valued("py", f[0]), valued("px", f[1])}
	case 4:
		return []string{valued("pt", f[0]), valued("pr", f[1]), valued("pb", f[2]), valued("pl", f[3])}
	}
	return []string{arbProp(Prop{"padding", v})}
}

// tailwindClasses: the classes of an element, in IR property order.
func tailwindClasses(props []Prop) []string {
	var out []string
	for _, p := range props {
		out = append(out, tailwindFor(p)...)
	}
	return out
}

// className is the value of the `className` attribute (without quotes).
func className(props []Prop) string { return strings.Join(tailwindClasses(props), " ") }
