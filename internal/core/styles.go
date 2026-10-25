package core

import (
	"errors"
	"fmt"
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
)

// SHARED PAINT AND EFFECT STYLES -- the Go half (the authority) of web/src/store/paintStyles.ts.
//
// A PAINT STYLE is a named list of paints; an EFFECT STYLE a named list of effects. Nodes point to them
// with fill_style_id / stroke_style_id / effect_style_id (SetProperties mask paths of the same names).
// Like text styles they are RESOLVED at read time (ResolveNode): the node draws with the style's values,
// its own fills / strokes / effects stay in the document as the fallback, and detaching (empty id)
// gives them back. The invariants:
//
//	1. a style has a non-empty id and a name; a paint style holds at least one paint, each one valid
//	   (the same rules as a node's paints), an effect style any number of effects;
//	2. the three ids on a node are empty or name an existing style of the right kind;
//	3. deleting a style clears the ids on the nodes that used it (they keep their own values).
//
// Upserts are ABSOLUTE: the inverse of an op is the previous state.

var (
	ErrNilPaintStyle      = errors.New("core: nil paint style")
	ErrPaintStyleMissing  = errors.New("core: paint style not found")
	ErrNilEffectStyle     = errors.New("core: nil effect style")
	ErrEffectStyleMissing = errors.New("core: effect style not found")
	ErrStyleValue         = errors.New("core: a style needs a name and valid paints")
)

func validatePaintStyleDef(d *opendesignerv1.PaintStyleDef) error {
	if d == nil || d.GetId() == "" {
		return ErrNilPaintStyle
	}
	if d.GetName() == "" || len(d.GetPaints()) == 0 {
		return fmt.Errorf("%w (paint style %s)", ErrStyleValue, d.GetId())
	}
	return validateNodePaints(d.GetPaints(), nil)
}

func validateEffectStyleDef(d *opendesignerv1.EffectStyleDef) error {
	if d == nil || d.GetId() == "" {
		return ErrNilEffectStyle
	}
	if d.GetName() == "" {
		return fmt.Errorf("%w (effect style %s)", ErrStyleValue, d.GetId())
	}
	return nil
}

func applySetPaintStyleDef(doc *opendesignerv1.Document, s *opendesignerv1.SetPaintStyleDef) error {
	d := s.GetPaintStyle()
	if err := validatePaintStyleDef(d); err != nil {
		return err
	}
	if doc.PaintStyles == nil {
		doc.PaintStyles = map[string]*opendesignerv1.PaintStyleDef{}
	}
	doc.PaintStyles[d.GetId()] = proto.Clone(d).(*opendesignerv1.PaintStyleDef)
	return nil
}

