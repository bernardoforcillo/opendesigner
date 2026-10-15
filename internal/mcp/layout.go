package mcp

import (
	"context"
	"fmt"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

// AutoLayoutSpec is a frame's auto layout. The server lays the frame's children
// out in a row or column after every change and stores the result as ordinary
// x/y, so an agent reads positions that are already correct and never computes
// layout itself.
type AutoLayoutSpec struct {
	Direction     string  `json:"direction" jsonschema:"horizontal or vertical"`
	Spacing       float64 `json:"spacing,omitempty" jsonschema:"gap between consecutive children, >= 0"`
	PaddingLeft   float64 `json:"paddingLeft,omitempty"`
	PaddingTop    float64 `json:"paddingTop,omitempty"`
	PaddingRight  float64 `json:"paddingRight,omitempty"`
	PaddingBottom float64 `json:"paddingBottom,omitempty"`
	MainAlign     string  `json:"mainAlign,omitempty" jsonschema:"along the direction: start (default), center, end or space-between"`
	CrossAlign    string  `json:"crossAlign,omitempty" jsonschema:"across the direction: start (default), center or end"`
	HugWidth      bool    `json:"hugWidth,omitempty" jsonschema:"the frame's width fits its content"`
	HugHeight     bool    `json:"hugHeight,omitempty" jsonschema:"the frame's height fits its content"`
	Wrap          bool    `json:"wrap,omitempty" jsonschema:"children that do not fit the main axis continue on a new line (ignored when the main axis hugs)"`
	CrossSpacing  float64 `json:"crossSpacing,omitempty" jsonschema:"gap between lines when wrapping, >= 0"`
}

var (
	directions = map[string]opendesignerv1.LayoutDirection{
		"horizontal": opendesignerv1.LayoutDirection_LAYOUT_DIRECTION_HORIZONTAL,
		"vertical":   opendesignerv1.LayoutDirection_LAYOUT_DIRECTION_VERTICAL,
	}
	aligns = map[string]opendesignerv1.LayoutAlign{
		"":              opendesignerv1.LayoutAlign_LAYOUT_ALIGN_START,
		"start":         opendesignerv1.LayoutAlign_LAYOUT_ALIGN_START,
		"center":        opendesignerv1.LayoutAlign_LAYOUT_ALIGN_CENTER,
		"end":           opendesignerv1.LayoutAlign_LAYOUT_ALIGN_END,
		"space-between": opendesignerv1.LayoutAlign_LAYOUT_ALIGN_SPACE_BETWEEN,
	}
	directionNames = map[opendesignerv1.LayoutDirection]string{
		opendesignerv1.LayoutDirection_LAYOUT_DIRECTION_UNSPECIFIED: "horizontal",
		opendesignerv1.LayoutDirection_LAYOUT_DIRECTION_HORIZONTAL:  "horizontal",
		opendesignerv1.LayoutDirection_LAYOUT_DIRECTION_VERTICAL:    "vertical",
	}
	alignNames = map[opendesignerv1.LayoutAlign]string{
		opendesignerv1.LayoutAlign_LAYOUT_ALIGN_UNSPECIFIED:   "start",
		opendesignerv1.LayoutAlign_LAYOUT_ALIGN_START:         "start",
		opendesignerv1.LayoutAlign_LAYOUT_ALIGN_CENTER:        "center",
		opendesignerv1.LayoutAlign_LAYOUT_ALIGN_END:           "end",
		opendesignerv1.LayoutAlign_LAYOUT_ALIGN_SPACE_BETWEEN: "space-between",
	}
)

func (a *AutoLayoutSpec) validate() error {
	if _, ok := directions[a.Direction]; !ok {
		return fmt.Errorf("autoLayout.direction must be \"horizontal\" or \"vertical\", got %q", a.Direction)
	}
	if _, ok := aligns[a.MainAlign]; !ok {
		return fmt.Errorf("autoLayout.mainAlign must be start, center, end or space-between, got %q", a.MainAlign)
	}
	if v, ok := aligns[a.CrossAlign]; !ok || v == opendesignerv1.LayoutAlign_LAYOUT_ALIGN_SPACE_BETWEEN {
		return fmt.Errorf("autoLayout.crossAlign must be start, center or end, got %q", a.CrossAlign)
	}
	for name, v := range map[string]float64{
		"spacing": a.Spacing, "paddingLeft": a.PaddingLeft, "paddingTop": a.PaddingTop,
		"paddingRight": a.PaddingRight, "paddingBottom": a.PaddingBottom, "crossSpacing": a.CrossSpacing,
	} {
		if v < 0 {
			return fmt.Errorf("autoLayout.%s must be >= 0", name)
		}
	}
	return nil
}

func (a *AutoLayoutSpec) toProto() *opendesignerv1.AutoLayout {
	return &opendesignerv1.AutoLayout{
		Direction: directions[a.Direction], Spacing: a.Spacing,
		PaddingLeft: a.PaddingLeft, PaddingTop: a.PaddingTop, PaddingRight: a.PaddingRight, PaddingBottom: a.PaddingBottom,
		MainAlign: aligns[a.MainAlign], CrossAlign: aligns[a.CrossAlign],
		HugWidth: a.HugWidth, HugHeight: a.HugHeight, Wrap: a.Wrap, CrossSpacing: a.CrossSpacing,
	}
}

func autoLayoutView(a *opendesignerv1.AutoLayout) *AutoLayoutSpec {
	if a == nil {
		return nil
	}
	return &AutoLayoutSpec{
		Direction: directionNames[a.GetDirection()], Spacing: a.GetSpacing(),
		PaddingLeft: a.GetPaddingLeft(), PaddingTop: a.GetPaddingTop(), PaddingRight: a.GetPaddingRight(), PaddingBottom: a.GetPaddingBottom(),
		MainAlign: alignNames[a.GetMainAlign()], CrossAlign: alignNames[a.GetCrossAlign()],
		HugWidth: a.GetHugWidth(), HugHeight: a.GetHugHeight(), Wrap: a.GetWrap(), CrossSpacing: a.GetCrossSpacing(),
	}
}

// CreateFrameInput creates a frame: a container with a box of its own, optionally
// clipping its children and optionally laying them out.
type CreateFrameInput struct {
	ParentId     string          `json:"parentId,omitempty" jsonschema:"parent node or page id; defaults to the first page"`
	X            float64         `json:"x"`
	Y            float64         `json:"y"`
	Width        float64         `json:"width"`
	Height       float64         `json:"height"`
	Name         string          `json:"name,omitempty"`
	ClipsContent bool            `json:"clipsContent,omitempty" jsonschema:"clip the children to the frame's box"`
	AutoLayout   *AutoLayoutSpec `json:"autoLayout,omitempty" jsonschema:"lay the children out in a row or column"`
}

// CreateFrame creates a frame under parentId (or the first page).
func (s *Session) CreateFrame(ctx context.Context, in CreateFrameInput) (CreateNodeOutput, error) {
	parent := s.resolveParent(in.ParentId)
	if parent == "" {
		return CreateNodeOutput{}, errNoParent
	}
	frame := &opendesignerv1.FrameNode{ClipsContent: in.ClipsContent}
	if in.AutoLayout != nil {
		if err := in.AutoLayout.validate(); err != nil {
			return CreateNodeOutput{}, err
		}
		frame.AutoLayout = in.AutoLayout.toProto()
	}
	n := s.newBaseNode(parent, in.Name, in.X, in.Y, in.Width, in.Height)
	n.Shape = &opendesignerv1.Node_Frame{Frame: frame}
	return s.createNode(ctx, n)
}

// SetAutoLayoutInput turns a frame's auto layout on, changes it, or (autoLayout
// omitted) turns it off. Turning it off leaves the children where the layout
// last put them.
type SetAutoLayoutInput struct {
	Id         string          `json:"id" jsonschema:"the frame's node id"`
	AutoLayout *AutoLayoutSpec `json:"autoLayout,omitempty" jsonschema:"omit to turn auto layout off"`
}

// SetAutoLayout writes a frame's auto layout. Only a frame accepts it; on any
// other node the server rejects the op.
func (s *Session) SetAutoLayout(ctx context.Context, in SetAutoLayoutInput) (SeqOutput, error) {
	frame := &opendesignerv1.FrameNode{}
	if in.AutoLayout != nil {
		if err := in.AutoLayout.validate(); err != nil {
			return SeqOutput{}, err
		}
		frame.AutoLayout = in.AutoLayout.toProto()
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id:    in.Id,
		Patch: &opendesignerv1.Node{Shape: &opendesignerv1.Node_Frame{Frame: frame}},
		Mask:  &fieldmaskpb.FieldMask{Paths: []string{"auto_layout"}},
	}}})
	if err != nil {
		return SeqOutput{}, err
	}
	return SeqOutput{Seq: seq}, nil
}

