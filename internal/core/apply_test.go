package core

import (
	"errors"
	"fmt"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

func rectNode(id string, x, y float64) *opendesignerv1.Node {
	return &opendesignerv1.Node{
		Id: id, ParentId: "page1", OrderKey: "a0", Name: "Rect", Visible: true, Opacity: 1,
		X: x, Y: y, Width: 100, Height: 80,
		Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}},
	}
}

func TestApplyCreateNode(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	op := &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: rectNode("n1", 10, 20)}}}
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply create: %v", err)
	}
	got, ok := doc.Nodes["n1"]
	if !ok {
		t.Fatal("node n1 not present after create")
	}
	if got.X != 10 || got.Y != 20 {
		t.Fatalf("wrong pos: %v,%v", got.X, got.Y)
	}
}

func TestApplyCreateDuplicateFails(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: rectNode("n1", 0, 0)}}})
	err := Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: rectNode("n1", 5, 5)}}})
	if err == nil {
		t.Fatal("expected error on duplicate create")
	}
}

func TestApplySetPropertiesMoves(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: rectNode("n1", 0, 0)}}})
	op := &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id:    "n1",
		Patch: &opendesignerv1.Node{X: 42, Y: 7},
		Mask:  &fieldmaskpb.FieldMask{Paths: []string{"x", "y"}},
	}}}
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply setprops: %v", err)
	}
	if doc.Nodes["n1"].X != 42 || doc.Nodes["n1"].Y != 7 {
		t.Fatalf("move not applied: %+v", doc.Nodes["n1"])
	}
}

func TestApplySetPropertiesMissingNode(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	err := Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: "ghost", Patch: &opendesignerv1.Node{X: 1}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"x"}},
	}}})
	if err == nil {
		t.Fatal("expected ErrNodeNotFound")
	}
}

func TestApplySetPropertiesMixedMaskIsAllOrNothing(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: rectNode("n1", 0, 0)}}})
	op := &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id:    "n1",
		Patch: &opendesignerv1.Node{X: 42, Y: 7},
		Mask:  &fieldmaskpb.FieldMask{Paths: []string{"x", "bogus"}},
	}}}
	if err := Apply(doc, op); err == nil {
		t.Fatal("expected error for unsupported mask path")
	}
	got := doc.Nodes["n1"]
	if got.X != 0 || got.Y != 0 {
		t.Fatalf("partial mutation leaked despite error: %+v", got)
	}
}

func ellipseNode(id string) *opendesignerv1.Node {
	return &opendesignerv1.Node{
		Id: id, ParentId: "page1", OrderKey: "a0", Name: "Ellipse", Visible: true, Opacity: 1,
		X: 0, Y: 0, Width: 100, Height: 80,
		Shape: &opendesignerv1.Node_Ellipse{Ellipse: &opendesignerv1.EllipseNode{}},
	}
}

// A GROUP: container without clipping and without geometry of its own (its
// bounds are the union of the children, see web/src/store/groups.ts). x/y are
// the translation it contributes to the children and are 0 at creation.
func groupNode(id string) *opendesignerv1.Node {
	return &opendesignerv1.Node{
		Id: id, ParentId: "page1", OrderKey: "a0", Name: "Group", Visible: true, Opacity: 1,
		Shape: &opendesignerv1.Node_Group{Group: &opendesignerv1.GroupNode{}},
	}
}

// A FRAME: container WITH geometry of its own (the box is its own, not derived
// from the children) and optional clipping. It is the artboard -- it is drawn
// and hit like a shape, unlike a group.
func frameNode(id string, clips bool) *opendesignerv1.Node {
	return &opendesignerv1.Node{
		Id: id, ParentId: "page1", OrderKey: "a0", Name: "Frame", Visible: true, Opacity: 1,
		X: 0, Y: 0, Width: 200, Height: 150,
		Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{ClipsContent: clips}},
	}
}

func setPropsOp(s *opendesignerv1.SetProperties) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: s}}
}

