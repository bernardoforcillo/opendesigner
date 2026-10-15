package core

import (
	"errors"
	"fmt"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// COMPONENT PROPERTIES. A component declares named controls; an instance sets
// them. A BOOLEAN shows or hides one master node, a TEXT sets one master text
// node's content. web/src/store/properties.ts mirrors the rules.

var (
	ErrBadProperty      = errors.New("core: invalid component property")
	ErrPropertyNotFound = errors.New("core: component property not found")
)

// underNode reports whether `id` is `root` or lies in its subtree.
func underNode(doc *opendesignerv1.Document, root, id string) bool {
	for i := 0; i < 10000 && id != ""; i++ {
		if id == root {
			return true
		}
		n := doc.GetNodes()[id]
		if n == nil {
			return false
		}
		id = n.GetParentId()
	}
	return false
}

func validPropertyValue(t opendesignerv1.ComponentPropertyType, v string) bool {
	if t == opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_BOOLEAN {
		return v == "true" || v == "false"
	}
	return true
}

func applySetComponentProperties(doc *opendesignerv1.Document, s *opendesignerv1.SetComponentProperties) error {
	c := doc.GetComponents()[s.GetComponentId()]
	if c == nil {
		return fmt.Errorf("%w: %s", ErrComponentNotFound, s.GetComponentId())
	}
	seen := map[string]bool{}
	props := make([]*opendesignerv1.ComponentProperty, 0, len(s.GetProperties()))
	for _, p := range s.GetProperties() {
		if p.GetName() == "" || seen[p.GetName()] {
			return fmt.Errorf("%w: empty or duplicate name %q", ErrBadProperty, p.GetName())
		}
		seen[p.GetName()] = true
		node := doc.GetNodes()[p.GetNodeId()]
		if node == nil || !underNode(doc, c.GetRootNodeId(), p.GetNodeId()) {
			return fmt.Errorf("%w: %q targets %q, which is not in the component's master", ErrBadProperty, p.GetName(), p.GetNodeId())
		}
		switch p.GetType() {
		case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_BOOLEAN:
		case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_TEXT:
			if node.GetText() == nil {
				return fmt.Errorf("%w: text property %q needs a text node", ErrBadProperty, p.GetName())
			}
		default:
			return fmt.Errorf("%w: %q has an unknown type", ErrBadProperty, p.GetName())
		}
		def := p.GetDefaultValue()
		if p.GetType() == opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_BOOLEAN && def == "" {
			def = "true"
		}
		if !validPropertyValue(p.GetType(), def) {
			return fmt.Errorf("%w: default of %q must be true or false", ErrBadProperty, p.GetName())
		}
		props = append(props, &opendesignerv1.ComponentProperty{Name: p.GetName(), Type: p.GetType(), NodeId: p.GetNodeId(), DefaultValue: def})
	}
	c.Properties = props
	return nil
}

func applySetInstanceProperty(doc *opendesignerv1.Document, s *opendesignerv1.SetInstanceProperty, cow *Shared) error {
	n, ok := doc.Nodes[s.GetInstanceId()]
	if ok {
		n = cow.mut(doc, s.GetInstanceId())
	}
	if !ok {
		return fmt.Errorf("%w: %s", ErrNodeNotFound, s.GetInstanceId())
	}
	inst := n.GetInstance()
	if inst == nil {
		return fmt.Errorf("%w: %s", ErrNotInstanceNode, s.GetInstanceId())
	}
	comp := doc.GetComponents()[inst.GetComponentId()]
	var def *opendesignerv1.ComponentProperty
	for _, p := range comp.GetProperties() {
		if p.GetName() == s.GetName() {
			def = p
		}
	}
	if def == nil {
		return fmt.Errorf("%w: %q on component %s", ErrPropertyNotFound, s.GetName(), inst.GetComponentId())
	}
	if s.GetValue() == "" {
		delete(inst.PropertyValues, s.GetName())
		return nil
	}
	if !validPropertyValue(def.GetType(), s.GetValue()) {
		return fmt.Errorf("%w: %q takes true or false, got %q", ErrBadProperty, s.GetName(), s.GetValue())
	}
	if inst.PropertyValues == nil {
		inst.PropertyValues = map[string]string{}
	}
	inst.PropertyValues[s.GetName()] = s.GetValue()
	return nil
}

// InstanceEffects is what an instance's property values do to its master, per
// master node: a visibility to force (shown or hidden) and a text to write.
type InstanceEffects struct {
	Visible map[string]bool
	Text    map[string]string
}

// EffectsOf resolves an instance's properties (value, else default) against its
// component. Properties win over per-node overrides; callers apply them last.
func EffectsOf(doc *opendesignerv1.Document, inst *opendesignerv1.InstanceNode) InstanceEffects {
	return EffectsWith(doc.GetComponents()[inst.GetComponentId()], inst.GetPropertyValues())
}

// EffectsWith is EffectsOf for a component and explicit values (nil = defaults).
func EffectsWith(comp *opendesignerv1.Component, values map[string]string) InstanceEffects {
	e := InstanceEffects{Visible: map[string]bool{}, Text: map[string]string{}}
	for _, p := range comp.GetProperties() {
		v, ok := values[p.GetName()]
		if !ok {
			v = p.GetDefaultValue()
		}
		switch p.GetType() {
		case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_BOOLEAN:
			e.Visible[p.GetNodeId()] = v != "false"
		case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_TEXT:
			if v != "" { // empty = keep the master's own text
				e.Text[p.GetNodeId()] = v
			}
		}
	}
	return e
}

// cascadeProperties drops the properties whose target node was just deleted: a
// property pointing at nothing could neither show nor hide anything.
func cascadeProperties(doc *opendesignerv1.Document, gone map[string]bool) {
	if len(gone) == 0 {
		return
	}
	for _, c := range doc.GetComponents() {
		kept := c.GetProperties()[:0:0]
		for _, p := range c.GetProperties() {
			if !gone[p.GetNodeId()] {
				kept = append(kept, p)
			}
		}
		if len(kept) != len(c.GetProperties()) {
			c.Properties = kept
		}
	}
}
