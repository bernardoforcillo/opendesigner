package mcp

import (
	"context"
	"errors"
	"fmt"
	"math"
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

// The context menu's structure commands: Group, Ungroup, Duplicate and the four Arrange entries
// (web/src/tools/grouping.ts, clipboard.ts::duplicateSelection and arrange.ts are the editor's
// twins). The draw order IS the order key (ascending = background to foreground), so every move is
// a fractional order key written between the neighbours' keys (core.OrderKeyBetween).
//
// There is no multi-op transaction on the wire: the ops are all computed first (any error is
// reported before anything is sent) and then submitted one after the other, in order. The editor
// wraps the same ops in one gesture, so one Ctrl+Z undoes them together; a document edited through
// MCP has no undo stack, so nothing is lost here -- other peers just see the ops arrive in turn.

// duplicateOffset is the editor's PASTE_OFFSET: the copy lands this far down and right so it is visible.
const duplicateOffset = 16

// GestureOutput is what the structure tools return.
type GestureOutput struct {
	NodeIds []string `json:"nodeIds" jsonschema:"the nodes the command leaves selected in the editor: the new group, the freed children, the copies; empty for arrange"`
	Changed int      `json:"changed" jsonschema:"how many ops were applied"`
	Seq     uint64   `json:"seq"`
}

// submitAll sends ops in order and returns the last seq.
func (s *Session) submitAll(ctx context.Context, ops []*opendesignerv1.Op) (uint64, error) {
	var seq uint64
	for _, op := range ops {
		var err error
		if seq, err = s.submit(ctx, op); err != nil {
			return seq, err
		}
	}
	return seq, nil
}

func setOrderKeyOp(id, key string) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: id, Patch: &opendesignerv1.Node{OrderKey: key}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"order_key"}},
	}}}
}

func setXYOp(id string, x, y float64) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: id, Patch: &opendesignerv1.Node{X: x, Y: y}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"x", "y"}},
	}}}
}

func reparentOp(id, parent, key string) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_ReparentNode{ReparentNode: &opendesignerv1.ReparentNode{Id: id, NewParentId: parent, OrderKey: key}}}
}

// drawOrder numbers every node in the draw order of the whole document (pages in order, each tree
// depth first, bottom to top): between nodes with different parents only the tree says which is on top.
func drawOrder(doc *opendesignerv1.Document) map[string]int {
	index := map[string]int{}
	var walk func(parent string)
	walk = func(parent string) {
		for _, c := range core.ChildrenOf(doc, parent) {
			if _, seen := index[c.GetId()]; seen {
				continue
			}
			index[c.GetId()] = len(index)
			walk(c.GetId())
		}
	}
	for _, p := range doc.GetPages() {
		walk(p.GetId())
	}
	return index
}

// topmostNodes keeps the existing nodes of ids that have no ancestor in ids (the container carries
// its descendants along), without repeats, in the order given; unknown ids are an error.
func topmostNodes(tool string, doc *opendesignerv1.Document, ids []string) ([]*opendesignerv1.Node, error) {
	if len(ids) == 0 {
		return nil, fmt.Errorf("%s: ids is empty", tool)
	}
	have := map[string]bool{}
	for _, id := range ids {
		if doc.GetNodes()[id] == nil {
			return nil, fmt.Errorf("%s: node %q not found (list_nodes for the ids)", tool, id)
		}
		have[id] = true
	}
	var out []*opendesignerv1.Node
	done := map[string]bool{}
	for _, id := range ids {
		if done[id] {
			continue
		}
		done[id] = true
		covered := false
		for other := range have {
			if other != id && core.IsAncestorOf(doc, other, id) {
				covered = true
				break
			}
		}
		if !covered {
			out = append(out, doc.GetNodes()[id])
		}
	}
	return out, nil
}

// siblingAbove is the sibling right above n among the children of its parent, or nil.
func siblingAbove(doc *opendesignerv1.Document, n *opendesignerv1.Node) *opendesignerv1.Node {
	sib := core.ChildrenOf(doc, n.GetParentId())
	for i, c := range sib {
		if c.GetId() == n.GetId() {
			if i+1 < len(sib) {
				return sib[i+1]
			}
			return nil
		}
	}
	return nil
}

// upperBound is the key of the neighbour above, only when it really leaves room (equal keys leave
// none: the new node then goes above that neighbour instead of failing).
func upperBound(above *opendesignerv1.Node, lower string) string {
	if above != nil && above.GetOrderKey() > lower {
		return above.GetOrderKey()
	}
	return ""
}

// ---------------------------------------------------------------------------
// Arrange

// ArrangeNodesInput is the context menu's Bring to front / forward, Send backward / to back.
type ArrangeNodesInput struct {
	Ids  []string `json:"ids" jsonschema:"the nodes to move; each is arranged among its own siblings (nodes in different parents are arranged in their own parent)"`
	Mode string   `json:"mode" jsonschema:"front (bring to front) | forward (one step up) | backward (one step down) | back (send to back)"`
}

