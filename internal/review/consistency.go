package review

import (
	"fmt"
	"math"
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Consistency and token usage: the other half of a design review, about whether the document says the same
// thing the same way. Pure like Review, and kept apart from it: these are suggestions to tidy up, not findings
// a CI gate should fail on.

// Consistency rules.
const (
	RuleNearColor  = "near-color"  // two literal colors a few steps apart: probably one color typed twice
	RuleNearSize   = "near-size"   // a font size one step from a size used more often
	RuleNearRadius = "near-radius" // a corner radius one or two steps from a radius used more often
	RuleUnstyled   = "unstyled"    // text with no text style in a document that has text styles
)

const nearColorSteps = 4.0 / 255 // per channel

type colorKey struct{ r, g, b, a uint8 }

func keyOf(c *opendesignerv1.Color) colorKey {
	q := func(v float32) uint8 { return uint8(math.Round(math.Min(1, math.Max(0, float64(v))) * 255)) }
	return colorKey{q(c.GetR()), q(c.GetG()), q(c.GetB()), q(c.GetA())}
}

func (k colorKey) hex() string { return fmt.Sprintf("#%02x%02x%02x", k.r, k.g, k.b) }

func closeColors(a, b colorKey) bool {
	d := func(x, y uint8) float64 { return math.Abs(float64(x)-float64(y)) / 255 }
	return a != b && d(a.r, b.r) <= nearColorSteps && d(a.g, b.g) <= nearColorSteps && d(a.b, b.b) <= nearColorSteps && d(a.a, b.a) <= nearColorSteps
}

// visibleNodes lists the stored nodes in a stable order.
func visibleNodes(doc *opendesignerv1.Document) []*opendesignerv1.Node {
	out := make([]*opendesignerv1.Node, 0, len(doc.GetNodes()))
	for _, n := range doc.GetNodes() {
		if n.GetVisible() {
			out = append(out, n)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].GetId() < out[j].GetId() })
	return out
}

// literalColors counts the solid fill and stroke colors that are not bound to a variable or a style, by value.
func literalColors(doc *opendesignerv1.Document) (map[colorKey]int, map[colorKey][]*opendesignerv1.Node) {
	count := map[colorKey]int{}
	users := map[colorKey][]*opendesignerv1.Node{}
	add := func(n *opendesignerv1.Node, c *opendesignerv1.Color) {
		if c == nil || c.GetA() == 0 {
			return
		}
		k := keyOf(c)
		count[k]++
		users[k] = append(users[k], n)
	}
	for _, n := range visibleNodes(doc) {
		if n.GetFillStyleId() == "" {
			for i, f := range n.GetFills() {
				if _, bound := n.GetBindings()[fmt.Sprintf("fills.%d", i)]; !bound && f.GetSolid() != nil {
					add(n, f.GetSolid().GetColor())
				}
			}
		}
		if n.GetStrokeStyleId() == "" {
			for i, s := range n.GetStrokes() {
				if _, bound := n.GetBindings()[fmt.Sprintf("strokes.%d", i)]; !bound && s.GetPaint().GetSolid() != nil {
					add(n, s.GetPaint().GetSolid().GetColor())
				}
			}
		}
	}
	return count, users
}

// ReviewConsistency returns the inconsistencies of the document, sorted like Review.
func ReviewConsistency(doc *opendesignerv1.Document) []Issue {
	var out []Issue
	add := func(rule string, n *opendesignerv1.Node, format string, a ...any) {
		out = append(out, Issue{Rule: rule, Severity: Warn, NodeID: n.GetId(), NodeName: n.GetName(), Message: fmt.Sprintf(format, a...)})
	}

	// Colors: the less used of two close colors is the odd one out.
	count, users := literalColors(doc)
	keys := make([]colorKey, 0, len(count))
	for k := range count {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return count[keys[i]] > count[keys[j]] || (count[keys[i]] == count[keys[j]] && keys[i].hex() < keys[j].hex()) })
	for i, k := range keys {
		for _, main := range keys[:i] {
			if count[main] > count[k] && closeColors(k, main) {
				seen := map[string]bool{}
				for _, n := range users[k] {
					if !seen[n.GetId()] {
						seen[n.GetId()] = true
						add(RuleNearColor, n, "color %s is a few steps from %s, which is used %d times: use the same one", k.hex(), main.hex(), count[main])
					}
				}
				break
			}
		}
	}

	// Font sizes and corner radii.
	sizes := map[float64]int{}
	radii := map[float64]int{}
	nodes := visibleNodes(doc)
	for _, n := range nodes {
		if t := n.GetText(); t != nil && n.GetTextStyleId() == "" {
			sizes[sizeOf(t)]++
		}
		if r := n.GetRect(); r != nil && r.GetCornerRadius() > 0 {
			radii[round1(float64(r.GetCornerRadius()))]++
		}
	}
	for _, n := range nodes {
		if t := n.GetText(); t != nil && n.GetTextStyleId() == "" {
			if main, ok := oddOneOut(sizes, sizeOf(t), 1); ok {
				add(RuleNearSize, n, "font size %g is one step from %g, which is used %d times", sizeOf(t), main, sizes[main])
			}
		}
		if r := n.GetRect(); r != nil && r.GetCornerRadius() > 0 {
			v := round1(float64(r.GetCornerRadius()))
			if main, ok := oddOneOut(radii, v, 2); ok {
				add(RuleNearRadius, n, "corner radius %g is close to %g, which is used %d times", v, main, radii[main])
			}
		}
		if len(doc.GetTextStyles()) > 0 && n.GetText() != nil && n.GetTextStyleId() == "" && !isBlank(n.GetText().GetContent()) {
			add(RuleUnstyled, n, "text has no text style, though the document defines %d", len(doc.GetTextStyles()))
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Rule != b.Rule {
			return a.Rule < b.Rule
		}
		if a.NodeName != b.NodeName {
			return a.NodeName < b.NodeName
		}
		return a.NodeID < b.NodeID
	})
	return out
}

