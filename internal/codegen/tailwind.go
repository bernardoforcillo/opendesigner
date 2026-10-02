package codegen

import (
	"strconv"
	"strings"
)

// Mappatura Prop CSS -> classi Tailwind v4. Vive in un file a sé, guidata da
// tabelle, perché è la parte che cambia più spesso (un'utility nuova, un nome
// rinominato fra versioni) e va testata riga per riga (tailwind_test.go).
//
// Regola: dove esiste un'utility pulita e stabile si usa quella
// (`flex flex-col justify-between rounded-[12px] bg-[#fff] w-[320px]`);
// altrimenti una proprietà arbitraria `[prop:value]` con gli spazi del valore
// scritti `_` (e i `_` veri come `\_`). Mai classi che dipendono dalla scala di
// spacing del tema: i valori del design sono px esatti, e `p-4` vorrebbe dire
// "1rem" solo finché nessuno cambia --spacing.

// arb ripara un valore per l'uso dentro `[...]`: gli spazi diventano `_`.
func arb(v string) string {
	v = strings.ReplaceAll(v, "_", `\_`)
	return strings.ReplaceAll(v, " ", "_")
}

// arbProp: la proprietà arbitraria `[name:value]`.
func arbProp(p Prop) string { return "[" + p.Name + ":" + arb(p.Value) + "]" }

// valued: `prefix-0` per lo zero, altrimenti `prefix-[v]`.
func valued(prefix, v string) string {
	if v == "0" {
		return prefix + "-0"
	}
	return prefix + "-[" + arb(v) + "]"
}

// keyword: tabelle valore -> utility per le proprietà a vocabolario chiuso.
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

// weights: i nomi delle utility del peso.
var weights = map[string]string{
	"100": "font-thin", "200": "font-extralight", "300": "font-light", "400": "font-normal",
	"500": "font-medium", "600": "font-semibold", "700": "font-bold", "800": "font-extrabold", "900": "font-black",
}

// prefixed: proprietà il cui valore va in `prefix-[valore]` (o `prefix-0`).
var prefixed = map[string]string{
	"left": "left", "top": "top", "right": "right", "bottom": "bottom",
	"gap": "gap", "font-size": "text", "line-height": "leading",
}

// tailwindFor traduce UNA proprietà; ritorna più classi solo per i shorthand
// che Tailwind scompone (padding).
func tailwindFor(p Prop) []string {
	if m, ok := keyword[p.Name]; ok {
		if c, ok := m[p.Value]; ok {
			return []string{c}
		}
	}
	switch p.Name {
	case "-webkit-background-clip":
		// bg-clip-text emette già il prefisso -webkit- dove serve.
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

// unwrap: "rotate(30deg)" con prefisso "rotate(" -> "30deg".
func unwrap(v, prefix string) (string, bool) {
	if strings.HasPrefix(v, prefix) && strings.HasSuffix(v, ")") {
		return v[len(prefix) : len(v)-1], true
	}
	return "", false
}

// paddingClasses scompone lo shorthand a 1, 2 o 4 valori nelle utility p/py+px/
// pt+pr+pb+pl.
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

// tailwindClasses: le classi di un elemento, nell'ordine delle proprietà IR.
func tailwindClasses(props []Prop) []string {
	var out []string
	for _, p := range props {
		out = append(out, tailwindFor(p)...)
	}
	return out
}

// className è il valore dell'attributo `className` (senza virgolette).
func className(props []Prop) string { return strings.Join(tailwindClasses(props), " ") }
