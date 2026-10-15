package core

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
)

// COMPONENT VARIANTS AND PROPERTIES -- the Go half (the authority) of
// web/src/store/components.ts for the four ops setComponentSet /
// deleteComponentSet / setComponentDef / setInstanceProps.
//
// A COMPONENT SET groups the variants of a component along named AXES (State:
// default | hover; Size: sm | md). Each member component assigns one option per
// axis. A COMPONENT PROPERTY is a named knob (a boolean that shows/hides nodes of
// the master, a text that sets the content of its text nodes -- free or from an
// option list --, a number written to one attribute of its nodes, or a swap that
// makes a nested instance show another component). An instance picks
// a variant (InstanceNode.variant_props) and sets property values
// (InstanceNode.property_values, by property NAME). The invariants:
//
//	1. a set has a non-empty id and at least one axis; axis names and options are
//	   plain names (letters, digits, space, '_', '.', '-'; 1..32), axis names are
//	   unique, every axis has at least one option and options are unique within it;
//	2. a component is either standalone (no set, no variant) or a member of an
//	   EXISTING set with exactly one valid option per axis, and no two members of a
//	   set share the same combination;
//	3. a property has a unique plain name, a type, a default of the type (BOOLEAN
//	   "true"/"false", TEXT at most 1000 bytes and one of its options when it has
//	   any, NUMBER a number in the range of its attribute, INSTANCE_SWAP "" or an
//	   existing component other than its own) and at least one target node, each
//	   inside the master's subtree (text nodes for TEXT and font_size, rectangles
//	   for corner_radius, instances for INSTANCE_SWAP); only NUMBER has an
//	   attribute (opacity | corner_radius | font_size), only TEXT has options
//	   (unique, non-empty);
//	4. an instance's variant choice names axes of the set of its base component with
//	   valid options, and its property values name properties of the component it
//	   resolves to, with values of the property's type;
//	5. deleting a node removes it from the property targets it was in (a property
//	   left without targets goes away); changing a set's axes or deleting the set
//	   detaches the members whose assignment is no longer valid -- after the
//	   op's renames (axis_renames old->new, option_renames) have carried the
//	   members' and the instances' choices over to the new names. Renames are
//	   one-to-one, point at an axis / option the new set has, and are refused
//	   when they would make two members the same combination.
//
// Upserts are ABSOLUTE: the inverse of an op is the previous state.

var (
	ErrNilComponentSet      = errors.New("core: nil component set")
	ErrComponentSetNotFound = errors.New("core: component set not found")
	ErrSetAxes              = errors.New("core: a component set needs at least one axis, each with unique plain names and at least one option")
	ErrVariantAssignment    = errors.New("core: a variant must assign exactly one valid option to every axis of its set (and none without a set)")
	ErrVariantDuplicate     = errors.New("core: another component of the set already has this variant")
	ErrComponentProperty    = errors.New("core: invalid component property")
	ErrPropertyTarget       = errors.New("core: property target must be a node of the master (a text node for text properties)")
	ErrInstanceProps        = errors.New("core: invalid instance property values or variant choice")
	ErrSetRenames           = errors.New("core: invalid axis or option renames (they must be one-to-one, point at the new set and keep members distinct)")
)

var nameRe = regexp.MustCompile(`^[\p{L}\p{N} _.\-]{1,32}$`)

const maxPropertyText = 1000

