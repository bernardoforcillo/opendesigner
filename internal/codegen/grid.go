package codegen

import (
	"strconv"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// gridTracksCSS is a grid-template-columns / -rows value. A hug track is max-content, an fr track
// `<weight>fr` (max-content when the frame hugs that axis, like the core), a fixed one its pixels.
func gridTracksCSS(tracks []*opendesignerv1.GridTrack, hug bool) string {
	if len(tracks) == 0 {
		return "max-content"
	}
	out := ""
	for i, t := range tracks {
		if i > 0 {
			out += " "
		}
		switch {
		case t.GetKind() == opendesignerv1.GridTrackKind_GRID_TRACK_KIND_FIXED:
			out += px(t.GetSize())
		case t.GetKind() == opendesignerv1.GridTrackKind_GRID_TRACK_KIND_FR && !hug:
			w := t.GetSize()
			if !(w > 0) {
				w = 1
			}
			out += num(w) + "fr"
		default:
			out += "max-content"
		}
	}
	return out
}

// gridProps is flexProps for a GRID auto layout: display:grid with the tracks, the gaps and the
// in-cell alignment (main_align horizontally, cross_align vertically; start unless center / end).
func gridProps(el *Element, al *opendesignerv1.AutoLayout) {
	el.addStyle("display", "grid")
	el.addStyle("grid-template-columns", gridTracksCSS(al.GetColumns(), al.GetHugWidth()))
	if len(al.GetRows()) > 0 {
		el.addStyle("grid-template-rows", gridTracksCSS(al.GetRows(), al.GetHugHeight()))
	}
	el.addStyle("grid-auto-rows", "max-content")
	el.addStyle("grid-auto-columns", "max-content")
	el.addStyle("justify-content", "start")
	el.addStyle("align-content", "start")
	el.addStyle("justify-items", cellAlignCSS(al.GetMainAlign()))
	el.addStyle("align-items", cellAlignCSS(al.GetCrossAlign()))
	if al.GetRowGap() > 0 || al.GetColumnGap() > 0 {
		el.addStyle("gap", px(al.GetRowGap())+" "+px(al.GetColumnGap()))
	}
	if p := paddingCSS(al); p != "" {
		el.addStyle("padding", p)
	}
}

func cellAlignCSS(a opendesignerv1.LayoutAlign) string {
	switch a {
	case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_CENTER:
		return "center"
	case opendesignerv1.LayoutAlign_LAYOUT_ALIGN_END:
		return "end"
	}
	return "start"
}

// gridCellCSS writes the child's grid-column / grid-row from its cell (nothing when it is auto-placed
// and spans one cell).
func gridCellCSS(el *Element, n *opendesignerv1.Node) {
	cell := n.GetGridCell()
	line := func(start, span int32) string {
		if span < 1 {
			span = 1
		}
		switch {
		case start > 0 && span > 1:
			return strconv.Itoa(int(start)) + " / span " + strconv.Itoa(int(span))
		case start > 0:
			return strconv.Itoa(int(start))
		case span > 1:
			return "span " + strconv.Itoa(int(span))
		}
		return ""
	}
	if v := line(cell.GetColumn(), cell.GetColumnSpan()); v != "" {
		el.addStyle("grid-column", v)
	}
	if v := line(cell.GetRow(), cell.GetRowSpan()); v != "" {
		el.addStyle("grid-row", v)
	}
}
