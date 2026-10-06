// Package merge brings the changes made on a BRANCH back into the document it came from. It is a
// three-way, property-level merge: `base` is the document as it was when the branch was taken,
// `branch` is the branch now and `source` is the original now. A change the branch made is taken
// unless the source changed the SAME property of the SAME thing to something else since the
// base -- that is a conflict, and the caller chooses a side (the source's by default).
//
// The result is a list of ops that the original's hub applies like any other edit, so every
// invariant the core enforces holds and the merge is undoable like any other work. Pure: no I/O.
package merge

import (
	"fmt"
	"sort"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/types/known/fieldmaskpb"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// Kinds of change.
const (
	Added   = "added"
	Removed = "removed"
	Changed = "changed"
)

// Change is one thing the branch did, as the review shows it.
type Change struct {
	// Entity: node, page, flow, transition, clip, collection, variable, font, text_style, component_set.
	Entity string `json:"entity"`
	ID     string `json:"id"`
	Name   string `json:"name"`
	Kind   string `json:"kind"`
	// Paths: what changed on a node (a mask path, "text", "vector", "parent"...).
	Paths []string `json:"paths,omitempty"`
	// Conflict: the source changed the same thing since the base; ConflictPaths says which parts.
	Conflict      bool     `json:"conflict,omitempty"`
	ConflictPaths []string `json:"conflictPaths,omitempty"`

	// clean: the ops that apply with no conflict; forced: what taking the branch's side of the
	// conflicting parts adds on top. Each carries the rank that orders it among all the others.
	clean  []step
	forced []step
}

// step is an op and where it goes in the merge.
type step struct {
	rank int
	op   *opendesignerv1.Op
}

func steps(rank int, ops ...*opendesignerv1.Op) []step {
	out := make([]step, len(ops))
	for i, op := range ops {
		out[i] = step{rank, op}
	}
	return out
}

// Plan is the outcome of comparing the three documents.
type Plan struct {
	Changes  []Change `json:"changes"`
	Warnings []string `json:"warnings,omitempty"`
}

// Conflicts is how many changes are in conflict.
func (p *Plan) Conflicts() int {
	n := 0
	for _, c := range p.Changes {
		if c.Conflict {
			n++
		}
	}
	return n
}

// Ops returns the ops that merge the branch into the source, in an order the core accepts
// (pages and definitions, then new nodes parents first, then edits, then removals). Conflicts
// are left out unless preferBranch is set, in which case the branch's side wins.
func (p *Plan) Ops(docID string, preferBranch bool) []*opendesignerv1.Op {
	var all []step
	for _, c := range p.Changes {
		all = append(all, c.clean...)
		if preferBranch {
			all = append(all, c.forced...)
		}
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].rank < all[j].rank })
	out := make([]*opendesignerv1.Op, len(all))
	for i, st := range all {
		op := proto.Clone(st.op).(*opendesignerv1.Op)
		op.DocId = docID
		out[i] = op
	}
	return out
}

// Ranks: the order the groups of ops go in.
const (
	rankPage = iota
	rankDefinition
	rankCreate
	rankEdit
	rankReparent
	rankDelete
)

// nodePaths are the Node fields a setProps can carry (see core.applySetProps); the others are
// reported as "not merged".
var nodePaths = map[string]bool{
	"x": true, "y": true, "width": true, "height": true, "rotation": true, "opacity": true, "name": true, "visible": true,
	"fills": true, "strokes": true, "effects": true, "meta": true, "is_mask": true, "constraint_x": true, "constraint_y": true,
	"layout_grids": true, "blend_mode": true, "layout_sizing_x": true, "layout_sizing_y": true, "bindings": true,
	"modes": true, "text_style_id": true,
}

// Compute compares the three documents.
func Compute(base, branch, source *opendesignerv1.Document) *Plan {
	p := &Plan{}
	if base == nil {
		base = &opendesignerv1.Document{}
	}
	p.pages(base, branch, source)
	definitions(p, base, branch, source)
	p.nodes(base, branch, source)
	return p
}

// ---- three-way helpers ----

type side int

