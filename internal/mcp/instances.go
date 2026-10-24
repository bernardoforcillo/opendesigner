package mcp

import (
	"context"
	"fmt"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

// instanceNode returns the instance node `id` or a tool error naming the tool.
func (s *Session) instanceNode(tool, id string) (*opendesignerv1.Node, error) {
	n, ok := s.doc.GetNodes()[id]
	switch {
	case !ok:
		return nil, fmt.Errorf("%s: node %q not found (list_nodes for the ids)", tool, id)
	case n.GetInstance() == nil:
		return nil, fmt.Errorf("%s: node %q is not a component instance", tool, id)
	}
	return n, nil
}

// SwapInstanceInput points an instance at another component.
type SwapInstanceInput struct {
	InstanceId  string `json:"instanceId"`
	ComponentId string `json:"componentId" jsonschema:"the component to show instead (list_components)"`
}

type SwapInstanceOutput struct {
	Seq uint64 `json:"seq"`
	// Kept / Dropped count the overrides that were carried over to the new component's layers and the ones that had no counterpart.
	KeptOverrides    int `json:"keptOverrides"`
	DroppedOverrides int `json:"droppedOverrides"`
}

// SwapInstance changes which component an instance points to. Overrides on layers the new
// master also has (same kind and name at the same place), property values the new component
// also defines and variant choices its set also has are kept; the instance takes the new
// master's size.
func (s *Session) SwapInstance(ctx context.Context, in SwapInstanceInput) (SwapInstanceOutput, error) {
	s.mu.Lock()
	n, err := s.instanceNode("swap_instance", in.InstanceId)
	var next *opendesignerv1.InstanceNode
	var w, h float64
	var resize bool
	dropped := 0
	if err == nil {
		dropped = len(n.GetInstance().GetOverrides())
		if next, err = core.SwapInstance(s.doc, in.InstanceId, in.ComponentId); err == nil {
			w, h, resize = core.SwapSize(s.doc, next)
			resize = resize && (w != n.GetWidth() || h != n.GetHeight())
		}
	}
	s.mu.Unlock()
	if err != nil {
		return SwapInstanceOutput{}, fmt.Errorf("swap_instance: %w", err)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstance{SetInstance: &opendesignerv1.SetInstance{InstanceId: in.InstanceId, Instance: next}}})
	if err != nil {
		return SwapInstanceOutput{}, err
	}
	if resize {
		if seq, err = s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
			Id: in.InstanceId, Patch: &opendesignerv1.Node{Width: w, Height: h}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"width", "height"}},
		}}}); err != nil {
			return SwapInstanceOutput{}, err
		}
	}
	return SwapInstanceOutput{Seq: seq, KeptOverrides: len(next.GetOverrides()), DroppedOverrides: dropped - len(next.GetOverrides())}, nil
}

// DetachInstanceInput turns an instance into plain nodes.
type DetachInstanceInput struct {
	InstanceId string `json:"instanceId"`
}

// DetachInstance replaces an instance with a copy of the master it renders (overrides, property
// values and the variant choice baked in). The node keeps its id, name, place and size; nested
// instances stay instances. Flow transitions that pointed at the instance go with the old node.
func (s *Session) DetachInstance(ctx context.Context, in DetachInstanceInput) (NodesOutput, error) {
	s.mu.Lock()
	var ops []*opendesignerv1.Op
	_, err := s.instanceNode("detach_instance", in.InstanceId)
	if err == nil {
		ops, err = core.DetachInstance(s.doc, in.InstanceId, uuid.NewString)
	}
	s.mu.Unlock()
	if err != nil {
		return NodesOutput{}, fmt.Errorf("detach_instance: %w", err)
	}
	out := NodesOutput{}
	for _, op := range ops {
		seq, err := s.submit(ctx, op)
		if err != nil {
			return out, err
		}
		out.Seq = seq
	}
	out.Changed = len(ops) - 1
	return out, nil
}