// corner_radius is the ONLY mask path that addresses a field INSIDE the
// `shape` oneof (RectNode.corner_radius) instead of a top-level field of the
// Node. The patch therefore carries it nested in the shape, exactly as a
// CreateNode would.
func TestApplySetPropertiesCornerRadius(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: rectNode("n1", 0, 0)}}})
	op := setPropsOp(&opendesignerv1.SetProperties{
		Id:    "n1",
		Patch: &opendesignerv1.Node{Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{CornerRadius: 12}}},
		Mask:  &fieldmaskpb.FieldMask{Paths: []string{"corner_radius"}},
	})
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply corner_radius: %v", err)
	}
	if got := doc.Nodes["n1"].GetRect().GetCornerRadius(); got != 12 {
		t.Fatalf("corner radius not applied: %v", got)
	}
}

// A patch WITHOUT rect resets the radius, like any other path: applySetProps
// reads the patch with protobuf's nil-safe getters (see the comment on
// NIL_PATCH in web/src/store/applyOp.ts, which documents the same choice on
// the TypeScript side).
func TestApplySetPropertiesCornerRadiusNilPatchZeroes(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	n := rectNode("n1", 0, 0)
	n.Shape = &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{CornerRadius: 8}}
	_ = Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}})
	op := setPropsOp(&opendesignerv1.SetProperties{
		Id:   "n1",
		Mask: &fieldmaskpb.FieldMask{Paths: []string{"corner_radius"}},
	})
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply corner_radius without patch: %v", err)
	}
	if got := doc.Nodes["n1"].GetRect().GetCornerRadius(); got != 0 {
		t.Fatalf("corner radius not reset by the nil patch: %v", got)
	}
}

// The `shape` oneof is the NATURE of the node: a corner_radius on an ellipse (or
// a text) is an op on the wrong node, not a field to fill in -- same rule as
// applySetText on a rectangle (ErrNotTextNode). The op is rejected
// ALL-OR-NOTHING, so not even the "x" travelling in the same mask moves.
func TestApplySetPropertiesCornerRadiusOnNonRectFails(t *testing.T) {
	for _, tc := range []struct {
		name string
		node *opendesignerv1.Node
	}{
		{"ellipse", ellipseNode("n1")},
		{"text", textNode("n1", "hello")},
		// An image is a node whose shape CARRIES DATA (the asset's hash):
		// materializing a rectangle on top of it would not just reset a radius, it
		// would delete the reference to the bytes -- and the op's inverse would not
		// know how to put them back.
		{"image", imageNode("n1", testAssetHash)},
		// And the vector, the sample of ALL the shapes the other tracks add: with the
		// old {Ellipse, Text} blacklist a setProps{corner_radius} on a vector node
		// passed validation and deleted its subpaths (diverging from applyOp.ts). The
		// whitelist rejects it like every non-rectangle.
		{"vector", vectorNode("n1", richSubPath(false))},
		// A group is not a shape: it has nothing to fill, hence no corner to
		// round. The client rejects it with the same guard
		// (`cur.kind !== "rect"`, web/src/store/applyOp.ts).
		{"group", groupNode("n1")},
		// A FRAME has a box of its own and is drawn like a shape, but its shape is
		// the FrameNode, not a RectNode: the radius has nowhere to land. Rejected by
		// the same guard that rejects a group.
		{"frame", frameNode("n1", true)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			doc := NewDocument("doc1", "Untitled")
			// Captured BEFORE Apply: applyCreate puts the same pointer in the
			// document, so comparing the node with tc.node after the op would be
			// comparing it with itself.
			wantShape := fmt.Sprintf("%T", tc.node.GetShape())
			wantSubpaths := len(tc.node.GetVector().GetSubpaths())
			_ = Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: tc.node}}})
			op := setPropsOp(&opendesignerv1.SetProperties{
				Id: "n1",
				Patch: &opendesignerv1.Node{
					X:     42,
					Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{CornerRadius: 12}},
				},
				Mask: &fieldmaskpb.FieldMask{Paths: []string{"x", "corner_radius"}},
			})
			if err := Apply(doc, op); !errors.Is(err, ErrNotRectNode) {
				t.Fatalf("expected ErrNotRectNode, got %v", err)
			}
			got := doc.Nodes["n1"]
			if got.GetX() != 0 {
				t.Fatalf("partial mutation leaked despite error: x=%v", got.GetX())
			}
			// "It did not become a rect" is not enough: the shape must still be the
			// one it was, with the same stuff inside. A vector node emptied of its
			// subpaths would still be a Node_Vector.
			if gotShape := fmt.Sprintf("%T", got.GetShape()); gotShape != wantShape {
				t.Fatalf("shape replaced by a rejected setProps: %s -> %s", wantShape, gotShape)
			}
			if n := len(got.GetVector().GetSubpaths()); n != wantSubpaths {
				t.Fatalf("geometry lost by a rejected setProps: %d subpaths -> %d", wantSubpaths, n)
			}
		})
	}
}

