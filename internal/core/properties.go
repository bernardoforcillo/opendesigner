package core

import (
	"errors"
	"fmt"
	"strconv"

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

// numberAttrs: the node attributes a NUMBER property can drive.
var numberAttrs = map[string]bool{"opacity": true, "corner_radius": true, "font_size": true}

func isNumber(v string) bool {
	f, err := strconv.ParseFloat(v, 64)
	return err == nil && f == f && f < 1e15 && f > -1e15
}

// validPropertyValue checks a value against a property definition (an empty
// value is "use the default" and is checked by the callers).
func validPropertyValue(doc *opendesignerv1.Document, p *opendesignerv1.ComponentProperty, v string) bool {
	switch p.GetType() {
	case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_BOOLEAN:
		return v == "true" || v == "false"
	case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_NUMBER:
		return isNumber(v)
	case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_INSTANCE_SWAP:
		return doc.GetComponents()[v] != nil
	case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_TEXT:
		if len(p.GetOptions()) == 0 {
			return true
		}
		for _, o := range p.GetOptions() {
			if o == v {
				return true
			}
		}
		return false
	}
	return false
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
		def := p.GetDefaultValue()
		switch p.GetType() {
		case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_BOOLEAN:
			if def == "" {
				def = "true"
			}
		case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_TEXT:
			if node.GetText() == nil {
				return fmt.Errorf("%w: text property %q needs a text node", ErrBadProperty, p.GetName())
			}
			if err := validOptions(p); err != nil {
				return err
			}
		case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_NUMBER:
			if !numberAttrs[p.GetAttribute()] {
				return fmt.Errorf("%w: number property %q needs an attribute: opacity, corner_radius or font_size", ErrBadProperty, p.GetName())
			}
			if (p.GetAttribute() == "corner_radius" && node.GetRect() == nil && node.GetShape() != nil) ||
				(p.GetAttribute() == "font_size" && node.GetText() == nil) {
				return fmt.Errorf("%w: %q cannot drive %s of this node", ErrBadProperty, p.GetName(), p.GetAttribute())
			}
		case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_INSTANCE_SWAP:
			if node.GetInstance() == nil {
				return fmt.Errorf("%w: swap property %q needs an instance node", ErrBadProperty, p.GetName())
			}
			if def == s.GetComponentId() {
				return fmt.Errorf("%w: a component cannot be swapped into itself (%q)", ErrBadProperty, p.GetName())
			}
		default:
			return fmt.Errorf("%w: %q has an unknown type", ErrBadProperty, p.GetName())
		}
		// An empty default means "keep what the master has" for everything but a boolean.
		if def != "" && !validPropertyValue(doc, p, def) {
			return fmt.Errorf("%w: default %q of %q is not valid for its type", ErrBadProperty, def, p.GetName())
		}
		props = append(props, &opendesignerv1.ComponentProperty{
			Name: p.GetName(), Type: p.GetType(), NodeId: p.GetNodeId(), DefaultValue: def,
			Attribute: p.GetAttribute(), Options: p.GetOptions(),
		})
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
	if !validPropertyValue(doc, def, s.GetValue()) {
		return fmt.Errorf("%w: %q takes %s, got %q", ErrBadProperty, s.GetName(), valueHint(def), s.GetValue())
	}
	if inst.PropertyValues == nil {
		inst.PropertyValues = map[string]string{}
	}
	inst.PropertyValues[s.GetName()] = s.GetValue()
	return nil
}

func valueHint(p *opendesignerv1.ComponentProperty) string {
	switch p.GetType() {
	case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_BOOLEAN:
		return "true or false"
	case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_NUMBER:
		return "a number"
	case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_INSTANCE_SWAP:
		return "the id of an existing component"
	}
	return "one of its options"
}

// validOptions: an option list holds unique non-empty strings.
func validOptions(p *opendesignerv1.ComponentProperty) error {
	seen := map[string]bool{}
	for _, o := range p.GetOptions() {
		if o == "" || seen[o] {
			return fmt.Errorf("%w: %q has an empty or duplicate option %q", ErrBadProperty, p.GetName(), o)
		}
		seen[o] = true
	}
	return nil
}

// InstanceEffects is what an instance's property values do to its master, per
// master node: a visibility to force (shown or hidden) and a text to write.
type InstanceEffects struct {
	Visible map[string]bool
	Text    map[string]string
	// Opacity, CornerRadius and FontSize: numbers written to a master node's attribute.
	Opacity, CornerRadius, FontSize map[string]float64
	// Swap: nested instance node -> the component id it should show.
	Swap map[string]string
}

// EffectsOf resolves an instance's properties (value, else default) against its
// component. Properties win over per-node overrides; callers apply them last.
func EffectsOf(doc *opendesignerv1.Document, inst *opendesignerv1.InstanceNode) InstanceEffects {
	return EffectsWith(doc.GetComponents()[inst.GetComponentId()], inst.GetPropertyValues())
}

// EffectsWith is EffectsOf for a component and explicit values (nil = defaults).
func EffectsWith(comp *opendesignerv1.Component, values map[string]string) InstanceEffects {
	e := InstanceEffects{
		Visible: map[string]bool{}, Text: map[string]string{},
		Opacity: map[string]float64{}, CornerRadius: map[string]float64{}, FontSize: map[string]float64{},
		Swap: map[string]string{},
	}
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
		case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_NUMBER:
			if f, err := strconv.ParseFloat(v, 64); err == nil && v != "" {
				switch p.GetAttribute() {
				case "opacity":
					e.Opacity[p.GetNodeId()] = f
				case "corner_radius":
					e.CornerRadius[p.GetNodeId()] = f
				case "font_size":
					e.FontSize[p.GetNodeId()] = f
				}
			}
		case opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_INSTANCE_SWAP:
			if v != "" { // empty = the nested instance keeps its own component
				e.Swap[p.GetNodeId()] = v
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
