package core

import (
	"errors"
	"fmt"
	"math"
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
)

// DESIGN VARIABLES (tokens). A Variable maps mode ids to colours; a paint can
// reference one (Paint.variable) and reads the value live. This file is the
// authority for the three ops; web/src/store/applyOp.ts mirrors it.

var (
	ErrNilVariable      = errors.New("core: nil variable")
	ErrVariableNotFound = errors.New("core: variable not found")
	ErrBadMode          = errors.New("core: invalid mode")
	ErrBadAlias         = errors.New("core: invalid variable alias")
	ErrBadBinding       = errors.New("core: invalid variable binding")
)

// maxAliasDepth bounds the walk along an alias chain. Cycles are refused when
// the alias is written, so this only guards a document that got one anyway.
const maxAliasDepth = 32

// effective follows alias_of to the variable that actually holds the values.
func effective(doc *opendesignerv1.Document, v *opendesignerv1.Variable) *opendesignerv1.Variable {
	for i := 0; v != nil && v.GetAliasOf() != "" && i < maxAliasDepth; i++ {
		v = doc.GetVariables()[v.GetAliasOf()]
	}
	if v != nil && v.GetAliasOf() != "" {
		return nil
	}
	return v
}

// defaultKey is the mode id a variable's unmoded value is read from: the first
// mode, or, when the document defines none, the smallest key of `keys`.
func defaultKey(doc *opendesignerv1.Document, keys []string) string {
	if len(doc.GetModes()) > 0 {
		return doc.GetModes()[0].GetId()
	}
	sort.Strings(keys)
	if len(keys) > 0 {
		return keys[0]
	}
	return ""
}

// ColorValue is the colour of a COLOR variable at the DEFAULT mode, alias
// followed. ok=false for a missing, dangling or differently typed variable.
func ColorValue(doc *opendesignerv1.Document, v *opendesignerv1.Variable) (*opendesignerv1.Color, bool) {
	e := effective(doc, v)
	if e == nil || e.GetType() != opendesignerv1.VariableType_VARIABLE_TYPE_COLOR {
		return nil, false
	}
	keys := make([]string, 0, len(e.GetValues()))
	for k := range e.GetValues() {
		keys = append(keys, k)
	}
	c := e.GetValues()[defaultKey(doc, keys)]
	return c, c != nil
}

// NumberValue: same, for NUMBER variables.
func NumberValue(doc *opendesignerv1.Document, v *opendesignerv1.Variable) (float64, bool) {
	e := effective(doc, v)
	if e == nil || e.GetType() != opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER {
		return 0, false
	}
	keys := make([]string, 0, len(e.GetNumbers()))
	for k := range e.GetNumbers() {
		keys = append(keys, k)
	}
	n, ok := e.GetNumbers()[defaultKey(doc, keys)]
	return n, ok
}

// StringValue: same, for STRING variables.
func StringValue(doc *opendesignerv1.Document, v *opendesignerv1.Variable) (string, bool) {
	e := effective(doc, v)
	if e == nil || e.GetType() != opendesignerv1.VariableType_VARIABLE_TYPE_STRING {
		return "", false
	}
	keys := make([]string, 0, len(e.GetStrings()))
	for k := range e.GetStrings() {
		keys = append(keys, k)
	}
	s, ok := e.GetStrings()[defaultKey(doc, keys)]
	return s, ok
}

