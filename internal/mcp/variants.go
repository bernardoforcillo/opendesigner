package mcp

import (
	"context"
	"fmt"
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// The component variants and properties tools: the agent groups components into SETS
// (axes such as State or Size), puts each component on one option per axis, defines the
// PROPERTIES an instance can set and sets them on instances. The model lives in
// internal/core/components.go and docs/components.md; the tools run the authority's own
// validators before submitting, so the error says what to fix.

type VariantAxisIO struct {
	Name    string   `json:"name" jsonschema:"e.g. State"`
	Options []string `json:"options" jsonschema:"e.g. [\"default\",\"hover\"]; at least one"`
}

type ComponentSetView struct {
	Id      string          `json:"id"`
	Name    string          `json:"name"`
	Axes    []VariantAxisIO `json:"axes"`
	Members []string        `json:"members" jsonschema:"ids of the components that are variants of this set"`
}

type ComponentPropertyIO struct {
	Name          string   `json:"name" jsonschema:"unique within the component; instances store values by this name"`
	Type          string   `json:"type" jsonschema:"boolean (shows/hides the target nodes) | text (sets the content of the target text nodes)"`
	DefaultValue  string   `json:"defaultValue" jsonschema:"boolean: \"true\" or \"false\"; text: the default content"`
	TargetNodeIds []string `json:"targetNodeIds" jsonschema:"nodes INSIDE the component's master that it controls (text nodes for a text property)"`
}

type ListComponentSetsOutput struct {
	ComponentSets []ComponentSetView `json:"componentSets"`
}

const variantsConventions = " Components: a COMPONENT SET groups the variants of a component along named AXES (State: default | hover; Size: sm | md); each member component assigns exactly one option per axis and no two members share a combination. " +
	"A component can define PROPERTIES: a boolean shows or hides nodes of its master, a text sets the content of its text nodes. " +
	"An INSTANCE chooses a variant (variantProps: axis -> option; axes it leaves out keep the base component's option) and sets property values (propertyValues: property name -> value; absent = the default). " +
	"Deleting a node removes it from the property targets; deleting a set or changing its axes detaches the members that no longer fit."

func axisViews(set *opendesignerv1.ComponentSet) []VariantAxisIO {
	out := make([]VariantAxisIO, 0, len(set.GetAxes()))
	for _, a := range set.GetAxes() {
		out = append(out, VariantAxisIO{Name: a.GetName(), Options: append([]string{}, a.GetOptions()...)})
	}
	return out
}

func propertyTypeName(t opendesignerv1.ComponentPropertyType) string {
	if t == opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_BOOLEAN {
		return "boolean"
	}
	return "text"
}

func propertyViews(c *opendesignerv1.Component) []ComponentPropertyIO {
	out := make([]ComponentPropertyIO, 0, len(c.GetProperties()))
	for _, p := range c.GetProperties() {
		out = append(out, ComponentPropertyIO{Name: p.GetName(), Type: propertyTypeName(p.GetType()), DefaultValue: p.GetDefaultValue(), TargetNodeIds: append([]string{}, p.GetTargetNodeIds()...)})
	}
	return out
}

func componentSetViews(doc *opendesignerv1.Document) []ComponentSetView {
	ids := make([]string, 0, len(doc.GetComponentSets()))
	for id := range doc.GetComponentSets() {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]ComponentSetView, 0, len(ids))
	for _, id := range ids {
		set := doc.GetComponentSets()[id]
		v := ComponentSetView{Id: id, Name: set.GetName(), Axes: axisViews(set), Members: []string{}}
		for cid, c := range doc.GetComponents() {
			if c.GetSetId() == id {
				v.Members = append(v.Members, cid)
			}
		}
		sort.Strings(v.Members)
		out = append(out, v)
	}
	return out
}

func (s *Session) ListComponentSets(_ context.Context, _ struct{}) (ListComponentSetsOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return ListComponentSetsOutput{ComponentSets: componentSetViews(s.doc)}, nil
}

