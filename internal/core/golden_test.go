package core

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

type goldenFile struct {
	DocID    string            `json:"docId"`
	Ops      []json.RawMessage `json:"ops"`
	Expected json.RawMessage   `json:"expected"`
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
			doc := NewDocument(gf.DocID, "Untitled")
			for i, opRaw := range gf.Ops {
				op := &brawtv1.Op{}
				if err := protojson.Unmarshal(opRaw, op); err != nil {
					t.Fatalf("op %d unmarshal: %v", i, err)
				}
				if err := Apply(doc, op); err != nil {
					t.Fatalf("apply op %d: %v", i, err)
				}
			}
			want := &brawtv1.Document{}
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
