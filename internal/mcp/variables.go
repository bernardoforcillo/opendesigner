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
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

// The variable (design token) tools. A variable maps MODE ids to colours; a
// node's fill or stroke can be BOUND to one, and then follows it. The model and
// the rules live in internal/core/variables.go; these tools validate with the
// same functions before sending, so the agent reads what to fix.

const variableConventions = " Variables are design tokens of three types: color, number and string. Each has a name (slash path, e.g. color/brand/primary; the code export turns it into a CSS custom property --color-brand-primary) and a value per MODE (e.g. light, dark). " +
	"The FIRST mode is the default; a mode with no value uses the default mode's. A variable can instead be an ALIAS (aliasOf = another variable of the same type, no values of its own). " +
	"bind_variable makes a fill, stroke, gradient stop (color variables) or opacity / corner_radius / font_size (number variables) / text (string variables) follow a variable; edit the variable once and every bound node follows. export_code writes the tokens as CSS custom properties."

type ModeIO struct {
	Id   string `json:"id" jsonschema:"stable id of the mode, e.g. light"`
	Name string `json:"name,omitempty" jsonschema:"display name; defaults to the id"`
}

type VariableView struct {
	Id      string             `json:"id"`
	Name    string             `json:"name"`
	Type    string             `json:"type" jsonschema:"color | number | string"`
	Values  map[string]RGBA    `json:"values,omitempty" jsonschema:"colour per mode id (color variables)"`
	Numbers map[string]float64 `json:"numbers,omitempty" jsonschema:"number per mode id (number variables)"`
	Strings map[string]string  `json:"strings,omitempty" jsonschema:"text per mode id (string variables)"`
	AliasOf string             `json:"aliasOf,omitempty" jsonschema:"id of the variable this one points at; it has no values of its own"`
	UsedBy  int                `json:"usedBy" jsonschema:"number of paints, gradient stops and properties bound to it"`
}

var typeNames = map[opendesignerv1.VariableType]string{
	opendesignerv1.VariableType_VARIABLE_TYPE_COLOR:  "color",
	opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER: "number",
	opendesignerv1.VariableType_VARIABLE_TYPE_STRING: "string",
}

func typeByName(name string) (opendesignerv1.VariableType, bool) {
	if name == "" {
		return opendesignerv1.VariableType_VARIABLE_TYPE_COLOR, true
	}
	for t, n := range typeNames {
		if n == name {
			return t, true
		}
	}
	return 0, false
}

type ListVariablesOutput struct {
	Modes     []ModeIO       `json:"modes" jsonschema:"in order; the first is the default"`
	Variables []VariableView `json:"variables"`
}

func rgbaOf(c *opendesignerv1.Color) RGBA {
	return RGBA{R: float64(c.GetR()), G: float64(c.GetG()), B: float64(c.GetB()), A: float64(c.GetA())}
}

// ListVariables lists the modes and the variables, with how many paints use each.
func (s *Session) ListVariables(ctx context.Context, _ struct{}) (ListVariablesOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return variablesView(s.doc), nil
}

func variablesView(doc *opendesignerv1.Document) ListVariablesOutput {
	out := ListVariablesOutput{Modes: []ModeIO{}, Variables: []VariableView{}}
	for _, m := range doc.GetModes() {
		out.Modes = append(out.Modes, ModeIO{Id: m.GetId(), Name: m.GetName()})
	}
	uses := map[string]int{}
	countPaint := func(p *opendesignerv1.Paint) {
		if r := p.GetVariable(); r != nil {
			uses[r.GetVariableId()]++
		}
		for _, g := range []*opendesignerv1.GradientPaint{p.GetLinear(), p.GetRadial()} {
			for _, st := range g.GetStops() {
				if st.GetVariableId() != "" {
					uses[st.GetVariableId()]++
				}
			}
		}
	}
	for _, n := range doc.GetNodes() {
		for _, p := range n.GetFills() {
			countPaint(p)
		}
		for _, st := range n.GetStrokes() {
			countPaint(st.GetPaint())
		}
		for _, id := range n.GetBindings() {
			uses[id]++
		}
	}
	ids := make([]string, 0, len(doc.GetVariables()))
	for id := range doc.GetVariables() {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		v := doc.GetVariables()[id]
		view := VariableView{Id: id, Name: v.GetName(), Type: typeNames[v.GetType()], AliasOf: v.GetAliasOf(), UsedBy: uses[id]}
		if len(v.GetValues()) > 0 {
			view.Values = map[string]RGBA{}
			for mode, c := range v.GetValues() {
				view.Values[mode] = rgbaOf(c)
			}
		}
		if len(v.GetNumbers()) > 0 {
			view.Numbers = v.GetNumbers()
		}
		if len(v.GetStrings()) > 0 {
			view.Strings = v.GetStrings()
		}
		out.Variables = append(out.Variables, view)
	}
	return out
}

