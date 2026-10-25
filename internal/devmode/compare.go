// Package devmode answers the questions of Dev Mode that need the whole document: what changed in
// a frame since it was marked ready for dev ("Compare changes") and what the annotations of a
// frame say. Pure: no I/O. internal/core owns the data (core/devmode.go); this package reads it.
//
// The diff is property-level like the branch merge (internal/merge), but it reports VALUES, not
// only which mask paths moved: the merge decides what to apply, the developer wants to read
// "width 120 -> 160". It walks the Node message by reflection, so a field added to Node later is
// compared without touching this file.
package devmode

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// Kinds of change.
const (
	Added   = "added"
	Removed = "removed"
	Changed = "changed"
)

// Change is one difference between the snapshot and the live frame.
type Change struct {
	NodeID   string `json:"nodeId"`
	NodeName string `json:"nodeName"`
	Kind     string `json:"kind"`
	// Property: the field that changed ("width", "fills[0]", "text.content", "meta.status"...).
	// Empty for an added or removed node.
	Property string `json:"property,omitempty"`
	// Before / After: readable values; "" when the property was not set on that side.
	Before string `json:"before,omitempty"`
	After  string `json:"after,omitempty"`
}

// Comparison is the outcome of Compare.
type Comparison struct {
	NodeID   string   `json:"nodeId"`
	Name     string   `json:"name"`
	MarkedAt int64    `json:"markedAt"`
	Changes  []Change `json:"changes"`
}

// ErrNotReady: the frame was never marked ready for dev.
var ErrNotReady = errors.New("devmode: the frame is not marked ready for dev")

// Compare diffs the live subtree of node `id` against its snapshot. A frame that was deleted since
// is reported as a single removed node.
func Compare(doc *opendesignerv1.Document, id string) (*Comparison, error) {
	ready := doc.GetReadyForDev()[id]
	if ready == nil {
		return nil, fmt.Errorf("%w: %s", ErrNotReady, id)
	}
	then := map[string]*opendesignerv1.Node{}
	for _, n := range ready.GetSnapshot() {
		then[n.GetId()] = n
	}
	now := map[string]*opendesignerv1.Node{}
	for _, n := range core.SubtreeOf(doc, id) {
		now[n.GetId()] = n
	}
	name := then[id].GetName()
	if n := now[id]; n != nil {
		name = n.GetName()
	}
	cmp := &Comparison{NodeID: id, Name: name, MarkedAt: ready.GetMarkedAt()}

	// Names for the report: the live name, else the one in the snapshot.
	nameOf := func(nid string) string {
		if n := now[nid]; n != nil {
			return n.GetName()
		}
		return then[nid].GetName()
	}
	// Pre-order of each side, so the report reads like the layer tree.
	order := func(m map[string]*opendesignerv1.Node, root string) []string {
		var ids []string
		var walk func(string)
		walk = func(nid string) {
			ids = append(ids, nid)
			var kids []*opendesignerv1.Node
			for _, n := range m {
				if n.GetParentId() == nid {
					kids = append(kids, n)
				}
			}
			sort.Slice(kids, func(i, j int) bool {
				if kids[i].GetOrderKey() != kids[j].GetOrderKey() {
					return kids[i].GetOrderKey() < kids[j].GetOrderKey()
				}
				return kids[i].GetId() < kids[j].GetId()
			})
			for _, k := range kids {
				walk(k.GetId())
			}
		}
		if m[root] != nil {
			walk(root)
		}
		return ids
	}

	seen := map[string]bool{}
	for _, nid := range order(now, id) {
		seen[nid] = true
		cur, old := now[nid], then[nid]
		if old == nil {
			cmp.Changes = append(cmp.Changes, Change{NodeID: nid, NodeName: cur.GetName(), Kind: Added})
			continue
		}
		cmp.Changes = append(cmp.Changes, diffNode(old, cur, nameOf)...)
	}
	for _, nid := range order(then, id) {
		if seen[nid] {
			continue
		}
		// Only the root of a removed subtree: its descendants go with it.
		if p := then[then[nid].GetParentId()]; p != nil && !seen[p.GetId()] && nid != id {
			continue
		}
		cmp.Changes = append(cmp.Changes, Change{NodeID: nid, NodeName: then[nid].GetName(), Kind: Removed})
	}
	return cmp, nil
}

