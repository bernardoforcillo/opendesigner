package merge

import (
	"sort"

	"google.golang.org/protobuf/proto"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// The document's other collections -- flows, transitions, clips, variables, fonts, text styles,
// component sets -- are merged ENTRY BY ENTRY: an entry added, changed or removed on the branch is
// taken unless the source changed that same entry to something else (a conflict). They are not
// merged field by field because each is one upsert op.

type definition struct {
	entity string
	get    func(d *opendesignerv1.Document) map[string]proto.Message
	set    func(m proto.Message) *opendesignerv1.Op
	del    func(id string) *opendesignerv1.Op
	label  func(m proto.Message) string
}

func msgs[M proto.Message](in map[string]M) map[string]proto.Message {
	out := make(map[string]proto.Message, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

var definitionKinds = []definition{
	{"collection",
		func(d *opendesignerv1.Document) map[string]proto.Message { return msgs(d.GetCollections()) },
		func(m proto.Message) *opendesignerv1.Op {
			return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetCollection{SetCollection: &opendesignerv1.SetCollection{Collection: m.(*opendesignerv1.VariableCollection)}}}
		},
		func(id string) *opendesignerv1.Op {
			return &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteCollection{DeleteCollection: &opendesignerv1.DeleteCollection{Id: id}}}
		},
		func(m proto.Message) string { return m.(*opendesignerv1.VariableCollection).GetName() }},
	{"variable",
		func(d *opendesignerv1.Document) map[string]proto.Message { return msgs(d.GetVariables()) },
		func(m proto.Message) *opendesignerv1.Op {
			return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetVariable{SetVariable: &opendesignerv1.SetVariable{Variable: m.(*opendesignerv1.Variable)}}}
		},
		func(id string) *opendesignerv1.Op {
			return &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteVariable{DeleteVariable: &opendesignerv1.DeleteVariable{Id: id}}}
		},
		func(m proto.Message) string { return m.(*opendesignerv1.Variable).GetName() }},
	{"font",
		func(d *opendesignerv1.Document) map[string]proto.Message { return msgs(d.GetFonts()) },
		func(m proto.Message) *opendesignerv1.Op {
			return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetFont{SetFont: &opendesignerv1.SetFont{Font: m.(*opendesignerv1.FontFace)}}}
		},
		func(id string) *opendesignerv1.Op {
			return &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteFont{DeleteFont: &opendesignerv1.DeleteFont{Id: id}}}
		},
		func(m proto.Message) string { return m.(*opendesignerv1.FontFace).GetFamily() }},
	{"text_style",
		func(d *opendesignerv1.Document) map[string]proto.Message { return msgs(d.GetTextStyles()) },
		func(m proto.Message) *opendesignerv1.Op {
			return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetTextStyleDef{SetTextStyleDef: &opendesignerv1.SetTextStyleDef{TextStyle: m.(*opendesignerv1.TextStyleDef)}}}
		},
		func(id string) *opendesignerv1.Op {
			return &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteTextStyleDef{DeleteTextStyleDef: &opendesignerv1.DeleteTextStyleDef{Id: id}}}
		},
		func(m proto.Message) string { return m.(*opendesignerv1.TextStyleDef).GetName() }},
	{"component_set",
		func(d *opendesignerv1.Document) map[string]proto.Message { return msgs(d.GetComponentSets()) },
		func(m proto.Message) *opendesignerv1.Op {
			return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetComponentSet{SetComponentSet: &opendesignerv1.SetComponentSet{ComponentSet: m.(*opendesignerv1.ComponentSet)}}}
		},
		func(id string) *opendesignerv1.Op {
			return &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteComponentSet{DeleteComponentSet: &opendesignerv1.DeleteComponentSet{Id: id}}}
		},
		func(m proto.Message) string { return m.(*opendesignerv1.ComponentSet).GetName() }},
	{"flow",
		func(d *opendesignerv1.Document) map[string]proto.Message { return msgs(d.GetFlows()) },
		func(m proto.Message) *opendesignerv1.Op {
			return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetFlow{SetFlow: &opendesignerv1.SetFlow{Flow: m.(*opendesignerv1.Flow)}}}
		},
		func(id string) *opendesignerv1.Op {
			return &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteFlow{DeleteFlow: &opendesignerv1.DeleteFlow{Id: id}}}
		},
		func(m proto.Message) string { return m.(*opendesignerv1.Flow).GetName() }},
	{"transition",
		func(d *opendesignerv1.Document) map[string]proto.Message { return msgs(d.GetTransitions()) },
		func(m proto.Message) *opendesignerv1.Op {
			return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetTransition{SetTransition: &opendesignerv1.SetTransition{Transition: m.(*opendesignerv1.Transition)}}}
		},
		func(id string) *opendesignerv1.Op {
			return &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteTransition{DeleteTransition: &opendesignerv1.DeleteTransition{Id: id}}}
		},
		func(m proto.Message) string { return "" }},
	{"clip",
		func(d *opendesignerv1.Document) map[string]proto.Message { return msgs(d.GetClips()) },
		func(m proto.Message) *opendesignerv1.Op {
			return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetClip{SetClip: &opendesignerv1.SetClip{Clip: m.(*opendesignerv1.Clip)}}}
		},
		func(id string) *opendesignerv1.Op {
			return &opendesignerv1.Op{Kind: &opendesignerv1.Op_DeleteClip{DeleteClip: &opendesignerv1.DeleteClip{Id: id}}}
		},
		func(m proto.Message) string { return m.(*opendesignerv1.Clip).GetName() }},
}

