package figimport

import (
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/google/uuid"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
)

// VARIABLES of a .fig file. Collections are VARIABLE_SET nodes (variableSetModes lists their modes),
// variables are VARIABLE nodes (variableSetID names the collection, variableResolvedType the type,
// variableDataValues one value per mode). A layer binds a variable by variableConsumptionMap (one
// entry per field) or, for a color, by colorVar on the paint; variableModeBySetMap pins modes. The
// names follow FigCraft's reader (crates/format/src/fig/map.rs, tests.rs): they are the schema's own
// field names, not something this importer made up, but like the rest of the reader they were only
// exercised on generated files.

// Limits of a hostile file: the node limit already bounds the variables, modes are bounded here.
const (
	maxModes      = 256
	maxAliasChain = 32
	// noStyle is the GUID Figma writes for "no reference".
	noStyle = "4294967295:4294967295"
)

type figMode struct{ key, id, name string }

type figColl struct {
	key, id, name string
	modes         []figMode
	modeID        map[string]string // Figma mode key -> our mode id
}

// figVal is one mode's value of a variable: a literal, or an alias of another variable.
type figVal struct {
	alias   string // the aliased variable's key ("" for a literal)
	lost    bool   // an alias of a variable that is not in the file
	literal *opendesignerv1.VariableValue
}

type figVar struct {
	key, id, name string
	coll          *figColl
	typ           opendesignerv1.VariableType
	vals          map[string]*figVal // by Figma mode key
	aliasOf       *figVar            // set when every mode aliases the same variable
	depth         int                // hops along aliasOf to a variable that holds values
}

type varTable struct {
	colls    map[string]*figColl
	vars     map[string]*figVar
	collList []*figColl
	varList  []*figVar
	assets   map[string]map[string]string // asset key -> version -> node key

	skippedType  map[string]int // variables left out, by Figma type
	orphans      int            // variables whose collection is not in the file
	lostValues   int            // values that could not be resolved
	splitAliases int            // variables imported with resolved values because their aliases differ per mode
	lostModes    bool           // a layer pinned a mode of a collection that is not in the file
	unmapped     map[string]int // bindings with no counterpart, by Figma field
}

// ref resolves a VariableID / VariableSetID: its guid, else the file node its asset key (and version)
// names. "" when it names nothing.
func (vt *varTable) ref(v any) string {
	m := asMap(v)
	if m == nil {
		return ""
	}
	if g := asMap(m["guid"]); g != nil {
		if k := guidKey(g); k != noStyle {
			return k
		}
	}
	a := asMap(m["assetRef"])
	versions := vt.assets[asStr(a["key"])]
	if a == nil || versions == nil {
		return ""
	}
	if v, ok := a["version"].(string); ok {
		return versions[v]
	}
	if k, ok := versions[""]; ok {
		return k
	}
	if len(versions) == 1 {
		for _, k := range versions {
			return k
		}
	}
	return ""
}

func (vt *varTable) collRef(v any) *figColl { return vt.colls[vt.ref(v)] }
func (vt *varTable) varRef(v any) *figVar   { return vt.vars[vt.ref(v)] }

func (vt *varTable) unmap(field string) {
	if vt.unmapped == nil {
		vt.unmapped = map[string]int{}
	}
	vt.unmapped[strings.ToLower(strings.ReplaceAll(field, "_", " "))]++
}

// sortKey orders nodes the way the file does: by the position in the parent, or the node's own
// sortPosition, then by key so the order is stable.
func sortKey(n *fnode, own string) string {
	if s := asStr(n.raw[own]); s != "" {
		return s
	}
	return n.position
}

func live(n *fnode) bool { return !boolOf(n.raw, "isSoftDeleted", false) }

