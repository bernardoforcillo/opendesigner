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
	// Indices (in `ops`) of the ops that MUST be rejected. An invariant --
	// a nonexistent parent, a reparent that closes a cycle -- is only visible
	// in the rejection: a fixture that could only contain valid ops would
	// prove parity of what the two implementations do, never of what both
	// refuse to do.
	//
	// Go checks that Apply returns an error; TypeScript, which has no errors
	// (applyOp is total), checks that the scene stays UNCHANGED -- which is the
	// same thing seen from a client whose op the server would reject. In
	// both cases the next op restarts from the previous state, so a fixture
	// can chain rejections and successes.
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
