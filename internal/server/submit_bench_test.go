package server

import (
	"fmt"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

// BenchmarkSubmitLargeDoc misura il costo di UN op su un documento grande: è il
// costo per passo di un trascinamento.
func BenchmarkSubmitLargeDoc(b *testing.B) {
	for _, n := range []int{1000, 5000, 20000} {
		b.Run(fmt.Sprintf("nodes=%d", n), func(b *testing.B) {
			h := newTestHub(&testing.T{})
			for i := 0; i < n; i++ {
				if _, err := h.Submit("c", createOp(fmt.Sprintf("n%d", i))); err != nil {
					b.Fatal(err)
				}
			}
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				op := &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
					Id: "n5", Patch: &opendesignerv1.Node{X: float64(i)}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"x"}},
				}}}
				if _, err := h.Submit("c", op); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}

// Un Submit non deve mai mutare la generazione precedente del documento: i
// nodi sono condivisi, e un lettore che ha preso lo snapshot prima non può
// vederli cambiare (lo garantisce core.ApplyShared clonando prima di scrivere).
func TestSubmitDoesNotMutatePreviousGeneration(t *testing.T) {
	h := newTestHub(t)
	for _, id := range []string{"a", "b"} {
		if _, err := h.Submit("c", createOp(id)); err != nil {
			t.Fatal(err)
		}
	}
	h.mu.Lock()
	old := h.doc
	oldA := old.Nodes["a"]
	h.mu.Unlock()
	op := &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: "a", Patch: &opendesignerv1.Node{X: 42}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"x"}},
	}}}
	if _, err := h.Submit("c", op); err != nil {
		t.Fatal(err)
	}
	if oldA.GetX() != 0 || old.Nodes["a"].GetX() != 0 {
		t.Fatalf("la generazione precedente è stata mutata: x=%v", oldA.GetX())
	}
	if h.doc.Nodes["a"].GetX() != 42 {
		t.Fatalf("la nuova generazione non ha la modifica")
	}
	if h.doc.Nodes["b"] != old.Nodes["b"] {
		t.Fatalf("un nodo non toccato dovrebbe restare condiviso")
	}
}
