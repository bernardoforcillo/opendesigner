package mcp

import (
	"context"
	"fmt"
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// The variant tools. A COMPONENT SET groups components that are variants of one
// another (Size=Small|Large x State=Default|Hover). Each member component says which
// combination it is; an instance switches variant by being pointed at another
// member. The rules live in internal/core/variants.go; these tools validate with
// the same logic before sending, so the agent reads what to fix.

const variantConventions = " Variants: a component SET names properties and their allowed values; each member component has ONE combination (a value for every property, no two members alike). " +
	"Editing a set's properties migrates its members: a new property gives them its first value, a removed value moves its members to the property's first value; it is refused if that would make two members identical. " +
	"swap_instance points an instance at another component (typically the member with another combination); its overrides follow the master nodes by name path and those with no counterpart are dropped."

type VariantPropertyIO struct {
	Name   string   `json:"name" jsonschema:"e.g. Size"`
	Values []string `json:"values" jsonschema:"allowed values, at least one, unique, e.g. [Small, Large]"`
}

type ComponentSetView struct {
	Id         string              `json:"id"`
	Name       string              `json:"name"`
	Properties []VariantPropertyIO `json:"properties"`
	Members    []ComponentView     `json:"members"`
}

type ListComponentSetsOutput struct {
	Sets []ComponentSetView `json:"sets"`
}

func componentSetViews(doc *opendesignerv1.Document) []ComponentSetView {
	ids := make([]string, 0, len(doc.GetComponentSets()))
	for id := range doc.GetComponentSets() {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var out []ComponentSetView
	for _, id := range ids {
		set := doc.GetComponentSets()[id]
		v := ComponentSetView{Id: id, Name: set.GetName(), Properties: []VariantPropertyIO{}, Members: []ComponentView{}}
		for _, p := range set.GetProperties() {
			v.Properties = append(v.Properties, VariantPropertyIO{Name: p.GetName(), Values: p.GetValues()})
		}
		cids := make([]string, 0)
		for cid, c := range doc.GetComponents() {
			if c.GetSetId() == id {
				cids = append(cids, cid)
			}
		}
		sort.Strings(cids)
		for _, cid := range cids {
			c := doc.GetComponents()[cid]
			v.Members = append(v.Members, ComponentView{Id: cid, RootNodeId: c.GetRootNodeId(), Name: c.GetName(), SetId: id, Variant: c.GetVariant()})
		}
		out = append(out, v)
	}
	return out
}

func (s *Session) ListComponentSets(ctx context.Context, _ struct{}) (ListComponentSetsOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := ListComponentSetsOutput{Sets: componentSetViews(s.doc)}
	if out.Sets == nil {
		out.Sets = []ComponentSetView{}
	}
	return out, nil
}

type SetComponentSetInput struct {
	Id         string              `json:"id,omitempty" jsonschema:"omit to CREATE a set; give an existing id to REPLACE its name and properties (members are migrated)"`
	Name       string              `json:"name"`
	Properties []VariantPropertyIO `json:"properties"`
}

type SetComponentSetOutput struct {
	SetId string `json:"setId"`
	Seq   uint64 `json:"seq"`
}

func (s *Session) SetComponentSet(ctx context.Context, in SetComponentSetInput) (SetComponentSetOutput, error) {
	id := in.Id
	s.mu.Lock()
	_, exists := s.doc.GetComponentSets()[id]
	s.mu.Unlock()
	switch {
	case id == "":
		id = uuid.NewString()
	case !exists:
		return SetComponentSetOutput{}, fmt.Errorf("set_component_set: set %q not found (omit id to create a new one; list_component_sets)", id)
	}
	set := &opendesignerv1.ComponentSet{Id: id, Name: in.Name}
	for _, p := range in.Properties {
		set.Properties = append(set.Properties, &opendesignerv1.VariantProperty{Name: p.Name, Values: p.Values})
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComponentSet{SetComponentSet: &opendesignerv1.SetComponentSet{Set: set}}})
	if err != nil {
		return SetComponentSetOutput{}, fmt.Errorf("set_component_set: %w (a set needs a name; property names and values must be non-empty and unique, each property with at least one value; the edit must not make two members the same variant)", err)
	}
	return SetComponentSetOutput{SetId: id, Seq: seq}, nil
}

type SetIdInput struct {
	Id string `json:"id" jsonschema:"id of the set (see list_component_sets)"`
}

func (s *Session) DeleteComponentSet(ctx context.Context, in SetIdInput) (SeqOutput, error) {
	s.mu.Lock()
	_, ok := s.doc.GetComponentSets()[in.Id]
	s.mu.Unlock()
	if !ok {
		return SeqOutput{}, fmt.Errorf("delete_component_set: set %q not found", in.Id)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteComponentSet{DeleteComponentSet: &opendesignerv1.DeleteComponentSet{Id: in.Id}}})
	if err != nil {
		return SeqOutput{}, err
	}
	return SeqOutput{Seq: seq}, nil
}

