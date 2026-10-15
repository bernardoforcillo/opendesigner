package mcp

import (
	"context"
	"errors"
	"fmt"
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

// The variables tools: the agent reads and writes the document's design tokens
// (collections of modes and color/number variables) and binds node properties to
// them. The model and its invariants live in internal/core/variables.go; the tools
// run the same validators BEFORE sending the op, so the error says what to fix.

type ColorIO struct {
	R float64 `json:"r" jsonschema:"red, 0..1"`
	G float64 `json:"g" jsonschema:"green, 0..1"`
	B float64 `json:"b" jsonschema:"blue, 0..1"`
	A float64 `json:"a" jsonschema:"alpha, 0..1"`
}

// ValueIO is the value of a variable in one mode: a color for a color variable,
// a number for a number variable (exactly one of the two).
type ValueIO struct {
	Color  *ColorIO `json:"color,omitempty"`
	Number *float64 `json:"number,omitempty"`
}

type ModeView struct {
	Id   string `json:"id"`
	Name string `json:"name"`
}

type VariableView struct {
	Id     string             `json:"id"`
	Name   string             `json:"name"`
	Type   string             `json:"type" jsonschema:"color | number"`
	Values map[string]ValueIO `json:"values" jsonschema:"mode id -> value; a mode with no entry resolves to the first mode's value"`
}

type CollectionView struct {
	Id        string         `json:"id"`
	Name      string         `json:"name"`
	Modes     []ModeView     `json:"modes" jsonschema:"the first mode is the default"`
	Variables []VariableView `json:"variables"`
}

type ListVariablesOutput struct {
	Collections []CollectionView `json:"collections"`
}

// variablesConventions is the manual every variables tool repeats in brief.
const variablesConventions = " Variables (design tokens): a COLLECTION has MODES (e.g. Light, Dark; the first is the default); a VARIABLE belongs to one collection, is a color or a number and has a value per mode. " +
	"A node BINDS a property to a variable and then takes its value from the variable for the node's active mode, instead of its own literal. " +
	"Bindable properties: fills.N and strokes.N (color; N is the paint's index, 0 = the first), opacity, rotation, corner_radius, strokes.N.weight (number). " +
	"The active mode of a collection is the one pinned by the nearest ancestor frame (set_node_mode) or, with none, the collection's first mode. " +
	"Deleting a variable unbinds it everywhere; deleting a collection deletes its variables."

func typeName(t opendesignerv1.VariableType) string {
	if t == opendesignerv1.VariableType_VARIABLE_TYPE_COLOR {
		return "color"
	}
	return "number"
}

func valueView(v *opendesignerv1.VariableValue) ValueIO {
	switch k := v.GetKind().(type) {
	case *opendesignerv1.VariableValue_Color:
		c := k.Color
		return ValueIO{Color: &ColorIO{R: float64(c.GetR()), G: float64(c.GetG()), B: float64(c.GetB()), A: float64(c.GetA())}}
	case *opendesignerv1.VariableValue_Number:
		n := k.Number
		return ValueIO{Number: &n}
	}
	return ValueIO{}
}

func collectionViews(doc *opendesignerv1.Document) []CollectionView {
	ids := make([]string, 0, len(doc.GetCollections()))
	for id := range doc.GetCollections() {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	out := make([]CollectionView, 0, len(ids))
	for _, id := range ids {
		c := doc.GetCollections()[id]
		cv := CollectionView{Id: id, Name: c.GetName(), Modes: []ModeView{}, Variables: []VariableView{}}
		for _, m := range c.GetModes() {
			cv.Modes = append(cv.Modes, ModeView{Id: m.GetId(), Name: m.GetName()})
		}
		vids := make([]string, 0)
		for vid, v := range doc.GetVariables() {
			if v.GetCollectionId() == id {
				vids = append(vids, vid)
			}
		}
		sort.Strings(vids)
		for _, vid := range vids {
			v := doc.GetVariables()[vid]
			vv := VariableView{Id: vid, Name: v.GetName(), Type: typeName(v.GetType()), Values: map[string]ValueIO{}}
			for mode, val := range v.GetValues() {
				vv.Values[mode] = valueView(val)
			}
			cv.Variables = append(cv.Variables, vv)
		}
		out = append(out, cv)
	}
	return out
}

func (s *Session) ListVariables(_ context.Context, _ struct{}) (ListVariablesOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return ListVariablesOutput{Collections: collectionViews(s.doc)}, nil
}

// ---------------------------------------------------------------------------
// create_collection / delete_collection
// ---------------------------------------------------------------------------

type CreateCollectionInput struct {
	Name  string   `json:"name" jsonschema:"collection name, e.g. Theme"`
	Modes []string `json:"modes,omitempty" jsonschema:"mode names in order, the first is the default (e.g. [\"Light\",\"Dark\"]); defaults to one mode named Default"`
}

type CreateCollectionOutput struct {
	CollectionId string            `json:"collectionId"`
	Modes        map[string]string `json:"modes" jsonschema:"mode name -> mode id"`
	Seq          uint64            `json:"seq"`
}

func (s *Session) CreateCollection(ctx context.Context, in CreateCollectionInput) (CreateCollectionOutput, error) {
	names := in.Modes
	if len(names) == 0 {
		names = []string{"Default"}
	}
	c := &opendesignerv1.VariableCollection{Id: uuid.NewString(), Name: in.Name}
	ids := map[string]string{}
	for _, n := range names {
		if _, dup := ids[n]; dup {
			return CreateCollectionOutput{}, fmt.Errorf("create_collection: duplicate mode name %q", n)
		}
		m := &opendesignerv1.VariableMode{Id: uuid.NewString(), Name: n}
		ids[n] = m.Id
		c.Modes = append(c.Modes, m)
	}
	if err := core.ValidateCollection(c); err != nil {
		return CreateCollectionOutput{}, fmt.Errorf("create_collection: %w", err)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetCollection{SetCollection: &opendesignerv1.SetCollection{Collection: c}}})
	if err != nil {
		return CreateCollectionOutput{}, err
	}
	return CreateCollectionOutput{CollectionId: c.Id, Modes: ids, Seq: seq}, nil
}

type IdInput struct {
	Id string `json:"id"`
}

func (s *Session) DeleteCollection(ctx context.Context, in IdInput) (SeqOutput, error) {
	s.mu.Lock()
	_, ok := s.doc.GetCollections()[in.Id]
	s.mu.Unlock()
	if !ok {
		return SeqOutput{}, fmt.Errorf("delete_collection: collection %q not found (list_variables for the ids)", in.Id)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteCollection{DeleteCollection: &opendesignerv1.DeleteCollection{Id: in.Id}}})
	return SeqOutput{Seq: seq}, err
}