func definitions(p *Plan, base, branch, source *opendesignerv1.Document) {
	for _, def := range definitionKinds {
		b0, b1, b2 := def.get(base), def.get(branch), def.get(source)
		seen := map[string]bool{}
		var ids []string
		for _, m := range []map[string]proto.Message{b0, b1} {
			for id := range m {
				if !seen[id] {
					seen[id] = true
					ids = append(ids, id)
				}
			}
		}
		sort.Strings(ids)
		for _, id := range ids {
			vb, vbr, vs := b0[id], b1[id], b2[id]
			label := func(m proto.Message) string {
				if m == nil {
					return ""
				}
				return def.label(m)
			}
			switch {
			case vb == nil && vbr != nil && vs == nil:
				p.add(Change{Entity: def.entity, ID: id, Name: label(vbr), Kind: Added, clean: steps(rankDefinition, def.set(proto.Clone(vbr)))})
			case vb == nil && vbr != nil && vs != nil && !proto.Equal(vbr, vs):
				// Both sides made an entry with the same id and different content.
				p.add(Change{Entity: def.entity, ID: id, Name: label(vbr), Kind: Added, Conflict: true, ConflictPaths: []string{"entry"}, forced: steps(rankDefinition, def.set(proto.Clone(vbr)))})
			case vb != nil && vbr == nil && vs != nil:
				c := Change{Entity: def.entity, ID: id, Name: label(vb), Kind: Removed}
				if proto.Equal(vb, vs) {
					c.clean = steps(rankDelete, def.del(id))
				} else {
					c.Conflict, c.ConflictPaths = true, []string{"entry"}
					c.forced = steps(rankDelete, def.del(id))
				}
				p.add(c)
			case vb != nil && vbr != nil && vs != nil:
				switch decide(vb, vbr, vs) {
				case takeBranch:
					p.add(Change{Entity: def.entity, ID: id, Name: label(vbr), Kind: Changed, clean: steps(rankDefinition, def.set(proto.Clone(vbr)))})
				case conflict:
					p.add(Change{Entity: def.entity, ID: id, Name: label(vbr), Kind: Changed, Conflict: true, ConflictPaths: []string{"entry"}, forced: steps(rankDefinition, def.set(proto.Clone(vbr)))})
				}
			}
		}
	}
}