// readVariables reads the collections and variables out of every node of the file. They sit on the
// internal page, which the page loop never visits.
func (c *converter) readVariables(all []*fnode) {
	vt := &c.vt
	vt.colls, vt.vars, vt.assets = map[string]*figColl{}, map[string]*figVar{}, map[string]map[string]string{}
	var sets, vars []*fnode
	for _, n := range all {
		t := asStr(n.raw["type"])
		if t != "VARIABLE_SET" && t != "VARIABLE" || !live(n) {
			continue
		}
		if k := asStr(n.raw["key"]); k != "" {
			if vt.assets[k] == nil {
				vt.assets[k] = map[string]string{}
			}
			vt.assets[k][asStr(n.raw["version"])] = n.key
		}
		if t == "VARIABLE_SET" {
			sets = append(sets, n)
		} else {
			vars = append(vars, n)
		}
	}
	byPosition := func(l []*fnode, own string) {
		sort.SliceStable(l, func(i, j int) bool {
			if a, b := sortKey(l[i], own), sortKey(l[j], own); a != b {
				return a < b
			}
			return l[i].key < l[j].key
		})
	}
	byPosition(sets, "")
	byPosition(vars, "sortPosition")

	for _, n := range sets {
		col := &figColl{key: n.key, id: uuid.NewString(), name: asStr(n.raw["name"]), modeID: map[string]string{}}
		if col.name == "" {
			col.name = "Collection"
		}
		type sm struct {
			m   figMode
			pos string
		}
		var ms []sm
		for _, m := range asList(n.raw["variableSetModes"]) {
			mm := asMap(m)
			k := guidKey(mm["id"])
			if mm == nil || k == "" || col.modeID[k] != "" || len(ms) >= maxModes {
				continue
			}
			name := asStr(mm["name"])
			if name == "" {
				name = "Mode"
			}
			id := uuid.NewString()
			col.modeID[k] = id
			ms = append(ms, sm{figMode{k, id, name}, asStr(mm["sortPosition"])})
		}
		sort.SliceStable(ms, func(i, j int) bool { return ms[i].pos < ms[j].pos })
		for _, m := range ms {
			col.modes = append(col.modes, m.m)
		}
		if len(col.modes) == 0 {
			continue // a collection needs a mode
		}
		vt.colls[n.key] = col
		vt.collList = append(vt.collList, col)
	}

	for _, n := range vars {
		col := vt.collRef(n.raw["variableSetID"])
		if col == nil {
			vt.orphans++
			continue
		}
		var typ opendesignerv1.VariableType
		switch asStr(n.raw["variableResolvedType"]) {
		case "COLOR":
			typ = opendesignerv1.VariableType_VARIABLE_TYPE_COLOR
		case "FLOAT":
			typ = opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER
		case "STRING":
			typ = opendesignerv1.VariableType_VARIABLE_TYPE_STRING
		case "BOOLEAN":
			typ = opendesignerv1.VariableType_VARIABLE_TYPE_BOOLEAN
		default:
			if vt.skippedType == nil {
				vt.skippedType = map[string]int{}
			}
			vt.skippedType[strings.ToLower(asStr(n.raw["variableResolvedType"]))]++
			continue
		}
		v := &figVar{key: n.key, id: uuid.NewString(), name: asStr(n.raw["name"]), coll: col, typ: typ, vals: map[string]*figVal{}}
		if v.name == "" {
			v.name = "Variable"
		}
		vt.vars[n.key] = v
		vt.varList = append(vt.varList, v)
	}
	// Values come second: an alias can name a variable that is listed after it.
	for _, n := range vars {
		v := vt.vars[n.key]
		if v == nil {
			continue
		}
		for _, e := range asList(asMap(n.raw["variableDataValues"])["entries"]) {
			em := asMap(e)
			mode := guidKey(em["modeID"])
			if em == nil || v.coll.modeID[mode] == "" {
				continue
			}
			if val := vt.value(v.typ, asMap(em["variableData"])); val != nil {
				v.vals[mode] = val
			}
		}
	}
	vt.linkAliases()
}

