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

// GRAPHICS AND COLOUR tools: object styles, layers and swatches (docs/graphics-colour.md).

const graphicsConventions = " An OBJECT STYLE is a shared look for shapes: the properties it sets (fills, strokes, effects, opacity, corner_radius, blend_mode) are taken from the style by every node that applies it. A LAYER spans all pages: a node names its layer, and hiding or locking the layer hides or locks everything on it. A SWATCH is a named color of the document's palette (RGB, CMYK process, spot, or a tint of another swatch) that fills and strokes can use."

// --- object styles -------------------------------------------------------------------------

type ObjectStyleView struct {
	Id           string   `json:"id"`
	Name         string   `json:"name"`
	Sets         []string `json:"sets"`
	Fills        []RGBA   `json:"fills,omitempty"`
	StrokeCount  int      `json:"strokeCount,omitempty"`
	EffectCount  int      `json:"effectCount,omitempty"`
	Opacity      float64  `json:"opacity,omitempty"`
	CornerRadius float64  `json:"cornerRadius,omitempty"`
	BlendMode    string   `json:"blendMode,omitempty"`
	BasedOn      string   `json:"basedOn,omitempty"`
}

type ListObjectStylesOutput struct {
	ObjectStyles []ObjectStyleView `json:"objectStyles"`
}

func (s *Session) ListObjectStyles(_ context.Context, _ struct{}) (ListObjectStylesOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := ListObjectStylesOutput{ObjectStyles: []ObjectStyleView{}}
	for id, d := range s.doc.GetObjectStyles() {
		v := ObjectStyleView{
			Id: id, Name: d.GetName(), Sets: d.GetSets(), StrokeCount: len(d.GetStrokes()), EffectCount: len(d.GetEffects()),
			Opacity: d.GetOpacity(), CornerRadius: d.GetCornerRadius(), BlendMode: blendModeName(d.GetBlendMode()), BasedOn: d.GetBasedOn(),
		}
		for _, p := range d.GetFills() {
			if c := p.GetSolid().GetColor(); c != nil {
				v.Fills = append(v.Fills, RGBA{R: float64(c.GetR()), G: float64(c.GetG()), B: float64(c.GetB()), A: float64(c.GetA())})
			}
		}
		out.ObjectStyles = append(out.ObjectStyles, v)
	}
	sort.Slice(out.ObjectStyles, func(i, j int) bool {
		a, b := out.ObjectStyles[i], out.ObjectStyles[j]
		return a.Name < b.Name || (a.Name == b.Name && a.Id < b.Id)
	})
	return out, nil
}

type SetObjectStyleInput struct {
	Id           string   `json:"id,omitempty" jsonschema:"id of an existing object style to REPLACE; omit to create one"`
	Name         string   `json:"name"`
	Sets         []string `json:"sets,omitempty" jsonschema:"which properties the style sets: fills, strokes, effects, opacity, corner_radius, blend_mode"`
	FromNodeId   string   `json:"fromNodeId,omitempty" jsonschema:"take the values of the properties named in sets from this node (fills, strokes, effects, opacity, corner radius, blend mode)"`
	Fills        []RGBA   `json:"fills,omitempty" jsonschema:"the fills, when sets has fills and fromNodeId is not given"`
	Opacity      *float64 `json:"opacity,omitempty"`
	CornerRadius *float64 `json:"cornerRadius,omitempty"`
	BlendMode    string   `json:"blendMode,omitempty" jsonschema:"normal | multiply | screen | ..."`
	BasedOn      string   `json:"basedOn,omitempty" jsonschema:"id of another object style this one starts from"`
}

type SetObjectStyleOutput struct {
	ObjectStyleId string `json:"objectStyleId"`
	Seq           uint64 `json:"seq"`
}