func applyDeletePaintStyleDef(doc *opendesignerv1.Document, d *opendesignerv1.DeletePaintStyleDef, cow *Shared) error {
	if _, ok := doc.GetPaintStyles()[d.GetId()]; !ok {
		return fmt.Errorf("%w: %s", ErrPaintStyleMissing, d.GetId())
	}
	delete(doc.PaintStyles, d.GetId())
	ids := make([]string, 0)
	for id, n := range doc.GetNodes() {
		if n.GetFillStyleId() == d.GetId() || n.GetStrokeStyleId() == d.GetId() {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		n := cow.mut(doc, id)
		if n.GetFillStyleId() == d.GetId() {
			n.FillStyleId = ""
		}
		if n.GetStrokeStyleId() == d.GetId() {
			n.StrokeStyleId = ""
		}
	}
	return nil
}

func applySetEffectStyleDef(doc *opendesignerv1.Document, s *opendesignerv1.SetEffectStyleDef) error {
	d := s.GetEffectStyle()
	if err := validateEffectStyleDef(d); err != nil {
		return err
	}
	if doc.EffectStyles == nil {
		doc.EffectStyles = map[string]*opendesignerv1.EffectStyleDef{}
	}
	doc.EffectStyles[d.GetId()] = proto.Clone(d).(*opendesignerv1.EffectStyleDef)
	return nil
}

func applyDeleteEffectStyleDef(doc *opendesignerv1.Document, d *opendesignerv1.DeleteEffectStyleDef, cow *Shared) error {
	if _, ok := doc.GetEffectStyles()[d.GetId()]; !ok {
		return fmt.Errorf("%w: %s", ErrEffectStyleMissing, d.GetId())
	}
	delete(doc.EffectStyles, d.GetId())
	ids := make([]string, 0)
	for id, n := range doc.GetNodes() {
		if n.GetEffectStyleId() == d.GetId() {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		cow.mut(doc, id).EffectStyleId = ""
	}
	return nil
}

// checkStyleId: an id is empty (detach) or names an existing style of the kind.
func checkStyleId(doc *opendesignerv1.Document, path, id string) error {
	if id == "" {
		return nil
	}
	if path == "effect_style_id" {
		if _, ok := doc.GetEffectStyles()[id]; !ok {
			return fmt.Errorf("%w: %s", ErrEffectStyleMissing, id)
		}
		return nil
	}
	if _, ok := doc.GetPaintStyles()[id]; !ok {
		return fmt.Errorf("%w: %s", ErrPaintStyleMissing, id)
	}
	return nil
}

// checkStylePath validates one of the three style-id mask paths of SetProperties.
func checkStylePath(doc *opendesignerv1.Document, path string, patch *opendesignerv1.Node) error {
	switch path {
	case "fill_style_id":
		return checkStyleId(doc, path, patch.GetFillStyleId())
	case "stroke_style_id":
		return checkStyleId(doc, path, patch.GetStrokeStyleId())
	case "effect_style_id":
		return checkStyleId(doc, path, patch.GetEffectStyleId())
	}
	return nil
}

// applyStylePath writes one of the style-id mask paths.
func applyStylePath(n, p *opendesignerv1.Node, path string) {
	switch path {
	case "fill_style_id":
		n.FillStyleId = p.GetFillStyleId()
	case "stroke_style_id":
		n.StrokeStyleId = p.GetStrokeStyleId()
	case "effect_style_id":
		n.EffectStyleId = p.GetEffectStyleId()
	}
}

// validateStyleRefs: the style ids of a node being created name existing styles.
func validateStyleRefs(doc *opendesignerv1.Document, n *opendesignerv1.Node) error {
	if err := checkStyleId(doc, "fill_style_id", n.GetFillStyleId()); err != nil {
		return err
	}
	if err := checkStyleId(doc, "stroke_style_id", n.GetStrokeStyleId()); err != nil {
		return err
	}
	return checkStyleId(doc, "effect_style_id", n.GetEffectStyleId())
}

// ValidatePaintStyleDef and ValidateEffectStyleDef are for the MCP tools.
func ValidatePaintStyleDef(d *opendesignerv1.PaintStyleDef) error   { return validatePaintStyleDef(d) }
func ValidateEffectStyleDef(d *opendesignerv1.EffectStyleDef) error { return validateEffectStyleDef(d) }

// resolvePaintStyles returns n with its shared paint / effect styles applied: a fill style replaces the
// fills; a stroke style replaces each stroke's paint (the one at the stroke's index, the last when the
// style has fewer) keeping weight, alignment and arrowheads; an effect style replaces the effects.
func resolvePaintStyles(doc *opendesignerv1.Document, n *opendesignerv1.Node) *opendesignerv1.Node {
	if n.GetFillStyleId() == "" && n.GetStrokeStyleId() == "" && n.GetEffectStyleId() == "" {
		return n
	}
	fill := doc.GetPaintStyles()[n.GetFillStyleId()]
	stroke := doc.GetPaintStyles()[n.GetStrokeStyleId()]
	eff := doc.GetEffectStyles()[n.GetEffectStyleId()]
	if fill == nil && stroke == nil && eff == nil {
		return n
	}
	out := proto.Clone(n).(*opendesignerv1.Node)
	if fill != nil {
		out.Fills = proto.Clone(&opendesignerv1.PaintStyleDef{Paints: fill.GetPaints()}).(*opendesignerv1.PaintStyleDef).Paints
	}
	if stroke != nil && len(stroke.GetPaints()) > 0 {
		for i, s := range out.Strokes {
			k := i
			if k >= len(stroke.GetPaints()) {
				k = len(stroke.GetPaints()) - 1
			}
			s.Paint = proto.Clone(stroke.GetPaints()[k]).(*opendesignerv1.Paint)
		}
	}
	if eff != nil {
		out.Effects = proto.Clone(&opendesignerv1.EffectStyleDef{Effects: eff.GetEffects()}).(*opendesignerv1.EffectStyleDef).Effects
	}
	return out
}
