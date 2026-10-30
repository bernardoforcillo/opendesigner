// Package library implements SHARED LIBRARIES across documents: what a document offers when it is
// published as a library (Items), and the ops that bring a chosen part of it into another document
// (BuildImport). It works on plain Documents: the server owns the I/O (which hub, which assets).
//
// Importing COPIES. The items (and what they depend on) are written into the importing document as
// ordinary ops, so the copy is editable, undoable and shared with every collaborator. Items keep their
// ids: importing again updates styles, variables, component sets and fonts in place, and leaves a
// component that is already there alone (its masters may have been edited since).
package library

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

var (
	// ErrNoItems: nothing was asked for.
	ErrNoItems = errors.New("library: no items to import")
	// ErrItemNotFound: the library has no such item.
	ErrItemNotFound = errors.New("library: item not found")
	// ErrComponentCycle: components that contain each other cannot be created in any order.
	ErrComponentCycle = errors.New("library: components contain each other")
)

type kind = opendesignerv1.LibraryItemKind

const (
	kComponent = opendesignerv1.LibraryItemKind_LIBRARY_ITEM_KIND_COMPONENT
	kText      = opendesignerv1.LibraryItemKind_LIBRARY_ITEM_KIND_TEXT_STYLE
	kPaint     = opendesignerv1.LibraryItemKind_LIBRARY_ITEM_KIND_PAINT_STYLE
	kEffect    = opendesignerv1.LibraryItemKind_LIBRARY_ITEM_KIND_EFFECT_STYLE
	kObject    = opendesignerv1.LibraryItemKind_LIBRARY_ITEM_KIND_OBJECT_STYLE
	kCollect   = opendesignerv1.LibraryItemKind_LIBRARY_ITEM_KIND_COLLECTION
)

// groupOf is the folder of a "a/b/name" name: everything before the last "/".
func groupOf(name string) string {
	if i := strings.LastIndex(name, "/"); i > 0 {
		return name[:i]
	}
	return ""
}

func item(k kind, id, name string) *opendesignerv1.LibraryItem {
	return &opendesignerv1.LibraryItem{Kind: k, Id: id, Name: name, Group: groupOf(name)}
}

// Items lists what doc offers as a library: its components, styles and variable collections, sorted by
// kind, then name, then id. Character styles are listed with the text styles.
func Items(doc *opendesignerv1.Document) []*opendesignerv1.LibraryItem {
	var out []*opendesignerv1.LibraryItem
	for id, c := range doc.GetComponents() {
		out = append(out, item(kComponent, id, c.GetName()))
	}
	for id, s := range doc.GetTextStyles() {
		out = append(out, item(kText, id, s.GetName()))
	}
	for id, s := range doc.GetPaintStyles() {
		out = append(out, item(kPaint, id, s.GetName()))
	}
	for id, s := range doc.GetEffectStyles() {
		out = append(out, item(kEffect, id, s.GetName()))
	}
	for id, s := range doc.GetObjectStyles() {
		out = append(out, item(kObject, id, s.GetName()))
	}
	for id, c := range doc.GetCollections() {
		out = append(out, item(kCollect, id, c.GetName()))
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		if a.Name != b.Name {
			return a.Name < b.Name
		}
		return a.Id < b.Id
	})
	return out
}

// Plan is what an import does: the ops to apply, in order, and the assets (by hash) to copy first.
type Plan struct {
	Ops      []*opendesignerv1.Op
	Imported []*opendesignerv1.LibraryItem
	Skipped  []*opendesignerv1.LibraryItem
	PageID   string   // the page that holds the imported masters ("" when none)
	Assets   []string // sha256 hex of the images and font files the items use, sorted
}