// A Node without `shape` is still a RECTANGLE for anyone reading the
// document: web/src/store/types.ts::toNodeLite explicitly maps it to
// kind "rect" ("a node without shape is still a drawable rectangle").
// Rejecting corner_radius here would make the two implementations diverge --
// the client would apply it, the server would not -- so the implicit
// rectangle is materialized.
func TestApplySetPropertiesCornerRadiusOnShapelessNodeMaterializesRect(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	n := rectNode("n1", 0, 0)
	n.Shape = nil
	_ = Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}})
	op := setPropsOp(&opendesignerv1.SetProperties{
		Id:    "n1",
		Patch: &opendesignerv1.Node{Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{CornerRadius: 4}}},
		Mask:  &fieldmaskpb.FieldMask{Paths: []string{"corner_radius"}},
	})
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply corner_radius on a node without shape: %v", err)
	}
	if got := doc.Nodes["n1"].GetRect().GetCornerRadius(); got != 4 {
		t.Fatalf("corner radius not applied: %v", got)
	}
}

// --- strokes (track 2) ------------------------------------------------------
//
// `strokes` is REPEATED like `fills`, and the write semantics are the same:
// the mask REPLACES the whole list, it does not merge element by element. It is
// the point where the two implementations (here and web/src/store/applyOp.ts)
// could silently diverge -- a shorter list that leaves the old strokes at the
// tail is only noticed by looking at the canvas -- so the replacement is
// pinned by a test on both sides, as well as by the golden fixture
// testdata/golden/strokes.json.

func stroke(weight float64, align opendesignerv1.StrokeAlign, r, g, b float32) *opendesignerv1.Stroke {
	return &opendesignerv1.Stroke{
		Paint: &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Solid{
			Solid: &opendesignerv1.SolidPaint{Color: &opendesignerv1.Color{R: r, G: g, B: b, A: 1}},
		}},
		Weight: weight,
		Align:  align,
	}
}

func TestApplySetPropertiesStrokesReplacesTheWholeList(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	n := rectNode("n1", 0, 0)
	n.Strokes = []*opendesignerv1.Stroke{
		stroke(4, opendesignerv1.StrokeAlign_STROKE_ALIGN_CENTER, 1, 0, 0),
		stroke(2, opendesignerv1.StrokeAlign_STROKE_ALIGN_INSIDE, 0, 1, 0),
	}
	_ = Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}})

	op := setPropsOp(&opendesignerv1.SetProperties{
		Id: "n1",
		Patch: &opendesignerv1.Node{Strokes: []*opendesignerv1.Stroke{
			stroke(9, opendesignerv1.StrokeAlign_STROKE_ALIGN_OUTSIDE, 0, 0, 1),
		}},
		Mask: &fieldmaskpb.FieldMask{Paths: []string{"strokes"}},
	})
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply strokes: %v", err)
	}
	got := doc.Nodes["n1"].GetStrokes()
	// ONE, not three: the new list replaces the old one. If the two
	// implementations diverged here, the authoritative document and the
	// client's would show a DIFFERENT number of strokes on the same node.
	if len(got) != 1 {
		t.Fatalf("the list was not replaced: %d strokes", len(got))
	}
	if got[0].GetWeight() != 9 {
		t.Fatalf("wrong weight: %v", got[0].GetWeight())
	}
	if got[0].GetAlign() != opendesignerv1.StrokeAlign_STROKE_ALIGN_OUTSIDE {
		t.Fatalf("wrong alignment: %v", got[0].GetAlign())
	}
	if c := got[0].GetPaint().GetSolid().GetColor(); c.GetB() != 1 {
		t.Fatalf("wrong color: %+v", c)
	}
}

