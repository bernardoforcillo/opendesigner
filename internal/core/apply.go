// Package core applies Ops to the document authoritatively.
package core

import (
	"errors"
	"fmt"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
)

var (
	ErrNilNode      = errors.New("core: nil node")
	ErrNodeExists   = errors.New("core: node already exists")
	ErrNodeNotFound = errors.New("core: node not found")
	ErrNotTextNode  = errors.New("core: not a text node")
	ErrNotRectNode  = errors.New("core: not a rect node")
	// ErrNotFrameNode: auto_layout is a field of FrameNode, so writing it to a
	// node that is not a frame is an op on the wrong node (same precedent as
	// ErrNotRectNode for corner_radius).
	ErrNotFrameNode = errors.New("core: not a frame node")
	// ErrNotVectorNode: same precedent as ErrNotTextNode -- the `shape` oneof is
	// the NATURE of the node, so a SetVectorPath on a rectangle is an op on the
	// wrong node, not a missing field to fill in.
	ErrNotVectorNode  = errors.New("core: not a vector node")
	ErrParentNotFound = errors.New("core: parent not found")
	ErrCycle          = errors.New("core: reparent would create a cycle")
	ErrNilPage        = errors.New("core: nil page")
	ErrPageExists     = errors.New("core: page id already taken")
	ErrPageNotFound   = errors.New("core: page not found")
	ErrLastPage       = errors.New("core: cannot delete the last page")
	// M4 — components.
	ErrComponentExists   = errors.New("core: component id already taken")
	ErrComponentNotFound = errors.New("core: component not found")
	ErrNotInstanceNode   = errors.New("core: not an instance node")
	// Flows.
	ErrNilFlow            = errors.New("core: nil flow")
	ErrFlowNotFound       = errors.New("core: flow not found")
	ErrNilTransition      = errors.New("core: nil transition")
	ErrTransitionNotFound = errors.New("core: transition not found")
)

// NewDocument creates an empty document with a default page ("page1").
func NewDocument(id, name string) *opendesignerv1.Document {
	return &opendesignerv1.Document{
		Id: id, Name: name, SchemaVersion: 1,
		Pages: []*opendesignerv1.Page{{Id: "page1", Name: "Page 1"}},
		Nodes: map[string]*opendesignerv1.Node{},
	}
}

// Apply mutates doc by applying op. It returns an error if the op violates an invariant.
//
// After a successful op it re-lays-out the auto layout frames the op may have
// touched (see layout.go): the result is part of the document, not a derived
// state to recompute on read. The affected frames are read both BEFORE the op
// (the old parent of a deleted or moved node) and AFTER (the new one).
func Apply(doc *opendesignerv1.Document, op *opendesignerv1.Op) error {
	return ApplyShared(doc, op, nil)
}

// Shared lets Apply work on a document that SHARES nodes with another one (a
// shallow copy of the map): a node not yet "owned" is cloned before the first
// write, so the other document never sees the mutation. It costs as much as the
// nodes touched by the op, not as much as the document: the server no longer
// clones everything on every op.
type Shared struct{ owned map[string]struct{} }

func NewShared() *Shared { return &Shared{owned: map[string]struct{}{}} }

// mut returns node `id` ready to be written. With a nil *Shared (plain Apply)
// every node already belongs to the document and is written in place.
func (c *Shared) mut(doc *opendesignerv1.Document, id string) *opendesignerv1.Node {
	n := doc.Nodes[id]
	if c == nil || n == nil {
		return n
	}
	if _, ok := c.owned[id]; ok {
		return n
	}
	n = proto.Clone(n).(*opendesignerv1.Node)
	doc.Nodes[id] = n
	c.owned[id] = struct{}{}
	return n
}

// ApplyShared is Apply on a document whose `Nodes` entries may be shared (see
// Shared). With a nil cow it is identical to Apply.
func ApplyShared(doc *opendesignerv1.Document, op *opendesignerv1.Op, cow *Shared) error {
	before := layoutTargets(doc, op)
	if err := applyOp(doc, op, cow); err != nil {
		return err
	}
	relayout(doc, append(before, layoutTargets(doc, op)...), cow)
	return nil
}