type SetComponentSetInput struct {
	Id   string          `json:"id,omitempty" jsonschema:"id of an existing set to REPLACE (members that no longer fit are detached); omit to create one"`
	Name string          `json:"name"`
	Axes []VariantAxisIO `json:"axes"`
}

type SetComponentSetOutput struct {
	ComponentSetId string `json:"componentSetId"`
	Seq            uint64 `json:"seq"`
}

func (s *Session) SetComponentSet(ctx context.Context, in SetComponentSetInput) (SetComponentSetOutput, error) {
	id := in.Id
	s.mu.Lock()
	if id == "" {
		id = uuid.NewString()
	} else if _, ok := s.doc.GetComponentSets()[id]; !ok {
		s.mu.Unlock()
		return SetComponentSetOutput{}, fmt.Errorf("set_component_set: set %q not found (omit id to create one; list_component_sets for the ids)", id)
	}
	s.mu.Unlock()
	set := &opendesignerv1.ComponentSet{Id: id, Name: in.Name}
	for _, a := range in.Axes {
		set.Axes = append(set.Axes, &opendesignerv1.VariantAxis{Name: a.Name, Options: a.Options})
	}
	if err := core.ValidateComponentSet(set); err != nil {
		return SetComponentSetOutput{}, fmt.Errorf("set_component_set: %w", err)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComponentSet{SetComponentSet: &opendesignerv1.SetComponentSet{ComponentSet: set}}})
	if err != nil {
		return SetComponentSetOutput{}, err
	}
	return SetComponentSetOutput{ComponentSetId: id, Seq: seq}, nil
}

func (s *Session) DeleteComponentSet(ctx context.Context, in IdInput) (SeqOutput, error) {
	s.mu.Lock()
	_, ok := s.doc.GetComponentSets()[in.Id]
	s.mu.Unlock()
	if !ok {
		return SeqOutput{}, fmt.Errorf("delete_component_set: set %q not found (list_component_sets for the ids)", in.Id)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteComponentSet{DeleteComponentSet: &opendesignerv1.DeleteComponentSet{Id: in.Id}}})
	return SeqOutput{Seq: seq}, err
}

type SetComponentDefInput struct {
	ComponentId string                `json:"componentId"`
	SetId       string                `json:"setId,omitempty" jsonschema:"the set this component is a variant of; empty = standalone"`
	Variant     map[string]string     `json:"variant,omitempty" jsonschema:"axis name -> option, for EVERY axis of the set (none without a set)"`
	Properties  []ComponentPropertyIO `json:"properties,omitempty" jsonschema:"REPLACES the component's properties; read them with list_components first to edit"`
}

func (in SetComponentDefInput) toProto() (*opendesignerv1.SetComponentDef, error) {
	def := &opendesignerv1.SetComponentDef{ComponentId: in.ComponentId, SetId: in.SetId, Variant: in.Variant}
	for _, p := range in.Properties {
		var t opendesignerv1.ComponentPropertyType
		switch p.Type {
		case "boolean":
			t = opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_BOOLEAN
		case "text":
			t = opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_TEXT
		default:
			return nil, fmt.Errorf("property %q: type must be boolean or text, got %q", p.Name, p.Type)
		}
		def.Properties = append(def.Properties, &opendesignerv1.ComponentProperty{
			Name: p.Name, Type: t, DefaultValue: p.DefaultValue, TargetNodeIds: p.TargetNodeIds,
		})
	}
	return def, nil
}

// SetComponentDef replaces a component's set membership, variant and properties
// wholesale: read them with list_components, edit, send them all back.
func (s *Session) SetComponentDef(ctx context.Context, in SetComponentDefInput) (SeqOutput, error) {
	def, err := in.toProto()
	if err == nil {
		s.mu.Lock()
		err = core.ValidateComponentDef(s.doc, def)
		s.mu.Unlock()
	}
	if err != nil {
		return SeqOutput{}, fmt.Errorf("set_component_def: %w", err)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComponentDef{SetComponentDef: def}})
	return SeqOutput{Seq: seq}, err
}