// ---------------------------------------------------------------------------
// set_variable / delete_variable
// ---------------------------------------------------------------------------

type SetVariableInput struct {
	Id           string             `json:"id,omitempty" jsonschema:"id of an existing variable to REPLACE; omit to create a new one"`
	CollectionId string             `json:"collectionId" jsonschema:"the collection the variable belongs to (see list_variables)"`
	Name         string             `json:"name" jsonschema:"e.g. color/primary; '/' groups variables in the UI"`
	Type         string             `json:"type" jsonschema:"color | number (cannot change on an existing variable)"`
	Values       map[string]ValueIO `json:"values" jsonschema:"mode id OR mode name -> value. Give the first (default) mode at least"`
}

type SetVariableOutput struct {
	VariableId string `json:"variableId"`
	Seq        uint64 `json:"seq"`
}

// toProto resolves mode names to ids and builds the variable. Replacing a
// variable is ABSOLUTE: read it with list_variables, modify, send it all back.
func (in SetVariableInput) toProto(doc *opendesignerv1.Document, id string) (*opendesignerv1.Variable, error) {
	col, ok := doc.GetCollections()[in.CollectionId]
	if !ok {
		return nil, fmt.Errorf("collection %q not found (create_collection first; list_variables for the ids)", in.CollectionId)
	}
	v := &opendesignerv1.Variable{Id: id, CollectionId: in.CollectionId, Name: in.Name, Values: map[string]*opendesignerv1.VariableValue{}}
	switch in.Type {
	case "color":
		v.Type = opendesignerv1.VariableType_VARIABLE_TYPE_COLOR
	case "number":
		v.Type = opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER
	default:
		return nil, fmt.Errorf("type must be \"color\" or \"number\", got %q", in.Type)
	}
	for key, val := range in.Values {
		mode := modeIDFor(col, key)
		if mode == "" {
			return nil, fmt.Errorf("mode %q not found in collection %q", key, col.GetName())
		}
		switch {
		case val.Color != nil && val.Number == nil:
			v.Values[mode] = &opendesignerv1.VariableValue{Kind: &opendesignerv1.VariableValue_Color{Color: &opendesignerv1.Color{
				R: float32(val.Color.R), G: float32(val.Color.G), B: float32(val.Color.B), A: float32(val.Color.A)}}}
		case val.Number != nil && val.Color == nil:
			v.Values[mode] = &opendesignerv1.VariableValue{Kind: &opendesignerv1.VariableValue_Number{Number: *val.Number}}
		default:
			return nil, fmt.Errorf("value for mode %q must have exactly one of color or number", key)
		}
	}
	return v, nil
}