func applyOp(doc *opendesignerv1.Document, op *opendesignerv1.Op, cow *Shared) error {
	switch k := op.GetKind().(type) {
	case *opendesignerv1.Op_CreateNode:
		return applyCreate(doc, k.CreateNode, cow)
	case *opendesignerv1.Op_SetProps:
		return applySetProps(doc, k.SetProps, cow)
	case *opendesignerv1.Op_DeleteNode:
		return applyDelete(doc, k.DeleteNode)
	case *opendesignerv1.Op_SetClip:
		return applySetClip(doc, k.SetClip)
	case *opendesignerv1.Op_DeleteClip:
		return applyDeleteClip(doc, k.DeleteClip)
	case *opendesignerv1.Op_SetCollection:
		return applySetCollection(doc, k.SetCollection, cow)
	case *opendesignerv1.Op_DeleteCollection:
		return applyDeleteCollection(doc, k.DeleteCollection, cow)
	case *opendesignerv1.Op_SetVariable:
		return applySetVariable(doc, k.SetVariable)
	case *opendesignerv1.Op_DeleteVariable:
		return applyDeleteVariable(doc, k.DeleteVariable, cow)
	case *opendesignerv1.Op_SetFont:
		return applySetFont(doc, k.SetFont)
	case *opendesignerv1.Op_DeleteFont:
		return applyDeleteFont(doc, k.DeleteFont)
	case *opendesignerv1.Op_SetTextStyleDef:
		return applySetTextStyleDef(doc, k.SetTextStyleDef)
	case *opendesignerv1.Op_DeleteTextStyleDef:
		return applyDeleteTextStyleDef(doc, k.DeleteTextStyleDef, cow)
	case *opendesignerv1.Op_SetComponentSet:
		return applySetComponentSet(doc, k.SetComponentSet)
	case *opendesignerv1.Op_DeleteComponentSet:
		return applyDeleteComponentSet(doc, k.DeleteComponentSet)
	case *opendesignerv1.Op_SetComponentDef:
		return applySetComponentDef(doc, k.SetComponentDef)
	case *opendesignerv1.Op_SetInstanceProps:
		return applySetInstanceProps(doc, k.SetInstanceProps, cow)
	case *opendesignerv1.Op_SetFlow:
		return applySetFlow(doc, k.SetFlow)
	case *opendesignerv1.Op_DeleteFlow:
		return applyDeleteFlow(doc, k.DeleteFlow)
	case *opendesignerv1.Op_SetTransition:
		return applySetTransition(doc, k.SetTransition)
	case *opendesignerv1.Op_DeleteTransition:
		return applyDeleteTransition(doc, k.DeleteTransition)
	case *opendesignerv1.Op_SetText:
		return applySetText(doc, k.SetText, cow)
	case *opendesignerv1.Op_SetVectorPath:
		return applySetVectorPath(doc, k.SetVectorPath, cow)
	case *opendesignerv1.Op_ReparentNode:
		return applyReparent(doc, k.ReparentNode, cow)
	case *opendesignerv1.Op_CreatePage:
		return applyCreatePage(doc, k.CreatePage)
	case *opendesignerv1.Op_DeletePage:
		return applyDeletePage(doc, k.DeletePage)
	case *opendesignerv1.Op_RenamePage:
		return applyRenamePage(doc, k.RenamePage)
	case *opendesignerv1.Op_CreateComponent:
		return applyCreateComponent(doc, k.CreateComponent)
	case *opendesignerv1.Op_SetInstanceOverride:
		return applySetInstanceOverride(doc, k.SetInstanceOverride, cow)
	default:
		return fmt.Errorf("core: unknown op kind %T", op.GetKind())
	}
}