type slot struct{ id, key string }

// arrangeKeys is arrange.ts::arrangeOps: the new order key of every node that has to move.
func arrangeKeys(doc *opendesignerv1.Document, nodes []*opendesignerv1.Node, mode string) (ids []string, keys map[string]string) {
	byParent := map[string][]string{}
	var parents []string
	for _, n := range nodes {
		p := n.GetParentId()
		if _, ok := byParent[p]; !ok {
			parents = append(parents, p)
		}
		byParent[p] = append(byParent[p], n.GetId())
	}
	keys = map[string]string{}
	between := func(a, b string) (string, bool) {
		k, err := core.OrderKeyBetween(a, b)
		return k, err == nil
	}
	for _, parent := range parents {
		picked := byParent[parent]
		sel := map[string]bool{}
		for _, id := range picked {
			sel[id] = true
		}
		var list []*slot
		for _, c := range core.ChildrenOf(doc, parent) {
			list = append(list, &slot{c.GetId(), c.GetOrderKey()})
		}
		moved := map[string]bool{}
		set := func(sl *slot, key string, ok bool) bool {
			if !ok {
				return false
			}
			sl.key = key
			moved[sl.id] = true
			return true
		}
		switch mode {
		case "front", "back":
			// Already a block at that end: nothing to do.
			count := len(picked)
			atEnd := true
			for i, sl := range list {
				inEnd := i >= len(list)-count
				if mode == "back" {
					inEnd = i < count
				}
				if inEnd && !sel[sl.id] {
					atEnd = false
				}
			}
			if atEnd {
				continue
			}
			var mine []*slot
			for _, sl := range list {
				if sel[sl.id] {
					mine = append(mine, sl)
				}
			}
			if mode == "front" {
				top := ""
				if len(list) > 0 {
					top = list[len(list)-1].key
				}
				for _, sl := range mine {
					k, ok := between(top, "")
					if set(sl, k, ok) {
						top = sl.key
					}
				}
			} else {
				bottom := ""
				if len(list) > 0 {
					bottom = list[0].key
				}
				for i := len(mine) - 1; i >= 0; i-- {
					k, ok := between("", bottom)
					if set(mine[i], k, ok) {
						bottom = mine[i].key
					}
				}
			}
		case "forward":
			for i := len(list) - 2; i >= 0; i-- {
				if !sel[list[i].id] || sel[list[i+1].id] {
					continue
				}
				over := list[i+1] // jump over the next sibling: land between it and the one after it
				next := ""
				if i+2 < len(list) {
					next = list[i+2].key
				}
				k, ok := between(over.key, next)
				if !ok {
					continue
				}
				me := list[i]
				list[i], list[i+1] = over, me
				set(me, k, true)
			}
		case "backward":
			for i := 1; i < len(list); i++ {
				if !sel[list[i].id] || sel[list[i-1].id] {
					continue
				}
				over := list[i-1]
				prev := ""
				if i >= 2 {
					prev = list[i-2].key
				}
				k, ok := between(prev, over.key)
				if !ok {
					continue
				}
				me := list[i]
				list[i], list[i-1] = over, me
				set(me, k, true)
			}
		}
		for _, id := range picked {
			if moved[id] {
				for _, sl := range list {
					if sl.id == id {
						keys[id] = sl.key
						ids = append(ids, id)
					}
				}
			}
		}
	}
	return ids, keys
}

// ArrangeNodes moves nodes in the draw order among their siblings, exactly as the editor's
// arrange commands do; nodes that cannot move any further are left alone (changed 0).
func (s *Session) ArrangeNodes(ctx context.Context, in ArrangeNodesInput) (GestureOutput, error) {
	switch in.Mode {
	case "front", "forward", "backward", "back":
	default:
		return GestureOutput{}, fmt.Errorf("arrange_nodes: mode must be front, forward, backward or back, got %q", in.Mode)
	}
	s.mu.Lock()
	nodes, err := topmostNodes("arrange_nodes", s.doc, in.Ids)
	var ids []string
	var keys map[string]string
	if err == nil {
		ids, keys = arrangeKeys(s.doc, nodes, in.Mode)
	}
	s.mu.Unlock()
	if err != nil {
		return GestureOutput{}, err
	}
	var ops []*opendesignerv1.Op
	for _, id := range ids {
		ops = append(ops, setOrderKeyOp(id, keys[id]))
	}
	seq, err := s.submitAll(ctx, ops)
	return GestureOutput{Changed: len(ops), Seq: seq}, err
}

// ---------------------------------------------------------------------------
// Group / Ungroup

