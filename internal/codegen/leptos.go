package codegen

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/flow"
)

// Target leptos: a Leptos (Rust) client-side app built with Trunk. Each screen is a `#[component]` in
// `src/screens/<name>.rs` whose `view!` holds the screen's markup, a component set (or a component
// with properties) is a `#[component]` with props in `src/components/<name>.rs`, `src/app.rs`
// mounts the screens as `leptos_router` routes, and flow transitions call `use_navigate()`.
//
// Like html and react it is written from the IR, and it uses the IR's CSS properties as they are:
// every element carries its declarations in an inline `style="..."` attribute (exactly what the html
// target writes in a <style> block), so fills, strokes, shadows, filters, gradients and text follow
// the canvas the same way and nothing is parsed back (unlike swiftui / compose). The wiring is the
// react target's, so the Playwright tests generated from the flows drive the app unchanged.

const (
	verLeptos       = "0.8"
	verLeptosRouter = "0.8"
)

// leptosReservedTypes: names a screen or component must not take, since they are in scope in the
// generated files (the leptos prelude, the router, std).
var leptosReservedTypes = setOf("App", "A", "Show", "For", "Suspense", "Transition", "Await", "Router", "Routes", "Route",
	"ParentRoute", "Outlet", "Form", "Redirect", "Title", "Meta", "Link", "Style", "Script", "Stylesheet", "Body", "Html", "Provider",
	"Children", "ChildrenFn", "ViewFn", "IntoView", "AnyView", "Signal", "Effect", "Memo", "Resource", "Action", "Callback", "Fragment",
	"Option", "Some", "None", "Vec", "String", "Result", "Ok", "Err", "Box", "Default", "Clone", "Copy", "Send", "Sync", "Sized", "Drop",
	"Fn", "FnMut", "FnOnce", "Iterator", "From", "Into", "Self", "NavigateOptions", "Screens", "Components")

var rustKeywords = setOf("as", "break", "const", "continue", "crate", "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in",
	"let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true",
	"type", "unsafe", "use", "where", "while", "async", "await", "dyn", "abstract", "become", "box", "do", "final", "macro", "override",
	"priv", "typeof", "unsized", "virtual", "yield", "try", "gen", "navigate", "children", "ev")