type SetComponentVariantInput struct {
	ComponentId string            `json:"componentId" jsonschema:"the component (see list_components)"`
	SetId       string            `json:"setId,omitempty" jsonschema:"the set to put it in; empty = take it OUT of its set"`
	Variant     map[string]string `json:"variant,omitempty" jsonschema:"its combination: a value for EVERY property of the set, not shared with another member"`
}

func (s *Session) SetComponentVariant(ctx context.Context, in SetComponentVariantInput) (SeqOutput, error) {
	s.mu.Lock()
	_, compOK := s.doc.GetComponents()[in.ComponentId]
	set := s.doc.GetComponentSets()[in.SetId]
	s.mu.Unlock()
	if !compOK {
		return SeqOutput{}, fmt.Errorf("set_component_variant: component %q not found (list_components)", in.ComponentId)
	}
	if in.SetId != "" && set == nil {
		return SeqOutput{}, fmt.Errorf("set_component_variant: set %q not found (set_component_set creates one)", in.SetId)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComponentVariant{SetComponentVariant: &opendesignerv1.SetComponentVariant{
		ComponentId: in.ComponentId, SetId: in.SetId, Variant: in.Variant,
	}}})
	if err != nil {
		return SeqOutput{}, fmt.Errorf("set_component_variant: %w (give a value for every property of the set; the combination must not belong to another member)", err)
	}
	return SeqOutput{Seq: seq}, nil
}

type SwapInstanceInput struct {
	InstanceId  string `json:"instanceId" jsonschema:"the instance node"`
	ComponentId string `json:"componentId" jsonschema:"the component it should show (for a variant switch: the member with the wanted combination)"`
}

func (s *Session) SwapInstance(ctx context.Context, in SwapInstanceInput) (SeqOutput, error) {
	s.mu.Lock()
	n := s.doc.GetNodes()[in.InstanceId]
	_, compOK := s.doc.GetComponents()[in.ComponentId]
	s.mu.Unlock()
	if n == nil || n.GetInstance() == nil {
		return SeqOutput{}, fmt.Errorf("swap_instance: %q is not an instance node", in.InstanceId)
	}
	if !compOK {
		return SeqOutput{}, fmt.Errorf("swap_instance: component %q not found (list_components)", in.ComponentId)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SwapInstance{SwapInstance: &opendesignerv1.SwapInstance{InstanceId: in.InstanceId, ComponentId: in.ComponentId}}})
	if err != nil {
		return SeqOutput{}, fmt.Errorf("swap_instance: %w", err)
	}
	return SeqOutput{Seq: seq}, nil
}

type CreateInstanceInput struct {
	ComponentId string  `json:"componentId" jsonschema:"the component to place (see list_components)"`
	ParentId    string  `json:"parentId,omitempty" jsonschema:"defaults to the first page"`
	X           float64 `json:"x,omitempty"`
	Y           float64 `json:"y,omitempty"`
	Name        string  `json:"name,omitempty" jsonschema:"defaults to the component's name"`
}

// CreateInstance places an instance of a component; it takes the master's size.
func (s *Session) CreateInstance(ctx context.Context, in CreateInstanceInput) (CreateNodeOutput, error) {
	s.mu.Lock()
	comp := s.doc.GetComponents()[in.ComponentId]
	master := s.doc.GetNodes()[comp.GetRootNodeId()]
	s.mu.Unlock()
	if comp == nil {
		return CreateNodeOutput{}, fmt.Errorf("create_instance: component %q not found (list_components)", in.ComponentId)
	}
	parent := s.resolveParent(in.ParentId)
	if parent == "" {
		return CreateNodeOutput{}, errNoParent
	}
	name := in.Name
	if name == "" {
		name = comp.GetName()
	}
	n := s.newBaseNode(parent, name, in.X, in.Y, master.GetWidth(), master.GetHeight())
	n.Shape = &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: in.ComponentId}}
	return s.createNode(ctx, n)
}

// ---------------------------------------------------------------------------
// component properties
// ---------------------------------------------------------------------------

const propertyConventions = " Component properties: a component declares named controls; an INSTANCE sets them. A boolean property shows or hides one layer of the master, a text property sets one text layer's content (optionally from an option list), a number property writes opacity / corner radius / font size of one layer, a swap property makes a nested instance show another component. " +
	"An instance's value wins over the default, and a property wins over a per-node override of the same layer. Values survive swap_instance; properties the new component lacks are ignored."

type ComponentPropertyIO struct {
	Name      string   `json:"name" jsonschema:"e.g. Label, Show icon"`
	Type      string   `json:"type" jsonschema:"boolean | text | number | swap"`
	NodeId    string   `json:"nodeId" jsonschema:"a node INSIDE the component's master: the layer to show/hide (boolean), the text layer (text), the node whose attribute the number drives (number), or the NESTED INSTANCE to replace (swap)"`
	Default   string   `json:"default,omitempty" jsonschema:"boolean: true (default) | false. text: the text (one of options if given); number: the number; swap: a component id. Empty keeps the master's own value"`
	Attribute string   `json:"attribute,omitempty" jsonschema:"number only: opacity (0..1) | corner_radius (rectangle) | font_size (text)"`
	Options   []string `json:"options,omitempty" jsonschema:"text only: an option list; the value must be one of them. Empty = free text"`
}

