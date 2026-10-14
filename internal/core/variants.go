package core

import (
	"errors"
	"fmt"
	"sort"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
)

// COMPONENT VARIANTS. A ComponentSet names properties and their allowed values; each
// member Component carries one full combination (Component.variant). An
// instance "switches variant" by being pointed at another member (SwapInstance).
// web/src/store/variants.ts mirrors the rules; this file is the authority.

var (
	ErrBadVariant  = errors.New("core: invalid variant")
	ErrSetNotFound = errors.New("core: component set not found")
	ErrBadSwap     = errors.New("core: cannot swap this instance")
	ErrNilSet      = errors.New("core: nil component set")
)

// validateSetShape checks the property list on its own: non-empty unique names,
// each with at least one non-empty unique value.
func validateSetShape(set *opendesignerv1.ComponentSet) error {
	if set == nil || set.GetId() == "" || set.GetName() == "" {
		return ErrNilSet
	}
	names := map[string]bool{}
	for _, p := range set.GetProperties() {
		if p.GetName() == "" || names[p.GetName()] {
			return fmt.Errorf("%w: empty or duplicate property %q in set %s", ErrBadVariant, p.GetName(), set.GetId())
		}
		names[p.GetName()] = true
		if len(p.GetValues()) == 0 {
			return fmt.Errorf("%w: property %q has no values", ErrBadVariant, p.GetName())
		}
		seen := map[string]bool{}
		for _, v := range p.GetValues() {
			if v == "" || seen[v] {
				return fmt.Errorf("%w: property %q has an empty or duplicate value %q", ErrBadVariant, p.GetName(), v)
			}
			seen[v] = true
		}
	}
	return nil
}

// validCombination: the variant names every property of the set exactly once,
// with an allowed value, and nothing else.
func validCombination(set *opendesignerv1.ComponentSet, variant map[string]string) error {
	if len(variant) != len(set.GetProperties()) {
		return fmt.Errorf("%w: set %s has %d properties, the variant gives %d", ErrBadVariant, set.GetId(), len(set.GetProperties()), len(variant))
	}
	for _, p := range set.GetProperties() {
		val, ok := variant[p.GetName()]
		if !ok {
			return fmt.Errorf("%w: no value for property %q", ErrBadVariant, p.GetName())
		}
		allowed := false
		for _, v := range p.GetValues() {
			allowed = allowed || v == val
		}
		if !allowed {
			return fmt.Errorf("%w: %q is not a value of %q", ErrBadVariant, val, p.GetName())
		}
	}
	return nil
}

