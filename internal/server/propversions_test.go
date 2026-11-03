package server

import (
	"fmt"
	"sync"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

func setPropsOp(id string, base uint64, x, y float64, paths ...string) *opendesignerv1.Op {
	return &opendesignerv1.Op{
		OpId: fmt.Sprintf("op-%s-%d-%v-%v", id, base, x, y), DocId: "doc1", BaseSeq: base,
		Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
			Id: id, Patch: &opendesignerv1.Node{X: x, Y: y}, Mask: &fieldmaskpb.FieldMask{Paths: paths},
		}},
	}
}

func nodeXY(t *testing.T, h *Hub, id string) (float64, float64) {
	t.Helper()
	d, _ := h.Snapshot()
	n := d.Nodes[id]
	if n == nil {
		t.Fatalf("node %s missing", id)
	}
	return n.X, n.Y
}

func mustSubmit(t *testing.T, h *Hub, c string, op *opendesignerv1.Op) *opendesignerv1.OpRecord {
	t.Helper()
	rec, err := h.Submit(c, op)
	if err != nil {
		t.Fatal(err)
	}
	return rec
}

func TestDifferentPropertiesOfOneNodeBothSurvive(t *testing.T) {
	h := newTestHub(t)
	mustSubmit(t, h, "a", createOp("n1"))
	mustSubmit(t, h, "a", setPropsOp("n1", 1, 10, 0, "x"))
	mustSubmit(t, h, "b", setPropsOp("n1", 1, 0, 20, "y"))
	if x, y := nodeXY(t, h, "n1"); x != 10 || y != 20 {
		t.Fatalf("x,y = %v,%v want 10,20", x, y)
	}
}

// Two concurrent writers (same base): the result must not depend on arrival.
func TestConcurrentSamePropertyIsOrderIndependent(t *testing.T) {
	for _, order := range [][2]string{{"a", "b"}, {"b", "a"}} {
		h := newTestHub(t)
		mustSubmit(t, h, "a", createOp("n1"))
		for _, c := range order {
			v := map[string]float64{"a": 1, "b": 2}[c]
			mustSubmit(t, h, c, setPropsOp("n1", 1, v, 0, "x"))
		}
		if x, _ := nodeXY(t, h, "n1"); x != 2 {
			t.Fatalf("order %v: x = %v, want 2 (higher client id wins the tie)", order, x)
		}
	}
}

// A stale writer (saw less) loses to a writer who saw the other's change,
// and the dropped path is absent from the broadcast record.
func TestStaleWriteLosesAndRecordCarriesEffectiveOp(t *testing.T) {
	h := newTestHub(t)
	mustSubmit(t, h, "a", createOp("n1")) // seq 1
	mustSubmit(t, h, "b", setPropsOp("n1", 1, 5, 0, "x"))
	mustSubmit(t, h, "a", setPropsOp("n1", 2, 7, 0, "x"))
	rec := mustSubmit(t, h, "c", setPropsOp("n1", 1, 99, 3, "x", "y")) // stale on x, fresh on y
	if got := rec.Op.GetSetProps().GetMask().GetPaths(); len(got) != 1 || got[0] != "y" {
		t.Fatalf("recorded mask = %v, want [y]", got)
	}
	if x, y := nodeXY(t, h, "n1"); x != 7 || y != 3 {
		t.Fatalf("x,y = %v,%v want 7,3", x, y)
	}
}

func TestFullyLosingOpStillGetsASeq(t *testing.T) {
	h := newTestHub(t)
	mustSubmit(t, h, "a", createOp("n1"))
	mustSubmit(t, h, "z", setPropsOp("n1", 1, 5, 0, "x"))
	rec := mustSubmit(t, h, "a", setPropsOp("n1", 1, 9, 0, "x"))
	if rec.Seq != 3 {
		t.Fatalf("seq = %d want 3", rec.Seq)
	}
	if x, _ := nodeXY(t, h, "n1"); x != 5 {
		t.Fatalf("x = %v want 5", x)
	}
}

func TestUnknownBaseKeepsArrivalOrder(t *testing.T) {
	h := newTestHub(t)
	mustSubmit(t, h, "a", createOp("n1"))
	mustSubmit(t, h, "z", setPropsOp("n1", 1, 5, 0, "x"))
	mustSubmit(t, h, "agent", setPropsOp("n1", 0, 8, 0, "x")) // no base: wins even against "z"
	if x, _ := nodeXY(t, h, "n1"); x != 8 {
		t.Fatalf("x = %v want 8", x)
	}
}

func TestSameClientSequentialWritesAllApply(t *testing.T) {
	h := newTestHub(t)
	mustSubmit(t, h, "a", createOp("n1"))
	for i := 1; i <= 5; i++ {
		mustSubmit(t, h, "a", setPropsOp("n1", 1, float64(i), 0, "x")) // all sent before any echo
	}
	if x, _ := nodeXY(t, h, "n1"); x != 5 {
		t.Fatalf("x = %v want 5", x)
	}
}

func TestDeleteResetsRegisters(t *testing.T) {
	h := newTestHub(t)
	mustSubmit(t, h, "a", createOp("n1"))
	mustSubmit(t, h, "z", setPropsOp("n1", 1, 5, 0, "x"))
	mustSubmit(t, h, "a", &opendesignerv1.Op{OpId: "d", Kind: &opendesignerv1.Op_DeleteNode{DeleteNode: &opendesignerv1.DeleteNode{Id: "n1"}}})
	mustSubmit(t, h, "a", createOp("n1"))
	mustSubmit(t, h, "a", setPropsOp("n1", 4, 1, 0, "x"))
	if x, _ := nodeXY(t, h, "n1"); x != 1 {
		t.Fatalf("x = %v want 1", x)
	}
}

// Many writers race with the same stale base; run under -race. Whatever the
// arrival order, the surviving value is the one with the highest stamp.
func TestConcurrentSubmittersConverge(t *testing.T) {
	h := newTestHub(t)
	mustSubmit(t, h, "a", createOp("n1"))
	const n = 16
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			c := fmt.Sprintf("c%02d", i)
			if _, err := h.Submit(c, setPropsOp("n1", 1, float64(i+1), 0, "x")); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	if x, _ := nodeXY(t, h, "n1"); x != n {
		t.Fatalf("x = %v want %d (c15 has the top stamp)", x, n)
	}
}