var propTypeNames = map[opendesignerv1.ComponentPropertyType]string{
	opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_BOOLEAN:       "boolean",
	opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_TEXT:          "text",
	opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_NUMBER:        "number",
	opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_INSTANCE_SWAP: "swap",
}

func propertyViews(c *opendesignerv1.Component) []ComponentPropertyIO {
	var out []ComponentPropertyIO
	for _, p := range c.GetProperties() {
		out = append(out, ComponentPropertyIO{Name: p.GetName(), Type: propTypeNames[p.GetType()], NodeId: p.GetNodeId(), Default: p.GetDefaultValue(), Attribute: p.GetAttribute(), Options: p.GetOptions()})
	}
	return out
}

type SetComponentPropertiesInput struct {
	ComponentId string                `json:"componentId"`
	Properties  []ComponentPropertyIO `json:"properties" jsonschema:"the COMPLETE list (it replaces the current one; [] removes all)"`
}

func (s *Session) SetComponentProperties(ctx context.Context, in SetComponentPropertiesInput) (SeqOutput, error) {
	s.mu.Lock()
	_, ok := s.doc.GetComponents()[in.ComponentId]
	s.mu.Unlock()
	if !ok {
		return SeqOutput{}, fmt.Errorf("set_component_properties: component %q not found (list_components)", in.ComponentId)
	}
	props := make([]*opendesignerv1.ComponentProperty, 0, len(in.Properties))
	for _, p := range in.Properties {
		var typ opendesignerv1.ComponentPropertyType
		for t, n := range propTypeNames {
			if n == p.Type {
				typ = t
			}
		}
		if typ == opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_UNSPECIFIED {
			return SeqOutput{}, fmt.Errorf("set_component_properties: type of %q must be boolean, text, number or swap, got %q", p.Name, p.Type)
		}
		props = append(props, &opendesignerv1.ComponentProperty{Name: p.Name, Type: typ, NodeId: p.NodeId, DefaultValue: p.Default, Attribute: p.Attribute, Options: p.Options})
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComponentProperties{SetComponentProperties: &opendesignerv1.SetComponentProperties{ComponentId: in.ComponentId, Properties: props}}})
	if err != nil {
		return SeqOutput{}, fmt.Errorf("set_component_properties: %w (names unique and non-empty; nodeId must be inside the component's master; a text property needs a text node; a number needs attribute opacity, corner_radius or font_size on a fitting node; a swap needs a nested instance and an existing component as default; a boolean default is true or false)", err)
	}
	return SeqOutput{Seq: seq}, nil
}

type SetInstancePropertyInput struct {
	InstanceId string `json:"instanceId"`
	Name       string `json:"name" jsonschema:"a property of the instance's component"`
	Value      string `json:"value,omitempty" jsonschema:"boolean: true | false. text: the text (an option if the property has options). number: a number. swap: a component id. Empty = back to the default"`
}

func (s *Session) SetInstanceProperty(ctx context.Context, in SetInstancePropertyInput) (SeqOutput, error) {
	s.mu.Lock()
	n := s.doc.GetNodes()[in.InstanceId]
	s.mu.Unlock()
	if n == nil || n.GetInstance() == nil {
		return SeqOutput{}, fmt.Errorf("set_instance_property: %q is not an instance node", in.InstanceId)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstanceProperty{SetInstanceProperty: &opendesignerv1.SetInstanceProperty{InstanceId: in.InstanceId, Name: in.Name, Value: in.Value}}})
	if err != nil {
		return SeqOutput{}, fmt.Errorf("set_instance_property: %w (the component must declare that property; list_components shows them; a boolean takes true or false, a number a number, a swap an existing component id, an option text one of its options)", err)
	}
	return SeqOutput{Seq: seq}, nil
}

func registerVariantTools(srv *mcp.Server, s *Session) {
	addTool(srv, "list_component_sets", "List the variant sets with their properties, allowed values and member components (each with its combination)."+variantConventions, s.ListComponentSets)
	addTool(srv, "set_component_set", "Create a variant set (omit id) or replace one's name and properties (give id). Returns the set id."+variantConventions, s.SetComponentSet)
	addTool(srv, "delete_component_set", "Delete a set; its members stay components but are no longer variants."+variantConventions, s.DeleteComponentSet)
	addTool(srv, "set_component_variant", "Put a component in a set with a full combination, or (setId empty) take it out."+variantConventions, s.SetComponentVariant)
	addTool(srv, "set_component_properties", "Replace a component's property definitions (boolean: show/hide a layer; text: set a text layer)."+propertyConventions, s.SetComponentProperties)
	addTool(srv, "set_instance_property", "Set one property of an instance (empty value = back to the default)."+propertyConventions, s.SetInstanceProperty)
	addTool(srv, "create_instance", "Place an instance of a component (it shows the master and follows it). Returns the node id; use swap_instance to switch it to another variant."+variantConventions, s.CreateInstance)
	addTool(srv, "swap_instance", "Point an instance at another component; use it to switch an instance to another variant."+variantConventions, s.SwapInstance)
}