func (s *Session) SetObjectStyle(ctx context.Context, in SetObjectStyleInput) (SetObjectStyleOutput, error) {
	id := in.Id
	s.mu.Lock()
	if id == "" {
		id = uuid.NewString()
	} else if _, ok := s.doc.GetObjectStyles()[id]; !ok {
		s.mu.Unlock()
		return SetObjectStyleOutput{}, fmt.Errorf("set_object_style: object style %q not found (omit id to create one; list_object_styles for the ids)", id)
	}
	d := &opendesignerv1.ObjectStyleDef{Id: id, Name: in.Name, Sets: in.Sets, BasedOn: in.BasedOn}
	if in.FromNodeId != "" {
		n, ok := s.doc.GetNodes()[in.FromNodeId]
		if !ok {
			s.mu.Unlock()
			return SetObjectStyleOutput{}, fmt.Errorf("set_object_style: node %q not found", in.FromNodeId)
		}
		for _, p := range in.Sets {
			switch p {
			case "fills":
				d.Fills = cloneAllMsgs(n.GetFills())
			case "strokes":
				d.Strokes = cloneAllMsgs(n.GetStrokes())
			case "effects":
				d.Effects = cloneAllMsgs(n.GetEffects())
			case "opacity":
				d.Opacity = n.GetOpacity()
			case "blend_mode":
				d.BlendMode = n.GetBlendMode()
			case "corner_radius":
				d.CornerRadius = n.GetRect().GetCornerRadius()
			}
		}
	} else {
		if err := validateFills(in.Fills); err != nil {
			s.mu.Unlock()
			return SetObjectStyleOutput{}, fmt.Errorf("set_object_style: %w", err)
		}
		d.Fills = toPaints(in.Fills)
		if in.Opacity != nil {
			d.Opacity = *in.Opacity
		}
		if in.CornerRadius != nil {
			d.CornerRadius = *in.CornerRadius
		}
		if in.BlendMode != "" {
			b, ok := blendModes[in.BlendMode]
			if !ok {
				s.mu.Unlock()
				return SetObjectStyleOutput{}, fmt.Errorf("set_object_style: unknown blend mode %q", in.BlendMode)
			}
			d.BlendMode = b
		}
	}
	err := core.ValidateObjectStyleDef(s.doc, d)
	s.mu.Unlock()
	if err != nil {
		return SetObjectStyleOutput{}, fmt.Errorf("set_object_style: %w", err)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetObjectStyleDef{SetObjectStyleDef: &opendesignerv1.SetObjectStyleDef{ObjectStyle: d}}})
	if err != nil {
		return SetObjectStyleOutput{}, err
	}
	return SetObjectStyleOutput{ObjectStyleId: id, Seq: seq}, nil
}

func cloneAllMsgs[T proto.Message](in []T) []T {
	out := make([]T, len(in))
	for i, m := range in {
		out[i] = proto.Clone(m).(T)
	}
	return out
}

func (s *Session) DeleteObjectStyle(ctx context.Context, in IdInput) (SeqOutput, error) {
	s.mu.Lock()
	_, ok := s.doc.GetObjectStyles()[in.Id]
	s.mu.Unlock()
	if !ok {
		return SeqOutput{}, fmt.Errorf("delete_object_style: object style %q not found (list_object_styles for the ids)", in.Id)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteObjectStyleDef{DeleteObjectStyleDef: &opendesignerv1.DeleteObjectStyleDef{Id: in.Id}}})
	return SeqOutput{Seq: seq}, err
}

type ApplyObjectStyleInput struct {
	NodeIds       []string `json:"nodeIds" jsonschema:"shapes, texts, pictures and frames (not groups or instances)"`
	ObjectStyleId string   `json:"objectStyleId,omitempty" jsonschema:"the object style to apply; empty detaches (the node falls back to its own values)"`
}

func (s *Session) ApplyObjectStyle(ctx context.Context, in ApplyObjectStyleInput) (NodesOutput, error) {
	return s.setNodeLink(ctx, "apply_object_style", in.NodeIds, in.ObjectStyleId, "object_style_id", func(n *opendesignerv1.Node) string { return n.GetObjectStyleId() },
		func(p *opendesignerv1.Node, v string) { p.ObjectStyleId = v },
		func(doc *opendesignerv1.Document, v string) bool { _, ok := doc.GetObjectStyles()[v]; return ok }, "object style")
}

