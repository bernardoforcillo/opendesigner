package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

type goldenFile struct {
	DocID string            `json:"docId"`
	Ops   []json.RawMessage `json:"ops"`
	// Indici (in `ops`) degli op che DEVONO essere rifiutati. Un invariante --
	// un parent inesistente, un reparent che chiude un ciclo -- si vede solo
	// nel rifiuto: una fixture che potesse contenere solo op validi
	// proverebbe la parità di ciò che le due implementazioni fanno, mai di ciò
	// che entrambe si rifiutano di fare.
	//
	// Go verifica che Apply ritorni errore; TypeScript, che non ha errori
	// (applyOp è totale), verifica che la scena resti INVARIATA -- che è la
	// stessa cosa vista da un client il cui op il server respingerebbe. In
	// entrambi i casi l'op successivo riparte dallo stato precedente, quindi
	// una fixture può mettere in fila rifiuti e successi.
	Rejected []int           `json:"rejected"`
	Expected json.RawMessage `json:"expected"`
}

// TestGolden runs every fixture under testdata/golden/ as its own subtest, so
// adding a new fixture file is enough to exercise it -- no runner edits.
func TestGolden(t *testing.T) {
	dir := filepath.Join("..", "..", "testdata", "golden")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		found = true
		name := entry.Name()
		t.Run(name, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				t.Fatal(err)
			}
			var gf goldenFile
			if err := json.Unmarshal(raw, &gf); err != nil {
				t.Fatal(err)
			}
			rejected := map[int]bool{}
			for _, i := range gf.Rejected {
				if i < 0 || i >= len(gf.Ops) {
					t.Fatalf("fixture lists a rejected index out of range: %d", i)
				}
				rejected[i] = true
			}
			doc := NewDocument(gf.DocID, "Untitled")
			for i, opRaw := range gf.Ops {
				op := &opendesignerv1.Op{}
				if err := protojson.Unmarshal(opRaw, op); err != nil {
					t.Fatalf("op %d unmarshal: %v", i, err)
				}
				err := Apply(doc, op)
				if rejected[i] {
					if err == nil {
						t.Fatalf("op %d was expected to be rejected but applied cleanly", i)
					}
					continue
				}
				if err != nil {
					t.Fatalf("apply op %d: %v", i, err)
				}
			}
			want := &opendesignerv1.Document{}
			if err := protojson.Unmarshal(gf.Expected, want); err != nil {
				t.Fatal(err)
			}
			if !proto.Equal(doc, want) {
				t.Fatalf("mismatch:\n got=%v\nwant=%v", doc, want)
			}
		})
	}
	if !found {
		t.Fatal("no golden fixtures found in " + dir)
	}
}