const (
	untouched  side = iota // the branch did not change it
	takeBranch             // the branch changed it and the source did not
	same                   // both changed it to the same value
	conflict               // both changed it, differently
)

func decide(base, branch, source proto.Message) side {
	switch {
	case proto.Equal(base, branch):
		return untouched
	case proto.Equal(base, source):
		return takeBranch
	case proto.Equal(branch, source):
		return same
	default:
		return conflict
	}
}

// ---- pages ----

func (p *Plan) pages(base, branch, source *opendesignerv1.Document) {
	index := func(d *opendesignerv1.Document) map[string]*opendesignerv1.Page {
		m := map[string]*opendesignerv1.Page{}
		for _, pg := range d.GetPages() {
			m[pg.GetId()] = pg
		}
		return m
	}
	b0, b1, b2 := index(base), index(branch), index(source)
	var ids []string
	seen := map[string]bool{}
	for _, d := range []*opendesignerv1.Document{base, branch} {
		for _, pg := range d.GetPages() {
			if !seen[pg.GetId()] {
				seen[pg.GetId()] = true
				ids = append(ids, pg.GetId())
			}
		}
	}
	for _, id := range ids {
		pb, pbr, ps := b0[id], b1[id], b2[id]
		switch {
		case pb == nil && pbr != nil && ps == nil: // added on the branch
			p.add(Change{Entity: "page", ID: id, Name: pbr.GetName(), Kind: Added,
				clean: steps(rankPage, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreatePage{CreatePage: &opendesignerv1.CreatePage{Page: proto.Clone(pbr).(*opendesignerv1.Page)}}})})
		case pb != nil && pbr == nil && ps != nil: // removed on the branch
			del := &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeletePage{DeletePage: &opendesignerv1.DeletePage{Id: id}}}
			if proto.Equal(pb, ps) {
				p.add(Change{Entity: "page", ID: id, Name: pb.GetName(), Kind: Removed, clean: steps(rankDelete, del)})
			} else {
				p.add(Change{Entity: "page", ID: id, Name: pb.GetName(), Kind: Removed, Conflict: true, ConflictPaths: []string{"name"}, forced: steps(rankDelete, del)})
			}
		case pb != nil && pbr != nil && ps != nil: // renamed?
			rename := &opendesignerv1.Op{Kind: &opendesignerv1.Op_RenamePage{RenamePage: &opendesignerv1.RenamePage{Id: id, Name: pbr.GetName()}}}
			switch decide(pb, pbr, ps) {
			case takeBranch:
				p.add(Change{Entity: "page", ID: id, Name: pbr.GetName(), Kind: Changed, Paths: []string{"name"}, clean: steps(rankPage, rename)})
			case conflict:
				p.add(Change{Entity: "page", ID: id, Name: pbr.GetName(), Kind: Changed, Paths: []string{"name"}, Conflict: true, ConflictPaths: []string{"name"}, forced: steps(rankPage, rename)})
			}
		}
	}
}

func (p *Plan) add(c Change) { p.Changes = append(p.Changes, c) }

func (p *Plan) warn(format string, a ...any) {
	p.Warnings = append(p.Warnings, fmt.Sprintf(format, a...))
}

// ---- nodes ----

// nodeFields are the Node fields compared one by one.
var nodeFields = func() []protoreflect.FieldDescriptor {
	var out []protoreflect.FieldDescriptor
	fds := (&opendesignerv1.Node{}).ProtoReflect().Descriptor().Fields()
	for i := 0; i < fds.Len(); i++ {
		fd := fds.Get(i)
		switch fd.Name() {
		case "id", "parent_id", "order_key":
			continue
		}
		if fd.ContainingOneof() != nil && fd.ContainingOneof().Name() == "shape" {
			continue
		}
		out = append(out, fd)
	}
	return out
}()

// onlyField is a Node holding just field `fd` of `n`, to compare one field with proto.Equal.
func onlyField(n *opendesignerv1.Node, fd protoreflect.FieldDescriptor) *opendesignerv1.Node {
	out := &opendesignerv1.Node{}
	if n == nil {
		return out
	}
	out = proto.Clone(n).(*opendesignerv1.Node)
	var others []protoreflect.FieldDescriptor
	out.ProtoReflect().Range(func(f protoreflect.FieldDescriptor, _ protoreflect.Value) bool {
		if f != fd {
			others = append(others, f)
		}
		return true
	})
	for _, f := range others {
		out.ProtoReflect().Clear(f)
	}
	return out
}