// moveOps reparents n under newParent with the key, keeping its WORLD position: its coordinates are
// rewritten into the space of `space` (the new group is born at (0,0) so its space is its parent's).
func moveOps(doc *opendesignerv1.Document, n *opendesignerv1.Node, newParent, space, key string) []*opendesignerv1.Op {
	ops := []*opendesignerv1.Op{reparentOp(n.GetId(), newParent, key)}
	wx, wy := codegen.ContainerToWorld(doc, n.GetParentId()).Apply(n.GetX(), n.GetY())
	x, y := wx, wy
	if inv, ok := codegen.ContainerToWorld(doc, space).Invert(); ok {
		x, y = inv.Apply(wx, wy)
	}
	if math.Abs(x-n.GetX()) > 1e-9 || math.Abs(y-n.GetY()) > 1e-9 {
		ops = append(ops, setXYOp(n.GetId(), x, y))
	}
	return ops
}

// GroupNodesInput groups nodes.
type GroupNodesInput struct {
	Ids  []string `json:"ids" jsonschema:"the nodes to group (a node selected together with its container is carried by the container)"`
	Name string   `json:"name,omitempty" jsonschema:"the group's name; default \"Group\""`
}

// GroupNodes is Ctrl+G: a group is created as the sibling right above the topmost grouped node
// and the nodes move into it in their draw order, keeping their world position (nothing moves on
// screen).
func (s *Session) GroupNodes(ctx context.Context, in GroupNodesInput) (GestureOutput, error) {
	s.mu.Lock()
	ops, groupID, err := s.groupOpsLocked(in)
	s.mu.Unlock()
	if err != nil {
		return GestureOutput{}, err
	}
	seq, err := s.submitAll(ctx, ops)
	return GestureOutput{NodeIds: []string{groupID}, Changed: len(ops), Seq: seq}, err
}

func (s *Session) groupOpsLocked(in GroupNodesInput) ([]*opendesignerv1.Op, string, error) {
	doc := s.doc
	nodes, err := topmostNodes("group_nodes", doc, in.Ids)
	if err != nil {
		return nil, "", err
	}
	index := drawOrder(doc)
	sort.SliceStable(nodes, func(i, j int) bool { return index[nodes[i].GetId()] < index[nodes[j].GetId()] })
	top := nodes[len(nodes)-1]
	parent := top.GetParentId()
	key, err := core.OrderKeyBetween(top.GetOrderKey(), upperBound(siblingAbove(doc, top), top.GetOrderKey()))
	if err != nil {
		return nil, "", fmt.Errorf("group_nodes: %w", err)
	}
	name := in.Name
	if name == "" {
		name = "Group"
	}
	groupID := uuid.NewString()
	// No geometry of its own: its bounds are the union of the children, and x/y 0 means it does not
	// yet translate anyone.
	group := &opendesignerv1.Node{
		Id: groupID, ParentId: parent, OrderKey: key, Name: name, Visible: true, Opacity: 1,
		Shape: &opendesignerv1.Node_Group{Group: &opendesignerv1.GroupNode{}},
	}
	ops := []*opendesignerv1.Op{{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: group}}}}
	prev := ""
	for _, n := range nodes {
		k, err := core.OrderKeyBetween(prev, "")
		if err != nil {
			return nil, "", fmt.Errorf("group_nodes: %w", err)
		}
		prev = k
		ops = append(ops, moveOps(doc, n, groupID, parent, k)...)
	}
	return ops, groupID, nil
}

// UngroupNodesInput ungroups groups.
type UngroupNodesInput struct {
	Ids []string `json:"ids" jsonschema:"the groups to dissolve (a group inside another selected group is left for the outer one)"`
}

// UngroupNodes is Ctrl+Shift+G: the children come back out into the group's slot in their relative
// order, keeping their world position, and the emptied group is deleted last. It refuses a
// selection with no group in it.
func (s *Session) UngroupNodes(ctx context.Context, in UngroupNodesInput) (GestureOutput, error) {
	s.mu.Lock()
	doc := s.doc
	nodes, err := topmostNodes("ungroup_nodes", doc, in.Ids)
	var ops []*opendesignerv1.Op
	var freed []string
	if err == nil {
		index := drawOrder(doc)
		var groups []*opendesignerv1.Node
		for _, n := range nodes {
			if n.GetGroup() != nil {
				groups = append(groups, n)
			}
		}
		sort.SliceStable(groups, func(i, j int) bool { return index[groups[i].GetId()] < index[groups[j].GetId()] })
		if len(groups) == 0 {
			err = errors.New("ungroup_nodes: none of the nodes is a group")
		}
		for _, g := range groups {
			if err != nil {
				break
			}
			upper := upperBound(siblingAbove(doc, g), g.GetOrderKey())
			prev := g.GetOrderKey()
			for _, c := range core.ChildrenOf(doc, g.GetId()) {
				var k string
				if k, err = core.OrderKeyBetween(prev, upper); err != nil {
					err = fmt.Errorf("ungroup_nodes: %w", err)
					break
				}
				prev = k
				// Parent and space coincide: the group still exists, so its translation is in the maths.
				ops = append(ops, moveOps(doc, c, g.GetParentId(), g.GetParentId(), k)...)
				freed = append(freed, c.GetId())
			}
			ops = append(ops, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteNode{DeleteNode: &opendesignerv1.DeleteNode{Id: g.GetId()}}})
		}
	}
	s.mu.Unlock()
	if err != nil {
		return GestureOutput{}, err
	}
	seq, err := s.submitAll(ctx, ops)
	return GestureOutput{NodeIds: freed, Changed: len(ops), Seq: seq}, err
}