// BuildImport plans the import of `want` from src (the library, named libName, with document id libDocID)
// into dst. dst is not modified. The ops are checked against a copy of dst, so a plan that is returned
// applies cleanly (given that the assets were copied).
func BuildImport(src, dst *opendesignerv1.Document, libDocID string, want []*opendesignerv1.LibraryItem) (*Plan, error) {
	if len(want) == 0 {
		return nil, ErrNoItems
	}
	b := &builder{
		src: src, dst: dst,
		comps: map[string]bool{}, texts: map[string]bool{}, paints: map[string]bool{}, effects: map[string]bool{},
		objects: map[string]bool{}, cols: map[string]bool{}, vars: map[string]bool{}, fonts: map[string]bool{},
		sets: map[string]bool{}, assets: map[string]bool{}, skipped: map[string]bool{},
	}
	for _, w := range want {
		if err := b.seed(w); err != nil {
			return nil, err
		}
	}
	plan := &Plan{}
	if err := b.emit(plan, libDocID); err != nil {
		return nil, err
	}
	// Dry run on a copy: a plan that cannot apply must fail before anything is written.
	probe := proto.Clone(dst).(*opendesignerv1.Document)
	for i, op := range plan.Ops {
		if err := core.Apply(probe, op); err != nil {
			return nil, fmt.Errorf("library: import step %d: %w", i+1, err)
		}
	}
	for h := range b.assets {
		plan.Assets = append(plan.Assets, h)
	}
	sort.Strings(plan.Assets)
	return plan, nil
}

type builder struct {
	src, dst *opendesignerv1.Document

	comps, texts, paints, effects, objects, cols, vars, fonts, sets, assets map[string]bool
	skipped                                                                 map[string]bool
}

func (b *builder) seed(w *opendesignerv1.LibraryItem) error {
	id := w.GetId()
	missing := func() error { return fmt.Errorf("%w: %s %q", ErrItemNotFound, w.GetKind(), id) }
	switch w.GetKind() {
	case kComponent:
		if b.src.GetComponents()[id] == nil {
			return missing()
		}
		b.addComp(id)
	case kText:
		if b.src.GetTextStyles()[id] == nil {
			return missing()
		}
		b.addText(id)
	case kPaint:
		if b.src.GetPaintStyles()[id] == nil {
			return missing()
		}
		b.addPaint(id)
	case kEffect:
		if b.src.GetEffectStyles()[id] == nil {
			return missing()
		}
		b.addEffect(id)
	case kObject:
		if b.src.GetObjectStyles()[id] == nil {
			return missing()
		}
		b.addObject(id)
	case kCollect:
		if b.src.GetCollections()[id] == nil {
			return missing()
		}
		b.addCollection(id)
	default:
		return fmt.Errorf("%w: unknown kind %v", ErrItemNotFound, w.GetKind())
	}
	return nil
}

// scan walks every string field named asset_hash or variable_id in m, whatever message holds it: image
// nodes, image paints, font faces, gradient stops and effects all point at assets and variables that way.
func (b *builder) scan(m protoreflect.Message) {
	m.Range(func(fd protoreflect.FieldDescriptor, v protoreflect.Value) bool {
		switch {
		case fd.IsMap():
			if fd.MapValue().Message() != nil {
				v.Map().Range(func(_ protoreflect.MapKey, mv protoreflect.Value) bool { b.scan(mv.Message()); return true })
			}
		case fd.Kind() == protoreflect.MessageKind && fd.IsList():
			for i := 0; i < v.List().Len(); i++ {
				b.scan(v.List().Get(i).Message())
			}
		case fd.Kind() == protoreflect.MessageKind:
			b.scan(v.Message())
		case fd.Kind() == protoreflect.StringKind && !fd.IsList() && !fd.IsMap():
			switch string(fd.Name()) {
			case "asset_hash":
				if v.String() != "" {
					b.assets[v.String()] = true
				}
			case "variable_id":
				if v.String() != "" {
					b.addVar(v.String())
				}
			}
		}
		return true
	})
}

func (b *builder) addComp(id string) {
	if b.comps[id] || b.skipped[id] {
		return
	}
	c := b.src.GetComponents()[id]
	if c == nil {
		return // a dangling reference in the library: the dry run reports it
	}
	if b.dst.GetComponents()[id] != nil {
		b.skipped[id] = true
		return
	}
	b.comps[id] = true
	if c.GetSetId() != "" {
		b.sets[c.GetSetId()] = true
		for other, oc := range b.src.GetComponents() {
			if oc.GetSetId() == c.GetSetId() {
				b.addComp(other)
			}
		}
	}
	for _, p := range c.GetProperties() {
		if p.GetType() == opendesignerv1.ComponentPropertyType_COMPONENT_PROPERTY_TYPE_INSTANCE_SWAP && p.GetDefaultValue() != "" {
			b.addComp(p.GetDefaultValue())
		}
	}
	for _, n := range core.SubtreeOf(b.src, c.GetRootNodeId()) {
		b.nodeDeps(n)
	}
}