func applyCreate(doc *opendesignerv1.Document, c *opendesignerv1.CreateNode, cow *Shared) error {
	n := c.GetNode()
	if n == nil || n.GetId() == "" {
		return ErrNilNode
	}
	if _, exists := doc.Nodes[n.GetId()]; exists {
		return fmt.Errorf("%w: %s", ErrNodeExists, n.GetId())
	}
	// The parent must EXIST: another node (nesting) or a Page (the roots).
	// Without this check a wrong id -- a typo, an op arriving out of order, a
	// client referencing a group just deleted by another -- produces a node that
	// no page reaches: invisible on the canvas and invisible in the layers panel,
	// but present in the document and in the snapshot forever. It is the same
	// reason applyDelete cascades: the `nodes` map is flat, but the DOCUMENT is the
	// tree, and only what hangs from a page is part of it.
	if !parentExists(doc, n.GetParentId()) {
		return fmt.Errorf("%w: %s (node %s)", ErrParentNotFound, n.GetParentId(), n.GetId())
	}
	// An INSTANCE must reference an EXISTING component: without it, it would
	// render nothing (its subtree is derived from the master), and no apply would
	// notice -- the same reason the parent must exist.
	if inst := n.GetInstance(); inst != nil {
		if doc.Components[inst.GetComponentId()] == nil {
			return fmt.Errorf("%w: %s (node %s)", ErrComponentNotFound, inst.GetComponentId(), n.GetId())
		}
	}
	if doc.Nodes == nil {
		// Apply is the authoritative mutator for any *opendesignerv1.Document, not
		// only ones built via NewDocument. proto.Unmarshal resets the
		// destination first, and proto3 omits empty map fields from the
		// wire, so a Document decoded from a zero-node snapshot has
		// Nodes == nil. Lazily init it here so replaying the oplog's first
		// CreateNode doesn't panic on assignment to a nil map.
		doc.Nodes = map[string]*opendesignerv1.Node{}
	}
	doc.Nodes[n.GetId()] = n
	if cow != nil {
		cow.owned[n.GetId()] = struct{}{}
	}
	return nil
}

// applyDelete deletes the node AND ITS WHOLE subtree.
//
// The cascade is not a convenience: without it, deleting a group would leave
// the children in the map with a parent_id that no longer exists -- exactly the
// orphans applyCreate refuses to create. They would be nodes unreachable from
// any page (hence invisible) but still in the document, and a later CreateNode
// reusing that id would be rejected with ErrNodeExists for a node the user
// deleted.
//
// The op stays a SINGLE one: the client sends `deleteNode(g1)` and both the
// server and applyOp (TS) expand the cascade the same way. The INVERSE instead
// is necessarily multiple -- one CreateNode per node, parent before children --
// and lives on the client side (web/src/store/history.ts), the only one that
// keeps a history.
func applyDelete(doc *opendesignerv1.Document, d *opendesignerv1.DeleteNode) error {
	if _, ok := doc.Nodes[d.GetId()]; !ok {
		return fmt.Errorf("%w: %s", ErrNodeNotFound, d.GetId())
	}
	gone := map[string]bool{}
	for _, n := range SubtreeOf(doc, d.GetId()) {
		gone[n.GetId()] = true
		delete(doc.Nodes, n.GetId())
	}
	cascadeFlows(doc, gone)
	cascadeClips(doc, gone)
	cascadeComponentTargets(doc, gone)
	return nil
}

// applyReparent moves a node under another container (or directly under a
// Page) and rewrites its order key among the new siblings.
//
// A dedicated op and not a SetProperties mask path (unlike `order_key`, which
// is a field like the others) because it has a VALIDATION no other field has:
// the new parent must exist and cannot be the node itself nor one of its
// descendants. A cycle would detach the subtree from the document -- it would
// no longer be reachable from any page -- while leaving it in the map:
// invisible, not cascade-deletable (no page reaches it) and able to send any
// naive traversal into a loop.
//
// As with a mixed mask in applySetProps, the rejection is ALL-OR-NOTHING:
// everything is validated before writing any field, so a rejected reparent does
// not leave the node with the new order key and the old parent.
func applyReparent(doc *opendesignerv1.Document, r *opendesignerv1.ReparentNode, cow *Shared) error {
	n, ok := doc.Nodes[r.GetId()]
	if ok {
		n = cow.mut(doc, r.GetId())
	}
	if !ok {
		return fmt.Errorf("%w: %s", ErrNodeNotFound, r.GetId())
	}
	if !parentExists(doc, r.GetNewParentId()) {
		return fmt.Errorf("%w: %s (node %s)", ErrParentNotFound, r.GetNewParentId(), r.GetId())
	}
	// The node itself is the degenerate case of the cycle: IsAncestorOf is STRICT
	// (nobody is an ancestor of themselves), so it must be excluded separately.
	if r.GetNewParentId() == r.GetId() || IsAncestorOf(doc, r.GetId(), r.GetNewParentId()) {
		return fmt.Errorf("%w: %s under %s", ErrCycle, r.GetId(), r.GetNewParentId())
	}
	n.ParentId = r.GetNewParentId()
	// Written ALWAYS, even if empty: as with every other field of an absolute op,
	// the incoming value is the final value. A reparent that keeps the same parent
	// is the reordering among siblings of the layers panel.
	n.OrderKey = r.GetOrderKey()
	return nil
}

