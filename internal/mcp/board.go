package mcp

import (
	"context"
	"errors"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/bernardoforcillo/opendesigner/internal/board"
	"github.com/bernardoforcillo/opendesigner/internal/diagram"
)

type CreateBoardObjectInput struct {
	Kind     string   `json:"kind" jsonschema:"sticky | table | kanban | mindmap | brainstorm | retrospective | user-flow | customer-journey"`
	Items    []string `json:"items,omitempty" jsonschema:"sticky: [the text]; table: the header cells; kanban: the column titles; mindmap: [center, branch...]. Templates ignore it"`
	Rows     int      `json:"rows,omitempty" jsonschema:"table: default 4"`
	Columns  int      `json:"columns,omitempty" jsonschema:"table: default 3"`
	Color    string   `json:"color,omitempty" jsonschema:"sticky: yellow (default) | pink | green | blue | orange | purple"`
	ParentId string   `json:"parentId,omitempty" jsonschema:"default: the first page"`
	X        *float64 `json:"x,omitempty" jsonschema:"default: right of what is already there"`
	Y        *float64 `json:"y,omitempty"`
	Name     string   `json:"name,omitempty"`
}

type CreateBoardObjectOutput struct {
	NodeId    string  `json:"nodeId" jsonschema:"the root group; its children are plain rectangles, texts and vectors you can edit"`
	Kind      string  `json:"kind"`
	Width     float64 `json:"width"`
	Height    float64 `json:"height"`
	NodeCount int     `json:"nodeCount"`
	Seq       uint64  `json:"seq"`
}

// CreateBoardObject draws a whiteboard object under parentId (or the first page).
func (s *Session) CreateBoardObject(ctx context.Context, in CreateBoardObjectInput) (CreateBoardObjectOutput, error) {
	res, err := board.Render(in.Kind, board.Params{Items: in.Items, Rows: in.Rows, Columns: in.Columns, Color: in.Color})
	if err != nil {
		var be *board.Error
		if errors.As(err, &be) {
			return CreateBoardObjectOutput{}, fmt.Errorf("create_board_object: %s", be.Msg)
		}
		return CreateBoardObjectOutput{}, fmt.Errorf("create_board_object: %w", err)
	}
	parent := s.resolveParent(in.ParentId)
	if parent == "" {
		return CreateBoardObjectOutput{}, errNoParent
	}
	x, y := s.placeRight(parent), 0.0
	if in.X != nil {
		x = *in.X
	}
	if in.Y != nil {
		y = *in.Y
	}
	out, err := s.insertDiagram(ctx, &diagram.Result{Kind: in.Kind, Nodes: res.Nodes, Width: res.Width, Height: res.Height}, parent, in.Name, x, y)
	if err != nil {
		return CreateBoardObjectOutput{}, err
	}
	return CreateBoardObjectOutput{NodeId: out.NodeId, Kind: in.Kind, Width: res.Width, Height: res.Height, NodeCount: out.NodeCount, Seq: out.Seq}, nil
}

func registerBoardTools(srv *mcp.Server, s *Session) {
	addTool(srv, "create_board_object", "Draw a whiteboard object as a group of plain nodes: a sticky note, a table, a kanban board, a mind map, or a template (brainstorm, retrospective, user-flow, customer-journey). Edit the texts afterwards with set_text.", s.CreateBoardObject)
}