func validateVariable(doc *opendesignerv1.Document, v *opendesignerv1.Variable) error {
	if v == nil || v.GetId() == "" {
		return ErrNilVariable
	}
	if v.GetName() == "" {
		return fmt.Errorf("%w: %s has no name", ErrNilVariable, v.GetId())
	}
	switch v.GetType() {
	case opendesignerv1.VariableType_VARIABLE_TYPE_COLOR, opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER, opendesignerv1.VariableType_VARIABLE_TYPE_STRING:
	default:
		return fmt.Errorf("%w: %s has unknown type %v", ErrNilVariable, v.GetId(), v.GetType())
	}
	// The kind decides which map holds values; the other two must be empty, so a
	// variable never carries a value nobody can read.
	typ := v.GetType()
	if (typ != opendesignerv1.VariableType_VARIABLE_TYPE_COLOR && len(v.GetValues()) > 0) ||
		(typ != opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER && len(v.GetNumbers()) > 0) ||
		(typ != opendesignerv1.VariableType_VARIABLE_TYPE_STRING && len(v.GetStrings()) > 0) {
		return fmt.Errorf("%w: %s has values of a kind other than its type %v", ErrNilVariable, v.GetId(), typ)
	}
	if v.GetAliasOf() != "" {
		return validateAlias(doc, v)
	}
	modes := map[string]bool{}
	for _, m := range doc.GetModes() {
		modes[m.GetId()] = true
	}
	check := func(mode string) error {
		// With modes defined, a value for an unknown mode is a typo that would
		// never be read; with none defined, the key is free (it becomes the
		// default mode's id later).
		if len(modes) > 0 && !modes[mode] {
			return fmt.Errorf("%w: variable %s has a value for unknown mode %q", ErrBadMode, v.GetId(), mode)
		}
		return nil
	}
	for mode, c := range v.GetValues() {
		if c == nil {
			return fmt.Errorf("%w: %s has a nil value for mode %q", ErrNilVariable, v.GetId(), mode)
		}
		if err := check(mode); err != nil {
			return err
		}
	}
	for mode := range v.GetNumbers() {
		if err := check(mode); err != nil {
			return err
		}
	}
	for mode := range v.GetStrings() {
		if err := check(mode); err != nil {
			return err
		}
	}
	return nil
}

// validateAlias: an alias holds no values, points at an EXISTING variable of the
// SAME type, and the chain must not come back to this variable.
func validateAlias(doc *opendesignerv1.Document, v *opendesignerv1.Variable) error {
	if len(v.GetValues())+len(v.GetNumbers())+len(v.GetStrings()) > 0 {
		return fmt.Errorf("%w: %s is an alias and must not carry values", ErrBadAlias, v.GetId())
	}
	target := doc.GetVariables()[v.GetAliasOf()]
	if target == nil {
		return fmt.Errorf("%w: %s points at unknown variable %q", ErrBadAlias, v.GetId(), v.GetAliasOf())
	}
	if target.GetType() != v.GetType() {
		return fmt.Errorf("%w: %s (%v) cannot alias %s (%v)", ErrBadAlias, v.GetId(), v.GetType(), target.GetId(), target.GetType())
	}
	cur := target
	for i := 0; cur != nil && i < maxAliasDepth; i++ {
		if cur.GetId() == v.GetId() {
			return fmt.Errorf("%w: %s would alias itself through %s", ErrBadAlias, v.GetId(), target.GetId())
		}
		if cur.GetAliasOf() == "" {
			return nil
		}
		cur = doc.GetVariables()[cur.GetAliasOf()]
	}
	return nil
}

func applySetVariable(doc *opendesignerv1.Document, s *opendesignerv1.SetVariable, cow *Shared) error {
	v := s.GetVariable()
	if err := validateVariable(doc, v); err != nil {
		return err
	}
	if doc.Variables == nil {
		doc.Variables = map[string]*opendesignerv1.Variable{}
	}
	doc.Variables[v.GetId()] = v
	rebindAll(doc, cow)
	return nil
}

func applyDeleteVariable(doc *opendesignerv1.Document, d *opendesignerv1.DeleteVariable) error {
	if _, ok := doc.GetVariables()[d.GetId()]; !ok {
		return fmt.Errorf("%w: %s", ErrVariableNotFound, d.GetId())
	}
	delete(doc.Variables, d.GetId())
	// Bound numbers and texts keep the last value they were given; there is
	// nothing to recompute. (Colour paints draw black, in the readers.)
	return nil
}