// ---------------------------------------------------------------------------
// constraints and layout sizing
// ---------------------------------------------------------------------------

var constraintValues = map[string]opendesignerv1.Constraint{
	"min": opendesignerv1.Constraint_CONSTRAINT_MIN, "max": opendesignerv1.Constraint_CONSTRAINT_MAX,
	"stretch": opendesignerv1.Constraint_CONSTRAINT_STRETCH, "center": opendesignerv1.Constraint_CONSTRAINT_CENTER,
	"scale": opendesignerv1.Constraint_CONSTRAINT_SCALE,
}

var constraintNames = map[opendesignerv1.Constraint]string{
	opendesignerv1.Constraint_CONSTRAINT_MIN: "min", opendesignerv1.Constraint_CONSTRAINT_MAX: "max",
	opendesignerv1.Constraint_CONSTRAINT_STRETCH: "stretch", opendesignerv1.Constraint_CONSTRAINT_CENTER: "center",
	opendesignerv1.Constraint_CONSTRAINT_SCALE: "scale",
}

// SetConstraintsInput sets how nodes follow their parent FRAME when it is resized (a frame
// without auto layout; the frame with auto layout decides for its children). Omitted axes
// are left alone.
type SetConstraintsInput struct {
	NodeIds    []string `json:"nodeIds"`
	Horizontal string   `json:"horizontal,omitempty" jsonschema:"min (left, the default) | max (right) | stretch (both margins) | center | scale"`
	Vertical   string   `json:"vertical,omitempty" jsonschema:"min (top, the default) | max (bottom) | stretch (both margins) | center | scale"`
}