// Like any other path: a patch WITHOUT strokes resets the list, because
// applySetProps reads the patch with protobuf's nil-safe getters. It is the
// counterpart of NIL_PATCH in web/src/store/applyOp.ts, and it is also how the
// properties panel removes the stroke from a node.
func TestApplySetPropertiesStrokesNilPatchClearsTheList(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	n := rectNode("n1", 0, 0)
	n.Strokes = []*opendesignerv1.Stroke{stroke(4, opendesignerv1.StrokeAlign_STROKE_ALIGN_CENTER, 1, 0, 0)}
	_ = Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}})

	op := setPropsOp(&opendesignerv1.SetProperties{
		Id:   "n1",
		Mask: &fieldmaskpb.FieldMask{Paths: []string{"strokes"}},
	})
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply strokes without patch: %v", err)
	}
	if got := doc.Nodes["n1"].GetStrokes(); len(got) != 0 {
		t.Fatalf("list not reset by the nil patch: %d strokes", len(got))
	}
}

// The stroke lives on EVERY node, not inside the `shape` oneof: unlike
// corner_radius there is no shape to check, and an ellipse or a text
// accepts it like a rectangle.
func TestApplySetPropertiesStrokesOnAnyShape(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: ellipseNode("e1")}}})
	_ = Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: textNode("t1", "hello")}}})
	for _, id := range []string{"e1", "t1"} {
		op := setPropsOp(&opendesignerv1.SetProperties{
			Id:    id,
			Patch: &opendesignerv1.Node{Strokes: []*opendesignerv1.Stroke{stroke(3, opendesignerv1.StrokeAlign_STROKE_ALIGN_CENTER, 0, 0, 0)}},
			Mask:  &fieldmaskpb.FieldMask{Paths: []string{"strokes"}},
		})
		if err := Apply(doc, op); err != nil {
			t.Fatalf("Apply strokes on %s: %v", id, err)
		}
		if got := doc.Nodes[id].GetStrokes(); len(got) != 1 || got[0].GetWeight() != 3 {
			t.Fatalf("stroke not applied on %s: %+v", id, got)
		}
	}
}

// TestApplyCreateNodeOnNilNodesMap covers the scenario the review flagged:
// a *opendesignerv1.Document not built via NewDocument (e.g. proto.Unmarshal-ed
// from a snapshot taken while the document had zero nodes — proto3 omits
// empty map fields from the wire, so the decoded Document has Nodes == nil)
// must not panic when the oplog replay hits the first CreateNode.
func TestApplyCreateNodeOnNilNodesMap(t *testing.T) {
	doc := &opendesignerv1.Document{
		Id: "doc1", Name: "Untitled", SchemaVersion: 1,
		Pages: []*opendesignerv1.Page{{Id: "page1", Name: "Page 1"}},
		// Nodes intentionally left nil to simulate a decoded empty-snapshot Document.
	}
	if doc.Nodes != nil {
		t.Fatal("test setup invalid: Nodes must start nil")
	}
	op := &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: rectNode("n1", 10, 20)}}}
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply create on nil Nodes map: %v", err)
	}
	got, ok := doc.Nodes["n1"]
	if !ok {
		t.Fatal("node n1 not present after create")
	}
	if got.X != 10 || got.Y != 20 {
		t.Fatalf("wrong pos: %v,%v", got.X, got.Y)
	}
}

func textNode(id, content string) *opendesignerv1.Node {
	return &opendesignerv1.Node{
		Id: id, ParentId: "page1", OrderKey: "a0", Name: "Text", Visible: true, Opacity: 1,
		X: 0, Y: 0, Width: 200, Height: 24,
		Shape: &opendesignerv1.Node_Text{Text: &opendesignerv1.TextNode{
			Content: content,
			Style: &opendesignerv1.TextStyle{
				FontFamily: "Inter", FontSize: 16, FontWeight: "400", LineHeight: 1.2,
				Align: opendesignerv1.TextAlign_TEXT_ALIGN_LEFT,
			},
		}},
	}
}

func setTextOp(s *opendesignerv1.SetText) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetText{SetText: s}}
}