func (b *builder) nodeDeps(n *opendesignerv1.Node) {
	b.scan(n.ProtoReflect())
	if n.GetTextStyleId() != "" {
		b.addText(n.GetTextStyleId())
	}
	if n.GetObjectStyleId() != "" {
		b.addObject(n.GetObjectStyleId())
	}
	if n.GetFillStyleId() != "" {
		b.addPaint(n.GetFillStyleId())
	}
	if n.GetStrokeStyleId() != "" {
		b.addPaint(n.GetStrokeStyleId())
	}
	if n.GetEffectStyleId() != "" {
		b.addEffect(n.GetEffectStyleId())
	}
	for _, v := range n.GetBindings() {
		b.addVar(v)
	}
	for col := range n.GetModes() {
		b.addCollection(col)
	}
	if t := n.GetText(); t != nil {
		for _, r := range t.GetRuns() {
			if r.GetStyleId() != "" {
				b.addText(r.GetStyleId())
			}
		}
	}
	if inst := n.GetInstance(); inst != nil {
		b.addComp(inst.GetComponentId())
	}
}

func (b *builder) addText(id string) {
	if b.texts[id] {
		return
	}
	s := b.src.GetTextStyles()[id]
	if s == nil {
		return
	}
	b.texts[id] = true
	if s.GetBasedOn() != "" {
		b.addText(s.GetBasedOn())
	}
	if s.GetNextStyleId() != "" {
		b.addText(s.GetNextStyleId())
	}
	for _, ns := range s.GetNestedStyles() {
		if ns.GetStyleId() != "" {
			b.addText(ns.GetStyleId())
		}
	}
	b.scan(s.ProtoReflect())
	// The uploaded font files the style draws with: every face of the family it names.
	for _, fam := range strings.Split(s.GetStyle().GetFontFamily(), ",") {
		fam = strings.Trim(strings.TrimSpace(fam), `"'`)
		if fam == "" {
			continue
		}
		for fid, f := range b.src.GetFonts() {
			if f.GetFamily() == fam {
				b.fonts[fid] = true
				b.scan(f.ProtoReflect())
			}
		}
	}
}

func (b *builder) addPaint(id string) {
	if b.paints[id] {
		return
	}
	if s := b.src.GetPaintStyles()[id]; s != nil {
		b.paints[id] = true
		b.scan(s.ProtoReflect())
	}
}

func (b *builder) addEffect(id string) {
	if b.effects[id] {
		return
	}
	if s := b.src.GetEffectStyles()[id]; s != nil {
		b.effects[id] = true
		b.scan(s.ProtoReflect())
	}
}

func (b *builder) addObject(id string) {
	if b.objects[id] {
		return
	}
	s := b.src.GetObjectStyles()[id]
	if s == nil {
		return
	}
	b.objects[id] = true
	b.scan(s.ProtoReflect())
	if s.GetBasedOn() != "" {
		b.addObject(s.GetBasedOn())
	}
}

// addCollection takes a whole collection: its modes and every variable in it.
func (b *builder) addCollection(id string) {
	if b.cols[id] {
		return
	}
	if b.src.GetCollections()[id] == nil {
		return
	}
	b.cols[id] = true
	for vid, v := range b.src.GetVariables() {
		if v.GetCollectionId() == id {
			b.addVar(vid)
		}
	}
}

