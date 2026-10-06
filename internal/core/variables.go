package core

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
)

// VARIABLES (design tokens) -- the Go half (the authority) of
// web/src/store/applyOp.ts and web/src/store/variables.ts for the four ops
// setCollection / deleteCollection / setVariable / deleteVariable and for the
// "bindings" / "modes" mask paths of SetProperties.
//
// A COLLECTION owns a list of MODES; a VARIABLE belongs to one collection, has
// a type (color or number) and one value per mode. A node BINDS a property to a
// variable (Node.bindings) and may pin a collection to a mode (Node.modes).
// The invariants:
//
//	1. a collection has a non-empty id and at least one mode; mode ids are
//	   non-empty and unique within the collection;
//	2. a variable has a non-empty id, an EXISTING collection, a COLOR or NUMBER
//	   type, and values only for modes of its collection, each of the variable's
//	   type (numbers finite, colors finite and in 0..1);
//	3. an existing variable cannot change type or collection: its bindings and
//	   values would stop meaning what they meant. Delete and recreate it;
//	4. every binding key is in the closed grammar below, points to an EXISTING
//	   variable and the variable's type matches the property's;
//	5. every node mode override names an EXISTING collection and one of ITS modes;
//	6. removing a mode from a collection drops that mode's values; deleting a
//	   variable removes the bindings to it; deleting a collection deletes its
//	   variables and removes the mode overrides that named it.
//
// Upserts are ABSOLUTE: the inverse of an op is the previous state (see
// web/src/store/history.ts). Both maps may be nil and are initialized on the
// first write.

var (
	ErrNilCollection      = errors.New("core: nil collection")
	ErrCollectionNotFound = errors.New("core: collection not found")
	ErrCollectionModes    = errors.New("core: a collection needs at least one mode, with unique non-empty ids")
	ErrNilVariable        = errors.New("core: nil variable")
	ErrVariableNotFound   = errors.New("core: variable not found")
	ErrVariableType       = errors.New("core: variable type must be color or number")
	ErrVariableImmutable  = errors.New("core: a variable cannot change type or collection")
	ErrVariableValue      = errors.New("core: variable value missing, of the wrong type or out of range")
	ErrVariableMode       = errors.New("core: variable has a value for a mode its collection does not have")
	ErrBindingKey         = errors.New("core: unknown binding property")
	ErrBindingVariable    = errors.New("core: binding to a missing variable or one of the wrong type")
	ErrModeOverride       = errors.New("core: mode override names a missing collection or mode")
)

// BindingType returns the variable type a binding key accepts, and whether the
// key is in the grammar:
//
//	opacity | rotation | corner_radius | strokes.N.weight   NUMBER
//	fills.N | strokes.N                                      COLOR
//
// The TS mirror (web/src/store/variables.ts::bindingType) repeats it.
func BindingType(key string) (opendesignerv1.VariableType, bool) {
	switch key {
	case "opacity", "rotation", "corner_radius":
		return opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER, true
	}
	parts := strings.Split(key, ".")
	if len(parts) < 2 || len(parts) > 3 || (parts[0] != "fills" && parts[0] != "strokes") {
		return 0, false
	}
	if !isIndex(parts[1]) {
		return 0, false
	}
	switch {
	case len(parts) == 2:
		return opendesignerv1.VariableType_VARIABLE_TYPE_COLOR, true
	case parts[0] == "strokes" && parts[2] == "weight":
		return opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER, true
	}
	return 0, false
}

// isIndex: a canonical non-negative decimal ("0", "12"; not "01", "-1", "+1").
func isIndex(s string) bool {
	n, err := strconv.Atoi(s)
	return err == nil && n >= 0 && strconv.Itoa(n) == s
}

func validColor(c *opendesignerv1.Color) bool {
	for _, v := range []float32{c.GetR(), c.GetG(), c.GetB(), c.GetA()} {
		if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) || v < 0 || v > 1 {
			return false
		}
	}
	return true
}

func modeIDs(c *opendesignerv1.VariableCollection) map[string]bool {
	ids := make(map[string]bool, len(c.GetModes()))
	for _, m := range c.GetModes() {
		ids[m.GetId()] = true
	}
	return ids
}

func validateCollection(c *opendesignerv1.VariableCollection) error {
	if c == nil {
		return ErrNilCollection
	}
	if c.GetId() == "" {
		return fmt.Errorf("%w: empty id", ErrNilCollection)
	}
	if len(c.GetModes()) == 0 {
		return ErrCollectionModes
	}
	seen := map[string]bool{}
	for _, m := range c.GetModes() {
		if m.GetId() == "" || seen[m.GetId()] {
			return ErrCollectionModes
		}
		seen[m.GetId()] = true
	}
	return nil
}

