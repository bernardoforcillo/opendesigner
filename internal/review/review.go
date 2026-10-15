// Package review checks a document against a few design rules that can be decided
// mechanically: text contrast (WCAG 2.x), touch target size, and use of design tokens.
// It is pure -- a document in, a deterministic list of issues out -- so an editor panel, a
// CI gate and an AI agent (through the review_design MCP tool) all see the same findings.
package review

import (
	"fmt"
	"math"
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

// Rules.
const (
	RuleContrast    = "contrast"     // text that is hard to read against its background
	RuleTouchTarget = "touch-target" // an interactive element smaller than the minimum
	RuleToken       = "token"        // a literal color that a design token already has
)

// Severities.
const (
	Error = "error" // fails an accessibility minimum
	Warn  = "warn"  // worth fixing
)

const (
	// WCAG 2.x AA: 4.5:1 for normal text, 3:1 for large text (>= 24px, or >= 18.66px and bold).
	MinContrast      = 4.5
	MinContrastLarge = 3.0
	// MinTouchTarget is the side, in px, below which a tap target is flagged (Apple HIG 44pt;
	// WCAG 2.5.5 AAA is 44 CSS px, 2.5.8 AA is 24).
	MinTouchTarget = 44.0
	// tokenEpsilon is how far a channel may be from a variable's (0..1) to count as "the same color".
	tokenEpsilon = 0.5 / 255
)

// Issue is one finding.
type Issue struct {
	Rule     string `json:"rule"`
	Severity string `json:"severity"`
	NodeID   string `json:"nodeId"`
	NodeName string `json:"nodeName"`
	Message  string `json:"message"`
}

type color struct{ r, g, b, a float64 }

// Review returns the issues of the document, sorted by severity (errors first), then by
// rule, node name and id, so the same document always gives the same bytes.
func Review(doc *opendesignerv1.Document) []Issue {
	r := &reviewer{doc: doc, children: map[string][]*opendesignerv1.Node{}}
	for _, n := range doc.GetNodes() {
		r.children[n.GetParentId()] = append(r.children[n.GetParentId()], n)
	}
	r.palette = colorVariables(doc)
	pages := map[string]bool{}
	for _, p := range doc.GetPages() {
		pages[p.GetId()] = true
	}
	hotspots := map[string]bool{}
	for _, t := range doc.GetTransitions() {
		if t.GetElementId() != "" {
			hotspots[t.GetElementId()] = true
		}
	}
	r.hotspots = hotspots
	for pid := range pages {
		r.walk(pid, nil, 0)
	}
	sort.SliceStable(r.issues, func(i, j int) bool {
		a, b := r.issues[i], r.issues[j]
		if a.Severity != b.Severity {
			return a.Severity == Error
		}
		if a.Rule != b.Rule {
			return a.Rule < b.Rule
		}
		if a.NodeName != b.NodeName {
			return a.NodeName < b.NodeName
		}
		return a.NodeID < b.NodeID
	})
	return r.issues
}

type reviewer struct {
	doc      *opendesignerv1.Document
	children map[string][]*opendesignerv1.Node
	palette  []namedColor
	hotspots map[string]bool
	issues   []Issue
}

type namedColor struct {
	name string
	c    color
}

// colorVariables lists every color value of every color variable (all modes).
func colorVariables(doc *opendesignerv1.Document) []namedColor {
	ids := make([]string, 0, len(doc.GetVariables()))
	for id := range doc.GetVariables() {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var out []namedColor
	for _, id := range ids {
		v := doc.GetVariables()[id]
		if v.GetType() != opendesignerv1.VariableType_VARIABLE_TYPE_COLOR {
			continue
		}
		modes := make([]string, 0, len(v.GetValues()))
		for m := range v.GetValues() {
			modes = append(modes, m)
		}
		sort.Strings(modes)
		for _, m := range modes {
			if c := v.GetValues()[m].GetColor(); c != nil && c.GetA() > 0 {
				out = append(out, namedColor{v.GetName(), color{float64(c.GetR()), float64(c.GetG()), float64(c.GetB()), float64(c.GetA())}})
			}
		}
	}
	return out
}

// walk visits the subtree under `parentID`. `backdrop` is the stack of fills painted behind
// the node, nearest last.
func (r *reviewer) walk(parentID string, backdrop []color, depth int) {
	if depth > 200 {
		return
	}
	kids := r.children[parentID]
	sort.SliceStable(kids, func(i, j int) bool { return kids[i].GetOrderKey() < kids[j].GetOrderKey() })
	for _, raw := range kids {
		if !raw.GetVisible() {
			continue
		}
		n := core.ResolveNode(r.doc, raw)
		r.check(n, raw, backdrop)
		next := backdrop
		if c, ok := solidFill(n); ok && n.GetText() == nil {
			next = append(append([]color(nil), backdrop...), c)
		}
		r.walk(raw.GetId(), next, depth+1)
	}
}

// solidFill is the first fill of the node when it is a visible solid color.
func solidFill(n *opendesignerv1.Node) (color, bool) {
	for _, f := range n.GetFills() {
		if s := f.GetSolid(); s != nil && s.GetColor().GetA() > 0 {
			c := s.GetColor()
			return color{float64(c.GetR()), float64(c.GetG()), float64(c.GetB()), float64(c.GetA())}, true
		}
		return color{}, false // a gradient or an image on top: do not guess
	}
	return color{}, false
}

func (r *reviewer) check(n, raw *opendesignerv1.Node, backdrop []color) {
	r.checkTokens(n, raw)
	if n.GetText() != nil {
		r.checkContrast(n, backdrop)
	}
	if r.hotspots[raw.GetId()] {
		r.checkTouch(n)
	}
}

func (r *reviewer) add(rule, sev string, n *opendesignerv1.Node, format string, a ...any) {
	r.issues = append(r.issues, Issue{Rule: rule, Severity: sev, NodeID: n.GetId(), NodeName: n.GetName(), Message: fmt.Sprintf(format, a...)})
}

// --- contrast -----------------------------------------------------------------------------

func (r *reviewer) checkContrast(n *opendesignerv1.Node, backdrop []color) {
	fg, ok := solidFill(n)
	if !ok || isBlank(n.GetText().GetContent()) {
		return
	}
	// The background: the stack of fills behind, composited over white (the canvas).
	bg := color{1, 1, 1, 1}
	for _, c := range backdrop {
		bg = over(c, bg)
	}
	text := over(fg, bg)
	ratio := contrast(text, bg)
	size := n.GetText().GetStyle().GetFontSize()
	if size == 0 {
		size = 16
	}
	bold := n.GetText().GetStyle().GetFontWeight() == "bold" || weightAtLeast(n.GetText().GetStyle().GetFontWeight(), 700)
	need, label := MinContrast, "text"
	if size >= 24 || (size >= 18.66 && bold) {
		need, label = MinContrastLarge, "large text"
	}
	if ratio+1e-9 < need {
		r.add(RuleContrast, Error, n, "%s contrast is %.2f:1, below the %.1f:1 minimum (%s on %s)", label, ratio, need, hex(text), hex(bg))
	}
}

func weightAtLeast(w string, min int) bool {
	n := 0
	for _, ch := range w {
		if ch < '0' || ch > '9' {
			return false
		}
		n = n*10 + int(ch-'0')
	}
	return n >= min
}

func isBlank(s string) bool {
	for _, ch := range s {
		if ch != ' ' && ch != '\n' && ch != '\t' {
			return false
		}
	}
	return true
}

// over composites c on an opaque backdrop.
func over(c, bg color) color {
	return color{
		r: c.r*c.a + bg.r*(1-c.a), g: c.g*c.a + bg.g*(1-c.a), b: c.b*c.a + bg.b*(1-c.a), a: 1,
	}
}

func linear(v float64) float64 {
	if v <= 0.03928 {
		return v / 12.92
	}
	return math.Pow((v+0.055)/1.055, 2.4)
}

func luminance(c color) float64 {
	return 0.2126*linear(c.r) + 0.7152*linear(c.g) + 0.0722*linear(c.b)
}

// contrast is the WCAG contrast ratio between two opaque colors (1..21).
func contrast(a, b color) float64 {
	la, lb := luminance(a), luminance(b)
	if la < lb {
		la, lb = lb, la
	}
	return (la + 0.05) / (lb + 0.05)
}

func hex(c color) string {
	ch := func(v float64) int { return int(math.Round(math.Min(1, math.Max(0, v)) * 255)) }
	return fmt.Sprintf("#%02x%02x%02x", ch(c.r), ch(c.g), ch(c.b))
}

// --- touch targets ------------------------------------------------------------------------

func (r *reviewer) checkTouch(n *opendesignerv1.Node) {
	w, h := n.GetWidth(), n.GetHeight()
	if w < MinTouchTarget || h < MinTouchTarget {
		r.add(RuleTouchTarget, Warn, n, "tap target is %gx%g, below %gx%g", round1(w), round1(h), MinTouchTarget, MinTouchTarget)
	}
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }

// --- tokens -------------------------------------------------------------------------------

// checkTokens flags a literal solid fill or stroke color that equals a color variable's
// value but is not bound to it. `raw` is the node as stored (bindings intact); `n` is resolved.
func (r *reviewer) checkTokens(n, raw *opendesignerv1.Node) {
	if len(r.palette) == 0 {
		return
	}
	check := func(key string, c *opendesignerv1.Color, what string) {
		if _, bound := raw.GetBindings()[key]; bound || c == nil || c.GetA() == 0 {
			return
		}
		lit := color{float64(c.GetR()), float64(c.GetG()), float64(c.GetB()), float64(c.GetA())}
		for _, p := range r.palette {
			if near(lit, p.c) {
				r.add(RuleToken, Warn, n, "%s %s matches the token %q but is not bound to it", what, hex(lit), p.name)
				return
			}
		}
	}
	for i, f := range raw.GetFills() {
		if s := f.GetSolid(); s != nil {
			check(fmt.Sprintf("fills.%d", i), s.GetColor(), "fill")
		}
	}
	for i, s := range raw.GetStrokes() {
		if sp := s.GetPaint().GetSolid(); sp != nil {
			check(fmt.Sprintf("strokes.%d", i), sp.GetColor(), "stroke")
		}
	}
}

func near(a, b color) bool {
	return math.Abs(a.r-b.r) <= tokenEpsilon && math.Abs(a.g-b.g) <= tokenEpsilon &&
		math.Abs(a.b-b.b) <= tokenEpsilon && math.Abs(a.a-b.a) <= tokenEpsilon
}