// skipped: Node fields that are bookkeeping, not design. order_key is compared through "parent"
// and the position among siblings is left out on purpose (a sibling inserted before changes every
// key, and the report would be noise).
var skipped = map[string]bool{"id": true, "order_key": true}

func diffNode(old, cur *opendesignerv1.Node, nameOf func(string) string) []Change {
	a, b := map[string]string{}, map[string]string{}
	flatten("", old.ProtoReflect(), a, nameOf)
	flatten("", cur.ProtoReflect(), b, nameOf)
	keys := make([]string, 0, len(a)+len(b))
	for k := range a {
		keys = append(keys, k)
	}
	for k := range b {
		if _, ok := a[k]; !ok {
			keys = append(keys, k)
		}
	}
	sort.Slice(keys, func(i, j int) bool {
		return propertyRank(keys[i]) < propertyRank(keys[j]) || (propertyRank(keys[i]) == propertyRank(keys[j]) && keys[i] < keys[j])
	})
	var out []Change
	for _, k := range keys {
		if a[k] == b[k] {
			continue
		}
		out = append(out, Change{NodeID: cur.GetId(), NodeName: cur.GetName(), Kind: Changed, Property: k, Before: a[k], After: b[k]})
	}
	return out
}

// propertyRank orders a node's changes the way a developer reads them: geometry first.
func propertyRank(p string) int {
	switch p {
	case "name":
		return 0
	case "parent":
		return 1
	case "x", "y", "width", "height", "rotation":
		return 2
	}
	return 3
}

// flatten writes every populated leaf of m into out under a dotted path. Colours, paints, strokes
// and effects are single leaves with a readable value; a map contributes one leaf per key; the
// shape oneof is entered by name ("text.content", "rect.corner_radius", "frame.auto_layout.spacing").
func flatten(prefix string, m protoreflect.Message, out map[string]string, nameOf func(string) string) {
	m.Range(func(fd protoreflect.FieldDescriptor, v protoreflect.Value) bool {
		name := string(fd.Name())
		if prefix == "" && skipped[name] {
			return true
		}
		path := prefix + name
		if prefix == "" && name == "parent_id" {
			path = "parent"
			out[path] = nameOf(v.String())
			return true
		}
		switch {
		case fd.IsMap():
			v.Map().Range(func(k protoreflect.MapKey, mv protoreflect.Value) bool {
				leaf(path+"."+k.String(), fd.MapValue(), mv, out, nameOf)
				return true
			})
		case fd.IsList():
			l := v.List()
			for i := 0; i < l.Len(); i++ {
				leaf(path+"["+strconv.Itoa(i)+"]", fd, l.Get(i), out, nameOf)
			}
		default:
			leaf(path, fd, v, out, nameOf)
		}
		return true
	})
}

// leaf records one value, entering messages that are not readable as a single value.
func leaf(path string, fd protoreflect.FieldDescriptor, v protoreflect.Value, out map[string]string, nameOf func(string) string) {
	if fd.Kind() != protoreflect.MessageKind && fd.Kind() != protoreflect.GroupKind {
		out[path] = scalar(fd, v)
		return
	}
	msg := v.Message()
	switch m := msg.Interface().(type) {
	case *opendesignerv1.Color:
		out[path] = colorHex(m)
	case *opendesignerv1.Paint:
		out[path] = describePaint(m)
	case *opendesignerv1.Stroke:
		out[path] = describeStroke(m)
	case *opendesignerv1.Effect:
		out[path] = describeEffect(m)
	case *opendesignerv1.VectorNode:
		out[path] = fmt.Sprintf("%d subpath(s), %d anchor(s)", len(m.GetSubpaths()), anchors(m))
	default:
		before := len(out)
		flatten(path+".", msg, out, nameOf)
		if len(out) == before {
			out[path] = "set" // an empty message that is present (e.g. a rect with default radius)
		}
	}
}

func anchors(v *opendesignerv1.VectorNode) int {
	n := 0
	for _, s := range v.GetSubpaths() {
		n += len(s.GetAnchors())
	}
	return n
}