// setNodeLink writes one of a node's references (object_style_id, layer_id) on every node that needs it.
func (s *Session) setNodeLink(ctx context.Context, tool string, ids []string, value, path string,
	get func(*opendesignerv1.Node) string, set func(*opendesignerv1.Node, string), exists func(*opendesignerv1.Document, string) bool, what string) (NodesOutput, error) {
	if len(ids) == 0 {
		return NodesOutput{}, fmt.Errorf("%s: nodeIds is empty", tool)
	}
	s.mu.Lock()
	for _, id := range ids {
		n, ok := s.doc.GetNodes()[id]
		if !ok {
			s.mu.Unlock()
			return NodesOutput{}, fmt.Errorf("%s: node %q not found (list_nodes for the ids)", tool, id)
		}
		if path == "object_style_id" {
			switch n.GetShape().(type) {
			case *opendesignerv1.Node_Group, *opendesignerv1.Node_Instance:
				s.mu.Unlock()
				return NodesOutput{}, fmt.Errorf("%s: node %q is a group or an instance and takes no object style", tool, id)
			}
		}
	}
	if value != "" && !exists(s.doc, value) {
		s.mu.Unlock()
		return NodesOutput{}, fmt.Errorf("%s: %s %q not found", tool, what, value)
	}
	var todo []string
	for _, id := range ids {
		if get(s.doc.GetNodes()[id]) != value {
			todo = append(todo, id)
		}
	}
	s.mu.Unlock()
	out := NodesOutput{}
	for _, id := range todo {
		patch := &opendesignerv1.Node{}
		set(patch, value)
		seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
			Id: id, Patch: patch, Mask: &fieldmaskpb.FieldMask{Paths: []string{path}},
		}}})
		if err != nil {
			return out, err
		}
		out.Changed++
		out.Seq = seq
	}
	return out, nil
}

// --- layers -----------------------------------------------------------------------------------

type LayerView struct {
	Id      string `json:"id"`
	Name    string `json:"name"`
	Hidden  bool   `json:"hidden,omitempty"`
	Locked  bool   `json:"locked,omitempty"`
	NoPrint bool   `json:"noPrint,omitempty"`
	Nodes   int    `json:"nodes" jsonschema:"how many nodes are on the layer"`
}

type ListLayersOutput struct {
	Layers []LayerView `json:"layers"`
}

func (s *Session) ListLayers(_ context.Context, _ struct{}) (ListLayersOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	count := map[string]int{}
	for _, n := range s.doc.GetNodes() {
		if n.GetLayerId() != "" {
			count[n.GetLayerId()]++
		}
	}
	out := ListLayersOutput{Layers: []LayerView{}}
	for _, l := range s.doc.GetLayers() {
		out.Layers = append(out.Layers, LayerView{Id: l.GetId(), Name: l.GetName(), Hidden: l.GetHidden(), Locked: l.GetLocked(), NoPrint: l.GetNoPrint(), Nodes: count[l.GetId()]})
	}
	return out, nil
}

type SetLayerInput struct {
	Id       string `json:"id,omitempty" jsonschema:"id of an existing layer to REPLACE; omit to create one (appended)"`
	Name     string `json:"name"`
	Hidden   bool   `json:"hidden,omitempty"`
	Locked   bool   `json:"locked,omitempty"`
	NoPrint  bool   `json:"noPrint,omitempty" jsonschema:"keep the layer out of PDF export"`
	Position uint32 `json:"position,omitempty" jsonschema:"1-based place in the layer list; 0 keeps the place"`
}

type SetLayerOutput struct {
	LayerId string `json:"layerId"`
	Seq     uint64 `json:"seq"`
}

func (s *Session) SetLayer(ctx context.Context, in SetLayerInput) (SetLayerOutput, error) {
	id := in.Id
	s.mu.Lock()
	if id == "" {
		id = uuid.NewString()
	} else {
		found := false
		for _, l := range s.doc.GetLayers() {
			found = found || l.GetId() == id
		}
		if !found {
			s.mu.Unlock()
			return SetLayerOutput{}, fmt.Errorf("set_layer: layer %q not found (omit id to create one; list_layers for the ids)", id)
		}
	}
	l := &opendesignerv1.Layer{Id: id, Name: in.Name, Hidden: in.Hidden, Locked: in.Locked, NoPrint: in.NoPrint}
	err := core.ValidateLayer(s.doc, l)
	s.mu.Unlock()
	if err != nil {
		return SetLayerOutput{}, fmt.Errorf("set_layer: %w", err)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetLayer{SetLayer: &opendesignerv1.SetLayer{Layer: l, Position: in.Position}}})
	if err != nil {
		return SetLayerOutput{}, err
	}
	return SetLayerOutput{LayerId: id, Seq: seq}, nil
}