// ResetOverridesInput resets an instance's overrides.
type ResetOverridesInput struct {
	InstanceId   string `json:"instanceId"`
	MasterNodeId string `json:"masterNodeId,omitempty" jsonschema:"reset only the override on this master node; omit to reset everything (overrides, property values and the variant choice)"`
}

// ResetInstanceOverrides clears one override of an instance, or all of its changes.
func (s *Session) ResetInstanceOverrides(ctx context.Context, in ResetOverridesInput) (SeqOutput, error) {
	s.mu.Lock()
	_, err := s.instanceNode("reset_instance_overrides", in.InstanceId)
	var all *opendesignerv1.InstanceNode
	if err == nil && in.MasterNodeId == "" {
		all, err = core.ResetInstance(s.doc, in.InstanceId)
	}
	s.mu.Unlock()
	if err != nil {
		return SeqOutput{}, err
	}
	var op *opendesignerv1.Op
	if in.MasterNodeId == "" {
		op = &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstance{SetInstance: &opendesignerv1.SetInstance{InstanceId: in.InstanceId, Instance: all}}}
	} else {
		// An override with nothing present IS a removal.
		op = &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstanceOverride{SetInstanceOverride: &opendesignerv1.SetInstanceOverride{
			InstanceId: in.InstanceId, Override: &opendesignerv1.InstanceOverride{MasterNodeId: in.MasterNodeId},
		}}}
	}
	seq, err := s.submit(ctx, op)
	return SeqOutput{Seq: seq}, err
}

// MainComponentInput finds the master behind an instance.
type MainComponentInput struct {
	NodeId string `json:"nodeId" jsonschema:"an instance, or any node inside a master"`
}

type MainComponentOutput struct {
	ComponentId string `json:"componentId"`
	Name        string `json:"name"`
	RootNodeId  string `json:"rootNodeId" jsonschema:"the master's root node (select it to edit the component)"`
	PageId      string `json:"pageId" jsonschema:"the page the master lives on"`
}

// GetMainComponent resolves the master an instance renders (the variant it chose, if any).
func (s *Session) GetMainComponent(ctx context.Context, in MainComponentInput) (MainComponentOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	n, ok := s.doc.GetNodes()[in.NodeId]
	if !ok {
		return MainComponentOutput{}, fmt.Errorf("get_main_component: node %q not found", in.NodeId)
	}
	cid := ""
	if inst := n.GetInstance(); inst != nil {
		cid = core.EffectiveComponentID(s.doc, inst)
	}
	comp := s.doc.GetComponents()[cid]
	if comp == nil {
		return MainComponentOutput{}, fmt.Errorf("get_main_component: node %q is not an instance of a known component", in.NodeId)
	}
	return MainComponentOutput{ComponentId: cid, Name: comp.GetName(), RootNodeId: comp.GetRootNodeId(), PageId: core.PageOf(s.doc, comp.GetRootNodeId())}, nil
}

func registerInstanceTools(srv *mcp.Server, s *Session) {
	addTool(srv, "swap_instance", "Change which component an instance points to. Overrides on layers the new master also has (same kind and name at the same place), property values the new component also defines and variant choices its set also has are kept; the instance takes the new master's size. Refused when the new component contains the instance.", s.SwapInstance)
	addTool(srv, "detach_instance", "Turn an instance into plain nodes: the master it renders is copied in its place with the overrides, property values and variant baked in. The node keeps its id, name, place and size; nested instances stay instances.", s.DetachInstance)
	addTool(srv, "reset_instance_overrides", "Reset an instance: one override (masterNodeId) or everything (overrides, property values and variant choice).", s.ResetInstanceOverrides)
	addTool(srv, "get_main_component", "Find the master behind an instance (the variant it chose): component id, root node id and the page it lives on -- the 'go to main component' lookup.", s.GetMainComponent)
}
