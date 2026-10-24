package core

import (
	"errors"
	"fmt"
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
)

// INSTANCE OPERATIONS -- swap, reset, detach and "go to main component". The Go half (the
// authority) of web/src/store/instanceOps.ts.
//
// One op carries them all: SetInstance replaces an instance's payload WHOLESALE (component,
// overrides, property values, variant choice), so a swap is the same op with another
// component_id and a reset the same op with the lists emptied; its inverse is the previous
// payload. The helpers below compute the payloads (what a swap carries over) and the ops of a
// detach, which needs no op of its own: it is a DeleteNode of the instance and CreateNodes of
// the plain nodes that take its place, so undo and replication come for free.

var (
	ErrInstanceCycle = errors.New("core: an instance cannot show a component that contains it")
	ErrInstanceBody  = errors.New("core: invalid instance payload")
)

// containingComponents lists the components whose master subtree holds node `id`.
func containingComponents(doc *opendesignerv1.Document, id string) []string {
	var out []string
	for cid, c := range doc.GetComponents() {
		if c.GetRootNodeId() != "" && inMasterSubtree(doc, id, c.GetRootNodeId()) {
			out = append(out, cid)
		}
	}
	sort.Strings(out)
	return out
}

// componentReaches: showing component `from` ends up showing an instance of `target`
// (directly or through nested instances, and through the variants of the sets it shows).
func componentReaches(doc *opendesignerv1.Document, from, target string, seen map[string]bool) bool {
	if from == target {
		return true
	}
	if seen[from] {
		return false
	}
	seen[from] = true
	// Any member of from's set can be the one an instance shows.
	cands := []string{from}
	if set := doc.GetComponents()[from].GetSetId(); set != "" {
		for cid, c := range doc.GetComponents() {
			if c.GetSetId() == set && cid != from {
				cands = append(cands, cid)
			}
		}
	}
	for _, cid := range cands {
		c := doc.GetComponents()[cid]
		if c == nil {
			continue
		}
		for _, n := range SubtreeOf(doc, c.GetRootNodeId()) {
			if inst := n.GetInstance(); inst != nil && componentReaches(doc, inst.GetComponentId(), target, seen) {
				return true
			}
		}
	}
	return false
}

// instanceCycle: instance node `id`, pointing at `componentID`, would show itself.
func instanceCycle(doc *opendesignerv1.Document, id, componentID string) bool {
	for _, host := range containingComponents(doc, id) {
		if componentReaches(doc, componentID, host, map[string]bool{}) {
			return true
		}
	}
	return false
}

// overrideTargetOK: an override names a node of the master of the component (or of a variant
// of its set) -- the ones an instance can show.
func overrideTargetOK(doc *opendesignerv1.Document, base *opendesignerv1.Component, masterNodeID string) bool {
	if _, ok := doc.GetNodes()[masterNodeID]; !ok {
		return false
	}
	if inMasterSubtree(doc, masterNodeID, base.GetRootNodeId()) {
		return true
	}
	if base.GetSetId() == "" {
		return false
	}
	for _, c := range doc.GetComponents() {
		if c.GetSetId() == base.GetSetId() && inMasterSubtree(doc, masterNodeID, c.GetRootNodeId()) {
			return true
		}
	}
	return false
}

func validateInstanceBody(doc *opendesignerv1.Document, id string, in *opendesignerv1.InstanceNode) error {
	if in == nil {
		return fmt.Errorf("%w: empty", ErrInstanceBody)
	}
	base := doc.GetComponents()[in.GetComponentId()]
	if base == nil || doc.GetNodes()[base.GetRootNodeId()] == nil {
		return fmt.Errorf("%w: %s", ErrComponentNotFound, in.GetComponentId())
	}
	if instanceCycle(doc, id, in.GetComponentId()) {
		return fmt.Errorf("%w: %s in %s", ErrInstanceCycle, id, in.GetComponentId())
	}
	seen := map[string]bool{}
	for _, o := range in.GetOverrides() {
		if o.GetMasterNodeId() == "" || seen[o.GetMasterNodeId()] || !(o.GetFillsPresent() || o.GetTextPresent()) ||
			!overrideTargetOK(doc, base, o.GetMasterNodeId()) {
			return fmt.Errorf("%w: override on %q", ErrInstanceBody, o.GetMasterNodeId())
		}
		seen[o.GetMasterNodeId()] = true
	}
	return validateInstanceProps(doc, in, in.GetPropertyValues(), in.GetVariantProps())
}