// modeIDFor finds a mode by id first, then by name; "" if there is none.
func modeIDFor(col *opendesignerv1.VariableCollection, key string) string {
	for _, m := range col.GetModes() {
		if m.GetId() == key {
			return m.GetId()
		}
	}
	for _, m := range col.GetModes() {
		if m.GetName() == key {
			return m.GetId()
		}
	}
	return ""
}

func (s *Session) SetVariable(ctx context.Context, in SetVariableInput) (SetVariableOutput, error) {
	s.mu.Lock()
	id := in.Id
	if id == "" {
		id = uuid.NewString()
	} else if _, ok := s.doc.GetVariables()[id]; !ok {
		s.mu.Unlock()
		return SetVariableOutput{}, fmt.Errorf("set_variable: variable %q not found (omit id to create one; list_variables for the ids)", id)
	}
	v, err := in.toProto(s.doc, id)
	if err == nil {
		err = core.ValidateVariable(s.doc, v)
	}
	s.mu.Unlock()
	if err != nil {
		return SetVariableOutput{}, fmt.Errorf("set_variable: %w", err)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetVariable{SetVariable: &opendesignerv1.SetVariable{Variable: v}}})
	if err != nil {
		return SetVariableOutput{}, err
	}
	return SetVariableOutput{VariableId: id, Seq: seq}, nil
}

func (s *Session) DeleteVariable(ctx context.Context, in IdInput) (SeqOutput, error) {
	s.mu.Lock()
	_, ok := s.doc.GetVariables()[in.Id]
	s.mu.Unlock()
	if !ok {
		return SeqOutput{}, fmt.Errorf("delete_variable: variable %q not found (list_variables for the ids)", in.Id)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteVariable{DeleteVariable: &opendesignerv1.DeleteVariable{Id: in.Id}}})
	return SeqOutput{Seq: seq}, err
}

// ---------------------------------------------------------------------------
// bind_variable / set_node_mode
// ---------------------------------------------------------------------------

type BindVariableInput struct {
	NodeIds    []string `json:"nodeIds" jsonschema:"the nodes to bind (see list_nodes)"`
	Property   string   `json:"property" jsonschema:"fills.N | strokes.N (color), opacity | rotation | corner_radius | strokes.N.weight (number)"`
	VariableId string   `json:"variableId,omitempty" jsonschema:"the variable to bind; empty detaches the property (its literal value applies again)"`
}

type NodesOutput struct {
	Changed int    `json:"changed" jsonschema:"how many nodes were modified"`
	Seq     uint64 `json:"seq"`
}

