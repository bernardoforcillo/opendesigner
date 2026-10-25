package core

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"unicode"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
)

// GRAPHICS AND COLOUR -- object styles, layers and swatch data. The Go half (the authority) of
// web/src/store/graphics.ts. Invariants:
//
//  1. OBJECT STYLES. An id is non-empty. `sets` lists distinct properties among fills, strokes, effects,
//     opacity, corner_radius and blend_mode; its paints are well formed; opacity is in 0..1, corner_radius
//     is >= 0, blend_mode is a known mode. `based_on` names another object style and never loops. A node
//     takes a style (object_style_id) only if it exists and the node is not a group or an instance. A node
//     with a style is drawn with the properties the style sets; its own stay as the fallback. Deleting a
//     style detaches its nodes and the styles based on it.
//  2. LAYERS. An id is non-empty, a name is at most 80 characters, there are at most 200. A node's layer_id
//     names an existing layer (or is empty). Deleting a layer detaches its nodes.
//  3. SWATCHES. The swatch fields belong to COLOR variables: cmyk channels are in 0..1, a spot name is at
//     most 64 characters, `tint_of` names a different existing color swatch and `tint` is in 1..100 exactly
//     when `tint_of` is set.
//  4. COLOUR MODE. DocSettings.color_mode is "" or "cmyk"; icc_profile is at most 64 characters.

var (
	ErrObjectStyle        = errors.New("core: invalid object style")
	ErrObjectStyleMissing = errors.New("core: object style not found")
	ErrNotStylable        = errors.New("core: this node cannot take an object style")
	ErrLayer              = errors.New("core: invalid layer")
	ErrLayerMissing       = errors.New("core: layer not found")
	ErrSwatch             = errors.New("core: invalid swatch")
)

const (
	maxLayers      = 200
	maxLayerName   = 80
	maxStyleChain  = 16
	maxSwatchName  = 64
	maxProfileName = 64
)

var objectStyleProps = map[string]bool{"fills": true, "strokes": true, "effects": true, "opacity": true, "corner_radius": true, "blend_mode": true}