func (b *builder) addVar(id string) {
	if b.vars[id] {
		return
	}
	v := b.src.GetVariables()[id]
	if v == nil {
		return
	}
	b.vars[id] = true
	b.addCollection(v.GetCollectionId())
	if v.GetAliasOf() != "" {
		b.addVar(v.GetAliasOf())
	}
	if v.GetTintOf() != "" {
		b.addVar(v.GetTintOf())
	}
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func (b *builder) emit(plan *Plan, libDocID string) error {
	var ops []*opendesignerv1.Op
	add := func(o *opendesignerv1.Op) { o.OpId = uuid.NewString(); ops = append(ops, o) }
	note := func(k kind, id, name string) {
		plan.Imported = append(plan.Imported, item(k, id, name))
	}

	// Variables: collections, then variables with what they alias (or are a tint of) first.
	for _, id := range sortedKeys(b.cols) {
		c := b.src.GetCollections()[id]
		add(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetCollection{SetCollection: &opendesignerv1.SetCollection{Collection: proto.Clone(c).(*opendesignerv1.VariableCollection)}}})
		note(kCollect, id, c.GetName())
	}
	done := map[string]bool{}
	var putVar func(id string)
	putVar = func(id string) {
		if done[id] || !b.vars[id] {
			return
		}
		done[id] = true
		v := b.src.GetVariables()[id]
		putVar(v.GetAliasOf())
		putVar(v.GetTintOf())
		add(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetVariable{SetVariable: &opendesignerv1.SetVariable{Variable: proto.Clone(v).(*opendesignerv1.Variable)}}})
	}
	for _, id := range sortedKeys(b.vars) {
		putVar(id)
	}

	// Fonts and styles.
	for _, id := range sortedKeys(b.fonts) {
		add(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetFont{SetFont: &opendesignerv1.SetFont{Font: proto.Clone(b.src.GetFonts()[id]).(*opendesignerv1.FontFace)}}})
	}
	// Text styles: based_on first; next_style_id may point around in a circle, so the first write of a
	// style leaves it out and a second write puts it back once every style exists.
	done = map[string]bool{}
	var putText func(id string)
	putText = func(id string) {
		if done[id] || !b.texts[id] {
			return
		}
		done[id] = true
		s := b.src.GetTextStyles()[id]
		putText(s.GetBasedOn())
		first := proto.Clone(s).(*opendesignerv1.TextStyleDef)
		if first.NextStyleId != id {
			first.NextStyleId = ""
		}
		add(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetTextStyleDef{SetTextStyleDef: &opendesignerv1.SetTextStyleDef{TextStyle: first}}})
		note(kText, id, s.GetName())
	}
	for _, id := range sortedKeys(b.texts) {
		putText(id)
	}
	for _, id := range sortedKeys(b.texts) {
		if s := b.src.GetTextStyles()[id]; s.GetNextStyleId() != "" && s.GetNextStyleId() != id {
			add(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetTextStyleDef{SetTextStyleDef: &opendesignerv1.SetTextStyleDef{TextStyle: proto.Clone(s).(*opendesignerv1.TextStyleDef)}}})
		}
	}
	for _, id := range sortedKeys(b.paints) {
		s := b.src.GetPaintStyles()[id]
		add(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetPaintStyleDef{SetPaintStyleDef: &opendesignerv1.SetPaintStyleDef{PaintStyle: proto.Clone(s).(*opendesignerv1.PaintStyleDef)}}})
		note(kPaint, id, s.GetName())
	}
	for _, id := range sortedKeys(b.effects) {
		s := b.src.GetEffectStyles()[id]
		add(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetEffectStyleDef{SetEffectStyleDef: &opendesignerv1.SetEffectStyleDef{EffectStyle: proto.Clone(s).(*opendesignerv1.EffectStyleDef)}}})
		note(kEffect, id, s.GetName())
	}
	done = map[string]bool{}
	var putObject func(id string)
	putObject = func(id string) {
		if done[id] || !b.objects[id] {
			return
		}
		done[id] = true
		s := b.src.GetObjectStyles()[id]
		putObject(s.GetBasedOn())
		add(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetObjectStyleDef{SetObjectStyleDef: &opendesignerv1.SetObjectStyleDef{ObjectStyle: proto.Clone(s).(*opendesignerv1.ObjectStyleDef)}}})
		note(kObject, id, s.GetName())
	}
	for _, id := range sortedKeys(b.objects) {
		putObject(id)
	}

	// Components: the masters go on one page per library, found again by a stable id.
	order, err := b.componentOrder()
	if err != nil {
		return err
	}
	for id := range b.skipped {
		plan.Skipped = append(plan.Skipped, item(kComponent, id, b.src.GetComponents()[id].GetName()))
	}
	sort.Slice(plan.Skipped, func(i, j int) bool { return plan.Skipped[i].Id < plan.Skipped[j].Id })
	if len(order) > 0 {
		pageID := uuid.NewSHA1(uuid.NameSpaceOID, []byte("opendesigner-library:"+libDocID)).String()
		plan.PageID = pageID
		cursor, last := 0.0, ""
		havePage := false
		for _, p := range b.dst.GetPages() {
			if p.GetId() == pageID {
				havePage = true
			}
		}
		if havePage {
			for _, n := range core.ChildrenOf(b.dst, pageID) {
				if r := n.GetX() + n.GetWidth(); r > cursor {
					cursor = r
				}
				last = n.GetOrderKey()
			}
			if cursor > 0 {
				cursor += gap
			}
		} else {
			name := b.src.GetName()
			if name == "" {
				name = "Library"
			}
			add(&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreatePage{CreatePage: &opendesignerv1.CreatePage{Page: &opendesignerv1.Page{Id: pageID, Name: name}}}})
		}
		// New node ids: kept, unless another node of dst already has the id.
		remap := map[string]string{}
		for _, id := range order {
			for _, n := range core.SubtreeOf(b.src, b.src.GetComponents()[id].GetRootNodeId()) {
				if _, taken := b.dst.GetNodes()[n.GetId()]; taken {
					remap[n.GetId()] = uuid.NewString()
				}
			}
		}
		mapped := func(id string) string {
			if r, ok := remap[id]; ok {
				return r
			}
			return id
		}
		for _, id := range order {
			c := b.src.GetComponents()[id]
			for _, n := range core.SubtreeOf(b.src, c.GetRootNodeId()) {
				cp := proto.Clone(n).(*opendesignerv1.Node)
				cp.Id = mapped(n.GetId())
				if n.GetId() == c.GetRootNodeId() {
					cp.ParentId = pageID
					cp.X, cp.Y = cursor, 0
					cursor += n.GetWidth() + gap
					key, err := core.OrderKeyBetween(last, "")
					if err != nil {
						return err
					}
					cp.OrderKey, last = key, key
				} else {
					cp.ParentId = mapped(n.GetParentId())
				}
				if next, ok := cp.GetMeta()["text.next"]; ok {
					cp.Meta["text.next"] = mapped(next)
				}
				if inst := cp.GetInstance(); inst != nil {
					for _, ov := range inst.GetOverrides() {
						ov.MasterNodeId = mapped(ov.GetMasterNodeId())
					}
				}
				add(&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: cp}}})
			}
			add(&opendesignerv1.Op{Kind: &opendesignerv1.Op_CreateComponent{CreateComponent: &opendesignerv1.CreateComponent{
				ComponentId: id, RootNodeId: mapped(c.GetRootNodeId()), Name: c.GetName()}}})
			note(kComponent, id, c.GetName())
		}
		for _, sid := range sortedKeys(b.sets) {
			if set := b.src.GetComponentSets()[sid]; set != nil {
				add(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComponentSet{SetComponentSet: &opendesignerv1.SetComponentSet{ComponentSet: proto.Clone(set).(*opendesignerv1.ComponentSet)}}})
			}
		}
		for _, id := range order {
			c := b.src.GetComponents()[id]
			if c.GetSetId() == "" && len(c.GetProperties()) == 0 {
				continue
			}
			def := &opendesignerv1.SetComponentDef{ComponentId: id, SetId: c.GetSetId(), Variant: c.GetVariant()}
			for _, p := range c.GetProperties() {
				p = proto.Clone(p).(*opendesignerv1.ComponentProperty)
				for i, t := range p.TargetNodeIds {
					p.TargetNodeIds[i] = mapped(t)
				}
				def.Properties = append(def.Properties, p)
			}
			add(&opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComponentDef{SetComponentDef: def}})
		}
	}
	for _, o := range ops {
		o.DocId = b.dst.GetId()
	}
	plan.Ops = ops
	return nil
}

const gap = 40

// componentOrder sorts the components to import so that one that an instance inside another one refers
// to comes first (an instance needs its component to exist when it is created).
func (b *builder) componentOrder() ([]string, error) {
	var out []string
	state := map[string]int{} // 1 = visiting, 2 = done
	var visit func(id string) error
	visit = func(id string) error {
		if !b.comps[id] || state[id] == 2 {
			return nil
		}
		if state[id] == 1 {
			return fmt.Errorf("%w: %s", ErrComponentCycle, id)
		}
		state[id] = 1
		for _, n := range core.SubtreeOf(b.src, b.src.GetComponents()[id].GetRootNodeId()) {
			if inst := n.GetInstance(); inst != nil {
				if err := visit(inst.GetComponentId()); err != nil {
					return err
				}
			}
		}
		state[id] = 2
		out = append(out, id)
		return nil
	}
	for _, id := range sortedKeys(b.comps) {
		if err := visit(id); err != nil {
			return nil, err
		}
	}
	return out, nil
}