// --- pages ------------------------------------------------------------------
//
// Pages are the ROOT containers: every node hangs from one of them and what is
// not reachable from any page is not part of the document (see tree.go). Hence
// the three invariants, mirroring those of nodes:
//
//	1. a page's id is FREE -- neither another page's nor a node's:
//	   parentExists answers "yes" for both, so two containers with the same id
//	   would make the parent of anyone naming them ambiguous;
//	2. deleting a page deletes ALL the nodes hanging under it (the cascade of
//	   applyDelete carried to the root);
//	3. the LAST page is not deleted: without pages there is no valid parent,
//	   so no node could ever be created again.

// pageIndex returns the position of a page in doc.Pages, or -1.
func pageIndex(doc *opendesignerv1.Document, id string) int {
	for i, p := range doc.GetPages() {
		if p.GetId() == id {
			return i
		}
	}
	return -1
}

// applyCreatePage appends a page AT THE END.
//
// At the end and not at an index chosen by the caller: the position in the list
// is the page selector's order, not a document property someone could violate,
// and an `index` in the op would mean clamping, validation and an inverse that
// depends on the position. The only consequence is that undoing the deletion of
// a middle page puts it back at the bottom -- its CONTENT comes back intact,
// which is what an undo must guarantee.
func applyCreatePage(doc *opendesignerv1.Document, c *opendesignerv1.CreatePage) error {
	p := c.GetPage()
	if p == nil || p.GetId() == "" {
		return ErrNilPage
	}
	// An id already taken -- by a page or by a NODE -- is rejected: see
	// invariant 1 above.
	if parentExists(doc, p.GetId()) {
		return fmt.Errorf("%w: %s", ErrPageExists, p.GetId())
	}
	doc.Pages = append(doc.Pages, p)
	return nil
}

// applyDeletePage deletes the page AND ALL the nodes hanging under it.
//
// The op stays a SINGLE one, like deleteNode: the client sends `deletePage(p2)`
// and both the server and applyOp (TS) expand the cascade the same way. The
// inverse is necessarily multiple (createPage + one createNode per node, parent
// before children) and lives on the client side, in web/src/store/history.ts.
func applyDeletePage(doc *opendesignerv1.Document, d *opendesignerv1.DeletePage) error {
	i := pageIndex(doc, d.GetId())
	if i < 0 {
		return fmt.Errorf("%w: %s", ErrPageNotFound, d.GetId())
	}
	if len(doc.GetPages()) == 1 {
		return fmt.Errorf("%w: %s", ErrLastPage, d.GetId())
	}
	// Everything validated BEFORE writing anything, as with a mixed mask: a
	// rejection must not leave the page removed and the nodes in place (or vice
	// versa).
	gone := map[string]bool{}
	for _, root := range ChildrenOf(doc, d.GetId()) {
		for _, n := range SubtreeOf(doc, root.GetId()) {
			gone[n.GetId()] = true
			delete(doc.Nodes, n.GetId())
		}
	}
	cascadeFlows(doc, gone)
	cascadeClips(doc, gone)
	cascadeComponentTargets(doc, gone)
	doc.Pages = append(doc.Pages[:i], doc.Pages[i+1:]...)
	return nil
}

func applyRenamePage(doc *opendesignerv1.Document, r *opendesignerv1.RenamePage) error {
	i := pageIndex(doc, r.GetId())
	if i < 0 {
		return fmt.Errorf("%w: %s", ErrPageNotFound, r.GetId())
	}
	// Written ALWAYS, even if empty: as with Node.name, the incoming value is the
	// final value, and the fallback for an empty name belongs to the UI.
	doc.Pages[i].Name = r.GetName()
	return nil
}