func (p *Plan) nodes(base, branch, source *opendesignerv1.Document) {
	bN, brN, sN := base.GetNodes(), branch.GetNodes(), source.GetNodes()

	// Pre-order of the branch's tree, so a new node comes after its parent.
	depth := map[string]int{}
	var depthOf func(id string, guard int) int
	depthOf = func(id string, guard int) int {
		if d, ok := depth[id]; ok {
			return d
		}
		n := brN[id]
		if n == nil || guard > 10000 {
			return 0
		}
		d := depthOf(n.GetParentId(), guard+1) + 1
		depth[id] = d
		return d
	}
	ids := make([]string, 0, len(brN))
	for id := range brN {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		di, dj := depthOf(ids[i], 0), depthOf(ids[j], 0)
		if di != dj {
			return di < dj
		}
		return ids[i] < ids[j]
	})

	pageIDs := map[string]bool{}
	for _, pg := range source.GetPages() {
		pageIDs[pg.GetId()] = true
	}
	for _, pg := range branch.GetPages() { // a page the merge itself creates
		if base == nil || !hasPage(base, pg.GetId()) {
			pageIDs[pg.GetId()] = true
		}
	}

	for _, id := range ids {
		bn, brn, sn := bN[id], brN[id], sN[id]
		switch {
		case bn == nil && sn == nil:
			// New on the branch.
			parent := brn.GetParentId()
			inSource := sN[parent] != nil || pageIDs[parent]
			// A parent that is itself new on the branch is created first (lower depth), so it counts.
			if bN[parent] == nil && brN[parent] != nil && sN[parent] == nil {
				inSource = true
			}
			c := Change{Entity: "node", ID: id, Name: brn.GetName(), Kind: Added}
			create := &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: proto.Clone(brn).(*opendesignerv1.Node)}}}
			if inSource {
				c.clean = steps(rankCreate, create)
			} else {
				c.Conflict, c.ConflictPaths = true, []string{"parent"}
				p.warn("%q is new on the branch but its parent no longer exists in the original", brn.GetName())
			}
			p.add(c)
		case bn != nil && sn != nil:
			p.editNode(id, bn, brn, sn, sN)
		}
	}

	// Removed on the branch: the roots of the removed subtrees only (deleting a node deletes its descendants).
	for id, bn := range bN {
		if brN[id] != nil {
			continue
		}
		sn := sN[id]
		if sn == nil {
			continue // gone from the source too
		}
		if parent := bN[bn.GetParentId()]; parent != nil && brN[parent.GetId()] == nil {
			continue // an ancestor is removed too: that one carries it
		}
		del := &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteNode{DeleteNode: &opendesignerv1.DeleteNode{Id: id}}}
		c := Change{Entity: "node", ID: id, Name: bn.GetName(), Kind: Removed}
		// The source edited it, or put something new inside it: do not delete work silently.
		if !proto.Equal(bn, sn) || hasNewDescendant(id, bN, sN) {
			c.Conflict, c.ConflictPaths = true, []string{"removed"}
			c.forced = steps(rankDelete, del)
		} else {
			c.clean = steps(rankDelete, del)
		}
		p.add(c)
	}
}

func hasPage(d *opendesignerv1.Document, id string) bool {
	for _, pg := range d.GetPages() {
		if pg.GetId() == id {
			return true
		}
	}
	return false
}

// hasNewDescendant: the source has, under `id`, a node the base did not have.
func hasNewDescendant(id string, base, source map[string]*opendesignerv1.Node) bool {
	for sid, n := range source {
		if base[sid] != nil {
			continue
		}
		for cur, guard := n.GetParentId(), 0; cur != "" && guard < 10000; guard++ {
			if cur == id {
				return true
			}
			next := source[cur]
			if next == nil {
				break
			}
			cur = next.GetParentId()
		}
	}
	return false
}