func sameCombination(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

// migrateVariant maps a member's combination onto a changed set: properties that
// no longer exist are dropped, a value that is no longer allowed (or a property
// the member never had) becomes the property's FIRST value. Deterministic, so the
// client computes the same result.
func migrateVariant(set *opendesignerv1.ComponentSet, variant map[string]string) map[string]string {
	out := make(map[string]string, len(set.GetProperties()))
	for _, p := range set.GetProperties() {
		val := p.GetValues()[0]
		for _, v := range p.GetValues() {
			if v == variant[p.GetName()] {
				val = v
			}
		}
		out[p.GetName()] = val
	}
	return out
}

// applySetComponentSet upserts a set. Members are migrated onto the new
// properties (see migrateVariant), so adding a property or a value never
// strands them; the op is refused if the migration would make two members the
// same combination (it would silently merge variants).
func applySetComponentSet(doc *opendesignerv1.Document, s *opendesignerv1.SetComponentSet) error {
	set := s.GetSet()
	if err := validateSetShape(set); err != nil {
		return err
	}
	migrated := map[string]map[string]string{}
	var ids []string
	for id, c := range doc.GetComponents() {
		if c.GetSetId() == set.GetId() {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	for i, id := range ids {
		m := migrateVariant(set, doc.GetComponents()[id].GetVariant())
		for _, other := range ids[:i] {
			if sameCombination(migrated[other], m) {
				return fmt.Errorf("%w: components %s and %s would become the same variant", ErrBadVariant, other, id)
			}
		}
		migrated[id] = m
	}
	for id, m := range migrated {
		doc.Components[id].Variant = m
	}
	if doc.ComponentSets == nil {
		doc.ComponentSets = map[string]*opendesignerv1.ComponentSet{}
	}
	doc.ComponentSets[set.GetId()] = set
	return nil
}

func applyDeleteComponentSet(doc *opendesignerv1.Document, d *opendesignerv1.DeleteComponentSet) error {
	if _, ok := doc.GetComponentSets()[d.GetId()]; !ok {
		return fmt.Errorf("%w: %s", ErrSetNotFound, d.GetId())
	}
	delete(doc.ComponentSets, d.GetId())
	for _, c := range doc.GetComponents() {
		if c.GetSetId() == d.GetId() {
			c.SetId, c.Variant = "", nil
		}
	}
	return nil
}

func applySetComponentVariant(doc *opendesignerv1.Document, s *opendesignerv1.SetComponentVariant) error {
	c := doc.GetComponents()[s.GetComponentId()]
	if c == nil {
		return fmt.Errorf("%w: %s", ErrComponentNotFound, s.GetComponentId())
	}
	if s.GetSetId() == "" {
		if len(s.GetVariant()) > 0 {
			return fmt.Errorf("%w: a component outside any set has no variant", ErrBadVariant)
		}
		c.SetId, c.Variant = "", nil
		return nil
	}
	set := doc.GetComponentSets()[s.GetSetId()]
	if set == nil {
		return fmt.Errorf("%w: %s", ErrSetNotFound, s.GetSetId())
	}
	if err := validCombination(set, s.GetVariant()); err != nil {
		return err
	}
	for id, other := range doc.GetComponents() {
		if id != s.GetComponentId() && other.GetSetId() == set.GetId() && sameCombination(other.GetVariant(), s.GetVariant()) {
			return fmt.Errorf("%w: component %s already is that combination in set %s", ErrBadVariant, id, set.GetId())
		}
	}
	c.SetId = set.GetId()
	c.Variant = s.GetVariant()
	return nil
}

// namePath: the names from `root` (excluded) down to `target`; ok=false if
// `target` is not under `root`.
func namePath(doc *opendesignerv1.Document, root, target string) ([]string, bool) {
	var rev []string
	for cur := target; cur != root; {
		n := doc.GetNodes()[cur]
		if n == nil {
			return nil, false
		}
		rev = append(rev, n.GetName())
		cur = n.GetParentId()
		if cur == "" {
			return nil, false
		}
	}
	path := make([]string, len(rev))
	for i, name := range rev {
		path[len(rev)-1-i] = name
	}
	return path, true
}

// resolveNamePath walks `path` down from `root`, taking the first child with
// each name in drawing order.
func resolveNamePath(doc *opendesignerv1.Document, root string, path []string) (string, bool) {
	cur := root
	for _, name := range path {
		next := ""
		for _, ch := range ChildrenOf(doc, cur) {
			if ch.GetName() == name {
				next = ch.GetId()
				break
			}
		}
		if next == "" {
			return "", false
		}
		cur = next
	}
	return cur, true
}

// applySwapInstance points an instance at another component. Overrides follow
// their master node to the same name path under the new master; the ones with no
// counterpart are dropped. Refused if the new component's master contains the
// instance itself (a component cannot contain an instance of itself).
func applySwapInstance(doc *opendesignerv1.Document, s *opendesignerv1.SwapInstance, cow *Shared) error {
	n, ok := doc.Nodes[s.GetInstanceId()]
	if ok {
		n = cow.mut(doc, s.GetInstanceId())
	}
	if !ok {
		return fmt.Errorf("%w: %s", ErrNodeNotFound, s.GetInstanceId())
	}
	inst := n.GetInstance()
	if inst == nil {
		return fmt.Errorf("%w: %s", ErrNotInstanceNode, s.GetInstanceId())
	}
	next := doc.GetComponents()[s.GetComponentId()]
	if next == nil {
		return fmt.Errorf("%w: %s", ErrComponentNotFound, s.GetComponentId())
	}
	for cur := n.GetParentId(); cur != ""; cur = doc.GetNodes()[cur].GetParentId() {
		if cur == next.GetRootNodeId() {
			return fmt.Errorf("%w: %s sits inside the master of %s", ErrBadSwap, s.GetInstanceId(), s.GetComponentId())
		}
		if doc.GetNodes()[cur] == nil {
			break
		}
	}
	prev := doc.GetComponents()[inst.GetComponentId()]
	var kept []*opendesignerv1.InstanceOverride
	for _, o := range inst.GetOverrides() {
		if prev == nil {
			break
		}
		path, ok := namePath(doc, prev.GetRootNodeId(), o.GetMasterNodeId())
		if !ok {
			continue
		}
		if target, ok := resolveNamePath(doc, next.GetRootNodeId(), path); ok {
			c := proto.Clone(o).(*opendesignerv1.InstanceOverride)
			c.MasterNodeId = target
			kept = append(kept, c)
		}
	}
	inst.ComponentId = s.GetComponentId()
	inst.Overrides = dedupeOverrides(kept)
	return nil
}

// dedupeOverrides keeps the LAST override per master node (two old masters can
// map to the same new one).
func dedupeOverrides(in []*opendesignerv1.InstanceOverride) []*opendesignerv1.InstanceOverride {
	last := map[string]int{}
	for i, o := range in {
		last[o.GetMasterNodeId()] = i
	}
	var out []*opendesignerv1.InstanceOverride
	for i, o := range in {
		if last[o.GetMasterNodeId()] == i {
			out = append(out, o)
		}
	}
	return out
}