// applySetProps copies the fields listed by the mask from patch to the target node.
// It validates the whole mask before mutating any field: a mixed mask
// (e.g. ["x","bogus"]) must not leave the document partially mutated.
func applySetProps(doc *opendesignerv1.Document, s *opendesignerv1.SetProperties, cow *Shared) error {
	n, ok := doc.Nodes[s.GetId()]
	if ok {
		n = cow.mut(doc, s.GetId())
	}
	if !ok {
		return fmt.Errorf("%w: %s", ErrNodeNotFound, s.GetId())
	}
	paths := s.GetMask().GetPaths()
	for _, path := range paths {
		switch path {
		case "x", "y", "width", "height", "rotation", "opacity", "name", "visible", "fills", "strokes", "effects", "order_key", "meta":
			// supported
		case "bindings":
			// Variable bindings: every key in the grammar, every variable existing
			// and of the property's type. Validated HERE, before any field is
			// written, so a mixed mask does not leave the node half mutated.
			if err := validateBindings(doc, s.GetPatch().GetBindings()); err != nil {
				return err
			}
		case "modes":
			if err := validateModes(doc, s.GetPatch().GetModes()); err != nil {
				return err
			}
		case "text_style_id":
			// Only a text node takes a shared style, and it must exist (or be empty).
			if err := validateTextStyleID(doc, n, s.GetPatch().GetTextStyleId()); err != nil {
				return err
			}
		case "corner_radius":
			// The ONLY mask path that addresses a field INSIDE the `shape` oneof
			// (RectNode.corner_radius) instead of a top-level field of the Node: the
			// patch carries it nested in the shape, and the target node must be a
			// rectangle.
			//
			// The `shape` oneof is the NATURE of the node, not a field of it: a
			// corner_radius on an ellipse or a text is not "a missing field to fill
			// in", it is an op on the wrong node -- the same rule by which applySetText
			// rejects a rectangle (ErrNotTextNode). The rejection lives HERE, in the
			// validation pass, for the same reason the unknown-path one does: a mixed
			// mask (e.g. ["x","corner_radius"]) must not leave the document half
			// mutated.
			//
			// An ABSENT `shape` instead passes: a Node without a shape is a rectangle
			// for anyone reading the document anyway
			// (web/src/store/types.ts::toNodeLite explicitly maps it to kind "rect"),
			// so rejecting it here would make client and server diverge exactly on the
			// node both draw as a rectangle. The implicit rectangle is materialized
			// further below.
			//
			// The guard is a WHITELIST (what a rectangle is) and not a list of the
			// shapes to reject, and it is a difference with teeth: listing the "bad
			// ones" silently lets EVERY shape added later through (image from track 3,
			// vector from track 4, group/frame from track 1), which falls straight into
			// the branch below -- the one that materializes the implicit rectangle --
			// and gets its `shape` REPLACED by a Node_Rect, destroying its own
			// geometry (or, for an image, the byte hash). It happened exactly like this
			// with VectorNode: the list said {Ellipse, Text}, a setProps{corner_radius}
			// on a vector node passed validation and wiped all its subpaths, while the
			// TS twin (web/src/store/applyOp.ts, `cur.kind !== "rect"`) rejected the
			// same op -- authoritative document and client out of sync forever. With
			// the whitelist group, frame and every new shape are rejected by default:
			// the worst it can do is force whoever adds one to decide, instead of
			// losing the user's work.
			switch n.GetShape().(type) {
			case nil, *opendesignerv1.Node_Rect:
				// Explicit rectangle, or implicit (absent shape).
			default:
				return fmt.Errorf("%w: %s", ErrNotRectNode, s.GetId())
			}
		case "auto_layout":
			// Like corner_radius, a field INSIDE the `shape` oneof: it only applies to
			// a frame. The whole op is rejected, so a mixed mask
			// (e.g. "x,auto_layout") on a rectangle does not even move x.
			if _, ok := n.GetShape().(*opendesignerv1.Node_Frame); !ok {
				return fmt.Errorf("%w: %s", ErrNotFrameNode, s.GetId())
			}
		default:
			return fmt.Errorf("core: unsupported mask path %q", path)
		}
	}
	p := s.GetPatch()
	for _, path := range paths {
		switch path {
		case "x":
			n.X = p.GetX()
		case "y":
			n.Y = p.GetY()
		case "width":
			n.Width = p.GetWidth()
		case "height":
			n.Height = p.GetHeight()
		case "rotation":
			n.Rotation = p.GetRotation()
		case "opacity":
			n.Opacity = p.GetOpacity()
		case "name":
			n.Name = p.GetName()
		case "visible":
			n.Visible = p.GetVisible()
		case "meta":
			// Replaces the whole map (like lists). An empty map clears it:
			// nil and {} are the same state after the proto3 round-trip.
			n.Meta = p.GetMeta()
		case "fills":
			n.Fills = p.GetFills()
		case "bindings":
			// Replaces the whole map, like meta. An empty map clears it.
			n.Bindings = p.GetBindings()
		case "modes":
			n.Modes = p.GetModes()
		case "text_style_id":
			n.TextStyleId = p.GetTextStyleId()
		case "strokes":
			// REPLACEMENT of the whole list, exactly like `fills` above -- not an
			// element-by-element merge. It is the REPEATED field on which the two
			// apply implementations could silently diverge (a shorter list that leaves
			// the old strokes at the tail is only noticed by looking at the canvas), so
			// the semantics are fixed by a test per side and by the fixture
			// testdata/golden/strokes.json, which the runner executes from both.
			//
			// Unlike corner_radius there is NO shape to check: the stroke is a
			// top-level field of the Node, and it holds for a rectangle as well as for
			// an ellipse or a text.
			n.Strokes = p.GetStrokes()
		case "effects":
			// REPLACEMENT of the whole list, like fills and strokes. Top-level field:
			// it holds for any shape. A patch that arrives without effects clears the
			// list -- the mask says what to write, not the patch.
			n.Effects = p.GetEffects()
		case "order_key":
			// The drawing order (and that of the layers panel) is a FIELD like the
			// others, not a dedicated op: reordering is writing a new order key,
			// computed by the client as a fractional index between the two neighbors
			// of the destination position. First multi-word path of the mask -- on the
			// JSON wire it travels as "orderKey" (see web/src/store/maskPaths.ts).
			n.OrderKey = p.GetOrderKey()
		case "auto_layout":
			// The validation pass already excluded every node that is not a frame. The
			// value comes from the patch NESTED in the frame shape; a patch without
			// frame (or without auto_layout) turns it OFF -- the nil-safe getter, as
			// for lists with the "fills" mask.
			n.GetFrame().AutoLayout = proto.Clone(p.GetFrame().GetAutoLayout()).(*opendesignerv1.AutoLayout)
		case "corner_radius":
			// The validation pass already excluded ellipse and text: what remains here
			// is a rectangle, explicit or implicit. In the latter case (absent shape,
			// or Node_Rect with nil Rect after a round-trip) the rectangle must be
			// materialized before writing into it -- otherwise the assignment would
			// go to a nil pointer.
			r := n.GetRect()
			if r == nil {
				r = &opendesignerv1.RectNode{}
				n.Shape = &opendesignerv1.Node_Rect{Rect: r}
			}
			r.CornerRadius = p.GetRect().GetCornerRadius()
		}
	}
	return nil
}