type SetInstancePropsInput struct {
	InstanceId     string            `json:"instanceId"`
	PropertyValues map[string]string `json:"propertyValues,omitempty" jsonschema:"property name -> value, of the component the instance resolves to; REPLACES the instance's values"`
	VariantProps   map[string]string `json:"variantProps,omitempty" jsonschema:"axis name -> option; REPLACES the instance's variant choice"`
}

func (s *Session) SetInstanceProps(ctx context.Context, in SetInstancePropsInput) (SeqOutput, error) {
	s.mu.Lock()
	n, ok := s.doc.GetNodes()[in.InstanceId]
	var err error
	switch {
	case !ok:
		err = fmt.Errorf("node %q not found (list_nodes for the ids)", in.InstanceId)
	case n.GetInstance() == nil:
		err = fmt.Errorf("node %q is not a component instance", in.InstanceId)
	default:
		err = core.ValidateInstanceProps(s.doc, n.GetInstance(), in.PropertyValues, in.VariantProps)
	}
	s.mu.Unlock()
	if err != nil {
		return SeqOutput{}, fmt.Errorf("set_instance_props: %w", err)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstanceProps{SetInstanceProps: &opendesignerv1.SetInstanceProps{
		InstanceId: in.InstanceId, PropertyValues: in.PropertyValues, VariantProps: in.VariantProps,
	}}})
	return SeqOutput{Seq: seq}, err
}

type CreateInstanceInput struct {
	ComponentId string  `json:"componentId" jsonschema:"the component to instantiate (see list_components)"`
	ParentId    string  `json:"parentId,omitempty" jsonschema:"defaults to the first page"`
	X           float64 `json:"x"`
	Y           float64 `json:"y"`
	Name        string  `json:"name,omitempty"`
}

// CreateInstance places an instance of a component: it renders the component's master
// (or the variant it chooses, see set_instance_props) at x/y.
func (s *Session) CreateInstance(ctx context.Context, in CreateInstanceInput) (CreateNodeOutput, error) {
	s.mu.Lock()
	comp, ok := s.doc.GetComponents()[in.ComponentId]
	var root *opendesignerv1.Node
	if ok {
		root = s.doc.GetNodes()[comp.GetRootNodeId()]
	}
	s.mu.Unlock()
	if !ok || root == nil {
		return CreateNodeOutput{}, fmt.Errorf("create_instance: component %q (or its master) not found (list_components for the ids)", in.ComponentId)
	}
	parent := s.resolveParent(in.ParentId)
	if parent == "" {
		return CreateNodeOutput{}, errNoParent
	}
	name := in.Name
	if name == "" {
		name = comp.GetName()
	}
	n := s.newBaseNode(parent, name, in.X, in.Y, root.GetWidth(), root.GetHeight())
	n.Shape = &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{ComponentId: in.ComponentId}}
	return s.createNode(ctx, n)
}

func registerVariantTools(srv *mcp.Server, s *Session) {
	addTool(srv, "create_instance", "Place an instance of a component at x/y (parentId defaults to the first page). Choose its variant and set its properties with set_instance_props."+variantsConventions, s.CreateInstance)
	addTool(srv, "list_component_sets", "List the document's component sets: axes, options and the member components."+variantsConventions, s.ListComponentSets)
	addTool(srv, "set_component_set", "Create a component set (omit id) or REPLACE one (read it with list_component_sets). Changing the axes detaches the members that no longer fit: reassign them with set_component_def."+variantsConventions, s.SetComponentSet)
	addTool(srv, "delete_component_set", "Delete a component set; its members become standalone components.", s.DeleteComponentSet)
	addTool(srv, "set_component_def", "Put a component in a set on one option per axis and/or define its properties. REPLACES its set membership, variant and properties wholesale (list_components shows the current ones)."+variantsConventions, s.SetComponentDef)
	addTool(srv, "set_instance_props", "Choose the variant of an instance and set its property values. REPLACES both maps."+variantsConventions, s.SetInstanceProps)
}