// value reads a VariableData of a variable of type `typ`: a literal of that type, or an alias.
func (vt *varTable) value(typ opendesignerv1.VariableType, d map[string]any) *figVal {
	val := asMap(d["value"])
	if val == nil {
		return nil
	}
	if val["alias"] != nil {
		if t := vt.varRef(val["alias"]); t != nil {
			return &figVal{alias: t.key}
		}
		return &figVal{lost: true}
	}
	switch typ {
	case opendesignerv1.VariableType_VARIABLE_TYPE_COLOR:
		if cm := asMap(val["colorValue"]); cm != nil {
			return &figVal{literal: &opendesignerv1.VariableValue{Kind: &opendesignerv1.VariableValue_Color{Color: color(cm, 1)}}}
		}
	case opendesignerv1.VariableType_VARIABLE_TYPE_NUMBER:
		if f, ok := val["floatValue"].(float64); ok && !math.IsNaN(f) && !math.IsInf(f, 0) {
			return &figVal{literal: &opendesignerv1.VariableValue{Kind: &opendesignerv1.VariableValue_Number{Number: f}}}
		}
	case opendesignerv1.VariableType_VARIABLE_TYPE_STRING:
		if s, ok := val["textValue"].(string); ok {
			return &figVal{literal: &opendesignerv1.VariableValue{Kind: &opendesignerv1.VariableValue_Text{Text: s}}}
		}
	case opendesignerv1.VariableType_VARIABLE_TYPE_BOOLEAN:
		if b, ok := val["boolValue"].(bool); ok {
			return &figVal{literal: &opendesignerv1.VariableValue{Kind: &opendesignerv1.VariableValue_Boolean{Boolean: b}}}
		}
	}
	return nil
}

// linkAliases decides which variables stay aliases: those whose every mode aliases the same variable
// of the same type, without a cycle. The editor's alias holds no values of its own, so a variable that
// aliases different variables per mode (or a literal in some modes) is imported with the values its
// aliases resolve to instead.
func (vt *varTable) linkAliases() {
	for _, v := range vt.varList {
		if len(v.vals) == 0 {
			continue
		}
		var target *figVar
		ok := true
		for _, val := range v.vals {
			t := vt.vars[val.alias]
			if val.alias == "" || t == nil || t == v || t.typ != v.typ || (target != nil && target != t) {
				ok = false
				break
			}
			target = t
		}
		if ok {
			v.aliasOf = target
		}
	}
	// Each chain is walked once. A cycle is broken where the walk comes back to itself, and a chain
	// longer than the document follows (core.maxAliasDepth) is cut: those variables keep resolved values.
	done := map[*figVar]bool{}
	for _, start := range vt.varList {
		var path []*figVar
		onPath := map[*figVar]bool{}
		for cur := start; cur != nil && !done[cur] && !onPath[cur]; cur = cur.aliasOf {
			path = append(path, cur)
			onPath[cur] = true
		}
		if len(path) == 0 {
			continue
		}
		if last := path[len(path)-1]; last.aliasOf != nil && onPath[last.aliasOf] {
			last.aliasOf = nil
		}
		for i := len(path) - 1; i >= 0; i-- {
			v := path[i]
			if v.aliasOf != nil {
				v.depth = v.aliasOf.depth + 1
				if v.depth > maxAliasChain-2 {
					v.aliasOf, v.depth = nil, 0
				}
			}
			done[v] = true
		}
	}
	for _, v := range vt.varList {
		if v.aliasOf != nil {
			continue
		}
		for _, val := range v.vals {
			if val.alias != "" || val.lost {
				vt.splitAliases++
				break
			}
		}
	}
}

// resolve is the literal a variable has in a Figma mode: its own value, else its default mode's; an
// alias is followed, in the same mode when the target's collection has it, else in the target's default.
func (vt *varTable) resolve(v *figVar, mode string, depth int) *opendesignerv1.VariableValue {
	if depth > maxAliasChain {
		return nil
	}
	val := v.vals[mode]
	if val == nil {
		val = v.vals[v.coll.modes[0].key]
	}
	switch {
	case val == nil || val.lost:
		return nil
	case val.alias == "":
		return val.literal
	}
	t := vt.vars[val.alias]
	if t == nil || t.typ != v.typ {
		return nil
	}
	if t.coll.modeID[mode] == "" {
		mode = t.coll.modes[0].key
	}
	return vt.resolve(t, mode, depth+1)
}

