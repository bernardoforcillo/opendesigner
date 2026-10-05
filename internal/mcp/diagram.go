package mcp

import (
	"context"
	"errors"
	"fmt"
	"math"

	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/bernardoforcillo/opendesigner/internal/diagram"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Diagrams: the agent describes a diagram in Mermaid -- flowchart, UML
// class, UML sequence, UML state -- and the server draws it as a group of
// ordinary shapes, vectors and text (internal/diagram, the same function the
// editor uses). The root carries the source text in `meta`, so a diagram can
// be read back (list_diagrams) and redrawn (update_diagram) without rebuilding
// anything by hand.

const diagramSyntax = " Supported Mermaid: " +
	"flowchart/graph (TD|LR|BT|RL; nodes A[rect] A(round) A([stadium]) A((circle)) A{decision}; edges --> --- -.-> ==> <--> with |label| or -- label -->; A & B --> C), " +
	"classDiagram (class X { +attr  +method() }, <<interface>>, relations <|-- *-- o-- --> ..> ..|> -- with \"1\" \"*\" multiplicities and : label; Animal <|-- Duck puts the parent on top), " +
	"sequenceDiagram (participant/actor X as Label, ->> -->> -> --> -x -), activations with + and -, Note over/left of/right of, autonumber, loop/alt/else/opt/par/and/critical/break ... end), " +
	"stateDiagram-v2 ([*] --> A, A --> B : event, state \"Long name\" as X, state X <<choice>>). Other Mermaid types are rejected."

type CreateDiagramInput struct {
	Source   string   `json:"source" jsonschema:"the diagram as Mermaid text"`
	ParentId string   `json:"parentId,omitempty" jsonschema:"parent node or page id; defaults to the first page"`
	X        *float64 `json:"x,omitempty" jsonschema:"top-left corner; by default the diagram is placed to the right of whatever is already in the parent"`
	Y        *float64 `json:"y,omitempty"`
	Name     string   `json:"name,omitempty" jsonschema:"layer name; defaults to Diagram"`
}

type DiagramOutput struct {
	NodeId    string  `json:"nodeId" jsonschema:"id of the diagram's root group"`
	Kind      string  `json:"kind" jsonschema:"flowchart, class, sequence or state"`
	Width     float64 `json:"width"`
	Height    float64 `json:"height"`
	NodeCount int     `json:"nodeCount" jsonschema:"how many nodes the diagram is made of, group included"`
	Seq       uint64  `json:"seq"`
}

// placeRight is where to put a new diagram without covering anything: to the
// right of what is already under parentID.
func (s *Session) placeRight(parentID string) float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	right := math.Inf(-1)
	for _, c := range core.ChildrenOf(s.doc, parentID) {
		right = math.Max(right, c.GetX()+c.GetWidth())
	}
	if math.IsInf(right, -1) {
		return 0
	}
	return right + 80
}

// insertDiagram creates res's nodes under parentID; if an op fails halfway it
// deletes what was already created, so a truncated diagram is not left behind.
func (s *Session) insertDiagram(ctx context.Context, res *diagram.Result, parentID, name string, x, y float64) (DiagramOutput, error) {
	root := res.Nodes[0]
	root.ParentId, root.OrderKey, root.X, root.Y = parentID, s.nextOrderKey(), x, y
	if name != "" {
		root.Name = name
	}
	var seq uint64
	for i, n := range res.Nodes {
		out, err := s.createNode(ctx, n)
		if err != nil {
			if i > 0 {
				// deleting the root also removes the children already created
				_, _ = s.DeleteNode(context.WithoutCancel(ctx), NodeIdInput{Id: root.Id})
			}
			return DiagramOutput{}, fmt.Errorf("diagram: creating %q: %w", n.GetName(), err)
		}
		seq = out.Seq
	}
	return DiagramOutput{NodeId: root.Id, Kind: res.Kind, Width: res.Width, Height: res.Height, NodeCount: len(res.Nodes), Seq: seq}, nil
}

func renderErr(tool string, err error) error {
	var de *diagram.Error
	if errors.As(err, &de) {
		return fmt.Errorf("%s: %s", tool, de.Msg)
	}
	return fmt.Errorf("%s: %w", tool, err)
}