func TestApplySetTextChangesContent(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: textNode("t1", "hello")}}})
	if err := Apply(doc, setTextOp(&opendesignerv1.SetText{Id: "t1", Content: "new text"})); err != nil {
		t.Fatalf("Apply setText: %v", err)
	}
	if got := doc.Nodes["t1"].GetText().GetContent(); got != "new text" {
		t.Fatalf("content not applied: %q", got)
	}
}

func TestApplySetTextOnNonTextNodeFails(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: rectNode("n1", 0, 0)}}})
	err := Apply(doc, setTextOp(&opendesignerv1.SetText{Id: "n1", Content: "x"}))
	if err == nil {
		t.Fatal("expected error setting text on a non-text node")
	}
	if doc.Nodes["n1"].GetShape() == nil {
		t.Fatal("shape clobbered by a rejected setText")
	}
	if _, ok := doc.Nodes["n1"].GetShape().(*opendesignerv1.Node_Rect); !ok {
		t.Fatalf("rect turned into %T by a rejected setText", doc.Nodes["n1"].GetShape())
	}
}

func TestApplySetTextMissingNode(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	err := Apply(doc, setTextOp(&opendesignerv1.SetText{Id: "ghost", Content: "x"}))
	if !errors.Is(err, ErrNodeNotFound) {
		t.Fatalf("expected ErrNodeNotFound, got %v", err)
	}
}

// The case that distinguishes "unspecified" from "reset": in proto3 an absent
// style and one with all fields at zero are indistinguishable after the
// protojson round-trip, so without style_present a content-only SetText would
// reset the node's style (font 0 => invisible text).
func TestApplySetTextWithoutStylePresentKeepsStyle(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: textNode("t1", "hello")}}})
	if err := Apply(doc, setTextOp(&opendesignerv1.SetText{Id: "t1", Content: "other"})); err != nil {
		t.Fatalf("Apply setText: %v", err)
	}
	st := doc.Nodes["t1"].GetText().GetStyle()
	if st.GetFontSize() != 16 || st.GetFontFamily() != "Inter" || st.GetLineHeight() != 1.2 {
		t.Fatalf("style clobbered by a style-less setText: %+v", st)
	}
	// An explicit `style` with style_present=false must be ignored too: it is the
	// flag, not the presence of the sub-message, that decides.
	op := setTextOp(&opendesignerv1.SetText{Id: "t1", Content: "third", Style: &opendesignerv1.TextStyle{FontSize: 99}})
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply setText: %v", err)
	}
	if doc.Nodes["t1"].GetText().GetStyle().GetFontSize() != 16 {
		t.Fatalf("style applied despite style_present=false: %+v", doc.Nodes["t1"].GetText().GetStyle())
	}
}

func TestApplySetTextWithStylePresentReplacesStyle(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: textNode("t1", "hello")}}})
	op := setTextOp(&opendesignerv1.SetText{
		Id: "t1", Content: "hello", StylePresent: true,
		Style: &opendesignerv1.TextStyle{
			FontFamily: "Inter", FontSize: 32, FontWeight: "700", LineHeight: 1.5,
			Align: opendesignerv1.TextAlign_TEXT_ALIGN_CENTER,
		},
	})
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply setText: %v", err)
	}
	st := doc.Nodes["t1"].GetText().GetStyle()
	if st.GetFontSize() != 32 || st.GetFontWeight() != "700" || st.GetAlign() != opendesignerv1.TextAlign_TEXT_ALIGN_CENTER {
		t.Fatalf("style not replaced: %+v", st)
	}
}

// ---------------------------------------------------------------------------
// SetVectorPath (op 15) -- the vector geometry.
// ---------------------------------------------------------------------------

// A "rich" subpath: ASYMMETRIC and never-zero bézier handles, so a side that
// forgot in_/out_ (or derived them by mirroring) could not pass by chance. They
// are OFFSETS relative to the anchor (see the proto), so small and centered on
// zero: zero would mean "no handle".
func richSubPath(closed bool) *opendesignerv1.SubPath {
	return &opendesignerv1.SubPath{
		Anchors: []*opendesignerv1.Anchor{
			{X: 10, Y: 20, InX: -2, InY: -1, OutX: 4, OutY: 6},
			{X: 60, Y: 70, InX: -5, InY: -8, OutX: 6, OutY: 1},
		},
		Closed: closed,
	}
}

