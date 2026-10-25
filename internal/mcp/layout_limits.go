package mcp

import (
	"context"
	"fmt"
	"math"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// SetLayoutLimitsInput sets the size limits the auto layout engine enforces. Omitted
// fields are left alone; 0 clears a limit.
type SetLayoutLimitsInput struct {
	NodeIds   []string `json:"nodeIds"`
	MinWidth  *float64 `json:"minWidth,omitempty" jsonschema:"smallest width, >= 0; 0 = no limit"`
	MaxWidth  *float64 `json:"maxWidth,omitempty" jsonschema:"largest width, >= 0; 0 = no limit"`
	MinHeight *float64 `json:"minHeight,omitempty" jsonschema:"smallest height, >= 0; 0 = no limit"`
	MaxHeight *float64 `json:"maxHeight,omitempty" jsonschema:"largest height, >= 0; 0 = no limit"`
}

// SetLayoutLimits writes min/max width and height on nodes. The layout engine clamps the
// node's size to them when it sits in an auto layout frame (fill children share the space
// around the ones that hit a limit), or when it is an auto layout frame that hugs.
func (s *Session) SetLayoutLimits(ctx context.Context, in SetLayoutLimitsInput) (NodesOutput, error) {
	patch := &opendesignerv1.Node{}
	var paths []string
	add := func(name, path string, v *float64, dst *float64) error {
		if v == nil {
			return nil
		}
		if math.IsNaN(*v) || math.IsInf(*v, 0) || *v < 0 {
			return fmt.Errorf("set_layout_limits: %s must be a number >= 0, got %v", name, *v)
		}
		*dst = *v
		paths = append(paths, path)
		return nil
	}
	for _, f := range []error{
		add("minWidth", "min_width", in.MinWidth, &patch.MinWidth),
		add("maxWidth", "max_width", in.MaxWidth, &patch.MaxWidth),
		add("minHeight", "min_height", in.MinHeight, &patch.MinHeight),
		add("maxHeight", "max_height", in.MaxHeight, &patch.MaxHeight),
	} {
		if f != nil {
			return NodesOutput{}, f
		}
	}
	if len(paths) == 0 {
		return NodesOutput{}, fmt.Errorf("set_layout_limits: give minWidth, maxWidth, minHeight and/or maxHeight")
	}
	return s.setOnNodes(ctx, "set_layout_limits", in.NodeIds, patch, paths)
}

// SetLayoutPositioningInput takes nodes out of (or back into) the flow of their auto layout parent.
type SetLayoutPositioningInput struct {
	NodeIds     []string `json:"nodeIds"`
	Positioning string   `json:"positioning" jsonschema:"auto (in the flow, default) | absolute (out of the flow, kept at its x/y and following the frame by its constraints)"`
}

func (s *Session) SetLayoutPositioning(ctx context.Context, in SetLayoutPositioningInput) (NodesOutput, error) {
	patch := &opendesignerv1.Node{}
	switch in.Positioning {
	case "auto":
		patch.LayoutPositioning = opendesignerv1.LayoutPositioning_LAYOUT_POSITIONING_AUTO
	case "absolute":
		patch.LayoutPositioning = opendesignerv1.LayoutPositioning_LAYOUT_POSITIONING_ABSOLUTE
	default:
		return NodesOutput{}, fmt.Errorf("set_layout_positioning: positioning must be auto or absolute, got %q", in.Positioning)
	}
	return s.setOnNodes(ctx, "set_layout_positioning", in.NodeIds, patch, []string{"layout_positioning"})
}

// SetGridCellInput puts nodes in cells of their GRID auto layout parent.
type SetGridCellInput struct {
	NodeIds    []string `json:"nodeIds"`
	Column     int32    `json:"column,omitempty" jsonschema:"1-based start column; 0 = auto-placed"`
	ColumnSpan int32    `json:"columnSpan,omitempty" jsonschema:"columns taken, 0 = 1"`
	Row        int32    `json:"row,omitempty" jsonschema:"1-based start row; 0 = auto-placed"`
	RowSpan    int32    `json:"rowSpan,omitempty" jsonschema:"rows taken, 0 = 1"`
}

// SetGridCell replaces the whole cell of the nodes (all zeros = auto-placed, one cell).
func (s *Session) SetGridCell(ctx context.Context, in SetGridCellInput) (NodesOutput, error) {
	for _, v := range []int32{in.Column, in.ColumnSpan, in.Row, in.RowSpan} {
		if v < 0 || v > 1000 {
			return NodesOutput{}, fmt.Errorf("set_grid_cell: column, row and the spans must be 0..1000")
		}
	}
	patch := &opendesignerv1.Node{GridCell: &opendesignerv1.GridPlacement{Column: in.Column, ColumnSpan: in.ColumnSpan, Row: in.Row, RowSpan: in.RowSpan}}
	return s.setOnNodes(ctx, "set_grid_cell", in.NodeIds, patch, []string{"grid_cell"})
}

func registerLayoutLimitTools(srv *mcp.Server, s *Session) {
	addTool(srv, "set_layout_limits", "Set min/max width and height (0 clears a limit). The auto layout engine clamps the node's size to them when it sits in an auto layout frame -- fill children share the space around the ones that hit a limit -- and a hugging auto layout frame stays within its own limits. When min > max the min wins.", s.SetLayoutLimits)
	addTool(srv, "set_layout_positioning", "Take nodes out of the flow of their auto layout parent (absolute) or put them back (auto). An absolute child takes no room in the layout, is not hugged or aligned, keeps its x/y and follows the frame's size by its constraints (set_constraints).", s.SetLayoutPositioning)
	addTool(srv, "set_grid_cell", "Put nodes in cells of their GRID auto layout parent (create_frame / set_auto_layout with mode grid): 1-based column and row, and how many columns / rows they span. 0 leaves an axis auto-placed (children flow row by row into the first free cells); all zeros resets. Fill (set_layout_sizing) makes the node take its whole cell.", s.SetGridCell)
}