// applySetInstance replaces an instance's payload wholesale. The node's own transform is not
// touched (write width/height with SetProperties).
func applySetInstance(doc *opendesignerv1.Document, s *opendesignerv1.SetInstance, cow *Shared) error {
	n, ok := doc.Nodes[s.GetInstanceId()]
	if !ok {
		return fmt.Errorf("%w: %s", ErrNodeNotFound, s.GetInstanceId())
	}
	if n.GetInstance() == nil {
		return fmt.Errorf("%w: %s", ErrNotInstanceNode, s.GetInstanceId())
	}
	if err := validateInstanceBody(doc, s.GetInstanceId(), s.GetInstance()); err != nil {
		return err
	}
	n = cow.mut(doc, s.GetInstanceId())
	n.GetInstance().ComponentId = s.GetInstance().GetComponentId()
	n.GetInstance().Overrides = nil
	for _, o := range s.GetInstance().GetOverrides() {
		n.GetInstance().Overrides = append(n.GetInstance().Overrides, proto.Clone(o).(*opendesignerv1.InstanceOverride))
	}
	n.GetInstance().PropertyValues, n.GetInstance().VariantProps = nil, nil
	if v := s.GetInstance().GetPropertyValues(); len(v) > 0 {
		n.GetInstance().PropertyValues = map[string]string{}
		for k, x := range v {
			n.GetInstance().PropertyValues[k] = x
		}
	}
	if v := s.GetInstance().GetVariantProps(); len(v) > 0 {
		n.GetInstance().VariantProps = map[string]string{}
		for k, x := range v {
			n.GetInstance().VariantProps[k] = x
		}
	}
	return nil
}

// ValidateInstanceBody is for the MCP tools, which run the authority's own checks first.
func ValidateInstanceBody(doc *opendesignerv1.Document, id string, in *opendesignerv1.InstanceNode) error {
	return validateInstanceBody(doc, id, in)
}

// masterKey identifies a node among its siblings across two masters: its kind of shape, its
// name and which of the siblings with that kind and name it is.
func masterKey(n *opendesignerv1.Node, occurrence int) string {
	return fmt.Sprintf("%T|%s|%d", n.GetShape(), n.GetName(), occurrence)
}

// matchMasters pairs the nodes of two master subtrees that are "the same layer": same kind,
// same name, same position among the siblings of that kind and name, from the roots down.
// The roots pair when they have the same kind. It returns old node id -> new node id.
func matchMasters(doc *opendesignerv1.Document, oldRoot, newRoot string) map[string]string {
	out := map[string]string{}
	o, n := doc.GetNodes()[oldRoot], doc.GetNodes()[newRoot]
	if o == nil || n == nil || fmt.Sprintf("%T", o.GetShape()) != fmt.Sprintf("%T", n.GetShape()) {
		return out
	}
	var walk func(a, b string)
	walk = func(a, b string) {
		out[a] = b
		idx := func(parent string) map[string]*opendesignerv1.Node {
			m := map[string]*opendesignerv1.Node{}
			seen := map[string]int{}
			for _, c := range ChildrenOf(doc, parent) {
				k := fmt.Sprintf("%T|%s", c.GetShape(), c.GetName())
				m[masterKey(c, seen[k])] = c
				seen[k]++
			}
			return m
		}
		ia, ib := idx(a), idx(b)
		keys := make([]string, 0, len(ia))
		for k := range ia {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if cb, ok := ib[k]; ok {
				walk(ia[k].GetId(), cb.GetId())
			}
		}
	}
	walk(oldRoot, newRoot)
	return out
}