func vectorNode(id string, subpaths ...*opendesignerv1.SubPath) *opendesignerv1.Node {
	return &opendesignerv1.Node{
		Id: id, ParentId: "page1", OrderKey: "a0", Name: "Vector", Visible: true, Opacity: 1,
		X: 0, Y: 0, Width: 100, Height: 80,
		Shape: &opendesignerv1.Node_Vector{Vector: &opendesignerv1.VectorNode{Subpaths: subpaths}},
	}
}

func setVectorPathOp(s *opendesignerv1.SetVectorPath) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetVectorPath{SetVectorPath: s}}
}

func TestApplySetVectorPathReplacesSubpaths(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: vectorNode("v1", richSubPath(false))}}})

	next := []*opendesignerv1.SubPath{richSubPath(true), {Anchors: []*opendesignerv1.Anchor{{X: 1, Y: 2}}}}
	if err := Apply(doc, setVectorPathOp(&opendesignerv1.SetVectorPath{Id: "v1", Subpaths: next})); err != nil {
		t.Fatalf("Apply setVectorPath: %v", err)
	}
	got := doc.Nodes["v1"].GetVector().GetSubpaths()
	// WHOLESALE replacement: not a merge, not an append.
	if len(got) != 2 {
		t.Fatalf("expected 2 subpaths, got %d", len(got))
	}
	if !got[0].GetClosed() {
		t.Fatal("closed dropped by setVectorPath")
	}
	a := got[0].GetAnchors()[0]
	if a.GetInX() != -2 || a.GetInY() != -1 || a.GetOutX() != 4 || a.GetOutY() != 6 {
		t.Fatalf("bezier handles dropped or mangled: %+v", a)
	}
}

// An EMPTY list is legitimate: it is the path the user emptied, not an
// "unspecified field" to ignore (unlike SetText.style).
func TestApplySetVectorPathEmptyListClearsPath(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: vectorNode("v1", richSubPath(true))}}})
	if err := Apply(doc, setVectorPathOp(&opendesignerv1.SetVectorPath{Id: "v1"})); err != nil {
		t.Fatalf("Apply setVectorPath: %v", err)
	}
	if n := len(doc.Nodes["v1"].GetVector().GetSubpaths()); n != 0 {
		t.Fatalf("expected an emptied path, got %d subpaths", n)
	}
	// The node remains a vector node (emptied), it does not lose its shape: a
	// subsequent setVectorPath must still be accepted.
	if _, ok := doc.Nodes["v1"].GetShape().(*opendesignerv1.Node_Vector); !ok {
		t.Fatalf("shape lost by an emptying setVectorPath: %T", doc.Nodes["v1"].GetShape())
	}
}

// Same precedent as applySetText on a rectangle (ErrNotTextNode): the `shape`
// oneof is the NATURE of the node, not a field to fill in.
func TestApplySetVectorPathOnNonVectorNodeFails(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: rectNode("n1", 0, 0)}}})
	err := Apply(doc, setVectorPathOp(&opendesignerv1.SetVectorPath{Id: "n1", Subpaths: []*opendesignerv1.SubPath{richSubPath(false)}}))
	if !errors.Is(err, ErrNotVectorNode) {
		t.Fatalf("expected ErrNotVectorNode, got %v", err)
	}
	if _, ok := doc.Nodes["n1"].GetShape().(*opendesignerv1.Node_Rect); !ok {
		t.Fatalf("rect turned into %T by a rejected setVectorPath", doc.Nodes["n1"].GetShape())
	}
}

func TestApplySetVectorPathMissingNode(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	err := Apply(doc, setVectorPathOp(&opendesignerv1.SetVectorPath{Id: "ghost"}))
	if !errors.Is(err, ErrNodeNotFound) {
		t.Fatalf("expected ErrNodeNotFound, got %v", err)
	}
}

func TestApplyDeleteNode(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: rectNode("n1", 0, 0)}}})
	if err := Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteNode{DeleteNode: &opendesignerv1.DeleteNode{Id: "n1"}}}); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, ok := doc.Nodes["n1"]; ok {
		t.Fatal("node still present after delete")
	}
}