// editNodeMap rewrites one of a node's maps (bindings or modes) on every node of
// `ids`, validating each NEW map against the document first, and submits one
// setProps per node that changes.
func (s *Session) editNodeMap(ctx context.Context, tool string, ids []string, path string, set func(m map[string]string), validate func(*opendesignerv1.Document, map[string]string) error) (NodesOutput, error) {
	if len(ids) == 0 {
		return NodesOutput{}, fmt.Errorf("%s: nodeIds is empty", tool)
	}
	type edit struct {
		id   string
		next map[string]string
	}
	var edits []edit
	s.mu.Lock()
	for _, id := range ids {
		n, ok := s.doc.GetNodes()[id]
		if !ok {
			s.mu.Unlock()
			return NodesOutput{}, fmt.Errorf("%s: node %q not found (list_nodes for the ids)", tool, id)
		}
		cur := n.GetBindings()
		if path == "modes" {
			cur = n.GetModes()
		}
		next := map[string]string{}
		for k, v := range cur {
			next[k] = v
		}
		set(next)
		if mapsEqual(cur, next) {
			continue
		}
		if err := validate(s.doc, next); err != nil {
			s.mu.Unlock()
			return NodesOutput{}, fmt.Errorf("%s: node %q: %w", tool, id, err)
		}
		edits = append(edits, edit{id, next})
	}
	s.mu.Unlock()
	out := NodesOutput{}
	for _, e := range edits {
		patch := &opendesignerv1.Node{}
		if path == "modes" {
			patch.Modes = e.next
		} else {
			patch.Bindings = e.next
		}
		seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
			Id: e.id, Patch: patch, Mask: &fieldmaskpb.FieldMask{Paths: []string{path}},
		}}})
		if err != nil {
			return out, err
		}
		out.Changed++
		out.Seq = seq
	}
	return out, nil
}

func mapsEqual(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if w, ok := b[k]; !ok || w != v {
			return false
		}
	}
	return true
}

func (s *Session) BindVariable(ctx context.Context, in BindVariableInput) (NodesOutput, error) {
	if in.Property == "" {
		return NodesOutput{}, errors.New("bind_variable: property is required")
	}
	return s.editNodeMap(ctx, "bind_variable", in.NodeIds, "bindings", func(m map[string]string) {
		if in.VariableId == "" {
			delete(m, in.Property)
		} else {
			m[in.Property] = in.VariableId
		}
	}, core.ValidateBindings)
}

type SetNodeModeInput struct {
	NodeIds      []string `json:"nodeIds" jsonschema:"the nodes (typically frames) to pin; the mode applies to their whole subtree"`
	CollectionId string   `json:"collectionId"`
	ModeId       string   `json:"modeId,omitempty" jsonschema:"the mode to pin; empty unpins (the node follows its parent again)"`
}

func (s *Session) SetNodeMode(ctx context.Context, in SetNodeModeInput) (NodesOutput, error) {
	if in.CollectionId == "" {
		return NodesOutput{}, errors.New("set_node_mode: collectionId is required")
	}
	return s.editNodeMap(ctx, "set_node_mode", in.NodeIds, "modes", func(m map[string]string) {
		if in.ModeId == "" {
			delete(m, in.CollectionId)
		} else {
			m[in.CollectionId] = in.ModeId
		}
	}, core.ValidateModes)
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

func registerVariableTools(srv *mcp.Server, s *Session) {
	addTool(srv, "list_variables", "List the document's variable collections with their modes, variables and per-mode values."+variablesConventions, s.ListVariables)
	addTool(srv, "create_collection", "Create a variable collection with named modes (the first is the default). Returns the collection id and the id of each mode."+variablesConventions, s.CreateCollection)
	addTool(srv, "delete_collection", "Delete a collection, its variables and every binding to them.", s.DeleteCollection)
	addTool(srv, "set_variable", "Create a variable (omit id) or REPLACE one entirely (read it with list_variables, edit, send it all back). Values are keyed by mode id or mode name; a color value is {color:{r,g,b,a}} with channels 0..1, a number value is {number:n}."+variablesConventions, s.SetVariable)
	addTool(srv, "delete_variable", "Delete a variable; the properties bound to it keep their own literal value.", s.DeleteVariable)
	addTool(srv, "bind_variable", "Bind a property of one or more nodes to a variable, or detach it (empty variableId)."+variablesConventions, s.BindVariable)
	addTool(srv, "set_node_mode", "Pin a collection to one of its modes on one or more nodes, so their whole subtree resolves its variables in that mode; empty modeId unpins."+variablesConventions, s.SetNodeMode)
}