// CreateDiagram draws a Mermaid diagram under parentId (or the first page).
func (s *Session) CreateDiagram(ctx context.Context, in CreateDiagramInput) (DiagramOutput, error) {
	res, err := diagram.Render(in.Source)
	if err != nil {
		return DiagramOutput{}, renderErr("create_diagram", err)
	}
	parent := s.resolveParent(in.ParentId)
	if parent == "" {
		return DiagramOutput{}, errNoParent
	}
	x, y := s.placeRight(parent), 0.0
	if in.X != nil {
		x = *in.X
	}
	if in.Y != nil {
		y = *in.Y
	}
	return s.insertDiagram(ctx, res, parent, in.Name, x, y)
}

type UpdateDiagramInput struct {
	Id     string `json:"id" jsonschema:"id of a diagram's root group (see list_diagrams)"`
	Source string `json:"source" jsonschema:"the new Mermaid text; the diagram is redrawn in place"`
}

// UpdateDiagram redraws an existing diagram: same parent, same position and
// same name; the new group gets the new id and the old one disappears.
func (s *Session) UpdateDiagram(ctx context.Context, in UpdateDiagramInput) (DiagramOutput, error) {
	s.mu.Lock()
	old := s.doc.GetNodes()[in.Id]
	var parent, name string
	var x, y float64
	if old != nil {
		parent, name, x, y = old.GetParentId(), old.GetName(), old.GetX(), old.GetY()
	}
	isDiagram := old != nil && old.GetMeta()[diagram.MetaSource] != ""
	s.mu.Unlock()
	if old == nil {
		return DiagramOutput{}, fmt.Errorf("update_diagram: no node %q", in.Id)
	}
	if !isDiagram {
		return DiagramOutput{}, fmt.Errorf("update_diagram: node %q is not a diagram (use list_diagrams to find them)", in.Id)
	}
	res, err := diagram.Render(in.Source)
	if err != nil {
		return DiagramOutput{}, renderErr("update_diagram", err)
	}
	out, err := s.insertDiagram(ctx, res, parent, name, x, y)
	if err != nil {
		return DiagramOutput{}, err
	}
	if _, err := s.DeleteNode(ctx, NodeIdInput{Id: in.Id}); err != nil {
		return DiagramOutput{}, fmt.Errorf("update_diagram: the new diagram %s was drawn but the old one could not be deleted: %w", out.NodeId, err)
	}
	return out, nil
}

type DiagramView struct {
	Id       string  `json:"id"`
	Name     string  `json:"name"`
	ParentId string  `json:"parentId"`
	Kind     string  `json:"kind"`
	Source   string  `json:"source" jsonschema:"the Mermaid text the diagram was drawn from"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	Width    float64 `json:"width"`
	Height   float64 `json:"height"`
}

type ListDiagramsOutput struct {
	Diagrams []DiagramView `json:"diagrams"`
}

// ListDiagrams lists the document's diagrams with their source text.
func (s *Session) ListDiagrams(_ context.Context, _ struct{}) (ListDiagramsOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := ListDiagramsOutput{Diagrams: []DiagramView{}}
	for _, p := range s.doc.GetPages() {
		for _, top := range core.ChildrenOf(s.doc, p.GetId()) {
			for _, n := range core.SubtreeOf(s.doc, top.GetId()) {
				if src := n.GetMeta()[diagram.MetaSource]; src != "" {
					out.Diagrams = append(out.Diagrams, DiagramView{
						Id: n.GetId(), Name: n.GetName(), ParentId: n.GetParentId(), Kind: n.GetMeta()[diagram.MetaKind], Source: src,
						X: n.GetX(), Y: n.GetY(), Width: n.GetWidth(), Height: n.GetHeight(),
					})
				}
			}
		}
	}
	return out, nil
}

func registerDiagramTools(srv *mcp.Server, s *Session) {
	addTool(srv, "create_diagram", "Draw a diagram from Mermaid text as an editable group of shapes, vectors and text (flowcharts and UML: class, sequence, state diagrams). The server does the layout. Returns the root group id; the Mermaid source is kept in the group's meta so the diagram can be read back (list_diagrams) and redrawn (update_diagram). Reports a precise error if the text cannot be read."+diagramSyntax, s.CreateDiagram)
	addTool(srv, "update_diagram", "Redraw an existing diagram from new Mermaid text, in the same place and with the same name. Returns the new root group id (the old group is deleted). Use it to edit a diagram instead of moving shapes by hand."+diagramSyntax, s.UpdateDiagram)
	addTool(srv, "list_diagrams", "List the diagrams in the document with their kind (flowchart, class, sequence, state), position and Mermaid source, so you can read or edit one.", s.ListDiagrams)
}