// applySetModes replaces the mode list. Ids must be non-empty and unique; the
// variables' values keyed by a mode that disappears are dropped, so no variable
// keeps a value nobody can read. Replaced variables are COPIES (the server's
// copy-on-write clone may share the originals with a previous generation).
func applySetModes(doc *opendesignerv1.Document, s *opendesignerv1.SetModes, cow *Shared) error {
	if err := ValidateModes(s.GetModes()); err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, m := range s.GetModes() {
		seen[m.GetId()] = true
	}
	doc.Modes = s.GetModes()
	if len(seen) > 0 {
		for id, v := range doc.GetVariables() {
			if !hasStale(v, seen) {
				continue
			}
			next := &opendesignerv1.Variable{Id: v.GetId(), Name: v.GetName(), AliasOf: v.GetAliasOf(), Type: v.GetType()}
			next.Values = keepModes(v.GetValues(), seen)
			next.Numbers = keepModes(v.GetNumbers(), seen)
			next.Strings = keepModes(v.GetStrings(), seen)
			doc.Variables[id] = next
		}
	}
	rebindAll(doc, cow)
	return nil
}

func keepModes[V any](in map[string]V, keep map[string]bool) map[string]V {
	if len(in) == 0 {
		return nil
	}
	out := map[string]V{}
	for k, v := range in {
		if keep[k] {
			out[k] = v
		}
	}
	return out
}

func hasStale(v *opendesignerv1.Variable, keep map[string]bool) bool {
	for k := range v.GetValues() {
		if !keep[k] {
			return true
		}
	}
	for k := range v.GetNumbers() {
		if !keep[k] {
			return true
		}
	}
	for k := range v.GetStrings() {
		if !keep[k] {
			return true
		}
	}
	return false
}

// --- numeric and text bindings -------------------------------------------------

// BindableProps: the node properties a variable can drive, and the kind it must be.
var BindableProps = map[string]opendesignerv1.VariableType{
	"opacity":       opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER,
	"corner_radius": opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER,
	"font_size":     opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER,
	"text":          opendesignerv1.VariableType_VARIABLE_TYPE_STRING,
}

// validateBindings checks a node's `bindings` against the document: known
// property, node of the right nature, existing variable of the right kind.
func validateBindings(doc *opendesignerv1.Document, n *opendesignerv1.Node, bindings map[string]string) error {
	for prop, id := range bindings {
		want, ok := BindableProps[prop]
		if !ok {
			return fmt.Errorf("%w: %q is not a bindable property", ErrBadBinding, prop)
		}
		switch prop {
		case "corner_radius":
			switch n.GetShape().(type) {
			case nil, *opendesignerv1.Node_Rect:
			default:
				return fmt.Errorf("%w: corner_radius needs a rectangle (%s)", ErrBadBinding, n.GetId())
			}
		case "font_size", "text":
			if _, isText := n.GetShape().(*opendesignerv1.Node_Text); !isText {
				return fmt.Errorf("%w: %s needs a text node (%s)", ErrBadBinding, prop, n.GetId())
			}
		}
		v := doc.GetVariables()[id]
		if v == nil {
			return fmt.Errorf("%w: unknown variable %q for %s", ErrBadBinding, id, prop)
		}
		if v.GetType() != want {
			return fmt.Errorf("%w: %s needs a %v variable, %q is %v", ErrBadBinding, prop, want, id, v.GetType())
		}
	}
	return nil
}

// applyBindings writes each bound variable's default-mode value into the node
// (already writable: the caller went through cow.mut). A variable with no value
// leaves the property as it is.
func applyBindings(doc *opendesignerv1.Document, n *opendesignerv1.Node) {
	resolveStops(doc, n)
	for prop, id := range n.GetBindings() {
		v := doc.GetVariables()[id]
		switch prop {
		case "opacity":
			if x, ok := NumberValue(doc, v); ok {
				n.Opacity = math.Max(0, math.Min(1, x))
			}
		case "corner_radius":
			if x, ok := NumberValue(doc, v); ok {
				if r := n.GetRect(); r != nil {
					r.CornerRadius = math.Max(0, x)
				} else if n.Shape == nil {
					n.Shape = &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{CornerRadius: math.Max(0, x)}}
				}
			}
		case "font_size":
			if x, ok := NumberValue(doc, v); ok && n.GetText() != nil && x > 0 {
				if n.GetText().Style == nil {
					n.GetText().Style = &opendesignerv1.TextStyle{}
				}
				n.GetText().Style.FontSize = x
			}
		case "text":
			if x, ok := StringValue(doc, v); ok && n.GetText() != nil {
				n.GetText().Content = x
			}
		}
	}
}