// ---------------------------------------------------------------------------
// Duplicate

// DuplicateNodesInput duplicates nodes.
type DuplicateNodesInput struct {
	Ids    []string `json:"ids" jsonschema:"the nodes to copy, each with its whole subtree"`
	Offset *float64 `json:"offset,omitempty" jsonschema:"how far down and right the copies land, in the parent's units; default 16 (the editor's), 0 puts them exactly on the originals"`
}

// DuplicateNodes is Ctrl+D: a deep copy of each node (new ids, same parent, on top of its siblings
// in the relative order of the originals, shifted by the offset). Instances stay instances of the
// same component; the clipboard is not involved.
func (s *Session) DuplicateNodes(ctx context.Context, in DuplicateNodesInput) (GestureOutput, error) {
	off := float64(duplicateOffset)
	if in.Offset != nil {
		off = *in.Offset
	}
	s.mu.Lock()
	doc := s.doc
	nodes, err := topmostNodes("duplicate_nodes", doc, in.Ids)
	var ops []*opendesignerv1.Op
	var roots []string
	if err == nil {
		sort.SliceStable(nodes, func(i, j int) bool {
			if nodes[i].GetOrderKey() != nodes[j].GetOrderKey() {
				return nodes[i].GetOrderKey() < nodes[j].GetOrderKey()
			}
			return nodes[i].GetId() < nodes[j].GetId()
		})
		top := map[string]string{} // parent -> highest key handed out so far
		for _, n := range nodes {
			p := n.GetParentId()
			if _, ok := top[p]; !ok {
				if sib := core.ChildrenOf(doc, p); len(sib) > 0 {
					top[p] = sib[len(sib)-1].GetOrderKey()
				}
			}
			var key string
			if key, err = core.OrderKeyBetween(top[p], ""); err != nil {
				err = fmt.Errorf("duplicate_nodes: %w", err)
				break
			}
			top[p] = key
			ids := map[string]string{}
			for _, o := range core.SubtreeOf(doc, n.GetId()) {
				ids[o.GetId()] = uuid.NewString()
			}
			for _, o := range core.SubtreeOf(doc, n.GetId()) {
				c := proto.Clone(o).(*opendesignerv1.Node)
				c.Id = ids[o.GetId()]
				if o.GetId() == n.GetId() {
					c.OrderKey, c.X, c.Y = key, o.GetX()+off, o.GetY()+off
					roots = append(roots, c.Id)
				} else {
					c.ParentId = ids[o.GetParentId()]
				}
				ops = append(ops, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: c}}})
			}
		}
	}
	s.mu.Unlock()
	if err != nil {
		return GestureOutput{}, err
	}
	seq, err := s.submitAll(ctx, ops)
	return GestureOutput{NodeIds: roots, Changed: len(ops), Seq: seq}, err
}

func registerArrangeTools(srv *mcp.Server, s *Session) {
	addTool(srv, "arrange_nodes", "Move nodes in the draw order among their siblings, as the context menu does: mode front (bring to front), forward (one step up), backward (one step down) or back (send to back). Each node is arranged in its own parent; a node that cannot move any further is left alone (changed 0). Only order keys change.", s.ArrangeNodes)
	addTool(srv, "group_nodes", "Group nodes (Ctrl+G): a group is created right above the topmost of them, and they move into it in their draw order keeping their place on screen (their x/y are rewritten into the group's parent space when they came from another parent). A node selected together with its container is carried by the container. Returns the group's id.", s.GroupNodes)
	addTool(srv, "ungroup_nodes", "Ungroup groups (Ctrl+Shift+G): the children come back out into the group's slot in their relative order, keeping their place on screen, and the group is deleted. Refused when none of the nodes is a group.", s.UngroupNodes)
	addTool(srv, "duplicate_nodes", "Duplicate nodes (Ctrl+D): a deep copy of each node with its subtree, new ids, same parent, on top of its siblings, shifted 16 units down and right (offset 0 overlaps the original). Returns the ids of the copies.", s.DuplicateNodes)
}