// SwapInstance computes the payload of instance `id` after pointing it at `componentID`,
// keeping what still fits: the overrides on layers the new master also has (same kind and
// name at the same place; a text override only on a text layer), the property values the new
// component also defines with a valid value, and the variant choices the new component's set
// also has. The transform is not part of it: a swap resizes the node to the new master with
// SwapSize.
func SwapInstance(doc *opendesignerv1.Document, id, componentID string) (*opendesignerv1.InstanceNode, error) {
	n := doc.GetNodes()[id]
	if n == nil {
		return nil, fmt.Errorf("%w: %s", ErrNodeNotFound, id)
	}
	old := n.GetInstance()
	if old == nil {
		return nil, fmt.Errorf("%w: %s", ErrNotInstanceNode, id)
	}
	base := doc.GetComponents()[componentID]
	if base == nil {
		return nil, fmt.Errorf("%w: %s", ErrComponentNotFound, componentID)
	}
	next := &opendesignerv1.InstanceNode{ComponentId: componentID}
	if componentID != old.GetComponentId() {
		// Variant choices that name an axis and option of the new set.
		if set := doc.GetComponentSets()[base.GetSetId()]; set != nil {
			for axis, opt := range old.GetVariantProps() {
				for _, a := range set.GetAxes() {
					if a.GetName() != axis {
						continue
					}
					for _, o := range a.GetOptions() {
						if o == opt {
							if next.VariantProps == nil {
								next.VariantProps = map[string]string{}
							}
							next.VariantProps[axis] = opt
						}
					}
				}
			}
		}
		newComp := doc.GetComponents()[EffectiveComponentID(doc, next)]
		oldComp := doc.GetComponents()[EffectiveComponentID(doc, old)]
		for name, v := range old.GetPropertyValues() {
			for _, p := range newComp.GetProperties() {
				if p.GetName() != name || !propertyValueValid(doc, p, v) {
					continue
				}
				for _, q := range oldComp.GetProperties() {
					if q.GetName() == name && q.GetType() == p.GetType() {
						if next.PropertyValues == nil {
							next.PropertyValues = map[string]string{}
						}
						next.PropertyValues[name] = v
					}
				}
			}
		}
		pairs := matchMasters(doc, oldComp.GetRootNodeId(), newComp.GetRootNodeId())
		for _, o := range old.GetOverrides() {
			to, ok := pairs[o.GetMasterNodeId()]
			if !ok {
				continue
			}
			c := proto.Clone(o).(*opendesignerv1.InstanceOverride)
			c.MasterNodeId = to
			if c.GetTextPresent() && doc.GetNodes()[to].GetText() == nil {
				c.Text, c.TextPresent = "", false
			}
			if c.GetFillsPresent() || c.GetTextPresent() {
				next.Overrides = append(next.Overrides, c)
			}
		}
	} else {
		next = proto.Clone(old).(*opendesignerv1.InstanceNode)
	}
	if err := validateInstanceBody(doc, id, next); err != nil {
		return nil, err
	}
	return next, nil
}

// SwapSize is the size a swapped instance takes: the one of the master it now renders.
func SwapSize(doc *opendesignerv1.Document, inst *opendesignerv1.InstanceNode) (w, h float64, ok bool) {
	c := doc.GetComponents()[EffectiveComponentID(doc, inst)]
	root := doc.GetNodes()[c.GetRootNodeId()]
	if root == nil {
		return 0, 0, false
	}
	return root.GetWidth(), root.GetHeight(), true
}

// ResetInstance is the payload of instance `id` with every override, property value and
// variant choice cleared (it keeps pointing at the same component).
func ResetInstance(doc *opendesignerv1.Document, id string) (*opendesignerv1.InstanceNode, error) {
	n := doc.GetNodes()[id]
	if n == nil {
		return nil, fmt.Errorf("%w: %s", ErrNodeNotFound, id)
	}
	if n.GetInstance() == nil {
		return nil, fmt.Errorf("%w: %s", ErrNotInstanceNode, id)
	}
	return &opendesignerv1.InstanceNode{ComponentId: n.GetInstance().GetComponentId()}, nil
}

// PageOf is the id of the page that holds node `id` ("" for an unknown node or a cycle).
func PageOf(doc *opendesignerv1.Document, id string) string {
	cur := doc.GetNodes()[id]
	for g := 0; cur != nil && g <= len(doc.GetNodes()); g++ {
		if doc.GetNodes()[cur.GetParentId()] == nil {
			return cur.GetParentId()
		}
		cur = doc.GetNodes()[cur.GetParentId()]
	}
	return ""
}