// output builds the collections and the variables, the targets of aliases before the aliases.
func (vt *varTable) output() ([]*opendesignerv1.VariableCollection, []*opendesignerv1.Variable) {
	var cols []*opendesignerv1.VariableCollection
	for _, col := range vt.collList {
		pc := &opendesignerv1.VariableCollection{Id: col.id, Name: col.name}
		for _, m := range col.modes {
			pc.Modes = append(pc.Modes, &opendesignerv1.VariableMode{Id: m.id, Name: m.name})
		}
		cols = append(cols, pc)
	}
	ordered := append([]*figVar(nil), vt.varList...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].depth < ordered[j].depth })
	var out []*opendesignerv1.Variable
	for _, v := range ordered {
		pv := &opendesignerv1.Variable{Id: v.id, CollectionId: v.coll.id, Name: v.name, Type: v.typ}
		if v.aliasOf != nil {
			pv.AliasOf = v.aliasOf.id
		} else {
			pv.Values = map[string]*opendesignerv1.VariableValue{}
			for _, m := range v.coll.modes {
				if _, has := v.vals[m.key]; !has {
					continue
				}
				if lit := vt.resolve(v, m.key, 0); lit != nil {
					pv.Values[m.id] = lit
				} else {
					vt.lostValues++
				}
			}
		}
		out = append(out, pv)
	}
	return cols, out
}

// warnings is what the variables could not carry over; the import report shows it.
func (vt *varTable) warnings() []string {
	var w []string
	if vt.orphans > 0 {
		w = append(w, fmt.Sprintf("%d variables belong to collections that are not in the file (library variables) and were left out", vt.orphans))
	}
	if len(vt.skippedType) > 0 {
		var kinds []string
		n := 0
		for k, c := range vt.skippedType {
			kinds = append(kinds, k)
			n += c
		}
		sort.Strings(kinds)
		w = append(w, fmt.Sprintf("%d variables of a type this editor has no counterpart for (%s) were left out", n, strings.Join(kinds, ", ")))
	}
	if vt.splitAliases > 0 {
		w = append(w, fmt.Sprintf("%d variables alias other variables in only some modes or to different ones per mode: they were imported with the values they resolve to", vt.splitAliases))
	}
	if vt.lostValues > 0 {
		w = append(w, fmt.Sprintf("%d variable values could not be resolved (an alias to a variable that is not in the file, or a cycle) and were left out", vt.lostValues))
	}
	if vt.lostModes {
		w = append(w, "variable modes of collections that aren't in the file were skipped")
	}
	if len(vt.unmapped) > 0 {
		var fields []string
		n := 0
		for f, c := range vt.unmapped {
			fields = append(fields, fmt.Sprintf("%s x%d", f, c))
			n += c
		}
		sort.Strings(fields)
		w = append(w, fmt.Sprintf("%d variable bindings were not imported (%s): the layers keep the values they show", n, strings.Join(fields, ", ")))
	}
	return w
}

// bindField maps a Figma variableField to the binding key it becomes, with whether the layer can take
// it. "" means the field has no counterpart.
func bindField(n *opendesignerv1.Node, field string) (key string, ok bool) {
	al := n.GetFrame().GetAutoLayout() != nil
	switch field {
	case "OPACITY":
		return "opacity", true
	case "VISIBLE":
		return "visible", true
	case "CORNER_RADIUS":
		return "corner_radius", n.GetRect() != nil
	case "FONT_SIZE":
		return "font_size", n.GetText() != nil
	case "TEXT_DATA":
		return "text", n.GetText() != nil
	case "STACK_SPACING":
		return "spacing", al
	case "STACK_COUNTER_SPACING":
		return "cross_spacing", al
	case "STACK_PADDING_LEFT":
		return "padding_left", al
	case "STACK_PADDING_TOP":
		return "padding_top", al
	case "STACK_PADDING_RIGHT":
		return "padding_right", al
	case "STACK_PADDING_BOTTOM":
		return "padding_bottom", al
	}
	return "", false
}