// applySetText writes the content (and, if requested, the style) of a text node.
//
// A dedicated op and not a SetProperties mask path: the content lives INSIDE
// the `shape` oneof, while the mask addresses top-level fields of the Node -- a
// nested path would force this function and its TS twin
// (web/src/store/applyOp.ts) to carry a path parser.
//
// The content is ALWAYS written (even if empty: it is the text the user
// deleted). The style is not: `style_present` distinguishes "unspecified" from
// "reset". In proto3 an absent sub-message and one with all fields at zero are
// indistinguishable after the protojson round-trip, so without the flag every
// content-only SetText -- i.e. every keystroke -- would bring the font to 0 and
// make the node invisible. With the flag: false => the existing style stays
// intact, true => it is replaced by `style` (nil included, which is the
// explicit reset).
func applySetText(doc *opendesignerv1.Document, s *opendesignerv1.SetText, cow *Shared) error {
	n, ok := doc.Nodes[s.GetId()]
	if ok {
		n = cow.mut(doc, s.GetId())
	}
	if !ok {
		return fmt.Errorf("%w: %s", ErrNodeNotFound, s.GetId())
	}
	// The `shape` oneof is the NATURE of the node, not a field of it: a SetText on
	// a rectangle is not "a missing field to fill in", it is an op on the wrong
	// node. Writing into it would silently transform the shape (and, since the op
	// has no inverse for the rect that was there before, in a non-undoable way), so
	// the op is rejected without touching anything.
	t, isText := n.GetShape().(*opendesignerv1.Node_Text)
	if !isText || t.Text == nil {
		return fmt.Errorf("%w: %s", ErrNotTextNode, s.GetId())
	}
	t.Text.Content = s.GetContent()
	if s.GetStylePresent() {
		t.Text.Style = s.GetStyle()
	}
	return nil
}