func plainText(s string, max int) bool {
	if len(s) > max {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func validateObjectStyleDef(doc *opendesignerv1.Document, d *opendesignerv1.ObjectStyleDef) error {
	if d == nil || d.GetId() == "" {
		return fmt.Errorf("%w: empty id", ErrObjectStyle)
	}
	if !plainText(d.GetName(), 80) {
		return fmt.Errorf("%w: name", ErrObjectStyle)
	}
	seen := map[string]bool{}
	for _, p := range d.GetSets() {
		if !objectStyleProps[p] || seen[p] {
			return fmt.Errorf("%w: sets %q", ErrObjectStyle, p)
		}
		seen[p] = true
	}
	if err := validateNodePaints(d.GetFills(), d.GetStrokes()); err != nil {
		return err
	}
	if op := d.GetOpacity(); math.IsNaN(op) || op < 0 || op > 1 {
		return fmt.Errorf("%w: opacity", ErrObjectStyle)
	}
	if r := d.GetCornerRadius(); math.IsNaN(r) || math.IsInf(r, 0) || r < 0 {
		return fmt.Errorf("%w: corner radius", ErrObjectStyle)
	}
	if b := d.GetBlendMode(); b < opendesignerv1.BlendMode_BLEND_MODE_UNSPECIFIED || b > opendesignerv1.BlendMode_BLEND_MODE_LUMINOSITY {
		return fmt.Errorf("%w: %v", ErrBlendMode, b)
	}
	for cur, hops := d.GetBasedOn(), 0; cur != ""; hops++ {
		b, ok := doc.GetObjectStyles()[cur]
		if cur == d.GetId() || !ok || hops > maxStyleChain {
			return fmt.Errorf("%w: based on %q", ErrObjectStyle, cur)
		}
		cur = b.GetBasedOn()
	}
	return nil
}

func applySetObjectStyleDef(doc *opendesignerv1.Document, s *opendesignerv1.SetObjectStyleDef) error {
	d := s.GetObjectStyle()
	if err := validateObjectStyleDef(doc, d); err != nil {
		return err
	}
	if doc.ObjectStyles == nil {
		doc.ObjectStyles = map[string]*opendesignerv1.ObjectStyleDef{}
	}
	doc.ObjectStyles[d.GetId()] = proto.Clone(d).(*opendesignerv1.ObjectStyleDef)
	return nil
}

func applyDeleteObjectStyleDef(doc *opendesignerv1.Document, d *opendesignerv1.DeleteObjectStyleDef, cow *Shared) error {
	if _, ok := doc.GetObjectStyles()[d.GetId()]; !ok {
		return fmt.Errorf("%w: %s", ErrObjectStyleMissing, d.GetId())
	}
	delete(doc.ObjectStyles, d.GetId())
	for _, s := range doc.ObjectStyles {
		if s.GetBasedOn() == d.GetId() {
			s.BasedOn = ""
		}
	}
	ids := make([]string, 0)
	for id, n := range doc.GetNodes() {
		if n.GetObjectStyleId() == d.GetId() {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		cow.mut(doc, id).ObjectStyleId = ""
	}
	return nil
}

// validateObjectStyleID checks a node's object_style_id write.
func validateObjectStyleID(doc *opendesignerv1.Document, n *opendesignerv1.Node, id string) error {
	switch n.GetShape().(type) {
	case *opendesignerv1.Node_Group, *opendesignerv1.Node_Instance:
		return fmt.Errorf("%w: %s", ErrNotStylable, n.GetId())
	}
	if id != "" {
		if _, ok := doc.GetObjectStyles()[id]; !ok {
			return fmt.Errorf("%w: %s", ErrObjectStyleMissing, id)
		}
	}
	return nil
}

// ValidateObjectStyleDef is for the MCP tools.
func ValidateObjectStyleDef(doc *opendesignerv1.Document, d *opendesignerv1.ObjectStyleDef) error {
	return validateObjectStyleDef(doc, d)
}

// objectStyleChain is the style and the styles it is based on, base first.
func objectStyleChain(doc *opendesignerv1.Document, id string) []*opendesignerv1.ObjectStyleDef {
	var chain []*opendesignerv1.ObjectStyleDef
	seen := map[string]bool{}
	for cur := id; cur != "" && !seen[cur] && len(chain) <= maxStyleChain; {
		d, ok := doc.GetObjectStyles()[cur]
		if !ok {
			break
		}
		seen[cur] = true
		chain = append([]*opendesignerv1.ObjectStyleDef{d}, chain...)
		cur = d.GetBasedOn()
	}
	return chain
}

// resolveObjectStyle returns n drawn with its object style: the properties the style (and the styles it is
// based on, the nearest winning) sets replace the node's own, which stay in the document as the fallback.
func resolveObjectStyle(doc *opendesignerv1.Document, n *opendesignerv1.Node) *opendesignerv1.Node {
	if n.GetObjectStyleId() == "" {
		return n
	}
	chain := objectStyleChain(doc, n.GetObjectStyleId())
	if len(chain) == 0 {
		return n
	}
	out := proto.Clone(n).(*opendesignerv1.Node)
	for _, d := range chain {
		for _, p := range d.GetSets() {
			switch p {
			case "fills":
				out.Fills = cloneAll(d.GetFills())
			case "strokes":
				out.Strokes = cloneAll(d.GetStrokes())
			case "effects":
				out.Effects = cloneAll(d.GetEffects())
			case "opacity":
				out.Opacity = d.GetOpacity()
			case "blend_mode":
				out.BlendMode = d.GetBlendMode()
			case "corner_radius":
				if r, ok := out.GetShape().(*opendesignerv1.Node_Rect); ok && r.Rect != nil {
					r.Rect.CornerRadius = d.GetCornerRadius()
				}
			}
		}
	}
	return out
}

func cloneAll[T proto.Message](in []T) []T {
	out := make([]T, len(in))
	for i, m := range in {
		out[i] = proto.Clone(m).(T)
	}
	return out
}

// --- layers ---------------------------------------------------------------------------------------

func validateLayer(doc *opendesignerv1.Document, l *opendesignerv1.Layer) error {
	if l == nil || l.GetId() == "" {
		return fmt.Errorf("%w: empty id", ErrLayer)
	}
	if !plainText(l.GetName(), maxLayerName) {
		return fmt.Errorf("%w: name", ErrLayer)
	}
	if layerIndex(doc, l.GetId()) < 0 && len(doc.GetLayers()) >= maxLayers {
		return fmt.Errorf("%w: at most %d layers", ErrLayer, maxLayers)
	}
	return nil
}

func layerIndex(doc *opendesignerv1.Document, id string) int {
	for i, l := range doc.GetLayers() {
		if l.GetId() == id {
			return i
		}
	}
	return -1
}

func applySetLayer(doc *opendesignerv1.Document, s *opendesignerv1.SetLayer) error {
	l := s.GetLayer()
	if err := validateLayer(doc, l); err != nil {
		return err
	}
	c := proto.Clone(l).(*opendesignerv1.Layer)
	if i := layerIndex(doc, l.GetId()); i >= 0 {
		doc.Layers[i] = c
	} else {
		doc.Layers = append(doc.Layers, c)
	}
	if pos := int(s.GetPosition()); pos > 0 {
		from := layerIndex(doc, l.GetId())
		to := pos - 1
		if to >= len(doc.Layers) {
			to = len(doc.Layers) - 1
		}
		doc.Layers = append(doc.Layers[:from], doc.Layers[from+1:]...)
		doc.Layers = append(doc.Layers[:to], append([]*opendesignerv1.Layer{c}, doc.Layers[to:]...)...)
	}
	return nil
}

func applyDeleteLayer(doc *opendesignerv1.Document, d *opendesignerv1.DeleteLayer, cow *Shared) error {
	i := layerIndex(doc, d.GetId())
	if i < 0 {
		return fmt.Errorf("%w: %s", ErrLayerMissing, d.GetId())
	}
	doc.Layers = append(doc.Layers[:i], doc.Layers[i+1:]...)
	ids := make([]string, 0)
	for id, n := range doc.GetNodes() {
		if n.GetLayerId() == d.GetId() {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		cow.mut(doc, id).LayerId = ""
	}
	return nil
}

func validateLayerID(doc *opendesignerv1.Document, id string) error {
	if id != "" && layerIndex(doc, id) < 0 {
		return fmt.Errorf("%w: %s", ErrLayerMissing, id)
	}
	return nil
}

// ValidateLayer is for the MCP tools.
func ValidateLayer(doc *opendesignerv1.Document, l *opendesignerv1.Layer) error {
	return validateLayer(doc, l)
}

// --- swatches and colour mode ------------------------------------------------------------------

// validateSwatch checks the swatch fields of a variable (invariant 3).
func validateSwatch(doc *opendesignerv1.Document, v *opendesignerv1.Variable) error {
	if !v.GetSwatch() && v.GetCmyk() == nil && v.GetSpotName() == "" && v.GetTintOf() == "" && v.GetTint() == 0 {
		return nil
	}
	if v.GetType() != opendesignerv1.VariableType_VARIABLE_TYPE_COLOR {
		return fmt.Errorf("%w: only a color variable can be a swatch", ErrSwatch)
	}
	if c := v.GetCmyk(); c != nil {
		for _, ch := range []float32{c.GetC(), c.GetM(), c.GetY(), c.GetK()} {
			if math.IsNaN(float64(ch)) || ch < 0 || ch > 1 {
				return fmt.Errorf("%w: cmyk", ErrSwatch)
			}
		}
	}
	if !plainText(v.GetSpotName(), maxSwatchName) {
		return fmt.Errorf("%w: spot name", ErrSwatch)
	}
	if (v.GetTintOf() == "") != (v.GetTint() == 0) {
		return fmt.Errorf("%w: a tint needs its base and a percentage", ErrSwatch)
	}
	if v.GetTintOf() != "" {
		base := doc.GetVariables()[v.GetTintOf()]
		if base == nil || v.GetTintOf() == v.GetId() || !base.GetSwatch() || base.GetType() != opendesignerv1.VariableType_VARIABLE_TYPE_COLOR ||
			math.IsNaN(v.GetTint()) || v.GetTint() < 1 || v.GetTint() > 100 {
			return fmt.Errorf("%w: tint of %q", ErrSwatch, v.GetTintOf())
		}
	}
	return nil
}

func validateColorMode(s *opendesignerv1.DocSettings) error {
	if m := s.GetColorMode(); m != "" && m != "cmyk" {
		return fmt.Errorf("%w: color mode %q", ErrBadDocSettings, m)
	}
	if !plainText(s.GetIccProfile(), maxProfileName) || strings.TrimSpace(s.GetIccProfile()) != s.GetIccProfile() {
		return fmt.Errorf("%w: icc profile", ErrBadDocSettings)
	}
	return nil
}

// --- linked images ------------------------------------------------------------------------------

var ErrNotImageNode = errors.New("core: not an image node")

const maxPixels = 1 << 20

// applySetImage (relink) replaces the source of an image node. The node's box is the caller's business.
func applySetImage(doc *opendesignerv1.Document, s *opendesignerv1.SetImage, cow *Shared) error {
	n, ok := doc.Nodes[s.GetId()]
	if !ok {
		return fmt.Errorf("%w: %s", ErrNodeNotFound, s.GetId())
	}
	if _, isImage := n.GetShape().(*opendesignerv1.Node_Image); !isImage {
		return fmt.Errorf("%w: %s", ErrNotImageNode, s.GetId())
	}
	im := s.GetImage()
	if im == nil || !plainText(im.GetOriginalName(), 255) || im.GetPixelWidth() > maxPixels || im.GetPixelHeight() > maxPixels {
		return fmt.Errorf("%w: image name or size", ErrNotImageNode)
	}
	n = cow.mut(doc, s.GetId())
	n.Shape = &opendesignerv1.Node_Image{Image: proto.Clone(im).(*opendesignerv1.ImageNode)}
	return nil
}