func validateVariable(doc *opendesignerv1.Document, v *opendesignerv1.Variable) error {
	if v == nil {
		return ErrNilVariable
	}
	if v.GetId() == "" {
		return fmt.Errorf("%w: empty id", ErrNilVariable)
	}
	col, ok := doc.GetCollections()[v.GetCollectionId()]
	if !ok {
		return fmt.Errorf("%w: %s", ErrCollectionNotFound, v.GetCollectionId())
	}
	t := v.GetType()
	if t != opendesignerv1.VariableType_VARIABLE_TYPE_COLOR && t != opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER {
		return ErrVariableType
	}
	if prev, ok := doc.GetVariables()[v.GetId()]; ok &&
		(prev.GetType() != t || prev.GetCollectionId() != v.GetCollectionId()) {
		return ErrVariableImmutable
	}
	modes := modeIDs(col)
	for mode, val := range v.GetValues() {
		if !modes[mode] {
			return fmt.Errorf("%w: %s", ErrVariableMode, mode)
		}
		switch t {
		case opendesignerv1.VariableType_VARIABLE_TYPE_COLOR:
			c, ok := val.GetKind().(*opendesignerv1.VariableValue_Color)
			if !ok || !validColor(c.Color) {
				return ErrVariableValue
			}
		case opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER:
			n, ok := val.GetKind().(*opendesignerv1.VariableValue_Number)
			if !ok || math.IsNaN(n.Number) || math.IsInf(n.Number, 0) {
				return ErrVariableValue
			}
		}
	}
	return nil
}

// validateBindings checks a node's bindings against the document (invariant 4).
func validateBindings(doc *opendesignerv1.Document, b map[string]string) error {
	for key, id := range b {
		want, ok := BindingType(key)
		if !ok {
			return fmt.Errorf("%w: %q", ErrBindingKey, key)
		}
		v, ok := doc.GetVariables()[id]
		if !ok || v.GetType() != want {
			return fmt.Errorf("%w: %q -> %q", ErrBindingVariable, key, id)
		}
	}
	return nil
}

// validateModes checks a node's mode overrides against the document (invariant 5).
func validateModes(doc *opendesignerv1.Document, m map[string]string) error {
	for col, mode := range m {
		c, ok := doc.GetCollections()[col]
		if !ok || !modeIDs(c)[mode] {
			return fmt.Errorf("%w: %s=%s", ErrModeOverride, col, mode)
		}
	}
	return nil
}

func applySetCollection(doc *opendesignerv1.Document, s *opendesignerv1.SetCollection, cow *Shared) error {
	c := s.GetCollection()
	if err := validateCollection(c); err != nil {
		return err
	}
	if doc.Collections == nil {
		doc.Collections = map[string]*opendesignerv1.VariableCollection{}
	}
	prev := doc.Collections[c.GetId()]
	doc.Collections[c.GetId()] = proto.Clone(c).(*opendesignerv1.VariableCollection)
	if prev == nil {
		return nil
	}
	// Invariant 6: the modes that disappeared take their values (and the
	// overrides that pinned them) with them.
	keep := modeIDs(c)
	for _, v := range doc.Variables {
		if v.GetCollectionId() != c.GetId() {
			continue
		}
		for mode := range v.GetValues() {
			if !keep[mode] {
				delete(v.Values, mode)
			}
		}
	}
	for _, id := range sortedNodeIDs(doc) {
		n := doc.Nodes[id]
		if mode, ok := n.GetModes()[c.GetId()]; ok && !keep[mode] {
			n = cow.mut(doc, id)
			delete(n.Modes, c.GetId())
		}
	}
	return nil
}

func applyDeleteCollection(doc *opendesignerv1.Document, d *opendesignerv1.DeleteCollection, cow *Shared) error {
	if _, ok := doc.GetCollections()[d.GetId()]; !ok {
		return fmt.Errorf("%w: %s", ErrCollectionNotFound, d.GetId())
	}
	gone := map[string]bool{}
	for id, v := range doc.Variables {
		if v.GetCollectionId() == d.GetId() {
			gone[id] = true
		}
	}
	delete(doc.Collections, d.GetId())
	for id := range gone {
		delete(doc.Variables, id)
	}
	for _, id := range sortedNodeIDs(doc) {
		n := doc.Nodes[id]
		_, pinned := n.GetModes()[d.GetId()]
		if pinned || bindsAny(n, gone) {
			n = cow.mut(doc, id)
			delete(n.Modes, d.GetId())
			unbind(n, gone)
		}
	}
	return nil
}

func applySetVariable(doc *opendesignerv1.Document, s *opendesignerv1.SetVariable) error {
	v := s.GetVariable()
	if err := validateVariable(doc, v); err != nil {
		return err
	}
	if doc.Variables == nil {
		doc.Variables = map[string]*opendesignerv1.Variable{}
	}
	doc.Variables[v.GetId()] = proto.Clone(v).(*opendesignerv1.Variable)
	return nil
}

func applyDeleteVariable(doc *opendesignerv1.Document, d *opendesignerv1.DeleteVariable, cow *Shared) error {
	if _, ok := doc.GetVariables()[d.GetId()]; !ok {
		return fmt.Errorf("%w: %s", ErrVariableNotFound, d.GetId())
	}
	delete(doc.Variables, d.GetId())
	gone := map[string]bool{d.GetId(): true}
	for _, id := range sortedNodeIDs(doc) {
		if bindsAny(doc.Nodes[id], gone) {
			unbind(cow.mut(doc, id), gone)
		}
	}
	return nil
}