// applySetVectorPath replaces the subpaths of a vector node WHOLESALE.
//
// A dedicated op and not a SetProperties mask path for the same reason as
// applySetText: the geometry lives INSIDE the `shape` oneof, while the mask
// addresses top-level fields of the Node.
//
// The list is ALWAYS written, even if empty -- it is the path the user emptied,
// not an "unspecified" to ignore. No `present` flag like
// SetText.style_present: there the flag was needed because a SetText carries
// TWO things (content and style) and one of them had to be able to stay intact;
// here the op IS the subpaths, so "absent" and "empty" describe the same state
// and the proto3 distinction is not observable.
func applySetVectorPath(doc *opendesignerv1.Document, s *opendesignerv1.SetVectorPath, cow *Shared) error {
	n, ok := doc.Nodes[s.GetId()]
	if ok {
		n = cow.mut(doc, s.GetId())
	}
	if !ok {
		return fmt.Errorf("%w: %s", ErrNodeNotFound, s.GetId())
	}
	// Same rejection as applySetText on a non-text: writing a geometry into a
	// rectangle would silently change its SHAPE, and the op has no inverse for the
	// rectangle that was there before -- hence non-undoably. Note that here there
	// is NO "absent shape = implicit rectangle" fallback as in applySetProps: a
	// node without a shape is a rectangle for anyone reading the document
	// (web/src/store/types.ts::toNodeLite), so it is exactly the case to reject.
	v, isVector := n.GetShape().(*opendesignerv1.Node_Vector)
	if !isVector || v.Vector == nil {
		return fmt.Errorf("%w: %s", ErrNotVectorNode, s.GetId())
	}
	v.Vector.Subpaths = s.GetSubpaths()
	return nil
}

// applyCreateComponent registers an EXISTING subtree as the master of a
// component. It copies nothing: the master stays in `nodes`, instances
// reference it by component_id, and master->instance propagation is therefore
// free (instances read the live master). Rejected if the id is already taken or
// if the root does not exist -- a component pointing at nothing would give
// instances that render nothing, with no way of noticing at apply time.
func applyCreateComponent(doc *opendesignerv1.Document, c *opendesignerv1.CreateComponent) error {
	if c.GetComponentId() == "" {
		return fmt.Errorf("%w: (empty id)", ErrComponentNotFound)
	}
	if _, exists := doc.Components[c.GetComponentId()]; exists {
		return fmt.Errorf("%w: %s", ErrComponentExists, c.GetComponentId())
	}
	if _, ok := doc.Nodes[c.GetRootNodeId()]; !ok {
		return fmt.Errorf("%w: %s (component %s)", ErrNodeNotFound, c.GetRootNodeId(), c.GetComponentId())
	}
	if doc.Components == nil {
		doc.Components = map[string]*opendesignerv1.Component{}
	}
	doc.Components[c.GetComponentId()] = &opendesignerv1.Component{
		RootNodeId: c.GetRootNodeId(),
		Name:       c.GetName(),
	}
	return nil
}

// applySetInstanceOverride sets, replaces or REMOVES an instance's override on
// a master node. The replaced override is the one with the same
// master_node_id; if the incoming one overrides nothing
// (fills_present=false && text_present=false) the override is removed -- the
// node goes back to inheriting from the master. Rejected if the node is not an
// instance: an override on a rectangle is an op on the wrong node, not a field
// to fill in.
func applySetInstanceOverride(doc *opendesignerv1.Document, s *opendesignerv1.SetInstanceOverride, cow *Shared) error {
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
	ov := s.GetOverride()
	if ov == nil || ov.GetMasterNodeId() == "" {
		return fmt.Errorf("core: instance override with empty master_node_id: %s", s.GetInstanceId())
	}
	// Remove the override with the same master_node_id, then put the new one back
	// only if it actually overrides something (otherwise the op IS a removal).
	kept := make([]*opendesignerv1.InstanceOverride, 0, len(inst.GetOverrides())+1)
	for _, o := range inst.GetOverrides() {
		if o.GetMasterNodeId() != ov.GetMasterNodeId() {
			kept = append(kept, o)
		}
	}
	if ov.GetFillsPresent() || ov.GetTextPresent() {
		kept = append(kept, ov)
	}
	inst.Overrides = kept
	return nil
}