// DetachInstance returns the ops that turn instance `id` into plain nodes: the instance is
// deleted and the master it renders is copied in its place, with the overrides, property
// values and variant choice baked in. The new root keeps the instance's id, name, place, size
// and layout settings, so the layers around it do not move; nested instances stay instances.
// `newID` makes the ids of the copied descendants.
func DetachInstance(doc *opendesignerv1.Document, id string, newID func() string) ([]*opendesignerv1.Op, error) {
	n := doc.GetNodes()[id]
	if n == nil {
		return nil, fmt.Errorf("%w: %s", ErrNodeNotFound, id)
	}
	inst := n.GetInstance()
	if inst == nil {
		return nil, fmt.Errorf("%w: %s", ErrNotInstanceNode, id)
	}
	comp := doc.GetComponents()[EffectiveComponentID(doc, inst)]
	root := doc.GetNodes()[comp.GetRootNodeId()]
	if comp == nil || root == nil {
		return nil, fmt.Errorf("%w: %s", ErrComponentNotFound, inst.GetComponentId())
	}
	fx := EffectsOf(doc, inst, "")
	ids := map[string]string{}
	var nodes []*opendesignerv1.Node
	for _, m := range SubtreeOf(doc, root.GetId()) {
		c := proto.Clone(m).(*opendesignerv1.Node)
		if m.GetId() == root.GetId() {
			c.Id, c.ParentId, c.OrderKey, c.Name = id, n.GetParentId(), n.GetOrderKey(), n.GetName()
			c.X, c.Y, c.Width, c.Height, c.Rotation = n.GetX(), n.GetY(), n.GetWidth(), n.GetHeight(), n.GetRotation()
			c.Visible, c.Opacity = n.GetVisible(), n.GetOpacity()
			c.ConstraintX, c.ConstraintY = n.GetConstraintX(), n.GetConstraintY()
			c.LayoutSizingX, c.LayoutSizingY = n.GetLayoutSizingX(), n.GetLayoutSizingY()
			c.MinWidth, c.MaxWidth, c.MinHeight, c.MaxHeight = n.GetMinWidth(), n.GetMaxWidth(), n.GetMinHeight(), n.GetMaxHeight()
			c.LayoutPositioning = n.GetLayoutPositioning()
			c.BlendMode, c.IsMask = n.GetBlendMode(), n.GetIsMask()
			c.Meta = n.GetMeta()
			if len(n.GetModes()) > 0 {
				c.Modes = n.GetModes()
			}
		} else {
			c.Id = newID()
			c.ParentId = ids[m.GetParentId()]
		}
		ids[m.GetId()] = c.GetId()
		bakeEffects(c, m.GetId(), fx)
		nodes = append(nodes, c)
	}
	ops := []*opendesignerv1.Op{{Kind: &opendesignerv1.Op_DeleteNode{DeleteNode: &opendesignerv1.DeleteNode{Id: id}}}}
	for _, c := range nodes {
		ops = append(ops, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: c}}})
	}
	return ops, nil
}

// bakeEffects writes what the instance changes on master node `masterID` into its copy.
func bakeEffects(c *opendesignerv1.Node, masterID string, fx InstanceEffects) {
	if fx.Hidden[masterID] {
		c.Visible = false
	}
	if o := fx.Overrides[masterID]; o != nil {
		if o.GetFillsPresent() {
			c.Fills = o.GetFills()
		}
		if o.GetTextPresent() && c.GetText() != nil {
			c.GetText().Content = o.GetText()
		}
	}
	if v, ok := fx.Opacity[masterID]; ok {
		c.Opacity = v
	}
	if v, ok := fx.CornerRadius[masterID]; ok && c.GetRect() != nil {
		c.GetRect().CornerRadius = v
	}
	if v, ok := fx.FontSize[masterID]; ok && c.GetText() != nil {
		if c.GetText().Style == nil {
			c.GetText().Style = &opendesignerv1.TextStyle{}
		}
		c.GetText().Style.FontSize = v
	}
	if to, ok := fx.Swap[masterID]; ok && c.GetInstance() != nil {
		c.GetInstance().ComponentId = to
	}
}