// --- ImageNode (track 3) -----------------------------------------------------

// An asset's hash is 64 lowercase hex digits (the sha256 of the bytes, see
// internal/store/assets.go). Only one is needed here, per shape.
const testAssetHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func imageNode(id, hash string) *opendesignerv1.Node {
	return &opendesignerv1.Node{
		Id: id, ParentId: "page1", OrderKey: "a0", Name: "Image", Visible: true, Opacity: 1,
		X: 0, Y: 0, Width: 160, Height: 90,
		Shape: &opendesignerv1.Node_Image{Image: &opendesignerv1.ImageNode{AssetHash: hash}},
	}
}

// An ImageNode carries a REFERENCE, never bytes: the op that creates it weighs
// as much as a hash, and the op-log stays a record of intentions instead of an
// archive of images.
func TestApplyCreateImageNodeCarriesOnlyTheHash(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	op := &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: imageNode("i1", testAssetHash)}}}
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply create: %v", err)
	}
	got := doc.Nodes["i1"]
	if got.GetImage().GetAssetHash() != testAssetHash {
		t.Fatalf("asset hash = %q, want %q", got.GetImage().GetAssetHash(), testAssetHash)
	}
	// The proof that no image byte travels in the op: the serialized op is of the
	// order of the hash, not of the order of a photo.
	wire, err := proto.Marshal(op)
	if err != nil {
		t.Fatal(err)
	}
	if len(wire) > 256 {
		t.Fatalf("a CreateNode with an image weighs %d bytes: something beyond the hash is travelling", len(wire))
	}
}

// Moving and resizing an image is a setProps like for any other node: the
// shape is irrelevant, and above all it is not touched.
func TestApplySetPropertiesOnImageKeepsTheAssetHash(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: imageNode("i1", testAssetHash)}}})
	op := setPropsOp(&opendesignerv1.SetProperties{
		Id:    "i1",
		Patch: &opendesignerv1.Node{X: 300, Y: 400},
		Mask:  &fieldmaskpb.FieldMask{Paths: []string{"x", "y"}},
	})
	if err := Apply(doc, op); err != nil {
		t.Fatalf("Apply setProps: %v", err)
	}
	got := doc.Nodes["i1"]
	if got.GetX() != 300 || got.GetY() != 400 {
		t.Fatalf("move not applied: x=%v y=%v", got.GetX(), got.GetY())
	}
	if got.GetImage().GetAssetHash() != testAssetHash {
		t.Fatalf("asset hash lost on a move: %q", got.GetImage().GetAssetHash())
	}
}

// Same rule as a rectangle (ErrNotTextNode): writing text into an image is not
// "filling a missing field", it is an op on the wrong node -- and it would
// replace the shape, i.e. throw away the reference to the asset.
func TestApplySetTextOnImageNodeFails(t *testing.T) {
	doc := NewDocument("doc1", "Untitled")
	_ = Apply(doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: imageNode("i1", testAssetHash)}}})
	if err := Apply(doc, setTextOp(&opendesignerv1.SetText{Id: "i1", Content: "x"})); !errors.Is(err, ErrNotTextNode) {
		t.Fatalf("expected ErrNotTextNode, got %v", err)
	}
	if doc.Nodes["i1"].GetImage().GetAssetHash() != testAssetHash {
		t.Fatal("a rejected setText clobbered the image")
	}
}

// --- M4: components / instances -----------------------------------------------

func instanceNode(id, componentID string, overrides ...*opendesignerv1.InstanceOverride) *opendesignerv1.Node {
	return &opendesignerv1.Node{
		Id: id, ParentId: "page1", OrderKey: "a0", Name: "Instance", Visible: true, Opacity: 1,
		X: 0, Y: 0, Width: 100, Height: 100,
		Shape: &opendesignerv1.Node_Instance{Instance: &opendesignerv1.InstanceNode{
			ComponentId: componentID, Overrides: overrides,
		}},
	}
}

func mkCreate(n *opendesignerv1.Node) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: n}}}
}