func (s *Session) SetConstraints(ctx context.Context, in SetConstraintsInput) (NodesOutput, error) {
	if in.Horizontal == "" && in.Vertical == "" {
		return NodesOutput{}, fmt.Errorf("set_constraints: give horizontal and/or vertical")
	}
	patch := &opendesignerv1.Node{}
	var paths []string
	for axis, v := range map[string]string{"horizontal": in.Horizontal, "vertical": in.Vertical} {
		if v == "" {
			continue
		}
		c, ok := constraintValues[v]
		if !ok {
			return NodesOutput{}, fmt.Errorf("set_constraints: %s must be min, max, stretch, center or scale, got %q", axis, v)
		}
		if axis == "horizontal" {
			patch.ConstraintX = c
			paths = append(paths, "constraint_x")
		} else {
			patch.ConstraintY = c
			paths = append(paths, "constraint_y")
		}
	}
	return s.setOnNodes(ctx, "set_constraints", in.NodeIds, patch, paths)
}

// SetLayoutSizingInput sets how an auto layout PARENT sizes nodes, per axis of the node.
type SetLayoutSizingInput struct {
	NodeIds []string `json:"nodeIds"`
	Width   string   `json:"width,omitempty" jsonschema:"fixed (keep the width) | fill (take the free space of the axis)"`
	Height  string   `json:"height,omitempty" jsonschema:"fixed | fill"`
}

func (s *Session) SetLayoutSizing(ctx context.Context, in SetLayoutSizingInput) (NodesOutput, error) {
	if in.Width == "" && in.Height == "" {
		return NodesOutput{}, fmt.Errorf("set_layout_sizing: give width and/or height")
	}
	patch := &opendesignerv1.Node{}
	var paths []string
	for axis, v := range map[string]string{"width": in.Width, "height": in.Height} {
		if v == "" {
			continue
		}
		var sz opendesignerv1.LayoutSizing
		switch v {
		case "fixed":
			sz = opendesignerv1.LayoutSizing_LAYOUT_SIZING_FIXED
		case "fill":
			sz = opendesignerv1.LayoutSizing_LAYOUT_SIZING_FILL
		default:
			return NodesOutput{}, fmt.Errorf("set_layout_sizing: %s must be fixed or fill, got %q", axis, v)
		}
		if axis == "width" {
			patch.LayoutSizingX = sz
			paths = append(paths, "layout_sizing_x")
		} else {
			patch.LayoutSizingY = sz
			paths = append(paths, "layout_sizing_y")
		}
	}
	return s.setOnNodes(ctx, "set_layout_sizing", in.NodeIds, patch, paths)
}

// setOnNodes submits the same setProps (patch + mask) for every node, after checking they exist.
func (s *Session) setOnNodes(ctx context.Context, tool string, ids []string, patch *opendesignerv1.Node, paths []string) (NodesOutput, error) {
	if len(ids) == 0 {
		return NodesOutput{}, fmt.Errorf("%s: nodeIds is empty", tool)
	}
	s.mu.Lock()
	for _, id := range ids {
		if _, ok := s.doc.GetNodes()[id]; !ok {
			s.mu.Unlock()
			return NodesOutput{}, fmt.Errorf("%s: node %q not found (list_nodes for the ids)", tool, id)
		}
	}
	s.mu.Unlock()
	out := NodesOutput{}
	for _, id := range ids {
		seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
			Id: id, Patch: patch, Mask: &fieldmaskpb.FieldMask{Paths: paths},
		}}})
		if err != nil {
			return out, err
		}
		out.Changed++
		out.Seq = seq
	}
	return out, nil
}

func registerConstraintTools(srv *mcp.Server, s *Session) {
	addTool(srv, "set_constraints", "Set how nodes follow their parent frame when it is resized: per axis min (left/top, default), max (right/bottom), stretch (keep both margins, the node resizes), center or scale. They apply when the frame has NO auto layout; resizing the frame (set_properties width/height) then moves and resizes its children for you, recursively.", s.SetConstraints)
	addTool(srv, "set_layout_sizing", "Set how an auto layout PARENT sizes nodes: width/height fixed (default) or fill (take the free space of that axis: on the layout's main axis the free space is shared equally among the children that fill, across it the node spans the frame's inner extent). Ignored on an axis the frame hugs and in a wrapping frame.", s.SetLayoutSizing)
}