func (s *Session) DeleteLayer(ctx context.Context, in IdInput) (SeqOutput, error) {
	s.mu.Lock()
	found := false
	for _, l := range s.doc.GetLayers() {
		found = found || l.GetId() == in.Id
	}
	s.mu.Unlock()
	if !found {
		return SeqOutput{}, fmt.Errorf("delete_layer: layer %q not found (list_layers for the ids)", in.Id)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteLayer{DeleteLayer: &opendesignerv1.DeleteLayer{Id: in.Id}}})
	return SeqOutput{Seq: seq}, err
}

type AssignLayerInput struct {
	NodeIds []string `json:"nodeIds"`
	LayerId string   `json:"layerId,omitempty" jsonschema:"the layer to put the nodes on; empty takes them off any layer"`
}

func (s *Session) AssignLayer(ctx context.Context, in AssignLayerInput) (NodesOutput, error) {
	return s.setNodeLink(ctx, "assign_layer", in.NodeIds, in.LayerId, "layer_id", func(n *opendesignerv1.Node) string { return n.GetLayerId() },
		func(p *opendesignerv1.Node, v string) { p.LayerId = v },
		func(doc *opendesignerv1.Document, v string) bool {
			for _, l := range doc.GetLayers() {
				if l.GetId() == v {
					return true
				}
			}
			return false
		}, "layer")
}

// --- swatches ---------------------------------------------------------------------------------

type SwatchView struct {
	Id       string   `json:"id"`
	Name     string   `json:"name"`
	Color    RGBA     `json:"color" jsonschema:"what it shows on screen"`
	Cmyk     *CmykIO  `json:"cmyk,omitempty"`
	SpotName string   `json:"spotName,omitempty"`
	TintOf   string   `json:"tintOf,omitempty"`
	Tint     float64  `json:"tint,omitempty"`
	Used     []string `json:"usedBy,omitempty" jsonschema:"ids of the nodes that use it"`
}

// CmykIO is a process color in percent (0..100).
type CmykIO struct {
	C float64 `json:"c"`
	M float64 `json:"m"`
	Y float64 `json:"y"`
	K float64 `json:"k"`
}

type ListSwatchesOutput struct {
	Swatches  []SwatchView `json:"swatches"`
	ColorMode string       `json:"colorMode" jsonschema:"rgb | cmyk"`
	Profile   string       `json:"iccProfile,omitempty"`
}

func swatchRGB(doc *opendesignerv1.Document, v *opendesignerv1.Variable) RGBA {
	col := doc.GetCollections()[v.GetCollectionId()]
	mode := ""
	if len(col.GetModes()) > 0 {
		mode = col.GetModes()[0].GetId()
	}
	c := v.GetValues()[mode].GetColor()
	return RGBA{R: float64(c.GetR()), G: float64(c.GetG()), B: float64(c.GetB()), A: float64(c.GetA())}
}

func (s *Session) ListSwatches(_ context.Context, _ struct{}) (ListSwatchesOutput, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	used := map[string][]string{}
	for id, n := range s.doc.GetNodes() {
		for _, vid := range n.GetBindings() {
			used[vid] = append(used[vid], id)
		}
	}
	out := ListSwatchesOutput{Swatches: []SwatchView{}, ColorMode: "rgb", Profile: s.doc.GetSettings().GetIccProfile()}
	if s.doc.GetSettings().GetColorMode() == "cmyk" {
		out.ColorMode = "cmyk"
	}
	for id, v := range s.doc.GetVariables() {
		if !v.GetSwatch() {
			continue
		}
		sv := SwatchView{Id: id, Name: v.GetName(), Color: swatchRGB(s.doc, v), SpotName: v.GetSpotName(), TintOf: v.GetTintOf(), Tint: v.GetTint()}
		if c := v.GetCmyk(); c != nil {
			sv.Cmyk = &CmykIO{C: float64(c.GetC()) * 100, M: float64(c.GetM()) * 100, Y: float64(c.GetY()) * 100, K: float64(c.GetK()) * 100}
		}
		sv.Used = used[id]
		sort.Strings(sv.Used)
		out.Swatches = append(out.Swatches, sv)
	}
	sort.Slice(out.Swatches, func(i, j int) bool {
		a, b := out.Swatches[i], out.Swatches[j]
		return a.Name < b.Name || (a.Name == b.Name && a.Id < b.Id)
	})
	return out, nil
}

