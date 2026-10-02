package mcp

import (
	"context"
	"fmt"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
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
		"paddingRight": a.PaddingRight, "paddingBottom": a.PaddingBottom,
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
		HugWidth: a.HugWidth, HugHeight: a.HugHeight,
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
		HugWidth: a.GetHugWidth(), HugHeight: a.GetHugHeight(),
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