type SetVariableInput struct {
	Id      string             `json:"id,omitempty" jsonschema:"omit to CREATE a variable; give an existing id to REPLACE it entirely (read it with list_variables, edit, send it all back)"`
	Name    string             `json:"name" jsonschema:"slash-separated path, e.g. color/brand/primary"`
	Type    string             `json:"type,omitempty" jsonschema:"color (default) | number | string. Only the matching values field may be given"`
	Values  map[string]RGBA    `json:"values,omitempty" jsonschema:"color variables: colour per mode id. Once modes exist, every key must be a known mode"`
	Numbers map[string]float64 `json:"numbers,omitempty" jsonschema:"number variables: number per mode id (unitless; opacity is 0..1, radius and font size are px)"`
	Strings map[string]string  `json:"strings,omitempty" jsonschema:"string variables: text per mode id"`
	AliasOf string             `json:"aliasOf,omitempty" jsonschema:"make this variable an alias of another variable of the SAME type (then no values may be given)"`
}

type SetVariableOutput struct {
	VariableId string `json:"variableId"`
	Seq        uint64 `json:"seq"`
}

// SetVariable creates a variable, or replaces an existing one (absolute upsert).
func (s *Session) SetVariable(ctx context.Context, in SetVariableInput) (SetVariableOutput, error) {
	id := in.Id
	s.mu.Lock()
	_, exists := s.doc.GetVariables()[id]
	s.mu.Unlock()
	switch {
	case id == "":
		id = uuid.NewString()
	case !exists:
		return SetVariableOutput{}, fmt.Errorf("set_variable: variable %q not found (omit id to create a new one; list_variables for the ids)", id)
	}
	typ, ok := typeByName(in.Type)
	if !ok {
		return SetVariableOutput{}, fmt.Errorf("set_variable: type must be color, number or string, got %q", in.Type)
	}
	v := &opendesignerv1.Variable{Id: id, Name: in.Name, Type: typ, AliasOf: in.AliasOf}
	if len(in.Values) > 0 {
		v.Values = map[string]*opendesignerv1.Color{}
		for mode, c := range in.Values {
			v.Values[mode] = &opendesignerv1.Color{R: float32(c.R), G: float32(c.G), B: float32(c.B), A: float32(c.A)}
		}
	}
	if len(in.Numbers) > 0 {
		v.Numbers = in.Numbers
	}
	if len(in.Strings) > 0 {
		v.Strings = in.Strings
	}
	s.mu.Lock()
	err := core.ValidateVariable(s.doc, v)
	s.mu.Unlock()
	if err != nil {
		return SetVariableOutput{}, fmt.Errorf("set_variable: %w (define the modes first with set_modes; every value key must be a mode id; give values of the variable's type only; an alias takes no values and needs an existing variable of the same type; name is required)", err)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetVariable{SetVariable: &opendesignerv1.SetVariable{Variable: v}}})
	if err != nil {
		return SetVariableOutput{}, err
	}
	return SetVariableOutput{VariableId: id, Seq: seq}, nil
}

type VariableIdInput struct {
	Id string `json:"id" jsonschema:"id of the variable (see list_variables)"`
}