// numberRe is what a NUMBER value may look like (plain decimal, optional exponent): the
// same text on both sides, so "0x10", "NaN" or "" parse nowhere.
var numberRe = regexp.MustCompile(`^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)

// numberAttrs: the node attributes a NUMBER property can drive.
var numberAttrs = map[string]bool{"opacity": true, "corner_radius": true, "font_size": true}

// parseNumber reads a NUMBER value for `attr`: finite and in the attribute's range
// (opacity 0..1, corner_radius >= 0, font_size > 0).
func parseNumber(attr, v string) (float64, bool) {
	if len(v) > 32 || !numberRe.MatchString(v) {
		return 0, false
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || math.IsInf(f, 0) || math.IsNaN(f) {
		return 0, false
	}
	switch attr {
	case "opacity":
		return f, f >= 0 && f <= 1
	case "corner_radius":
		return f, f >= 0
	case "font_size":
		return f, f > 0
	}
	return f, false
}

func validateComponentSet(s *opendesignerv1.ComponentSet) error {
	if s == nil || s.GetId() == "" {
		return ErrNilComponentSet
	}
	if len(s.GetAxes()) == 0 {
		return ErrSetAxes
	}
	names := map[string]bool{}
	for _, a := range s.GetAxes() {
		if !nameRe.MatchString(a.GetName()) || names[a.GetName()] || len(a.GetOptions()) == 0 {
			return ErrSetAxes
		}
		names[a.GetName()] = true
		opts := map[string]bool{}
		for _, o := range a.GetOptions() {
			if !nameRe.MatchString(o) || opts[o] {
				return ErrSetAxes
			}
			opts[o] = true
		}
	}
	return nil
}

// assignmentValid: `variant` assigns exactly one valid option to every axis of `set`.
func assignmentValid(set *opendesignerv1.ComponentSet, variant map[string]string) bool {
	if len(variant) != len(set.GetAxes()) {
		return false
	}
	for _, a := range set.GetAxes() {
		v, ok := variant[a.GetName()]
		if !ok {
			return false
		}
		found := false
		for _, o := range a.GetOptions() {
			found = found || o == v
		}
		if !found {
			return false
		}
	}
	return true
}

func sameAssignment(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if w, ok := b[k]; !ok || w != v {
			return false
		}
	}
	return true
}

// inMasterSubtree: node `id` is the root of the master or one of its descendants.
func inMasterSubtree(doc *opendesignerv1.Document, id, root string) bool {
	for cur, g := doc.GetNodes()[id], 0; cur != nil && g < 10000; cur, g = doc.GetNodes()[cur.GetParentId()], g+1 {
		if cur.GetId() == root {
			return true
		}
	}
	return false
}

func validateProperties(doc *opendesignerv1.Document, componentID, root string, props []*opendesignerv1.ComponentProperty) error {
	names := map[string]bool{}
	for _, p := range props {
		if p == nil || !nameRe.MatchString(p.GetName()) || names[p.GetName()] {
			return ErrComponentProperty
		}
		names[p.GetName()] = true
		if (p.GetAttribute() != "") != (p.GetType() == opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_NUMBER) ||
			(len(p.GetOptions()) > 0 && p.GetType() != opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_TEXT) {
			return ErrComponentProperty
		}
		switch p.GetType() {
		case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_BOOLEAN:
			if p.GetDefaultValue() != "true" && p.GetDefaultValue() != "false" {
				return ErrComponentProperty
			}
		case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_TEXT:
			if len(p.GetDefaultValue()) > maxPropertyText {
				return ErrComponentProperty
			}
			if len(p.GetOptions()) > 0 {
				seen := map[string]bool{}
				for _, o := range p.GetOptions() {
					if o == "" || len(o) > maxPropertyText || seen[o] {
						return ErrComponentProperty
					}
					seen[o] = true
				}
				if !seen[p.GetDefaultValue()] {
					return ErrComponentProperty
				}
			}
		case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_NUMBER:
			if !numberAttrs[p.GetAttribute()] {
				return ErrComponentProperty
			}
			if _, ok := parseNumber(p.GetAttribute(), p.GetDefaultValue()); !ok {
				return ErrComponentProperty
			}
		case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_INSTANCE_SWAP:
			// "" keeps the nested instance's own component.
			if d := p.GetDefaultValue(); d != "" && (d == componentID || doc.GetComponents()[d] == nil) {
				return ErrComponentProperty
			}
		default:
			return ErrComponentProperty
		}
		if len(p.GetTargetNodeIds()) == 0 {
			return ErrPropertyTarget
		}
		seen := map[string]bool{}
		for _, t := range p.GetTargetNodeIds() {
			n := doc.GetNodes()[t]
			if n == nil || seen[t] || !inMasterSubtree(doc, t, root) || !targetFits(p, n) {
				return ErrPropertyTarget
			}
			seen[t] = true
		}
	}
	return nil
}

// targetFits: node `n` can be driven by property `p` (text nodes for TEXT and font_size,
// rectangles for corner_radius, instances for INSTANCE_SWAP).
func targetFits(p *opendesignerv1.ComponentProperty, n *opendesignerv1.Node) bool {
	switch p.GetType() {
	case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_TEXT:
		return n.GetText() != nil
	case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_INSTANCE_SWAP:
		return n.GetInstance() != nil
	case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_NUMBER:
		switch p.GetAttribute() {
		case "corner_radius":
			return n.GetRect() != nil
		case "font_size":
			return n.GetText() != nil
		}
	}
	return true
}

func validateComponentDef(doc *opendesignerv1.Document, s *opendesignerv1.SetComponentDef) error {
	comp, ok := doc.GetComponents()[s.GetComponentId()]
	if !ok {
		return fmt.Errorf("%w: %s", ErrComponentNotFound, s.GetComponentId())
	}
	if err := validateProperties(doc, s.GetComponentId(), comp.GetRootNodeId(), s.GetProperties()); err != nil {
		return err
	}
	if s.GetSetId() == "" {
		if len(s.GetVariant()) != 0 {
			return ErrVariantAssignment
		}
		return nil
	}
	set, ok := doc.GetComponentSets()[s.GetSetId()]
	if !ok {
		return fmt.Errorf("%w: %s", ErrComponentSetNotFound, s.GetSetId())
	}
	if !assignmentValid(set, s.GetVariant()) {
		return ErrVariantAssignment
	}
	for id, other := range doc.GetComponents() {
		if id != s.GetComponentId() && other.GetSetId() == s.GetSetId() && sameAssignment(other.GetVariant(), s.GetVariant()) {
			return ErrVariantDuplicate
		}
	}
	return nil
}

func applySetComponentSet(doc *opendesignerv1.Document, s *opendesignerv1.SetComponentSet, cow *Shared) error {
	set := s.GetComponentSet()
	if err := validateComponentSet(set); err != nil {
		return err
	}
	rn, err := newRenamer(set, s.GetAxisRenames(), s.GetOptionRenames())
	if err != nil {
		return err
	}
	// Carry the choices over BEFORE the set is replaced: members of the OLD set and the
	// instances whose base component is one of them.
	if !rn.empty() {
		members := map[string]map[string]string{}
		for id, c := range doc.GetComponents() {
			if c.GetSetId() == set.GetId() {
				members[id] = rn.variant(c.GetVariant())
			}
		}
		if members, err = rn.distinct(set, members); err != nil {
			return err
		}
		for id, v := range members {
			doc.Components[id].Variant = v
		}
		ids := make([]string, 0)
		for id, n := range doc.GetNodes() {
			if inst := n.GetInstance(); inst != nil && len(inst.GetVariantProps()) > 0 && hasKey(members, inst.GetComponentId()) {
				ids = append(ids, id)
			}
		}
		sort.Strings(ids)
		for _, id := range ids {
			inst := cow.mut(doc, id).GetInstance()
			inst.VariantProps = rn.variant(inst.GetVariantProps())
		}
	}
	if doc.ComponentSets == nil {
		doc.ComponentSets = map[string]*opendesignerv1.ComponentSet{}
	}
	doc.ComponentSets[set.GetId()] = proto.Clone(set).(*opendesignerv1.ComponentSet)
	detachInvalidMembers(doc, set.GetId())
	return nil
}

// renamer: the axis / option renames of a SetComponentSet, validated against the NEW set.
type renamer struct {
	axes map[string]string            // old axis name -> new
	opts map[string]map[string]string // NEW axis name -> old option -> new option
}

func newRenamer(set *opendesignerv1.ComponentSet, axes map[string]string, opts []*opendesignerv1.OptionRename) (*renamer, error) {
	r := &renamer{axes: axes, opts: map[string]map[string]string{}}
	byName := map[string]*opendesignerv1.VariantAxis{}
	for _, a := range set.GetAxes() {
		byName[a.GetName()] = a
	}
	hasOption := func(a *opendesignerv1.VariantAxis, o string) bool {
		for _, x := range a.GetOptions() {
			if x == o {
				return true
			}
		}
		return false
	}
	seen := map[string]bool{}
	for _, to := range axes {
		if byName[to] == nil || seen[to] {
			return nil, ErrSetRenames
		}
		seen[to] = true
	}
	taken := map[string]map[string]bool{}
	for _, o := range opts {
		a := byName[o.GetAxis()]
		if a == nil || !hasOption(a, o.GetTo()) || r.opts[o.GetAxis()][o.GetFrom()] != "" {
			return nil, ErrSetRenames
		}
		if taken[o.GetAxis()] == nil {
			taken[o.GetAxis()] = map[string]bool{}
			r.opts[o.GetAxis()] = map[string]string{}
		}
		if taken[o.GetAxis()][o.GetTo()] {
			return nil, ErrSetRenames
		}
		taken[o.GetAxis()][o.GetTo()] = true
		r.opts[o.GetAxis()][o.GetFrom()] = o.GetTo()
	}
	return r, nil
}

func hasKey(m map[string]map[string]string, k string) bool { _, ok := m[k]; return ok }

func (r *renamer) empty() bool { return len(r.axes) == 0 && len(r.opts) == 0 }

// variant renames the keys of a choice (axis -> option), then the option of each axis
// under its NEW name. Choices that do not mention a renamed axis are untouched.
func (r *renamer) variant(v map[string]string) map[string]string {
	if len(v) == 0 {
		return v
	}
	out := make(map[string]string, len(v))
	for k, o := range v {
		if nk, ok := r.axes[k]; ok {
			k = nk
		}
		if no, ok := r.opts[k][o]; ok {
			o = no
		}
		out[k] = o
	}
	return out
}

// distinct refuses the renames when they would make two members that stay valid in the
// new set the same combination (the op would silently merge two variants).
func (r *renamer) distinct(set *opendesignerv1.ComponentSet, members map[string]map[string]string) (map[string]map[string]string, error) {
	ids := make([]string, 0, len(members))
	for id := range members {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for i, id := range ids {
		if !assignmentValid(set, members[id]) {
			continue
		}
		for _, other := range ids[:i] {
			if assignmentValid(set, members[other]) && sameAssignment(members[other], members[id]) {
				return nil, ErrSetRenames
			}
		}
	}
	return members, nil
}

// detachInvalidMembers: invariant 5 -- the members of `setID` whose assignment is
// no longer valid (the set's axes changed, or the set is gone) become standalone.
func detachInvalidMembers(doc *opendesignerv1.Document, setID string) {
	set := doc.GetComponentSets()[setID]
	ids := make([]string, 0)
	for id, c := range doc.GetComponents() {
		if c.GetSetId() == setID && (set == nil || !assignmentValid(set, c.GetVariant())) {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		c := doc.Components[id]
		c.SetId, c.Variant = "", nil
	}
}

func applyDeleteComponentSet(doc *opendesignerv1.Document, d *opendesignerv1.DeleteComponentSet) error {
	if _, ok := doc.GetComponentSets()[d.GetId()]; !ok {
		return fmt.Errorf("%w: %s", ErrComponentSetNotFound, d.GetId())
	}
	delete(doc.ComponentSets, d.GetId())
	detachInvalidMembers(doc, d.GetId())
	return nil
}

func applySetComponentDef(doc *opendesignerv1.Document, s *opendesignerv1.SetComponentDef) error {
	if err := validateComponentDef(doc, s); err != nil {
		return err
	}
	c := doc.Components[s.GetComponentId()]
	c.SetId = s.GetSetId()
	c.Variant = nil
	if len(s.GetVariant()) > 0 {
		c.Variant = map[string]string{}
		for k, v := range s.GetVariant() {
			c.Variant[k] = v
		}
	}
	c.Properties = nil
	for _, p := range s.GetProperties() {
		c.Properties = append(c.Properties, proto.Clone(p).(*opendesignerv1.ComponentProperty))
	}
	return nil
}

// EffectiveComponentID is the id of the component an instance renders: the member of
// its base component's set that matches the instance's variant choice over the base
// assignment, or the base component itself when it has no set or nothing matches.
func EffectiveComponentID(doc *opendesignerv1.Document, inst *opendesignerv1.InstanceNode) string {
	base := inst.GetComponentId()
	comp := doc.GetComponents()[base]
	if comp == nil || comp.GetSetId() == "" || len(inst.GetVariantProps()) == 0 {
		return base
	}
	want := map[string]string{}
	for k, v := range comp.GetVariant() {
		want[k] = v
	}
	for k, v := range inst.GetVariantProps() {
		if _, isAxis := want[k]; isAxis {
			want[k] = v
		}
	}
	ids := make([]string, 0)
	for id, c := range doc.GetComponents() {
		if c.GetSetId() == comp.GetSetId() && sameAssignment(c.GetVariant(), want) {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return base
	}
	sort.Strings(ids)
	return ids[0]
}

// PropertyValue is the value of property `p` for an instance: its own value when it
// is valid for the type, else the default.
func PropertyValue(doc *opendesignerv1.Document, inst *opendesignerv1.InstanceNode, p *opendesignerv1.ComponentProperty) string {
	v, ok := inst.GetPropertyValues()[p.GetName()]
	if !ok || !propertyValueValid(doc, p, v) {
		return p.GetDefaultValue()
	}
	return v
}

func propertyValueValid(doc *opendesignerv1.Document, p *opendesignerv1.ComponentProperty, v string) bool {
	switch p.GetType() {
	case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_BOOLEAN:
		return v == "true" || v == "false"
	case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_TEXT:
		if len(p.GetOptions()) > 0 {
			for _, o := range p.GetOptions() {
				if o == v {
					return true
				}
			}
			return false
		}
		return len(v) <= maxPropertyText
	case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_NUMBER:
		_, ok := parseNumber(p.GetAttribute(), v)
		return ok
	case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_INSTANCE_SWAP:
		return doc.GetComponents()[v] != nil
	}
	return false
}

// EffectiveOverrides merges what an instance changes in its master: the overrides
// derived from the component's properties (a text property sets the content of its
// text targets) under the instance's explicit overrides (which win), and the set of
// master nodes a false boolean property hides.
func EffectiveOverrides(doc *opendesignerv1.Document, inst *opendesignerv1.InstanceNode) (map[string]*opendesignerv1.InstanceOverride, map[string]bool) {
	out := map[string]*opendesignerv1.InstanceOverride{}
	var hidden map[string]bool
	if comp := doc.GetComponents()[EffectiveComponentID(doc, inst)]; comp != nil {
		for _, p := range comp.GetProperties() {
			v := PropertyValue(doc, inst, p)
			switch p.GetType() {
			case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_BOOLEAN:
				if v == "false" {
					if hidden == nil {
						hidden = map[string]bool{}
					}
					for _, t := range p.GetTargetNodeIds() {
						hidden[t] = true
					}
				}
			case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_TEXT:
				for _, t := range p.GetTargetNodeIds() {
					out[t] = &opendesignerv1.InstanceOverride{MasterNodeId: t, Text: v, TextPresent: true}
				}
			}
		}
	}
	for _, o := range inst.GetOverrides() {
		base := out[o.GetMasterNodeId()]
		if base == nil {
			out[o.GetMasterNodeId()] = o
			continue
		}
		merged := proto.Clone(base).(*opendesignerv1.InstanceOverride)
		if o.GetFillsPresent() {
			merged.Fills, merged.FillsPresent = o.GetFills(), true
		}
		if o.GetTextPresent() {
			merged.Text, merged.TextPresent = o.GetText(), true
		}
		out[o.GetMasterNodeId()] = merged
	}
	return out, hidden
}

func validateInstanceProps(doc *opendesignerv1.Document, inst *opendesignerv1.InstanceNode, values, variants map[string]string) error {
	base := doc.GetComponents()[inst.GetComponentId()]
	if base == nil {
		return fmt.Errorf("%w: %s", ErrComponentNotFound, inst.GetComponentId())
	}
	if len(variants) > 0 {
		set := doc.GetComponentSets()[base.GetSetId()]
		if set == nil {
			return ErrInstanceProps
		}
		for axis, opt := range variants {
			ok := false
			for _, a := range set.GetAxes() {
				if a.GetName() != axis {
					continue
				}
				for _, o := range a.GetOptions() {
					ok = ok || o == opt
				}
			}
			if !ok {
				return ErrInstanceProps
			}
		}
	}
	// Only the base component and the variant choice decide which component this resolves to.
	eff := &opendesignerv1.InstanceNode{ComponentId: inst.GetComponentId(), VariantProps: variants}
	comp := doc.GetComponents()[EffectiveComponentID(doc, eff)]
	for name, v := range values {
		var prop *opendesignerv1.ComponentProperty
		for _, p := range comp.GetProperties() {
			if p.GetName() == name {
				prop = p
			}
		}
		if prop == nil || !propertyValueValid(doc, prop, v) {
			return ErrInstanceProps
		}
	}
	return nil
}

func applySetInstanceProps(doc *opendesignerv1.Document, s *opendesignerv1.SetInstanceProps, cow *Shared) error {
	n, ok := doc.Nodes[s.GetInstanceId()]
	if !ok {
		return fmt.Errorf("%w: %s", ErrNodeNotFound, s.GetInstanceId())
	}
	inst := n.GetInstance()
	if inst == nil {
		return fmt.Errorf("%w: %s", ErrNotInstanceNode, s.GetInstanceId())
	}
	if err := validateInstanceProps(doc, inst, s.GetPropertyValues(), s.GetVariantProps()); err != nil {
		return err
	}
	inst = cow.mut(doc, s.GetInstanceId()).GetInstance()
	inst.PropertyValues, inst.VariantProps = nil, nil
	if len(s.GetPropertyValues()) > 0 {
		inst.PropertyValues = map[string]string{}
		for k, v := range s.GetPropertyValues() {
			inst.PropertyValues[k] = v
		}
	}
	if len(s.GetVariantProps()) > 0 {
		inst.VariantProps = map[string]string{}
		for k, v := range s.GetVariantProps() {
			inst.VariantProps[k] = v
		}
	}
	return nil
}

// cascadeComponentTargets: invariant 5 -- the deleted nodes leave the property
// targets they were in, and a property left without targets goes away. Properties
// that lose nothing are left untouched.
func cascadeComponentTargets(doc *opendesignerv1.Document, gone map[string]bool) {
	for _, c := range doc.GetComponents() {
		changed := false
		kept := make([]*opendesignerv1.ComponentProperty, 0, len(c.GetProperties()))
		for _, p := range c.GetProperties() {
			targets := make([]string, 0, len(p.GetTargetNodeIds()))
			for _, t := range p.GetTargetNodeIds() {
				if !gone[t] {
					targets = append(targets, t)
				}
			}
			if len(targets) == len(p.GetTargetNodeIds()) {
				kept = append(kept, p)
				continue
			}
			changed = true
			if len(targets) > 0 {
				np := proto.Clone(p).(*opendesignerv1.ComponentProperty)
				np.TargetNodeIds = targets
				kept = append(kept, np)
			}
		}
		if changed {
			c.Properties = kept
		}
	}
}

// ValidateComponentSet / ValidateComponentDef / ValidateInstanceProps are for the
// MCP tools, which run the authority's own checks before submitting.
func ValidateComponentSet(s *opendesignerv1.ComponentSet) error { return validateComponentSet(s) }

func ValidateComponentDef(doc *opendesignerv1.Document, s *opendesignerv1.SetComponentDef) error {
	return validateComponentDef(doc, s)
}

func ValidateInstanceProps(doc *opendesignerv1.Document, inst *opendesignerv1.InstanceNode, values, variants map[string]string) error {
	return validateInstanceProps(doc, inst, values, variants)
}
