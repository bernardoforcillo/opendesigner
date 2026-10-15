package codegen

import (
	"fmt"
	"html"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Target html: ONE SELF-CONTAINED .html file per screen. The CSS lives in a
// <style> in the <head> with one class per element (`.name-3`); navigation
// between screens is made of <a href> (the element that fires a transition
// becomes the link, transitions without an element become a transparent <nav class="nav-hidden">).
// The only external dependencies are the image assets (assets/<hash>.<ext>)
// and the Inter font from Google Fonts.

const htmlBaseCSS = `*,*::before,*::after{box-sizing:border-box}
body{margin:0}
img,svg{display:block}
.nav-hidden{position:absolute;left:0;top:0;z-index:50;display:flex;flex-direction:column;opacity:0}
.nav-hidden a{display:block;width:1px;height:1px;overflow:hidden}`

const interLink = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">`

// generatedHeader: the header of every exported file. It deliberately does NOT
// contain the flow.GeneratedMarker marker: that one lets `flow coverage` NOT
// count the generated tests as implementation, whereas the exported screens
// ARE the implementation and must be counted (their route appears in the
// code).
func generatedHeader(d *opendesignerv1.Document, what string) string {
	return fmt.Sprintf("Exported by opendesigner (opendesigner export): %s of document %q (%s). DO NOT edit by hand:\n"+
		"regenerate with `opendesigner export`. The data-node-id attribute ties every element to its design node.",
		what, oneLine(d.GetName()), d.GetId())
}

func oneLine(s string) string {
	return strings.Join(strings.Fields(strings.ReplaceAll(s, "--", "-")), " ")
}

func renderHTML(d *opendesignerv1.Document, screens []*Screen, opts Options, files map[string][]byte, fontCSS string) {
	hasStart := false
	for _, s := range screens {
		if s.File == "index.html" {
			hasStart = true
		}
		files[s.File] = []byte(htmlPage(d, s, screens, fontCSS))
	}
	if !hasStart {
		files["index.html"] = []byte(htmlIndex(d, screens))
	}
}

type htmlWriter struct {
	sb      strings.Builder
	css     strings.Builder
	counter int
	used    map[string]bool
	self    *Screen
	d       *opendesignerv1.Document
	anim    htmlAnim
}

func htmlPage(d *opendesignerv1.Document, s *Screen, all []*Screen, fontCSS string) string {
	w := &htmlWriter{used: map[string]bool{}, self: s, d: d}
	w.element(s.Root, 1, true)
	w.finishAnim()
	var b strings.Builder
	b.WriteString("<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n")
	b.WriteString("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n")
	fmt.Fprintf(&b, "<title>%s</title>\n", html.EscapeString(d.GetNodes()[s.NodeID].GetName()))
	fmt.Fprintf(&b, "<!-- %s -->\n", generatedHeader(d, "screen \""+oneLine(d.GetNodes()[s.NodeID].GetName())+"\""))
	b.WriteString(interLink + "\n<style>\n" + htmlBaseCSS + "\n" + fontCSS + w.css.String() + "</style>\n</head>\n<body>\n")
	b.WriteString(w.sb.String())
	b.WriteString("</body>\n</html>\n")
	return b.String()
}

func htmlIndex(d *opendesignerv1.Document, screens []*Screen) string {
	var b strings.Builder
	b.WriteString("<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n")
	b.WriteString("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n")
	fmt.Fprintf(&b, "<title>%s</title>\n", html.EscapeString(d.GetName()))
	fmt.Fprintf(&b, "<!-- %s -->\n", generatedHeader(d, "screen index"))
	b.WriteString("<style>body{font-family:Inter,sans-serif;margin:2rem}li{margin:.25rem 0}</style>\n</head>\n<body>\n")
	fmt.Fprintf(&b, "<h1>%s</h1>\n<ul>\n", html.EscapeString(d.GetName()))
	for _, s := range screens {
		fmt.Fprintf(&b, "  <li><a href=\"%s\">%s</a></li>\n", html.EscapeString(s.File), html.EscapeString(d.GetNodes()[s.NodeID].GetName()))
	}
	b.WriteString("</ul>\n</body>\n</html>\n")
	return b.String()
}

var voidTags = map[string]bool{"img": true, "br": true, "input": true, "meta": true, "link": true}

func (w *htmlWriter) newClass(e *Element) string {
	base := e.NodeName
	if base == "" {
		base = e.Tag
	}
	w.counter++
	return fmt.Sprintf("%s-%d", classSlug(base), w.counter)
}

func (w *htmlWriter) writeCSS(class string, props []Prop) {
	fmt.Fprintf(&w.css, ".%s {\n", class)
	for _, p := range props {
		fmt.Fprintf(&w.css, "  %s: %s;\n", p.Name, p.Value)
	}
	w.css.WriteString("}\n")
}

func (w *htmlWriter) element(e *Element, depth int, root bool) {
	ind := strings.Repeat("  ", depth)
	tag, style, attrs := e.Tag, append([]Prop(nil), e.Style...), append([]Attr(nil), e.Attrs...)

	// Transition fired by this element: it becomes the link to the destination
	// screen. A tag that cannot be <a> (img, svg) is wrapped.
	wrapHref := ""
	var trig *Trigger
	if len(e.Triggers) > 0 && e.Triggers[0].Dest != nil {
		trig = &e.Triggers[0]
	}
	if trig != nil {
		href := trig.Dest.File
		switch tag {
		case "img", "svg":
			wrapHref = href
		default:
			tag = "a"
			attrs = append(attrs, Attr{"href", href})
			if !hasProp(style, "display") {
				style = append(style, Prop{"display", "block"})
			}
			style = append(style, Prop{"text-decoration", "none"})
		}
		if trig.Label != "" {
			attrs = append(attrs, Attr{"aria-label", trig.Label})
		}
	}
	for _, t := range e.Triggers {
		w.sb.WriteString(ind + "<!-- " + flowComment(t) + " -->\n")
	}
	if wrapHref != "" {
		fmt.Fprintf(&w.sb, "%s<a href=\"%s\" style=\"display:contents\"%s>\n", ind, html.EscapeString(wrapHref), ariaLabel(trig))
		ind += "  "
	}

	var open strings.Builder
	open.WriteString("<" + tag)
	if len(style) > 0 || e.Anim != nil {
		class := w.newClass(e)
		if e.Anim != nil {
			style, attrs = w.animate(e, class, style, attrs)
		}
		w.writeCSS(class, style)
		fmt.Fprintf(&open, " class=\"%s\"", class)
	}
	for _, a := range attrs {
		fmt.Fprintf(&open, " %s=\"%s\"", a.Name, html.EscapeString(a.Value))
	}
	if voidTags[tag] {
		w.sb.WriteString(ind + open.String() + ">\n")
	} else if e.HasText && len(e.Children) == 0 && !root {
		// The text goes ON ONE LINE: with white-space: pre-wrap every indent
		// would become visible text.
		w.sb.WriteString(ind + open.String() + ">" + html.EscapeString(e.Text) + "</" + tag + ">\n")
	} else {
		w.sb.WriteString(ind + open.String() + ">")
		if e.HasText {
			w.sb.WriteString(html.EscapeString(e.Text))
		}
		hasKids := len(e.Children) > 0 || (root && (len(e.NavTriggers) > 0 || len(e.KeyTriggers) > 0))
		if hasKids {
			w.sb.WriteString("\n")
			for _, c := range e.Children {
				w.element(c, depth+1, false)
			}
			if root {
				w.nav(e, depth+1)
			}
			w.sb.WriteString(ind)
		}
		w.sb.WriteString("</" + tag + ">\n")
	}
	if wrapHref != "" {
		w.sb.WriteString(strings.TrimSuffix(ind, "  ") + "</a>\n")
	}
}

func ariaLabel(t *Trigger) string {
	if t == nil || t.Label == "" {
		return ""
	}
	return fmt.Sprintf(" aria-label=\"%s\"", html.EscapeString(t.Label))
}

func hasProp(ps []Prop, name string) bool {
	for _, p := range ps {
		if p.Name == name {
			return true
		}
	}
	return false
}

// flowComments: the comment lines of a transition, as in the generated
// tests: `flow: <id>`, then `guard:` and `effect:` if present. Free text from
// the document: it goes on ONE line and cannot close a comment (`*/`, `-->`).
func flowComments(t Trigger) []string {
	safe := func(s string) string { return strings.ReplaceAll(oneLine(s), "*/", "* /") }
	lines := []string{"flow: " + t.TransitionID}
	if t.Guard != "" {
		lines = append(lines, "guard: "+safe(t.Guard))
	}
	if t.Effect != "" {
		lines = append(lines, "effect: "+safe(t.Effect))
	}
	return lines
}

// flowComment: the same lines on a single line.
func flowComment(t Trigger) string { return strings.Join(flowComments(t), " | ") }

// nav: the links of transitions without an element, visually hidden
// but present in the DOM (and for assistive technologies).
func (w *htmlWriter) nav(root *Element, depth int) {
	var links []Trigger
	for _, t := range root.NavTriggers {
		if t.Kind != "auto" && t.Dest != nil {
			links = append(links, t)
		}
	}
	for _, t := range root.NavTriggers {
		if t.Kind == "auto" || t.Dest == nil {
			w.sb.WriteString(strings.Repeat("  ", depth) + "<!-- " + flowComment(t) + " (no link generated) -->\n")
		}
	}
	for _, t := range root.KeyTriggers {
		w.sb.WriteString(strings.Repeat("  ", depth) + "<!-- " + flowComment(t) + " (key " + oneLine(t.Label) + ": not wired in the html target) -->\n")
	}
	if len(links) == 0 {
		return
	}
	ind := strings.Repeat("  ", depth)
	w.sb.WriteString(ind + "<nav class=\"nav-hidden\" aria-label=\"Flow navigation\">\n")
	for _, t := range links {
		w.sb.WriteString(ind + "  <!-- " + flowComment(t) + " -->\n")
		label := t.Label
		if label == "" {
			label = "Go to " + w.d.GetNodes()[t.Dest.NodeID].GetName()
		}
		fmt.Fprintf(&w.sb, "%s  <a href=\"%s\">%s</a>\n", ind, html.EscapeString(t.Dest.File), html.EscapeString(label))
	}
	w.sb.WriteString(ind + "</nav>\n")
}
