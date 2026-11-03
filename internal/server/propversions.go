package server

import (
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

// textKey is the register key of a node's text content (SetText), which is not
// a SetProperties mask path.
const textKey = "@text"

// stamp orders two writes to one property. base is the highest oplog seq the
// writer had applied when it made the write (a Lamport-style logical clock:
// whoever saw more happened later), client breaks a tie so the order is total.
type stamp struct {
	base   uint64
	client string
}

func (a stamp) less(b stamp) bool {
	if a.base != b.base {
		return a.base < b.base
	}
	return a.client < b.client
}

// propVersions is a per-property last-writer-wins register map: node id ->
// property -> stamp of the write currently in effect.
//
// Why it exists: the hub serialises ops by arrival, so two people dragging the
// same layer at once used to be decided by network timing, and a client that
// had not yet seen someone's change could overwrite it with a stale value.
// With stamps, of two concurrent writes to the same property the higher stamp
// wins whatever order they reach the server in; different properties of the
// same node never conflict (they never did, thanks to the field mask). The
// loser's path is dropped from the op before it is applied and broadcast, so
// every client converges on the record stream, which carries the effective op.
//
// It is touched only under Hub.writeMu and is not persisted: after a restart
// every register is empty, i.e. the next write wins.
type propVersions map[string]map[string]stamp

// resolve returns the op to apply: op itself when nothing is dropped, else a
// clone with the losing mask paths removed (an empty mask is a no-op the
// stream still carries, so the submitter's pending op is confirmed). commit
// records the winners; call it once the record is durable.
func (v propVersions) resolve(client string, op *opendesignerv1.Op, curSeq uint64) (out *opendesignerv1.Op, commit func()) {
	base := op.GetBaseSeq()
	if base == 0 || base > curSeq {
		base = curSeq // unknown: assume it saw everything, i.e. arrival order
	}
	st := stamp{base: base, client: client}
	wins := func(node, key string) bool {
		cur, ok := v[node][key]
		return !ok || !st.less(cur)
	}
	set := func(node string, keys []string) func() {
		return func() {
			m := v[node]
			if m == nil {
				m = map[string]stamp{}
				v[node] = m
			}
			for _, k := range keys {
				m[k] = st
			}
		}
	}
	switch k := op.GetKind().(type) {
	case *opendesignerv1.Op_SetProps:
		id := k.SetProps.GetId()
		var keep []string
		for _, p := range k.SetProps.GetMask().GetPaths() {
			if wins(id, p) {
				keep = append(keep, p)
			}
		}
		if len(keep) != len(k.SetProps.GetMask().GetPaths()) {
			op = proto.Clone(op).(*opendesignerv1.Op)
			op.GetSetProps().Mask = &fieldmaskpb.FieldMask{Paths: keep}
		}
		return op, set(id, keep)
	case *opendesignerv1.Op_SetText:
		id := k.SetText.GetId()
		if !wins(id, textKey) {
			// The text lost: keep a no-op record (an empty mask) so the op still confirms.
			return &opendesignerv1.Op{
				OpId: op.GetOpId(), DocId: op.GetDocId(), BaseSeq: op.GetBaseSeq(),
				Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
					Id: id, Mask: &fieldmaskpb.FieldMask{},
				}},
			}, func() {}
		}
		return op, set(id, []string{textKey})
	case *opendesignerv1.Op_DeleteNode:
		id := k.DeleteNode.GetId()
		return op, func() { delete(v, id) }
	case *opendesignerv1.Op_CreateNode:
		id := k.CreateNode.GetNode().GetId()
		return op, func() { delete(v, id) }
	}
	return op, func() {}
}