type SetSwatchInput struct {
	Id       string  `json:"id,omitempty" jsonschema:"id of an existing swatch to REPLACE; omit to create one"`
	Name     string  `json:"name"`
	Cmyk     *CmykIO `json:"cmyk,omitempty" jsonschema:"a process color in percent; the screen color is derived from it"`
	Color    *RGBA   `json:"color,omitempty" jsonschema:"the screen color, 0..1 (when cmyk is not given)"`
	SpotName string  `json:"spotName,omitempty" jsonschema:"a spot color: the name of the ink"`
	TintOf   string  `json:"tintOf,omitempty" jsonschema:"the swatch this is a tint of (then give tint)"`
	Tint     float64 `json:"tint,omitempty" jsonschema:"percent of the base swatch's ink, 1..100"`
}

type SetSwatchOutput struct {
	SwatchId string `json:"swatchId"`
	Seq      uint64 `json:"seq"`
}

const swatchCollectionName = "Swatches"

// SetSwatch creates or replaces a swatch: a color variable in the "Swatches" collection (made on first use).
// Use a swatch with bind_variable on "fills.0" / "strokes.0".
func (s *Session) SetSwatch(ctx context.Context, in SetSwatchInput) (SetSwatchOutput, error) {
	s.mu.Lock()
	id := in.Id
	if id == "" {
		id = uuid.NewString()
	} else if v, ok := s.doc.GetVariables()[id]; !ok || !v.GetSwatch() {
		s.mu.Unlock()
		return SetSwatchOutput{}, fmt.Errorf("set_swatch: swatch %q not found (omit id to create one; list_swatches for the ids)", id)
	}
	// The collection: the one named Swatches, else a new one with a single mode.
	var colID, mode string
	var pre *opendesignerv1.Op
	for cid, c := range s.doc.GetCollections() {
		if c.GetName() == swatchCollectionName && len(c.GetModes()) > 0 {
			colID, mode = cid, c.GetModes()[0].GetId()
			break
		}
	}
	if colID == "" {
		colID, mode = uuid.NewString(), uuid.NewString()
		pre = &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetCollection{SetCollection: &opendesignerv1.SetCollection{Collection: &opendesignerv1.VariableCollection{
			Id: colID, Name: swatchCollectionName, Modes: []*opendesignerv1.VariableMode{{Id: mode, Name: "Default"}},
		}}}}
	}
	if prev, ok := s.doc.GetVariables()[id]; ok {
		colID = prev.GetCollectionId()
		if c := s.doc.GetCollections()[colID]; len(c.GetModes()) > 0 {
			mode = c.GetModes()[0].GetId()
		}
	}
	v := &opendesignerv1.Variable{Id: id, CollectionId: colID, Name: in.Name, Type: opendesignerv1.VariableType_VARIABLE_TYPE_COLOR, Swatch: true, SpotName: in.SpotName}
	rgb := RGBA{A: 1}
	switch {
	case in.TintOf != "":
		base := s.doc.GetVariables()[in.TintOf]
		if base == nil || !base.GetSwatch() || in.Tint < 1 || in.Tint > 100 {
			s.mu.Unlock()
			return SetSwatchOutput{}, errors.New("set_swatch: a tint needs an existing swatch to be a tint of, and a percentage from 1 to 100")
		}
		b := swatchRGB(s.doc, base)
		t := in.Tint / 100
		rgb = RGBA{R: 1 - t*(1-b.R), G: 1 - t*(1-b.G), B: 1 - t*(1-b.B), A: 1}
		v.TintOf, v.Tint = in.TintOf, in.Tint
		if c := base.GetCmyk(); c != nil {
			v.Cmyk = &opendesignerv1.Cmyk{C: c.GetC() * float32(t), M: c.GetM() * float32(t), Y: c.GetY() * float32(t), K: c.GetK() * float32(t)}
		}
	case in.Cmyk != nil:
		c := *in.Cmyk
		v.Cmyk = &opendesignerv1.Cmyk{C: float32(c.C / 100), M: float32(c.M / 100), Y: float32(c.Y / 100), K: float32(c.K / 100)}
		rgb = RGBA{R: (1 - c.C/100) * (1 - c.K/100), G: (1 - c.M/100) * (1 - c.K/100), B: (1 - c.Y/100) * (1 - c.K/100), A: 1}
	case in.Color != nil:
		rgb = *in.Color
		rgb.A = 1
	}
	v.Values = map[string]*opendesignerv1.VariableValue{mode: {Kind: &opendesignerv1.VariableValue_Color{Color: &opendesignerv1.Color{R: float32(rgb.R), G: float32(rgb.G), B: float32(rgb.B), A: 1}}}}
	s.mu.Unlock()
	var last uint64
	var err error
	if pre != nil {
		if last, err = s.submit(ctx, pre); err != nil {
			return SetSwatchOutput{}, err
		}
	}
	if last, err = s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetVariable{SetVariable: &opendesignerv1.SetVariable{Variable: v}}}); err != nil {
		return SetSwatchOutput{}, fmt.Errorf("set_swatch: %w", err)
	}
	return SetSwatchOutput{SwatchId: id, Seq: last}, nil
}