func (p *Plan) editNode(id string, bn, brn, sn *opendesignerv1.Node, sourceNodes map[string]*opendesignerv1.Node) {
	var clean, forced []protoreflect.FieldDescriptor
	var paths, conflictPaths []string

	for _, fd := range nodeFields {
		switch decide(onlyField(bn, fd), onlyField(brn, fd), onlyField(sn, fd)) {
		case takeBranch:
			if !nodePaths[string(fd.Name())] {
				p.warn("%q: %s changed on the branch and is not merged", brn.GetName(), fd.Name())
				continue
			}
			clean = append(clean, fd)
			paths = append(paths, string(fd.Name()))
		case conflict:
			if !nodePaths[string(fd.Name())] {
				continue
			}
			forced = append(forced, fd)
			paths = append(paths, string(fd.Name()))
			conflictPaths = append(conflictPaths, string(fd.Name()))
		}
	}

	sp, sf := p.shapeChange(bn, brn, sn)
	shapeOps, shapeForced := sp.ops, sf.ops
	paths = append(paths, sp.names...)
	paths = append(paths, sf.names...)
	conflictPaths = append(conflictPaths, sf.names...)

	patchOp := func(fds []protoreflect.FieldDescriptor) *opendesignerv1.Op {
		if len(fds) == 0 {
			return nil
		}
		patch := &opendesignerv1.Node{}
		var mask []string
		for _, fd := range fds {
			proto.Merge(patch, onlyField(brn, fd))
			mask = append(mask, string(fd.Name()))
		}
		return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
			Id: id, Patch: patch, Mask: &fieldmaskpb.FieldMask{Paths: mask},
		}}}
	}

	c := Change{Entity: "node", ID: id, Name: brn.GetName(), Kind: Changed, Paths: paths}
	if op := patchOp(clean); op != nil {
		c.clean = append(c.clean, steps(rankEdit, op)...)
	}
	c.clean = append(c.clean, steps(rankEdit, shapeOps...)...)
	if op := patchOp(forced); op != nil {
		c.forced = append(c.forced, steps(rankEdit, op)...)
	}
	c.forced = append(c.forced, steps(rankEdit, shapeForced...)...)

	// Where it sits: parent and order. A move goes after every create and edit, so a parent the
	// merge creates is already there.
	if brn.GetParentId() != bn.GetParentId() || brn.GetOrderKey() != bn.GetOrderKey() {
		parentChanged := brn.GetParentId() != bn.GetParentId()
		sourceMoved := sn.GetParentId() != bn.GetParentId() || sn.GetOrderKey() != bn.GetOrderKey()
		sameSpot := sn.GetParentId() == brn.GetParentId() && sn.GetOrderKey() == brn.GetOrderKey()
		name := "order_key"
		move := &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
			Id: id, Patch: &opendesignerv1.Node{OrderKey: brn.GetOrderKey()}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"order_key"}},
		}}}
		if parentChanged {
			name = "parent"
			move = &opendesignerv1.Op{Kind: &opendesignerv1.Op_ReparentNode{ReparentNode: &opendesignerv1.ReparentNode{Id: id, NewParentId: brn.GetParentId(), OrderKey: brn.GetOrderKey()}}}
		}
		switch {
		case sameSpot:
		case !sourceMoved:
			c.clean = append(c.clean, steps(rankReparent, move)...)
			c.Paths = append(c.Paths, name)
		default:
			c.forced = append(c.forced, steps(rankReparent, move)...)
			c.Paths = append(c.Paths, name)
			conflictPaths = append(conflictPaths, name)
		}
	}

	if len(c.clean) == 0 && len(c.forced) == 0 {
		return
	}
	if len(conflictPaths) > 0 {
		c.Conflict, c.ConflictPaths = true, conflictPaths
	}
	p.add(c)
}

type shapeOps struct {
	ops   []*opendesignerv1.Op
	names []string
}