// stopBound reports whether any gradient stop of the node follows a variable.
func stopBound(n *opendesignerv1.Node) bool {
	check := func(p *opendesignerv1.Paint) bool {
		for _, g := range []*opendesignerv1.GradientPaint{p.GetLinear(), p.GetRadial()} {
			for _, st := range g.GetStops() {
				if st.GetVariableId() != "" {
					return true
				}
			}
		}
		return false
	}
	for _, p := range n.GetFills() {
		if check(p) {
			return true
		}
	}
	for _, s := range n.GetStrokes() {
		if check(s.GetPaint()) {
			return true
		}
	}
	return false
}

// resolveStops writes into each variable-bound gradient stop the variable's
// DEFAULT-mode colour, so a reader that ignores variables still draws the right
// gradient. The paints are cloned first: after SetProperties they are the op's
// own messages, which other holders (the op log, subscribers) still reference.
func resolveStops(doc *opendesignerv1.Document, n *opendesignerv1.Node) {
	if !stopBound(n) {
		return
	}
	fix := func(p *opendesignerv1.Paint) *opendesignerv1.Paint {
		c := proto.Clone(p).(*opendesignerv1.Paint)
		for _, g := range []*opendesignerv1.GradientPaint{c.GetLinear(), c.GetRadial()} {
			for _, st := range g.GetStops() {
				if id := st.GetVariableId(); id != "" {
					if col, ok := ColorValue(doc, doc.GetVariables()[id]); ok {
						st.Color = col
					}
				}
			}
		}
		return c
	}
	// New slices and new Stroke messages: the old ones may be the op's own.
	fills := make([]*opendesignerv1.Paint, len(n.Fills))
	for i, p := range n.Fills {
		fills[i] = fix(p)
	}
	n.Fills = fills
	strokes := make([]*opendesignerv1.Stroke, len(n.Strokes))
	for i, s := range n.Strokes {
		c := proto.Clone(s).(*opendesignerv1.Stroke)
		c.Paint = fix(s.GetPaint())
		strokes[i] = c
	}
	n.Strokes = strokes
}

// rebindAll re-applies every node's bindings after a variable or the modes
// changed. Nodes are written through cow, so a shared one is cloned first.
func rebindAll(doc *opendesignerv1.Document, cow *Shared) {
	for id, n := range doc.GetNodes() {
		if len(n.GetBindings()) == 0 && !stopBound(n) {
			continue
		}
		applyBindings(doc, cow.mut(doc, id))
	}
}

// ValidateVariable reports whether a SetVariable with this variable would be
// accepted by the document, without applying it: the MCP tools use the same
// logic as the authority to give the agent a clear error BEFORE sending.
func ValidateVariable(doc *opendesignerv1.Document, v *opendesignerv1.Variable) error {
	return validateVariable(doc, v)
}

// ValidateModes is the same for SetModes.
func ValidateModes(modes []*opendesignerv1.Mode) error {
	seen := map[string]bool{}
	for _, m := range modes {
		if m.GetId() == "" || seen[m.GetId()] {
			return fmt.Errorf("%w: empty or duplicate id %q", ErrBadMode, m.GetId())
		}
		seen[m.GetId()] = true
	}
	return nil
}

// ApplyBindings writes the bound variables' default-mode values into the node.
// The server does it as part of every op; this export lets the code generator do
// it for a document that was built outside the server.
func ApplyBindings(doc *opendesignerv1.Document, n *opendesignerv1.Node) { applyBindings(doc, n) }