func scalar(fd protoreflect.FieldDescriptor, v protoreflect.Value) string {
	switch fd.Kind() {
	case protoreflect.EnumKind:
		ev := fd.Enum().Values().ByNumber(v.Enum())
		if ev == nil {
			return strconv.Itoa(int(v.Enum()))
		}
		name := string(ev.Name())
		// "LAYOUT_ALIGN_CENTER" -> "center": drop the enum's own prefix.
		prefix := camelToUpperSnake(string(fd.Enum().Name())) + "_"
		return strings.ToLower(strings.TrimPrefix(name, prefix))
	case protoreflect.DoubleKind, protoreflect.FloatKind:
		return strconv.FormatFloat(v.Float(), 'f', -1, 64)
	case protoreflect.BoolKind:
		return strconv.FormatBool(v.Bool())
	case protoreflect.BytesKind:
		return fmt.Sprintf("%d bytes", len(v.Bytes()))
	}
	return v.String()
}

func camelToUpperSnake(s string) string {
	var sb strings.Builder
	for i, r := range s {
		if i > 0 && r >= 'A' && r <= 'Z' {
			sb.WriteByte('_')
		}
		sb.WriteRune(r)
	}
	return strings.ToUpper(sb.String())
}

func colorHex(c *opendesignerv1.Color) string {
	ch := func(v float32) int {
		if v < 0 {
			v = 0
		}
		if v > 1 {
			v = 1
		}
		return int(v*255 + 0.5)
	}
	s := fmt.Sprintf("#%02x%02x%02x", ch(c.GetR()), ch(c.GetG()), ch(c.GetB()))
	if c.GetA() < 0.9995 {
		s += fmt.Sprintf(" @%d%%", int(c.GetA()*100+0.5))
	}
	return s
}

func describePaint(p *opendesignerv1.Paint) string {
	grad := func(kind string, g *opendesignerv1.GradientPaint) string {
		var cols []string
		for _, s := range g.GetStops() {
			cols = append(cols, colorHex(s.GetColor()))
		}
		return fmt.Sprintf("%s %s", kind, strings.Join(cols, " > "))
	}
	switch k := p.GetKind().(type) {
	case *opendesignerv1.Paint_Solid:
		return "solid " + colorHex(k.Solid.GetColor())
	case *opendesignerv1.Paint_Linear:
		return grad("linear", k.Linear)
	case *opendesignerv1.Paint_Radial:
		return grad("radial", k.Radial)
	case *opendesignerv1.Paint_Image:
		h := k.Image.GetAssetHash()
		if len(h) > 8 {
			h = h[:8]
		}
		return "image " + h
	case *opendesignerv1.Paint_Mesh:
		return "mesh"
	}
	return "none"
}

func describeStroke(s *opendesignerv1.Stroke) string {
	al := strings.ToLower(strings.TrimPrefix(s.GetAlign().String(), "STROKE_ALIGN_"))
	if al == "unspecified" {
		al = "center"
	}
	return fmt.Sprintf("%spx %s %s", strconv.FormatFloat(s.GetWeight(), 'f', -1, 64), al, describePaint(s.GetPaint()))
}

func describeEffect(e *opendesignerv1.Effect) string {
	f := func(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }
	switch k := e.GetKind().(type) {
	case *opendesignerv1.Effect_DropShadow:
		s := k.DropShadow
		return fmt.Sprintf("drop shadow %s %s blur %s %s", f(s.GetOffsetX()), f(s.GetOffsetY()), f(s.GetBlur()), colorHex(s.GetColor()))
	case *opendesignerv1.Effect_InnerShadow:
		s := k.InnerShadow
		return fmt.Sprintf("inner shadow %s %s blur %s %s", f(s.GetOffsetX()), f(s.GetOffsetY()), f(s.GetBlur()), colorHex(s.GetColor()))
	case *opendesignerv1.Effect_LayerBlur:
		return "layer blur " + f(k.LayerBlur.GetRadius())
	case *opendesignerv1.Effect_BackgroundBlur:
		return "background blur " + f(k.BackgroundBlur.GetRadius())
	}
	return "effect"
}

// Summary is a one-line description of a change, for logs and the MCP tool.
func (c Change) Summary() string {
	switch c.Kind {
	case Added:
		return fmt.Sprintf("%s: added", c.NodeName)
	case Removed:
		return fmt.Sprintf("%s: removed", c.NodeName)
	}
	show := func(s string) string {
		if s == "" {
			return "(unset)"
		}
		return s
	}
	return fmt.Sprintf("%s: %s %s -> %s", c.NodeName, c.Property, show(c.Before), show(c.After))
}