// shapeChange compares what lives inside the `shape` oneof: a rectangle's corner radius, a frame's
// auto layout, a text's content and style, a vector's path. Other shape changes are not merged.
func (p *Plan) shapeChange(bn, brn, sn *opendesignerv1.Node) (clean, forced shapeOps) {
	name := brn.GetName()
	switch b := brn.GetShape().(type) {
	case *opendesignerv1.Node_Rect:
		o, ok1 := bn.GetShape().(*opendesignerv1.Node_Rect)
		s, ok2 := sn.GetShape().(*opendesignerv1.Node_Rect)
		if !ok1 || !ok2 {
			return
		}
		op := &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
			Id: brn.GetId(), Patch: &opendesignerv1.Node{Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{CornerRadius: b.Rect.GetCornerRadius()}}},
			Mask: &fieldmaskpb.FieldMask{Paths: []string{"corner_radius"}},
		}}}
		route(&clean, &forced, decide(o.Rect, b.Rect, s.Rect), "corner_radius", op)
	case *opendesignerv1.Node_Frame:
		o, ok1 := bn.GetShape().(*opendesignerv1.Node_Frame)
		s, ok2 := sn.GetShape().(*opendesignerv1.Node_Frame)
		if !ok1 || !ok2 {
			return
		}
		if !proto.Equal(o.Frame.GetAutoLayout(), b.Frame.GetAutoLayout()) {
			op := &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
				Id: brn.GetId(), Patch: &opendesignerv1.Node{Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{AutoLayout: proto.Clone(b.Frame.GetAutoLayout()).(*opendesignerv1.AutoLayout)}}},
				Mask: &fieldmaskpb.FieldMask{Paths: []string{"auto_layout"}},
			}}}
			route(&clean, &forced, decide(o.Frame.GetAutoLayout(), b.Frame.GetAutoLayout(), s.Frame.GetAutoLayout()), "auto_layout", op)
		}
		if o.Frame.GetClipsContent() != b.Frame.GetClipsContent() {
			p.warn("%q: clipping changed on the branch and is not merged", name)
		}
	case *opendesignerv1.Node_Text:
		o, ok1 := bn.GetShape().(*opendesignerv1.Node_Text)
		s, ok2 := sn.GetShape().(*opendesignerv1.Node_Text)
		if !ok1 || !ok2 {
			return
		}
		op := &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetText{SetText: &opendesignerv1.SetText{
			Id: brn.GetId(), Content: b.Text.GetContent(), Style: proto.Clone(b.Text.GetStyle()).(*opendesignerv1.TextStyle), StylePresent: true,
		}}}
		route(&clean, &forced, decide(o.Text, b.Text, s.Text), "text", op)
	case *opendesignerv1.Node_Vector:
		o, ok1 := bn.GetShape().(*opendesignerv1.Node_Vector)
		s, ok2 := sn.GetShape().(*opendesignerv1.Node_Vector)
		if !ok1 || !ok2 {
			return
		}
		op := &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetVectorPath{SetVectorPath: &opendesignerv1.SetVectorPath{
			Id: brn.GetId(), Subpaths: cloneSubpaths(b.Vector.GetSubpaths()),
		}}}
		route(&clean, &forced, decide(o.Vector, b.Vector, s.Vector), "vector", op)
	default:
		// Ellipse, group, image, instance (or none): nothing inside is mergeable.
		if !shapeEqual(bn, brn) {
			p.warn("%q: its shape changed on the branch and is not merged", name)
		}
	}
	return
}

func shapeEqual(a, b *opendesignerv1.Node) bool {
	x, y := &opendesignerv1.Node{}, &opendesignerv1.Node{}
	x.Shape, y.Shape = a.GetShape(), b.GetShape()
	return proto.Equal(x, y)
}

func cloneSubpaths(in []*opendesignerv1.SubPath) []*opendesignerv1.SubPath {
	out := make([]*opendesignerv1.SubPath, len(in))
	for i, s := range in {
		out[i] = proto.Clone(s).(*opendesignerv1.SubPath)
	}
	return out
}

func route(clean, forced *shapeOps, s side, name string, op *opendesignerv1.Op) {
	switch s {
	case takeBranch:
		clean.ops = append(clean.ops, op)
		clean.names = append(clean.names, name)
	case conflict:
		forced.ops = append(forced.ops, op)
		forced.names = append(forced.names, name)
	}
}