func (s *Session) DeleteSwatch(ctx context.Context, in IdInput) (SeqOutput, error) {
	s.mu.Lock()
	v, ok := s.doc.GetVariables()[in.Id]
	s.mu.Unlock()
	if !ok || !v.GetSwatch() {
		return SeqOutput{}, fmt.Errorf("delete_swatch: swatch %q not found (list_swatches for the ids)", in.Id)
	}
	seq, err := s.submit(ctx, &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteVariable{DeleteVariable: &opendesignerv1.DeleteVariable{Id: in.Id}}})
	return SeqOutput{Seq: seq}, err
}

func registerGraphicsTools(srv *mcp.Server, s *Session) {
	addTool(srv, "list_object_styles", "List the document's object styles."+graphicsConventions, s.ListObjectStyles)
	addTool(srv, "set_object_style", "Create an object style (omit id) or REPLACE one. Give sets and either fromNodeId (take the values from a node) or the values."+graphicsConventions, s.SetObjectStyle)
	addTool(srv, "delete_object_style", "Delete an object style; the nodes that used it keep their own values.", s.DeleteObjectStyle)
	addTool(srv, "apply_object_style", "Apply an object style to shapes, or detach it (empty objectStyleId)."+graphicsConventions, s.ApplyObjectStyle)
	addTool(srv, "list_layers", "List the document's layers (shared by all pages) with how many nodes are on each."+graphicsConventions, s.ListLayers)
	addTool(srv, "set_layer", "Create a layer (omit id) or REPLACE one: its name and whether it is hidden, locked or kept out of print."+graphicsConventions, s.SetLayer)
	addTool(srv, "delete_layer", "Delete a layer; the nodes on it are taken off it (not deleted).", s.DeleteLayer)
	addTool(srv, "assign_layer", "Put nodes on a layer, or take them off any layer (empty layerId)."+graphicsConventions, s.AssignLayer)
	addTool(srv, "list_swatches", "List the document's swatches with the colour mode and output profile (set_document_settings changes them)."+graphicsConventions, s.ListSwatches)
	addTool(srv, "set_swatch", "Create a swatch (omit id) or REPLACE one: a CMYK process color, an RGB color, a spot color, or a tint of another swatch. Use it with bind_variable on \"fills.0\" or \"strokes.0\"."+graphicsConventions, s.SetSwatch)
	addTool(srv, "delete_swatch", "Delete a swatch; what used it is detached and keeps its color.", s.DeleteSwatch)
}