// snake: "buttonSize" -> "button_size", "LoginScreen" -> "login_screen".
func snake(s string) string {
	rs := []rune(s)
	var b strings.Builder
	for i, r := range rs {
		if unicode.IsUpper(r) {
			prevLower := i > 0 && (unicode.IsLower(rs[i-1]) || unicode.IsDigit(rs[i-1]))
			acronymEnd := i > 0 && unicode.IsUpper(rs[i-1]) && i+1 < len(rs) && unicode.IsLower(rs[i+1])
			if prevLower || acronymEnd {
				b.WriteByte('_')
			}
			b.WriteRune(unicode.ToLower(r))
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// rustIdent: a snake_case Rust identifier for a prop; a keyword gets a `_prop` suffix.
func rustIdent(camel string) string {
	s := snake(camel)
	if rustKeywords[s] {
		s += "_prop"
	}
	return s
}

// rustModule: the module (file) name of a screen or component; a keyword gets a `_mod` suffix.
func rustModule(name string) string {
	s := snake(name)
	if rustKeywords[s] {
		s += "_mod"
	}
	return s
}

// rustFloat: a float literal (`1.0`, `0.5`): an integer literal would not type-check as f64.
func rustFloat(v float64) string {
	s := lit(v)
	if !strings.ContainsAny(s, ".e") {
		s += ".0"
	}
	return s
}

var leptosStaticSeg = regexp.MustCompile(`^[A-Za-z0-9._~%-]+$`)
var leptosParamSeg = regexp.MustCompile(`^[:*][A-Za-z_][A-Za-z0-9_]*$`)

// leptosRoute turns a screen's route into one the router's path!() accepts: `[slug]` becomes
// `:slug`, `:id` / `*rest` stay, and a static segment with other characters has them replaced by `-`.
// The second result tells whether the route had to change.
func leptosRoute(route string) (string, bool) {
	var segs []string
	for _, seg := range strings.Split(route, "/") {
		if seg == "" {
			continue
		}
		switch {
		case strings.HasPrefix(seg, "[") && strings.HasSuffix(seg, "]") && len(seg) > 2:
			seg = ":" + regexp.MustCompile(`[^A-Za-z0-9_]`).ReplaceAllString(seg[1:len(seg)-1], "_")
		case leptosParamSeg.MatchString(seg) || leptosStaticSeg.MatchString(seg):
		default:
			seg = strings.Trim(regexp.MustCompile(`[^A-Za-z0-9._~%-]+`).ReplaceAllString(seg, "-"), "-")
			if seg == "" {
				seg = "x"
			}
		}
		segs = append(segs, seg)
	}
	out := "/" + strings.Join(segs, "/")
	return out, out != route && !(route == "" && out == "/")
}

// rsWriter renders Elements as the inside of a Leptos `view! { ... }`.
type rsWriter struct {
	sb  strings.Builder
	reg *compRegistry
	// ident: inside a component, the Rust identifier of a component property.
	ident func(name string) string
	// navigate: a `navigate(...)` call was written (the component needs `use_navigate()`).
	navigate bool
	// anim: an element carries animation clips (not exported).
	anim bool
}

func (w *rsWriter) line(depth int, s string) {
	w.sb.WriteString(strings.Repeat("    ", depth) + s + "\n")
}

func rsStr(s string) string { return quote(s, false) }

func styleText(props []Prop) string {
	parts := make([]string, len(props))
	for i, p := range props {
		parts[i] = p.Name + ": " + p.Value
	}
	return strings.Join(parts, "; ")
}

// navExpr: the statement that follows a transition.
func (w *rsWriter) navExpr(t Trigger) string {
	if t.Kind == "back" {
		return "let _ = window().history().and_then(|h| h.back());"
	}
	w.navigate = true
	r, _ := leptosRoute(t.Dest.Route)
	return "navigate(" + rsStr(r) + ", NavigateOptions::default());"
}

// numberUnits: the CSS unit a NUMBER property needs when it becomes an inline style (React adds px itself).
var numberUnits = map[string]string{"borderRadius": "px", "fontSize": "px"}

var cssNames = map[string]string{"borderRadius": "border-radius", "fontSize": "font-size", "opacity": "opacity"}

// element writes one element of a view!. Flow wiring (the react target's, so the generated tests find
// the same things): the trigger element gets role="button", tabindex, aria-label, on:click and
// on:keydown (Enter) and a pointer cursor; transitions without an element are visually hidden
// buttons in a transparent <nav> at the bottom of the screen's root.
func (w *rsWriter) element(e *Element, depth int, root bool) {
	// A layer a component property shows or hides.
	if e.ShowIf != "" && w.ident != nil {
		inner := *e
		inner.ShowIf = ""
		w.line(depth, "{"+w.ident(e.ShowIf)+".then(|| view! {")
		w.element(&inner, depth+1, root)
		w.line(depth, "})}")
		return
	}
	if e.Anim != nil {
		w.anim = true
	}
	type kv struct{ k, v string }
	var attrs []kv
	var comments []string
	style := e.Style

	var trig *Trigger
	comments = append(comments, e.Notes...)
	for i := range e.Triggers {
		t := e.Triggers[i]
		comments = append(comments, flowComments(t)...)
		if trig == nil && (t.Dest != nil || t.Kind == "back") {
			trig = &e.Triggers[i]
		}
	}
	if trig != nil {
		style = append(append([]Prop(nil), style...), Prop{"cursor", "pointer"})
	}
	for _, a := range e.Attrs {
		attrs = append(attrs, kv{a.Name, rsStr(a.Value)})
	}
	switch {
	case len(e.Dyn) > 0 && w.ident != nil:
		// Number attributes driven by a component prop: appended to the style, which then beats the static part.
		static := strings.NewReplacer("{", "{{", "}", "}}").Replace(styleText(style))
		var fmtParts, args []string
		for _, dy := range e.Dyn {
			fmtParts = append(fmtParts, cssNames[dy.Style]+": {}"+numberUnits[dy.Style])
			args = append(args, w.ident(dy.Prop))
		}
		sep := ""
		if static != "" {
			sep = "; "
		}
		attrs = append(attrs, kv{"style", fmt.Sprintf("format!(%s, %s)", rsStr(static+sep+strings.Join(fmtParts, "; ")), strings.Join(args, ", "))})
	case len(style) > 0:
		attrs = append(attrs, kv{"style", rsStr(styleText(style))})
	}
	if trig != nil {
		attrs = append(attrs, kv{"role", `"button"`}, kv{"tabindex", `"0"`})
		if trig.Label != "" {
			attrs = append(attrs, kv{"aria-label", rsStr(trig.Label)})
		}
		act := w.navExpr(*trig)
		pre := ""
		if trig.Kind != "back" {
			pre = "let navigate = navigate.clone(); "
		}
		attrs = append(attrs,
			kv{"on:click", "{" + pre + "move |_| { " + act + " }}"},
			kv{"on:keydown", "{" + pre + "move |ev: web_sys::KeyboardEvent| { if ev.key() == \"Enter\" { " + act + " } }}"})
	}

	tag := e.Tag
	var one strings.Builder
	for _, a := range attrs {
		fmt.Fprintf(&one, " %s=%s", a.k, a.v)
	}
	useChild := e.Use != nil && w.reg != nil && w.reg.known(e.Use)
	kids := len(e.Children) > 0 || e.HasText || (root && hasNav(e)) || useChild
	for _, c := range comments {
		w.line(depth, "// "+c)
	}
	if tag == "img" {
		w.line(depth, "<img"+one.String()+" />")
		return
	}
	if len(one.String())+len(tag)+depth*4 > 110 {
		w.line(depth, "<"+tag)
		for _, a := range attrs {
			w.line(depth+1, a.k+"="+a.v)
		}
		w.line(depth, ">")
	} else {
		w.line(depth, "<"+tag+one.String()+">")
	}
	if kids {
		if e.HasText {
			if e.TextProp != "" && w.ident != nil {
				w.line(depth+1, "{"+w.ident(e.TextProp)+".clone()}")
			} else {
				w.line(depth+1, rsStr(e.Text))
			}
		}
		switch {
		case e.SwapProp != "" && w.ident != nil:
			// A replaceable nested component: the prop's content, or the default one.
			sw := w.ident(e.SwapProp)
			w.line(depth+1, "{match &"+sw+" {")
			w.line(depth+2, "Some(f) => f.run().into_any(),")
			w.line(depth+2, "None => view! {")
			if useChild {
				w.lineBlock(depth+3, w.reg.rsCall(e.Use, w))
			}
			for _, c := range e.Children {
				if !useChild {
					w.element(c, depth+3, false)
				}
			}
			w.line(depth+2, "}.into_any(),")
			w.line(depth+1, "}}")
		case useChild:
			w.lineBlock(depth+1, w.reg.rsCall(e.Use, w))
		default:
			for _, c := range e.Children {
				w.element(c, depth+1, false)
			}
		}
		if root {
			w.nav(e, depth+1)
		}
	}
	w.line(depth, "</"+tag+">")
}

func (w *rsWriter) lineBlock(depth int, lines []string) {
	for _, l := range lines {
		w.line(depth, l)
	}
}

// nav: the buttons of transitions without an element, visually hidden but present in the DOM and in the
// accessibility tree. The same 1px transparent corner as the react target (not sr-only: Playwright
// would find the root intercepting the pointer).
func (w *rsWriter) nav(root *Element, depth int) {
	if !hasNav(root) {
		return
	}
	w.line(depth, `<nav style="position: absolute; left: 0; top: 0; z-index: 50; display: flex; flex-direction: column; opacity: 0" aria-label="Flow navigation">`)
	for _, t := range root.NavTriggers {
		if t.Kind == "auto" || (t.Dest == nil && t.Kind != "back") {
			continue
		}
		label := t.Label
		if label == "" {
			if t.Dest != nil {
				label = "Go to " + w.reg.d.GetNodes()[t.Dest.NodeID].GetName()
			} else {
				label = "Back"
			}
		}
		for _, l := range flowComments(t) {
			w.line(depth+1, "// "+l)
		}
		pre := ""
		if t.Kind != "back" {
			pre = "let navigate = navigate.clone(); "
		}
		w.line(depth+1, `<button type="button" style="display: block; width: 1px; height: 1px; overflow: hidden; padding: 0; border: 0" on:click={`+pre+`move |_| { `+w.navExpr(t)+` }}>`+rsStr(label)+`</button>`)
	}
	w.line(depth, "</nav>")
}

// rsCall is the component call of an instance: <Button size="L" label="Buy" />. Axes at the set's first
// option and properties at their defaults are left out. A swap prop gets a ViewFn (a closure over a view!).
func (r *compRegistry) rsCall(u *ComponentUse, parent *rsWriter) []string {
	cu := r.units[u.UnitKey]
	comp := r.d.GetComponents()[u.ComponentID]
	var args [][]string // each argument as one or more lines
	for i, ax := range cu.set.GetAxes() {
		if v, ok := comp.GetVariant()[ax.GetName()]; ok && len(ax.GetOptions()) > 0 && v != ax.GetOptions()[0] {
			args = append(args, []string{cu.axes[i] + "=" + rsStr(v)})
		}
	}
	for _, pv := range r.values(cu, u) {
		p, v := pv.p, pv.v
		switch p.kind {
		case pkText:
			args = append(args, []string{p.ident + "=" + rsStr(v)})
		case pkNumber:
			if f, err := strconv.ParseFloat(v, 64); err == nil {
				args = append(args, []string{p.ident + "=" + rustFloat(f)})
			}
		case pkSwap:
			if sw := r.rsSwap(v, parent); sw != nil {
				sw[0] = p.ident + "=" + sw[0]
				args = append(args, sw)
			}
		default:
			args = append(args, []string{p.ident + "=" + strconv.FormatBool(v != "false")})
		}
	}
	multi := false
	for _, a := range args {
		multi = multi || len(a) > 1
	}
	if !multi {
		parts := []string{"<" + cu.name}
		for _, a := range args {
			parts = append(parts, a[0])
		}
		return []string{strings.Join(parts, " ") + " />"}
	}
	lines := []string{"<" + cu.name}
	for _, a := range args {
		lines = append(lines, indentLines(a, "    ")...)
	}
	return append(lines, "/>")
}

// rsSwap is the value a swap prop receives for component `compID`: ViewFn::from(|| view! { ... }).
func (r *compRegistry) rsSwap(compID string, parent *rsWriter) []string {
	comp := r.d.GetComponents()[compID]
	if comp == nil {
		return nil
	}
	if key := unitKey(comp, compID); key != "" {
		if _, ok := r.units[key]; ok {
			call := r.rsCall(&ComponentUse{UnitKey: key, ComponentID: compID, Inst: &opendesignerv1.InstanceNode{ComponentId: compID}}, parent)
			if len(call) == 1 {
				return []string{"ViewFn::from(|| view! { " + call[0] + " })"}
			}
			out := []string{"ViewFn::from(|| view! {"}
			out = append(out, indentLines(call, "    ")...)
			return append(out, "})")
		}
	}
	if tree := r.swapTrees[compID]; tree != nil {
		w := &rsWriter{reg: r}
		w.element(tree, 1, false)
		parent.navigate = parent.navigate || w.navigate
		parent.anim = parent.anim || w.anim
		out := []string{"ViewFn::from(|| view! {"}
		out = append(out, strings.Split(strings.TrimRight(w.sb.String(), "\n"), "\n")...)
		return append(out, "})")
	}
	return nil
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

func rsHeader(d *opendesignerv1.Document, what string) string { return tsHeader(d, what) }

// leptosScreen writes `src/screens/<name>.rs`.
func leptosScreen(d *opendesignerv1.Document, s *Screen, reg *compRegistry) (string, bool) {
	w := &rsWriter{reg: reg}
	w.element(s.Root, 2, true)

	// Key triggers: one window listener, removed with the component.
	var keys []Trigger
	for _, t := range s.Root.KeyTriggers {
		if t.Dest != nil {
			keys = append(keys, t)
		}
	}
	needNav := w.navigate || len(keys) > 0

	var b strings.Builder
	b.WriteString(rsHeader(d, "screen \""+oneLine(d.GetNodes()[s.NodeID].GetName())+"\" (route "+s.Route+")"))
	b.WriteString("\nuse leptos::prelude::*;\n")
	if needNav {
		b.WriteString("use leptos_router::hooks::use_navigate;\nuse leptos_router::NavigateOptions;\n")
	}
	if used := reg.usedBy(s.Root); len(used) == 1 {
		b.WriteString("use crate::components::" + used[0] + ";\n")
	} else if len(used) > 1 {
		b.WriteString("use crate::components::{" + strings.Join(used, ", ") + "};\n")
	}
	b.WriteString("\n#[component]\npub fn " + s.Name + "() -> impl IntoView {\n")
	if needNav {
		b.WriteString("    let navigate = use_navigate();\n")
	}
	for _, t := range s.Root.KeyTriggers {
		if t.Dest == nil {
			fmt.Fprintf(&b, "    // %s (key %s: destination not exported)\n", flowComment(t), oneLine(t.Label))
		}
	}
	for _, t := range s.Root.NavTriggers {
		if t.Kind == "auto" {
			fmt.Fprintf(&b, "    // %s (auto trigger: to be wired, e.g. with set_timeout)\n", flowComment(t))
		}
	}
	if len(keys) > 0 {
		b.WriteString("    {\n        let navigate = navigate.clone();\n        let handle = window_event_listener(leptos::ev::keydown, move |e| {\n")
		for _, t := range keys {
			for _, l := range flowComments(t) {
				fmt.Fprintf(&b, "            // %s\n", l)
			}
			r, _ := leptosRoute(t.Dest.Route)
			fmt.Fprintf(&b, "            if e.key() == %s {\n                navigate(%s, NavigateOptions::default());\n            }\n", rsStr(t.Label), rsStr(r))
		}
		b.WriteString("        });\n        on_cleanup(move || handle.remove());\n    }\n")
	}
	b.WriteString("    view! {\n")
	b.WriteString(w.sb.String())
	b.WriteString("    }\n}\n")
	return b.String(), w.anim
}

// leptosComponent writes `src/components/<name>.rs`: props from the set's axes and the component's properties.
func (r *compRegistry) leptosComponent(u *compUnit) (string, bool) {
	var b strings.Builder
	what := "component \"" + oneLine(u.title()) + "\""
	if u.set != nil {
		what = "component \"" + oneLine(u.set.GetName()) + "\" (variant set)"
	}
	b.WriteString(rsHeader(r.d, what))
	b.WriteString("\nuse leptos::prelude::*;\n")
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
	if len(names) == 1 {
		b.WriteString("use super::" + names[0] + ";\n")
	} else if len(names) > 1 {
		b.WriteString("use super::{" + strings.Join(names, ", ") + "};\n")
	}
	b.WriteString("\n#[component]\npub fn " + u.name + "(\n")
	for i, ax := range u.set.GetAxes() {
		fmt.Fprintf(&b, "    /// %s: %s\n    #[prop(into, default = %s.to_string())] %s: String,\n",
			oneLine(ax.GetName()), oneLine(strings.Join(ax.GetOptions(), " | ")), rsStr(ax.GetOptions()[0]), u.axes[i])
	}
	for _, p := range u.cprops {
		switch p.kind {
		case pkText:
			note := "text"
			if len(p.options) > 0 {
				note += ": " + oneLine(strings.Join(p.options, " | "))
			}
			fmt.Fprintf(&b, "    /// %s (%s)\n    #[prop(into, default = %s.to_string())] %s: String,\n", oneLine(p.name), note, rsStr(p.def), p.ident)
		case pkNumber:
			def := "0.0"
			if f, err := strconv.ParseFloat(p.def, 64); err == nil {
				def = rustFloat(f)
			}
			fmt.Fprintf(&b, "    /// %s (%s)\n    #[prop(default = %s)] %s: f64,\n", oneLine(p.name), strings.ReplaceAll(p.attr, "_", " "), def, p.ident)
		case pkSwap:
			fmt.Fprintf(&b, "    /// %s (replaces a nested component; None keeps the default)\n    #[prop(optional)] %s: Option<ViewFn>,\n", oneLine(p.name), p.ident)
		default:
			fmt.Fprintf(&b, "    /// %s (show/hide)\n    #[prop(default = %v)] %s: bool,\n", oneLine(p.name), p.def != "false", p.ident)
		}
	}
	b.WriteString(") -> impl IntoView {\n")

	anim := false
	// expr writes a master as an expression: `view! { ... }`, or `prop.then(|| view! { ... })` when the
	// master itself is toggled by a boolean property.
	expr := func(v *compVariant, depth int) []string {
		w := &rsWriter{reg: r, ident: u.identOf}
		root := v.root
		var open, close string
		if root.ShowIf != "" {
			cp := *root
			cp.ShowIf = ""
			root = &cp
			open, close = u.identOf(v.root.ShowIf)+".then(|| view! {", "})"
		} else {
			open, close = "view! {", "}"
		}
		w.element(root, 1, false)
		anim = anim || w.anim
		lines := []string{open}
		lines = append(lines, strings.Split(strings.TrimRight(w.sb.String(), "\n"), "\n")...)
		return append(lines, close)
	}
	if u.set == nil {
		for _, l := range expr(u.variants[0], 0) {
			b.WriteString("    " + l + "\n")
		}
		b.WriteString("}\n")
		return b.String(), anim
	}
	fmts := strings.TrimSuffix(strings.Repeat("{}|", len(u.axes)), "|")
	fmt.Fprintf(&b, "    match format!(%s, %s).as_str() {\n", rsStr(fmts), strings.Join(u.axes, ", "))
	for _, v := range u.variants {
		vals := make([]string, len(u.axes))
		for i, ax := range u.set.GetAxes() {
			vals[i] = v.variant[ax.GetName()]
		}
		fmt.Fprintf(&b, "        %s => {\n            // %s\n", rsStr(strings.Join(vals, "|")), oneLine(v.name))
		lines := expr(v, 0)
		lines[len(lines)-1] += ".into_any()"
		for _, l := range lines {
			b.WriteString("            " + l + "\n")
		}
		b.WriteString("        }\n")
	}
	b.WriteString("        _ => ().into_any(), // this combination has no variant in the design\n    }\n}\n")
	return b.String(), anim
}

// cargoName: a valid, non-reserved crate name from the document's name.
func cargoName(d *opendesignerv1.Document) string {
	n := slug(d.GetName())
	if n[0] >= '0' && n[0] <= '9' || setOf("test", "core", "std", "alloc", "proc_macro", "self", "crate", "super")[n] {
		n = "app-" + n
	}
	return n
}

func renderLeptos(d *opendesignerv1.Document, b *builder, screens []*Screen, opts Options, files map[string][]byte, warnings *[]string, fontCSS string) error {
	put := func(path, content string) { files[path] = []byte(content) }
	home := homeScreen(d, screens, opts)
	hasFlows := len(selectedFlows(d, opts.FlowID)) > 0

	hasAssets := false
	for p := range files {
		if strings.HasPrefix(p, "public/assets/") {
			hasAssets = true
		}
	}
	copyAssets := ""
	if hasAssets {
		copyAssets = "    <link data-trunk rel=\"copy-dir\" href=\"public/assets\" />\n"
	}

	put("Cargo.toml", fmt.Sprintf(`# %s
[package]
name = %q
version = "0.1.0"
edition = "2021"

[dependencies]
console_error_panic_hook = "0.1"
leptos = { version = %q, features = ["csr"] }
leptos_router = %q
web-sys = { version = "0.3", features = ["History", "KeyboardEvent"] }

[profile.release]
opt-level = "s"
lto = true
codegen-units = 1
`, strings.ReplaceAll(generatedHeader(d, "Cargo manifest"), "\n", "\n# "), cargoName(d), verLeptos, verLeptosRouter))

	put("index.html", fmt.Sprintf(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>%s</title>
    <!-- %s -->
    <link data-trunk rel="rust" data-wasm-opt="s" />
%s    %s
    <style>
%s
%s</style>
  </head>
  <body></body>
</html>
`, escapeHTML(d.GetName()), generatedHeader(d, "app skeleton"), copyAssets, strings.ReplaceAll(interLink, "\n", "\n    "), htmlBaseCSS, fontCSS))

	put(".gitignore", "target\ndist\nnode_modules\ntest-results\nplaywright-report\n")

	reg := newCompRegistry(d, b, screens, leptosNaming)
	anim := false

	// Components.
	modUsed := map[string]bool{}
	if len(reg.order) > 0 {
		var mods strings.Builder
		mods.WriteString(rsHeader(d, "components"))
		for _, key := range reg.order {
			u := reg.units[key]
			mod := dedupe(modUsed, rustModule(u.name), "_")
			code, a := reg.leptosComponent(u)
			anim = anim || a
			put("src/components/"+mod+".rs", code)
			fmt.Fprintf(&mods, "\nmod %s;\npub use %s::%s;\n", mod, mod, u.name)
		}
		put("src/components/mod.rs", mods.String())
	}

	// Screens.
	var smods strings.Builder
	smods.WriteString(rsHeader(d, "screens"))
	screenMods := map[string]bool{}
	for _, s := range screens {
		mod := dedupe(screenMods, rustModule(s.Name), "_")
		code, a := leptosScreen(d, s, reg)
		anim = anim || a || hasAnimation(s.Root)
		put("src/screens/"+mod+".rs", code)
		fmt.Fprintf(&smods, "\nmod %s;\npub use %s::%s;\n", mod, mod, s.Name)
	}
	put("src/screens/mod.rs", smods.String())

	// App: one route per screen; "/" leads to the start screen.
	var app strings.Builder
	app.WriteString(rsHeader(d, "app routes"))
	app.WriteString("\nuse leptos::prelude::*;\nuse leptos_router::components::{Route, Router, Routes};\nuse leptos_router::path;\n\nuse crate::screens::*;\n")
	app.WriteString("\n#[component]\npub fn App() -> impl IntoView {\n    view! {\n        <Router>\n            <Routes fallback=|| \"Page not found\">\n")
	homeRoute, _ := leptosRoute(home.Route)
	if homeRoute != "/" {
		fmt.Fprintf(&app, "                // start screen: also mounted on \"/\"\n                <Route path=path!(\"/\") view=%s />\n", home.Name)
	}
	for _, s := range screens {
		r, changed := leptosRoute(s.Route)
		if changed {
			*warnings = append(*warnings, fmt.Sprintf("leptos: route %q of screen %s is mounted as %q (the router's path! takes plain segments, :params and *wildcards)", s.Route, s.Name, r))
		}
		fmt.Fprintf(&app, "                <Route path=path!(%s) view=%s />\n", rsStr(r), s.Name)
	}
	app.WriteString("            </Routes>\n        </Router>\n    }\n}\n")
	put("src/app.rs", app.String())

	mods := "mod app;\n"
	if len(reg.order) > 0 {
		mods += "mod components;\n"
	}
	mods += "mod screens;\n"
	put("src/main.rs", rsHeader(d, "entry point")+"\n"+mods+"\nuse app::App;\nuse leptos::prelude::*;\n\nfn main() {\n    console_error_panic_hook::set_once();\n    mount_to_body(App);\n}\n")

	// The same Playwright tests as the react target: the wiring writes the same roles, labels and test ids.
	if hasFlows {
		spec, err := flow.PlaywrightTests(d, opts.FlowID, flow.PlaywrightOptions{})
		if err != nil {
			return err
		}
		put("tests/flows.spec.ts", spec)
		put("package.json", fmt.Sprintf("{\n  \"name\": %s,\n  \"private\": true,\n  \"version\": \"0.0.0\",\n  \"scripts\": {\n    \"test\": \"playwright test\"\n  },\n  \"devDependencies\": {\n    \"@playwright/test\": %q\n  }\n}\n", tsString(slug(d.GetName())+"-e2e"), verPlaywright))
		put("playwright.config.ts", tsHeader(d, "Playwright configuration")+`import { defineConfig, devices } from "@playwright/test";

// Trunk serves the app on its own; PW_CHROMIUM_PATH (optional) points to a Chromium that is already
// installed instead of the one downloaded by Playwright.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  reporter: "list",
  use: { baseURL: "http://localhost:5173", trace: "on-first-retry" },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH || undefined },
      },
    },
  ],
  webServer: {
    command: "trunk serve --port 5173",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
});
`)
	}

	put("README.md", leptosReadme(d, screens, opts, hasFlows, home, reg, anim))
	if anim {
		*warnings = append(*warnings, "leptos: animation clips are not exported")
	}
	return nil
}

var leptosNaming = &regNaming{types: leptosReservedTypes, fix: rustIdent}

func leptosReadme(d *opendesignerv1.Document, screens []*Screen, opts Options, hasFlows bool, home *Screen, reg *compRegistry, anim bool) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n", d.GetName())
	fmt.Fprintf(&b, "<!-- %s -->\n\n", generatedHeader(d, "README"))
	b.WriteString("Leptos (Rust, client-side rendered) app generated from the design with `opendesigner export -target leptos`.\n\n")
	b.WriteString("## Getting started\n\n```sh\nrustup target add wasm32-unknown-unknown\ncargo install trunk   # first time only\ntrunk serve           # http://localhost:8080\ntrunk build --release # production build in dist/\n")
	if hasFlows {
		b.WriteString("npm install && npx playwright install chromium   # first time only\nnpm test              # the e2e tests generated from the flows (starts `trunk serve --port 5173`)\n")
	}
	b.WriteString("```\n\n")
	b.WriteString("## How the design becomes code\n\n")
	b.WriteString("- Each **screen** (top-level frame) is a `#[component]` in `src/screens/<name>.rs` whose `view!` holds the markup; `src/app.rs` mounts the routes with `leptos_router` (the frame's `meta[\"code.route\"]`, otherwise the name's slug; `[slug]` becomes `:slug`). The flow's start screen (`" + home.Name + "`) is also mounted on `/`.\n")
	b.WriteString("- Every element carries its CSS in an inline `style` attribute, the same declarations the html target writes: **auto layout** -> flexbox, everything else positioned absolutely with the design's coordinates, `hug` -> `fit-content`. Fills (colour, linear, radial, angular and diamond gradients), strokes (`box-shadow` rings), shadows, blurs, rotation, clipping, text and vectors follow **what the editor's canvas draws**.\n")
	b.WriteString("- **Images** are copied to `public/assets/<hash>.<ext>` (Trunk's `copy-dir`); if missing, the canvas placeholder appears.\n")
	b.WriteString("- Every element carries `data-node-id=\"<node id>\"`: the link between the design and the code.\n")
	if len(reg.order) > 0 {
		b.WriteString("- A **component set** (variants) is ONE `#[component]` in `src/components/<name>.rs`: its props are the set's axes (a `String`, the first option by default) and the **component properties** (boolean = show/hide, text = `String`, number = `f64` written into the element's inline style, instance swap = an `Option<ViewFn>` slot with the default content as fallback). An instance becomes `<Name axis=\"option\" prop=... />`; what it leaves out is the component's default. Instances with overrides, or with animation or flow wiring inside, are expanded inline.\n")
	} else {
		b.WriteString("- Component **instances** are expanded inline.\n")
	}
	b.WriteString("- Screens have a fixed size (no responsiveness).\n\n")
	if hasFlows {
		b.WriteString("## Flows and tests\n\n")
		b.WriteString("For each transition, the element that fires it (`elementId`) is clickable (`on:click` -> `use_navigate()`, `role=\"button\"`, `aria-label` = label, `data-testid` from the `test.id` meta). Transitions without an element are visually hidden buttons in a transparent `<nav>` (1px, top-left). Key triggers are a window `keydown` listener; `back` goes back in the browser history. The `// flow: <id>`, `// guard:` and `// effect:` lines indicate the design's transition (guards are comments: the prototype player is where they run).\n\n")
		b.WriteString("`tests/flows.spec.ts` is produced by `opendesigner flow tests` and walks all the flows' paths with Playwright, exactly as in the react target.\n\n")
	}
	if anim {
		b.WriteString("## Not exported\n\n- animation clips\n\n")
	}
	b.WriteString("## Screens\n\n| Component | Route | Design node |\n|---|---|---|\n")
	for _, s := range screens {
		fmt.Fprintf(&b, "| `%s` | `%s` | `%s` (%s) |\n", s.Name, s.Route, s.NodeID, strings.ReplaceAll(d.GetNodes()[s.NodeID].GetName(), "|", "\\|"))
	}
	b.WriteString("\n## Regenerating\n\n")
	flag := ""
	if opts.FlowID != "" {
		flag = " -flow " + opts.FlowID
	}
	fmt.Fprintf(&b, "```sh\nopendesigner export -doc %s -target leptos%s -out . -force\n```\n\n", d.GetId(), flag)
	b.WriteString("The generated files must not be edited by hand: the next export overwrites them. To evolve the project by hand, export once and work on the code from then on (regeneration does not merge).\n")
	return b.String()
}