func sizeOf(t *opendesignerv1.TextNode) float64 {
	if s := t.GetStyle().GetFontSize(); s > 0 {
		return round1(float64(s))
	}
	return 16
}

// oddOneOut: is `v` within `reach` of a value used more often? Returns the most used such value.
func oddOneOut(uses map[float64]int, v, reach float64) (float64, bool) {
	best, found := 0.0, false
	for o, n := range uses {
		if o == v || math.Abs(o-v) > reach || n <= uses[v] {
			continue
		}
		if !found || n > uses[best] || (n == uses[best] && o < best) {
			best, found = o, true
		}
	}
	return best, found
}

// --- token usage ---------------------------------------------------------------------------

// TokenUse is how many properties use one token or shared style.
type TokenUse struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Uses int    `json:"uses"`
}

// LiteralColor is a color written by value in several places that no token has.
type LiteralColor struct {
	Color string `json:"color"`
	Uses  int    `json:"uses"`
}

// TokenUsageReport says where the document's tokens and shared styles are used and what is not tokenised.
type TokenUsageReport struct {
	Variables    []TokenUse     `json:"variables"`
	TextStyles   []TokenUse     `json:"textStyles"`
	PaintStyles  []TokenUse     `json:"paintStyles"`
	EffectStyles []TokenUse     `json:"effectStyles"`
	Unused       []string       `json:"unused" jsonschema:"names of tokens and styles nothing uses"`
	Candidates   []LiteralColor `json:"candidates" jsonschema:"colors used by value three or more times that match no token: worth making a variable"`
}

// TokenUsage counts the uses of the document's variables and shared styles.
func TokenUsage(doc *opendesignerv1.Document) TokenUsageReport {
	rep := TokenUsageReport{Variables: []TokenUse{}, TextStyles: []TokenUse{}, PaintStyles: []TokenUse{}, EffectStyles: []TokenUse{}, Unused: []string{}, Candidates: []LiteralColor{}}
	vars, text, paint, effect := map[string]int{}, map[string]int{}, map[string]int{}, map[string]int{}
	for _, n := range doc.GetNodes() {
		for _, v := range n.GetBindings() {
			vars[v]++
		}
		if id := n.GetTextStyleId(); id != "" {
			text[id]++
		}
		for _, id := range []string{n.GetFillStyleId(), n.GetStrokeStyleId()} {
			if id != "" {
				paint[id]++
			}
		}
		if id := n.GetEffectStyleId(); id != "" {
			effect[id]++
		}
	}
	// A variable that is an alias target is in use through the alias.
	for _, v := range doc.GetVariables() {
		if a := v.GetAliasOf(); a != "" {
			vars[a]++
		}
	}
	collect := func(into *[]TokenUse, uses map[string]int, names map[string]string, kind string) {
		for id, name := range names {
			*into = append(*into, TokenUse{ID: id, Name: name, Uses: uses[id]})
			if uses[id] == 0 {
				rep.Unused = append(rep.Unused, kind+" "+name)
			}
		}
		sort.Slice(*into, func(i, j int) bool {
			a, b := (*into)[i], (*into)[j]
			return a.Uses > b.Uses || (a.Uses == b.Uses && (a.Name < b.Name || (a.Name == b.Name && a.ID < b.ID)))
		})
	}
	names := map[string]string{}
	for id, v := range doc.GetVariables() {
		names[id] = v.GetName()
	}
	collect(&rep.Variables, vars, names, "variable")
	names = map[string]string{}
	for id, s := range doc.GetTextStyles() {
		names[id] = s.GetName()
	}
	collect(&rep.TextStyles, text, names, "text style")
	names = map[string]string{}
	for id, s := range doc.GetPaintStyles() {
		names[id] = s.GetName()
	}
	collect(&rep.PaintStyles, paint, names, "paint style")
	names = map[string]string{}
	for id, s := range doc.GetEffectStyles() {
		names[id] = s.GetName()
	}
	collect(&rep.EffectStyles, effect, names, "effect style")
	sort.Strings(rep.Unused)

	palette := colorVariables(doc)
	count, _ := literalColors(doc)
	for k, n := range count {
		if n < 3 {
			continue
		}
		lit := color{float64(k.r) / 255, float64(k.g) / 255, float64(k.b) / 255, float64(k.a) / 255}
		tokenised := false
		for _, p := range palette {
			if near(lit, p.c) {
				tokenised = true
				break
			}
		}
		if !tokenised {
			rep.Candidates = append(rep.Candidates, LiteralColor{Color: k.hex(), Uses: n})
		}
	}
	sort.Slice(rep.Candidates, func(i, j int) bool {
		return rep.Candidates[i].Uses > rep.Candidates[j].Uses || (rep.Candidates[i].Uses == rep.Candidates[j].Uses && rep.Candidates[i].Color < rep.Candidates[j].Color)
	})
	return rep
}
