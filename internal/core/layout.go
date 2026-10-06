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
// rectangle, ellipse, text, image, vector, frame and instance (an instance is laid out
// with the width/height of its own node). Groups stay where they are: their bounds are
// derived from the children and there is no measure to lay out.
//
// Beyond the row/column, a frame can WRAP its children onto several lines, and a
// child can FILL the free space of its axis (LayoutSizing). A frame WITHOUT auto
// layout instead keeps its children where they are, and when it is resized moves and
// resizes them by their CONSTRAINTS (resizeChildren).

// layoutKind reports whether the node has a measure of its own to lay out.
func participates(n *opendesignerv1.Node) bool {
	if !n.GetVisible() {
		return false
	}
	switch n.GetShape().(type) {
	case nil,
		*opendesignerv1.Node_Rect, *opendesignerv1.Node_Ellipse, *opendesignerv1.Node_Text,
		*opendesignerv1.Node_Image, *opendesignerv1.Node_Vector, *opendesignerv1.Node_Frame,
		*opendesignerv1.Node_Instance:
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

// isFrame: a frame, with or without auto layout.
func isFrame(n *opendesignerv1.Node) bool {
	_, ok := n.GetShape().(*opendesignerv1.Node_Frame)
	return ok
}

// layoutFrame re-lays-out the children of ONE frame and, if hug, resizes its axes.
// It does nothing for a node that is not a frame with auto layout.
//
// Three modes, one set of rules:
//   - a row/column (the default);
//   - the same with FILL children: the main-axis free space is shared equally among the
//     children that fill it (hug on that axis turns them back into fixed ones), and a
//     cross-axis fill child spans the inner cross extent;
//   - WRAP (not when the main axis hugs): the children flow onto lines as long as the
//     inner main extent, each line aligned on its own, `cross_spacing` apart. Fill is
//     ignored (the lines are what gives the children their room).
//
// A child frame whose size the layout changes is laid out again (auto layout) or
// resizes ITS children by their constraints, so the effect propagates down.
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
	setMain := func(n *opendesignerv1.Node, v float64) {
		if vertical {
			n.Height = v
		} else {
			n.Width = v
		}
	}
	setCross := func(n *opendesignerv1.Node, v float64) {
		if vertical {
			n.Width = v
		} else {
			n.Height = v
		}
	}
	fillMain := func(n *opendesignerv1.Node) bool {
		if vertical {
			return n.GetLayoutSizingY() == opendesignerv1.LayoutSizing_LAYOUT_SIZING_FILL
		}
		return n.GetLayoutSizingX() == opendesignerv1.LayoutSizing_LAYOUT_SIZING_FILL
	}
	fillCross := func(n *opendesignerv1.Node) bool {
		if vertical {
			return n.GetLayoutSizingX() == opendesignerv1.LayoutSizing_LAYOUT_SIZING_FILL
		}
		return n.GetLayoutSizingY() == opendesignerv1.LayoutSizing_LAYOUT_SIZING_FILL
	}

	// What each child measured BEFORE the layout, to know which child frames to follow up.
	type size struct{ w, h float64 }
	before := make([]size, len(kids))
	for i, k := range kids {
		before[i] = size{k.GetWidth(), k.GetHeight()}
	}

	spacing := al.GetSpacing()
	wrap := al.GetWrap() && !hugMain
	innerMain := mainOf(frame) - padMainStart - padMainEnd

	if wrap {
		layoutWrapped(kids, frame, al, vertical, innerMain, padMainStart, padCrossStart, padCrossEnd, hugCross, mainOf, crossOf, setMain, setCross)
	} else {
		layoutLine(kids, frame, al, vertical, hugMain, hugCross, padMainStart, padMainEnd, padCrossStart, padCrossEnd, spacing,
			mainOf, crossOf, setMain, setCross, fillMain, fillCross)
	}

	// Follow up the child frames whose size the layout changed.
	for i, k := range kids {
		if (k.GetWidth() != before[i].w || k.GetHeight() != before[i].h) && isFrame(k) {
			if autoLayoutOf(k) != nil {
				layoutFrame(doc, k.GetId(), cow)
			} else {
				resizeChildren(doc, k.GetId(), before[i].w, before[i].h, cow)
			}
		}
	}
}

// layoutLine: a single row/column, with fill children.
func layoutLine(
	kids []*opendesignerv1.Node, frame *opendesignerv1.Node, al *opendesignerv1.AutoLayout, vertical, hugMain, hugCross bool,
	padMainStart, padMainEnd, padCrossStart, padCrossEnd, spacing float64,
	mainOf, crossOf func(*opendesignerv1.Node) float64, setMain, setCross func(*opendesignerv1.Node, float64),
	fillMain, fillCross func(*opendesignerv1.Node) bool,
) {
	// A hugging axis cannot also be filled: its length is the content's.
	isFillMain := func(k *opendesignerv1.Node) bool { return !hugMain && fillMain(k) }
	isFillCross := func(k *opendesignerv1.Node) bool { return !hugCross && fillCross(k) }

	var sum, maxCross float64
	nFill := 0
	for _, k := range kids {
		if isFillMain(k) {
			nFill++
		} else {
			sum += mainOf(k)
		}
		if !isFillCross(k) {
			if c := crossOf(k); c > maxCross {
				maxCross = c
			}
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

	// The fill children share what is left; afterwards nothing is free.
	if nFill > 0 {
		share := float64(0)
		if free > 0 {
			share = free / float64(nFill)
		}
		for _, k := range kids {
			if isFillMain(k) {
				setMain(k, share)
			}
		}
		free = 0
	}
	for _, k := range kids {
		if isFillCross(k) {
			c := innerCross
			if c < 0 {
				c = 0
			}
			setCross(k, c)
		}
	}

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

// layoutWrapped: the children flow onto lines. The main axis never hugs here.
func layoutWrapped(
	kids []*opendesignerv1.Node, frame *opendesignerv1.Node, al *opendesignerv1.AutoLayout, vertical bool,
	innerMain, padMainStart, padCrossStart, padCrossEnd float64, hugCross bool,
	mainOf, crossOf func(*opendesignerv1.Node) float64, _, _ func(*opendesignerv1.Node, float64),
) {
	spacing, crossSpacing := al.GetSpacing(), al.GetCrossSpacing()

	// Split into lines: a child that does not fit goes to the next one (a line always has
	// at least one child, even if it is longer than the frame).
	type line struct {
		from, to      int // kids[from:to]
		sum, maxCross float64
	}
	var lines []line
	cur := line{}
	for i, k := range kids {
		need := mainOf(k)
		if i > cur.from {
			need = float64(cur.sum+spacing) + mainOf(k)
		}
		if i > cur.from && need > innerMain {
			cur.to = i
			lines = append(lines, cur)
			cur = line{from: i}
			need = mainOf(k)
		}
		cur.sum = need
		if c := crossOf(k); c > cur.maxCross {
			cur.maxCross = c
		}
	}
	if len(kids) > 0 {
		cur.to = len(kids)
		lines = append(lines, cur)
	}

	if hugCross {
		var total float64
		for _, l := range lines {
			total += l.maxCross
		}
		if len(lines) > 1 {
			total += float64(crossSpacing * float64(len(lines)-1))
		}
		frameCross := padCrossStart + total + padCrossEnd
		if vertical {
			frame.Width = frameCross
		} else {
			frame.Height = frameCross
		}
	}

	crossPos := padCrossStart
	for _, l := range lines {
		n := l.to - l.from
		free := innerMain - l.sum
		pos := padMainStart
		step := spacing
		switch al.GetMainAlign() {
		case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_CENTER:
			pos = padMainStart + free/2
		case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_END:
			pos = padMainStart + free
		case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_SPACE_BETWEEN:
			if n > 1 && free > 0 {
				step = spacing + free/float64(n-1)
			}
		}
		for _, k := range kids[l.from:l.to] {
			cross := crossPos
			switch al.GetCrossAlign() {
			case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_CENTER:
				cross = crossPos + (l.maxCross-crossOf(k))/2
			case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_END:
				cross = crossPos + (l.maxCross - crossOf(k))
			}
			if vertical {
				k.X, k.Y = cross, pos
			} else {
				k.X, k.Y = pos, cross
			}
			pos = pos + mainOf(k) + step
		}
		crossPos = crossPos + l.maxCross + crossSpacing
	}
}

// constrainAxis moves and resizes one child along ONE axis after its parent frame went from
// `oldFrame` to `newFrame` on that axis. `resizable` is false for nodes whose size is
// not a free field (vector, group, instance): they only move.
func constrainAxis(mode opendesignerv1.Constraint, pos, size *float64, oldFrame, newFrame float64, resizable bool) {
	d := newFrame - oldFrame
	switch mode {
	case opendesignerv1.Constraint_CONSTRAINT_MAX:
		*pos = *pos + d
	case opendesignerv1.Constraint_CONSTRAINT_STRETCH:
		if resizable {
			s := *size + d
			if s < 0 {
				s = 0
			}
			*size = s
		}
	case opendesignerv1.Constraint_CONSTRAINT_CENTER:
		*pos = *pos + d/2
	case opendesignerv1.Constraint_CONSTRAINT_SCALE:
		if oldFrame > 0 {
			r := newFrame / oldFrame
			*pos = float64(*pos * r)
			if resizable {
				*size = float64(*size * r)
			}
		}
	}
}

func hasFreeSize(n *opendesignerv1.Node) bool {
	switch n.GetShape().(type) {
	case *opendesignerv1.Node_Vector, *opendesignerv1.Node_Group, *opendesignerv1.Node_Instance:
		return false
	}
	return true
}

// resizeChildren applies the CONSTRAINTS of the children of frame `id`, which has just
// gone from oldW x oldH to its current size. A frame with auto layout is skipped (its
// layout decides), and so is a frame that did not change. A child frame that this
// resizes follows up on its own children, recursively.
func resizeChildren(doc *opendesignerv1.Document, id string, oldW, oldH float64, cow *Shared) {
	frame := doc.GetNodes()[id]
	if frame == nil || !isFrame(frame) || autoLayoutOf(frame) != nil {
		return
	}
	newW, newH := frame.GetWidth(), frame.GetHeight()
	if newW == oldW && newH == oldH {
		return
	}
	for _, c := range ChildrenOf(doc, id) {
		k := cow.mut(doc, c.GetId())
		oldKW, oldKH := k.GetWidth(), k.GetHeight()
		free := hasFreeSize(k)
		constrainAxis(k.GetConstraintX(), &k.X, &k.Width, oldW, newW, free)
		constrainAxis(k.GetConstraintY(), &k.Y, &k.Height, oldH, newH, free)
		if (k.GetWidth() != oldKW || k.GetHeight() != oldKH) && isFrame(k) {
			if autoLayoutOf(k) != nil {
				layoutFrame(doc, k.GetId(), cow)
			} else {
				resizeChildren(doc, k.GetId(), oldKW, oldKH, cow)
			}
		}
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