// DeleteVariable removes a variable. Paints still bound to it draw black until
// rebound; the binding itself is kept, so re-creating the id restores them.
func (s *Session) DeleteVariable(ctx context.Context, in VariableIdInput) (SeqOutput, error) {
	s.mu.Lock()
	_, ok := s.doc.GetVariables()[in.Id]
	s.mu.Unlock()
	if !ok {
		return SeqOutput{}, fmt.Errorf("delete_variable: variable %q not found", in.Id)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteVariable{DeleteVariable: &opendesignerv1.DeleteVariable{Id: in.Id}}})
	if err != nil {
		return SeqOutput{}, err
	}
	return SeqOutput{Seq: seq}, nil
}

type SetModesInput struct {
	Modes []ModeIO `json:"modes" jsonschema:"the COMPLETE ordered list of modes; the first is the default. Values of a removed mode are dropped from every variable"`
}

func (s *Session) SetModes(ctx context.Context, in SetModesInput) (SeqOutput, error) {
	modes := make([]*opendesignerv1.Mode, 0, len(in.Modes))
	for _, m := range in.Modes {
		name := m.Name
		if name == "" {
			name = m.Id
		}
		modes = append(modes, &opendesignerv1.Mode{Id: m.Id, Name: name})
	}
	if err := core.ValidateModes(modes); err != nil {
		return SeqOutput{}, fmt.Errorf("set_modes: %w (ids must be non-empty and unique)", err)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetModes{SetModes: &opendesignerv1.SetModes{Modes: modes}}})
	if err != nil {
		return SeqOutput{}, err
	}
	return SeqOutput{Seq: seq}, nil
}

type BindVariableInput struct {
	NodeId     string `json:"nodeId" jsonschema:"the node to bind"`
	VariableId string `json:"variableId,omitempty" jsonschema:"the variable to follow (see list_variables). Empty = UNBIND a property binding (a fill or stroke is unbound by setting a plain colour with set_properties)"`
	Target     string `json:"target,omitempty" jsonschema:"fill (default) | stroke: colour variables. opacity | corner_radius | font_size: number variables. text: string variable"`
	Index      int    `json:"index,omitempty" jsonschema:"which fill or stroke (default 0, the first)"`
	Stop       *int   `json:"stop,omitempty" jsonschema:"fill/stroke only: bind this gradient STOP (0-based) of the fill instead of the whole paint"`
}