func mkCreateComponent(componentID, rootID, name string) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateComponent{CreateComponent: &opendesignerv1.CreateComponent{
		ComponentId: componentID, RootNodeId: rootID, Name: name,
	}}}
}

func mkSetOverride(instanceID string, ov *opendesignerv1.InstanceOverride) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetInstanceOverride{SetInstanceOverride: &opendesignerv1.SetInstanceOverride{
		InstanceId: instanceID, Override: ov,
	}}}
}

func TestApplyCreateComponent(t *testing.T) {
	doc := NewDocument("d", "U")
	_ = Apply(doc, mkCreate(rectNode("master", 0, 0)))
	if err := Apply(doc, mkCreateComponent("c1", "master", "Button")); err != nil {
		t.Fatalf("create component: %v", err)
	}
	if doc.Components["c1"].GetRootNodeId() != "master" || doc.Components["c1"].GetName() != "Button" {
		t.Fatalf("component not registered: %+v", doc.Components["c1"])
	}
	if err := Apply(doc, mkCreateComponent("c1", "master", "X")); !errors.Is(err, ErrComponentExists) {
		t.Fatalf("expected ErrComponentExists, got %v", err)
	}
	if err := Apply(doc, mkCreateComponent("c2", "ghost", "X")); !errors.Is(err, ErrNodeNotFound) {
		t.Fatalf("expected ErrNodeNotFound for missing root, got %v", err)
	}
}

func TestApplyCreateInstanceValidatesComponent(t *testing.T) {
	doc := NewDocument("d", "U")
	if err := Apply(doc, mkCreate(instanceNode("i1", "nope"))); !errors.Is(err, ErrComponentNotFound) {
		t.Fatalf("expected ErrComponentNotFound, got %v", err)
	}
	if _, ok := doc.Nodes["i1"]; ok {
		t.Fatal("a rejected instance must not be created")
	}
	_ = Apply(doc, mkCreate(rectNode("master", 0, 0)))
	_ = Apply(doc, mkCreateComponent("c1", "master", "Button"))
	if err := Apply(doc, mkCreate(instanceNode("i1", "c1"))); err != nil {
		t.Fatalf("create valid instance: %v", err)
	}
}

func TestApplySetInstanceOverride(t *testing.T) {
	doc := NewDocument("d", "U")
	_ = Apply(doc, mkCreate(rectNode("master", 0, 0)))
	_ = Apply(doc, mkCreateComponent("c1", "master", "Button"))
	_ = Apply(doc, mkCreate(instanceNode("i1", "c1")))

	red := &opendesignerv1.InstanceOverride{
		MasterNodeId: "master",
		Fills:        []*opendesignerv1.Paint{{Kind: &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{Color: &opendesignerv1.Color{R: 1, A: 1}}}}},
		FillsPresent: true,
	}
	if err := Apply(doc, mkSetOverride("i1", red)); err != nil {
		t.Fatalf("set override: %v", err)
	}
	ovs := doc.Nodes["i1"].GetInstance().GetOverrides()
	if len(ovs) != 1 || !ovs[0].GetFillsPresent() {
		t.Fatalf("override not set: %+v", ovs)
	}
	// Same master_node_id: REPLACES, only one remains.
	_ = Apply(doc, mkSetOverride("i1", &opendesignerv1.InstanceOverride{MasterNodeId: "master", Text: "x", TextPresent: true}))
	ovs = doc.Nodes["i1"].GetInstance().GetOverrides()
	if len(ovs) != 1 || !ovs[0].GetTextPresent() || ovs[0].GetFillsPresent() {
		t.Fatalf("override not replaced: %+v", ovs)
	}
	// An override that overrides nothing = REMOVAL.
	_ = Apply(doc, mkSetOverride("i1", &opendesignerv1.InstanceOverride{MasterNodeId: "master"}))
	if len(doc.Nodes["i1"].GetInstance().GetOverrides()) != 0 {
		t.Fatal("an empty override should remove it")
	}
	// Override on a non-instance -> rejected.
	_ = Apply(doc, mkCreate(rectNode("r", 0, 0)))
	if err := Apply(doc, mkSetOverride("r", red)); !errors.Is(err, ErrNotInstanceNode) {
		t.Fatalf("expected ErrNotInstanceNode, got %v", err)
	}
}