func bindsAny(n *opendesignerv1.Node, vars map[string]bool) bool {
	for _, id := range n.GetBindings() {
		if vars[id] {
			return true
		}
	}
	return false
}

func unbind(n *opendesignerv1.Node, vars map[string]bool) {
	for key, id := range n.GetBindings() {
		if vars[id] {
			delete(n.Bindings, key)
		}
	}
}

// sortedNodeIDs makes the cascades deterministic (and the copy-on-write set
// reproducible); the cascade touches every node only when it has to.
func sortedNodeIDs(doc *opendesignerv1.Document) []string {
	ids := make([]string, 0, len(doc.GetNodes()))
	for id := range doc.GetNodes() {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// ---------- resolution ----------

// ActiveMode is the mode of `collectionID` in force for node `nodeID`: the
// nearest ancestor (the node itself included) that pins the collection to a
// mode the collection still has, else the collection's first mode. "" if the
// collection does not exist.
func ActiveMode(doc *opendesignerv1.Document, nodeID, collectionID string) string {
	col, ok := doc.GetCollections()[collectionID]
	if !ok || len(col.GetModes()) == 0 {
		return ""
	}
	modes := modeIDs(col)
	cur := doc.GetNodes()[nodeID]
	for guard := 0; cur != nil && guard < 10000; guard++ {
		if m, ok := cur.GetModes()[collectionID]; ok && modes[m] {
			return m
		}
		cur = doc.GetNodes()[cur.GetParentId()]
	}
	return col.GetModes()[0].GetId()
}

// VariableValueIn is the value of `v` in `mode`, falling back to the
// collection's default mode, or nil if neither has one.
func VariableValueIn(doc *opendesignerv1.Document, v *opendesignerv1.Variable, mode string) *opendesignerv1.VariableValue {
	if val, ok := v.GetValues()[mode]; ok {
		return val
	}
	if col := doc.GetCollections()[v.GetCollectionId()]; len(col.GetModes()) > 0 {
		return v.GetValues()[col.GetModes()[0].GetId()]
	}
	return nil
}

// ResolveNode returns `n` with its variable bindings substituted by the values
// of the active modes. A node without bindings (the common case) is returned
// as is; otherwise it is a clone, the document is never touched. A binding whose
// variable, value or target paint is missing is ignored: the literal stays.
func ResolveNode(doc *opendesignerv1.Document, n *opendesignerv1.Node) *opendesignerv1.Node {
	if len(n.GetBindings()) == 0 {
		return n
	}
	out := proto.Clone(n).(*opendesignerv1.Node)
	keys := make([]string, 0, len(n.GetBindings()))
	for k := range n.GetBindings() {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, key := range keys {
		v := doc.GetVariables()[n.GetBindings()[key]]
		if v == nil {
			continue
		}
		val := VariableValueIn(doc, v, ActiveMode(doc, n.GetId(), v.GetCollectionId()))
		if val == nil {
			continue
		}
		setBound(out, key, val)
	}
	return out
}

func setBound(n *opendesignerv1.Node, key string, val *opendesignerv1.VariableValue) {
	if num, ok := val.GetKind().(*opendesignerv1.VariableValue_Number); ok {
		switch key {
		case "opacity":
			n.Opacity = math.Min(1, math.Max(0, num.Number))
		case "rotation":
			n.Rotation = num.Number
		case "corner_radius":
			// An absent shape is an implicit rectangle (see applySetProps), so it
			// takes the radius too; any other shape ignores the binding.
			switch n.GetShape().(type) {
			case nil:
				n.Shape = &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{CornerRadius: math.Max(0, num.Number)}}
			case *opendesignerv1.Node_Rect:
				if n.GetRect() == nil {
					n.GetShape().(*opendesignerv1.Node_Rect).Rect = &opendesignerv1.RectNode{}
				}
				n.GetRect().CornerRadius = math.Max(0, num.Number)
			}
		default: // strokes.N.weight
			parts := strings.Split(key, ".")
			if i, _ := strconv.Atoi(parts[1]); i < len(n.GetStrokes()) {
				n.Strokes[i].Weight = math.Max(0, num.Number)
			}
		}
		return
	}
	col, ok := val.GetKind().(*opendesignerv1.VariableValue_Color)
	if !ok {
		return
	}
	parts := strings.Split(key, ".")
	i, _ := strconv.Atoi(parts[1])
	var paint *opendesignerv1.Paint
	switch {
	case parts[0] == "fills" && i < len(n.GetFills()):
		paint = n.Fills[i]
	case parts[0] == "strokes" && i < len(n.GetStrokes()):
		paint = n.Strokes[i].GetPaint()
	}
	if s := paint.GetSolid(); s != nil {
		s.Color = proto.Clone(col.Color).(*opendesignerv1.Color)
	}
}