// BindVariable makes a node's fill/stroke/gradient stop, or one of its numeric or
// text properties, follow a variable. Everything else on the node is kept.
func (s *Session) BindVariable(ctx context.Context, in BindVariableInput) (SeqOutput, error) {
	target := in.Target
	if target == "" {
		target = "fill"
	}
	s.mu.Lock()
	n := s.doc.GetNodes()[in.NodeId]
	v := s.doc.GetVariables()[in.VariableId]
	s.mu.Unlock()
	if n == nil {
		return SeqOutput{}, fmt.Errorf("bind_variable: node %q not found", in.NodeId)
	}
	if want, isProp := core.BindableProps[target]; isProp {
		bindings := map[string]string{}
		for k, val := range n.GetBindings() {
			bindings[k] = val
		}
		if in.VariableId == "" {
			delete(bindings, target)
		} else {
			if v == nil {
				return SeqOutput{}, fmt.Errorf("bind_variable: variable %q not found (list_variables; set_variable to create one)", in.VariableId)
			}
			if v.GetType() != want {
				return SeqOutput{}, fmt.Errorf("bind_variable: %s needs a %s variable, %q is %s", target, typeNames[want], in.VariableId, typeNames[v.GetType()])
			}
			bindings[target] = in.VariableId
		}
		return s.submitProps(ctx, in.NodeId, &opendesignerv1.Node{Bindings: bindings}, "bindings")
	}
	if target != "fill" && target != "stroke" {
		return SeqOutput{}, fmt.Errorf("bind_variable: target must be fill, stroke, opacity, corner_radius, font_size or text, got %q", in.Target)
	}
	if in.VariableId == "" {
		return SeqOutput{}, errors.New("bind_variable: variableId is required for a fill or stroke (to unbind, set a plain colour with set_properties)")
	}
	if v == nil {
		return SeqOutput{}, fmt.Errorf("bind_variable: variable %q not found (list_variables; set_variable to create one)", in.VariableId)
	}
	if v.GetType() != opendesignerv1.VariableType_VARIABLE_TYPE_COLOR {
		return SeqOutput{}, fmt.Errorf("bind_variable: a %s needs a color variable, %q is %s", target, in.VariableId, typeNames[v.GetType()])
	}
	ref := &opendesignerv1.Paint{Kind: &opendesignerv1.Paint_Variable{Variable: &opendesignerv1.VariableRef{VariableId: in.VariableId}}}
	// paintAt rewrites the paint at `in.Index`: the whole paint, or just one gradient stop.
	paintAt := func(cur *opendesignerv1.Paint) (*opendesignerv1.Paint, error) {
		if in.Stop == nil {
			return ref, nil
		}
		c := proto.Clone(cur).(*opendesignerv1.Paint)
		for _, g := range []*opendesignerv1.GradientPaint{c.GetLinear(), c.GetRadial()} {
			if g == nil {
				continue
			}
			if *in.Stop < 0 || *in.Stop >= len(g.GetStops()) {
				return nil, fmt.Errorf("bind_variable: the gradient has %d stops, there is no stop %d", len(g.GetStops()), *in.Stop)
			}
			g.Stops[*in.Stop].VariableId = in.VariableId
			return c, nil
		}
		return nil, errors.New("bind_variable: stop given but that paint is not a gradient")
	}
	patch := &opendesignerv1.Node{}
	if target == "fill" {
		fills := n.GetFills()
		if in.Index < 0 || in.Index > len(fills) || (in.Index == len(fills) && in.Stop != nil) {
			return SeqOutput{}, fmt.Errorf("bind_variable: node has %d fills, there is no fill %d", len(fills), in.Index)
		}
		for i, p := range fills {
			if i == in.Index {
				np, err := paintAt(p)
				if err != nil {
					return SeqOutput{}, err
				}
				p = np
			}
			patch.Fills = append(patch.Fills, p)
		}
		if in.Index == len(fills) {
			patch.Fills = append(patch.Fills, ref) // binding the next free slot creates the fill
		}
		return s.submitProps(ctx, in.NodeId, patch, "fills")
	}
	strokes := n.GetStrokes()
	if in.Index < 0 || in.Index >= len(strokes) {
		return SeqOutput{}, fmt.Errorf("bind_variable: the node has no stroke %d to bind (give it one first)", in.Index)
	}
	for i, st := range strokes {
		c := &opendesignerv1.Stroke{Paint: st.GetPaint(), Weight: st.GetWeight(), Align: st.GetAlign()}
		if i == in.Index {
			np, err := paintAt(st.GetPaint())
			if err != nil {
				return SeqOutput{}, err
			}
			c.Paint = np
		}
		patch.Strokes = append(patch.Strokes, c)
	}
	return s.submitProps(ctx, in.NodeId, patch, "strokes")
}

func (s *Session) submitProps(ctx context.Context, id string, patch *opendesignerv1.Node, path string) (SeqOutput, error) {
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: id, Patch: patch, Mask: &fieldmaskpb.FieldMask{Paths: []string{path}},
	}}})
	if err != nil {
		return SeqOutput{}, err
	}
	return SeqOutput{Seq: seq}, nil
}

func registerVariableTools(srv *mcp.Server, s *Session) {
	addTool(srv, "list_variables", "List the colour variables (design tokens) and the modes, with how many fills and strokes use each."+variableConventions, s.ListVariables)
	addTool(srv, "set_variable", "Create a variable (omit id) or REPLACE one entirely (give id). Returns the variable id."+variableConventions, s.SetVariable)
	addTool(srv, "delete_variable", "Delete a variable. Bound fills draw black until rebound."+variableConventions, s.DeleteVariable)
	addTool(srv, "set_modes", "Replace the whole list of modes (e.g. light, dark); the first is the default."+variableConventions, s.SetModes)
	addTool(srv, "bind_variable", "Make a node's fill, stroke, gradient stop, opacity, corner radius, font size or text follow a variable instead of a fixed value."+variableConventions, s.BindVariable)
}
