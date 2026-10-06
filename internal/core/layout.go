package core

import (
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// AUTO LAYOUT -- the Go half (the authority) of web/src/store/layout.ts.
//
// A frame with `auto_layout` arranges its children in a row. The result is not
// a separate state: it is the children's x/y (and the frame's width/height, if
// hug) written into the document like any other field, after EVERY op that can
// change them. This way a client that knows nothing about auto layout -- an MCP
// agent, an export tool -- reads positions that are already right.
//
// The two implementations (Go and TS) must produce the SAME numbers: they are
// float64 on both sides, so it is enough to perform the same operations in the
// same order. Two precautions make it true:
//   - no multiplication summed with something else in the same expression:
//     on some architectures the Go compiler may FUSE them (FMA), changing the
//     last bit compared to JS. Every product goes through an explicit float64(),
//     which the spec says forbids fusion;
//   - the children's order is that of ChildrenOf (order_key, then id).
// The fixture testdata/golden/auto_layout.json, executed on both sides, pins it.
//
// What participates: the VISIBLE children with a measure of their own --
// rectangle, ellipse, text, image, vector, frame. Groups and instances stay
// where they are: their bounds are derived from the children and there is no
// measure to lay out.

// layoutKind reports whether the node has a measure of its own to lay out.
func participates(n *opendesignerv1.Node) bool {
	if !n.GetVisible() {
		return false
	}
	switch n.GetShape().(type) {
	case nil,
		*opendesignerv1.Node_Rect, *opendesignerv1.Node_Ellipse, *opendesignerv1.Node_Text,
		*opendesignerv1.Node_Image, *opendesignerv1.Node_Vector, *opendesignerv1.Node_Frame:
		return true
	}
	return false
}

func autoLayoutOf(n *opendesignerv1.Node) *opendesignerv1.AutoLayout {
	if n == nil {
		return nil
	}
	return n.GetFrame().GetAutoLayout()
}

// layoutFrame re-lays-out the children of ONE frame and, if hug, resizes its axes.
// It does nothing for a node that is not a frame with auto layout.
func layoutFrame(doc *opendesignerv1.Document, id string, cow *Shared) {
	frame := doc.GetNodes()[id]
	al := autoLayoutOf(frame)
	if al == nil {
		return
	}
	frame = cow.mut(doc, id)
	al = autoLayoutOf(frame)
	vertical := al.GetDirection() == opendesignerv1.LayoutDirection_LAYOUT_DIRECTION_VERTICAL

	var kids []*opendesignerv1.Node
	for _, c := range ChildrenOf(doc, id) {
		if participates(c) {
			kids = append(kids, cow.mut(doc, c.GetId()))
		}
	}

	// The axes in the frame's space: "main" is the one of the direction.
	// padMain*/padCross* are the margins along each axis.
	padL, padT, padR, padB := al.GetPaddingLeft(), al.GetPaddingTop(), al.GetPaddingRight(), al.GetPaddingBottom()
	var padMainStart, padMainEnd, padCrossStart, padCrossEnd float64
	var hugMain, hugCross bool
	if vertical {
		padMainStart, padMainEnd, padCrossStart, padCrossEnd = padT, padB, padL, padR
		hugMain, hugCross = al.GetHugHeight(), al.GetHugWidth()
	} else {
		padMainStart, padMainEnd, padCrossStart, padCrossEnd = padL, padR, padT, padB
		hugMain, hugCross = al.GetHugWidth(), al.GetHugHeight()
	}
	mainOf := func(n *opendesignerv1.Node) float64 {
		if vertical {
			return n.GetHeight()
		}
		return n.GetWidth()
	}
	crossOf := func(n *opendesignerv1.Node) float64 {
		if vertical {
			return n.GetWidth()
		}
		return n.GetHeight()
	}

	spacing := al.GetSpacing()
	var sum, maxCross float64
	for _, k := range kids {
		sum += mainOf(k)
		if c := crossOf(k); c > maxCross {
			maxCross = c
		}
	}
	gaps := float64(0)
	if len(kids) > 1 {
		gaps = float64(spacing * float64(len(kids)-1))
	}

	frameMain, frameCross := mainOf(frame), crossOf(frame)
	if hugMain {
		frameMain = padMainStart + sum + gaps + padMainEnd
	}
	if hugCross {
		frameCross = padCrossStart + maxCross + padCrossEnd
	}
	if vertical {
		frame.Width, frame.Height = frameCross, frameMain
	} else {
		frame.Width, frame.Height = frameMain, frameCross
	}

	innerMain := frameMain - padMainStart - padMainEnd
	innerCross := frameCross - padCrossStart - padCrossEnd
	free := innerMain - sum - gaps

	pos := padMainStart
	step := spacing
	switch al.GetMainAlign() {
	case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_CENTER:
		pos = padMainStart + free/2
	case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_END:
		pos = padMainStart + free
	case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_SPACE_BETWEEN:
		// With fewer than two children there is nothing to distribute between: it stays at the start.
		// If the space is not enough (free < 0) it does not compress below `spacing`.
		if len(kids) > 1 && free > 0 {
			step = spacing + free/float64(len(kids)-1)
		}
	}

	for _, k := range kids {
		cross := padCrossStart
		switch al.GetCrossAlign() {
		case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_CENTER:
			cross = padCrossStart + (innerCross-crossOf(k))/2
		case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_END:
			cross = padCrossStart + (innerCross - crossOf(k))
		}
		if vertical {
			k.X, k.Y = cross, pos
		} else {
			k.X, k.Y = pos, cross
		}
		pos = pos + mainOf(k) + step
	}
}

// layoutTargets lists the frames whose layout may change because of `op`,
// read from state `doc` (which is therefore queried BEFORE and AFTER the op: a
// deleted or moved node leaves the old parent only in the state from
// before). It may contain ids that are not frames with auto layout or that no
// longer exist: layoutFrame ignores them.
func layoutTargets(doc *opendesignerv1.Document, op *opendesignerv1.Op) []string {
	parentOf := func(id string) []string {
		if n := doc.GetNodes()[id]; n != nil {
			return []string{n.GetParentId()}
		}
		return nil
	}
	switch k := op.GetKind().(type) {
	case *opendesignerv1.Op_CreateNode:
		n := k.CreateNode.GetNode()
		return []string{n.GetParentId(), n.GetId()}
	case *opendesignerv1.Op_DeleteNode:
		return parentOf(k.DeleteNode.GetId())
	case *opendesignerv1.Op_ReparentNode:
		return append(parentOf(k.ReparentNode.GetId()), k.ReparentNode.GetNewParentId())
	case *opendesignerv1.Op_SetProps:
		return append(parentOf(k.SetProps.GetId()), k.SetProps.GetId())
	case *opendesignerv1.Op_SetVectorPath:
		return parentOf(k.SetVectorPath.GetId())
	}
	return nil
}

// relayout re-lays-out the touched frames and climbs up: a frame that changes size (hug)
// moves its siblings, so its parent's layout must be redone, and so on
// until the parent is not a frame with auto layout.
//
// Order: from the DEEPEST. A hug frame inside another must have the right
// measure BEFORE the container reads it.
func relayout(doc *opendesignerv1.Document, ids []string, cow *Shared) {
	seen := map[string]bool{}
	depth := func(id string) int {
		d := 0
		for cur := doc.GetNodes()[id]; cur != nil && d <= len(doc.GetNodes()); cur = doc.GetNodes()[cur.GetParentId()] {
			d++
		}
		return d
	}
	var frames []string
	for _, id := range ids {
		if id != "" && !seen[id] && autoLayoutOf(doc.GetNodes()[id]) != nil {
			seen[id] = true
			frames = append(frames, id)
		}
	}
	// Also the ancestors with auto layout: a hug's measure affects them.
	for _, id := range append([]string(nil), frames...) {
		cur := doc.GetNodes()[id]
		for guard := 0; cur != nil && guard <= len(doc.GetNodes()); guard++ {
			p := doc.GetNodes()[cur.GetParentId()]
			if p == nil {
				break
			}
			if autoLayoutOf(p) != nil && !seen[p.GetId()] {
				seen[p.GetId()] = true
				frames = append(frames, p.GetId())
			}
			cur = p
		}
	}
	sort.SliceStable(frames, func(i, j int) bool {
		di, dj := depth(frames[i]), depth(frames[j])
		if di != dj {
			return di > dj
		}
		return frames[i] < frames[j]
	})
	for _, id := range frames {
		layoutFrame(doc, id, cow)
	}
}