// bindLayer carries a layer's variable bindings and pinned modes onto `n`. fillSrc / strokeSrc are the
// indexes the layer's kept paints had in the file. What has no counterpart stays a literal (the node
// already holds the value the layer shows) and is counted for the report.
func (c *converter) bindLayer(n *opendesignerv1.Node, raw map[string]any, fillSrc, strokeSrc []int) {
	vt := &c.vt
	bind := func(key string, v *figVar) bool {
		if want, ok := core.BindingType(key); !ok || v == nil || v.typ != want {
			return false
		}
		if n.Bindings == nil {
			n.Bindings = map[string]string{}
		}
		n.Bindings[key] = v.id
		return true
	}
	miss := func(field string) {
		vt.unmap(field)
	}

	// Paint colors: colorVar on a solid paint. fills.N / strokes.N index the paints that were kept.
	paintVars := func(list any, src []int, kept int, prefix string) {
		if len(src) != kept {
			src = nil
		}
		for i, p := range asList(list) {
			pm := asMap(p)
			if pm == nil {
				continue
			}
			bound := asMap(asMap(pm["colorVar"])["value"])["alias"]
			hasStops := false
			for _, s := range asList(pm["stopsVar"]) {
				if asMap(asMap(asMap(s)["colorVar"])["value"])["alias"] != nil {
					hasStops = true
				}
			}
			if hasStops {
				miss("gradient stop color")
			}
			if bound == nil {
				continue
			}
			at := -1
			for k, s := range src {
				if s == i {
					at = k
				}
			}
			if at < 0 {
				continue // the paint was hidden or left out: nothing to bind
			}
			var solid bool
			if prefix == "fills" {
				solid = n.Fills[at].GetSolid() != nil
			} else {
				solid = n.Strokes[at].GetPaint().GetSolid() != nil
			}
			if !solid || !bind(fmt.Sprintf("%s.%d", prefix, at), vt.varRef(bound)) {
				miss(prefix + " color")
			}
		}
	}
	paintVars(raw["fillPaints"], fillSrc, len(n.Fills), "fills")
	paintVars(raw["strokePaints"], strokeSrc, len(n.Strokes), "strokes")

	for _, e := range asList(asMap(raw["variableConsumptionMap"])["entries"]) {
		em := asMap(e)
		if em == nil {
			continue
		}
		field := asStr(em["variableField"])
		d := asMap(em["variableData"])
		if asStr(d["dataType"]) != "ALIAS" && asMap(d["value"])["alias"] == nil {
			continue // a literal, nothing is bound
		}
		v := vt.varRef(asMap(d["value"])["alias"])
		switch field {
		case "STROKE_WEIGHT":
			ok := len(n.Strokes) > 0
			for i := range n.Strokes {
				ok = bind(fmt.Sprintf("strokes.%d.weight", i), v) && ok
			}
			if !ok {
				miss(field)
			}
		default:
			if key, can := bindField(n, field); !can || !bind(key, v) {
				miss(field)
			}
		}
	}

	for _, e := range asList(asMap(raw["variableModeBySetMap"])["entries"]) {
		em := asMap(e)
		set := asMap(em["variableSetID"])
		if em == nil || set == nil {
			continue
		}
		col := vt.collRef(set)
		if col == nil {
			if set["guid"] != nil || set["assetRef"] != nil {
				vt.lostModes = true
			}
			continue
		}
		if id := col.modeID[guidKey(em["variableModeID"])]; id != "" {
			if n.Modes == nil {
				n.Modes = map[string]string{}
			}
			n.Modes[col.id] = id
		}
	}
}
