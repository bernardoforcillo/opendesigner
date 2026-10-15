package store

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"

	"github.com/bernardoforcillo/opendesigner/internal/core"
)

func TestVersionsRoundTrip(t *testing.T) {
	ws := t.TempDir()
	id := uuid.NewString()
	b, err := Open(ws, id, "Doc")
	if err != nil {
		t.Fatal(err)
	}
	doc := core.NewDocument(id, "Doc")
	v, err := b.SaveVersion("  Launch ", doc, 7)
	if err != nil || v.Name != "Launch" || v.Seq != 7 {
		t.Fatalf("SaveVersion = %+v %v", v, err)
	}
	if _, err := b.SaveVersion("   ", doc, 1); err == nil {
		t.Fatal("an empty name must be refused")
	}
	got, info, err := b.LoadVersion(v.ID)
	if err != nil || got.GetId() != id || info.Name != "Launch" {
		t.Fatalf("LoadVersion = %v %+v %v", got, info, err)
	}
	list, err := b.ListVersions()
	if err != nil || len(list) != 1 || list[0].ID != v.ID {
		t.Fatalf("ListVersions = %+v %v", list, err)
	}
	// Strangers in the folder (a JSON that is not a version, a foreign file) do not break the list.
	dir := filepath.Join(ws, id+bundleSuffix, versionsDir)
	_ = os.WriteFile(filepath.Join(dir, "junk.json"), []byte("{"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, uuid.NewString()+".json"), []byte(`{"id":"someone-else"}`), 0o644)
	if list, _ := b.ListVersions(); len(list) != 1 {
		t.Fatalf("junk must be skipped: %+v", list)
	}
	for _, bad := range []string{"../escape", "", "not-a-uuid"} {
		if _, _, err := b.LoadVersion(bad); !errors.Is(err, ErrVersionNotFound) {
			t.Errorf("LoadVersion(%q) = %v", bad, err)
		}
		if err := b.DeleteVersion(bad); !errors.Is(err, ErrVersionNotFound) {
			t.Errorf("DeleteVersion(%q) = %v", bad, err)
		}
	}
	if err := b.DeleteVersion(v.ID); err != nil {
		t.Fatal(err)
	}
	if err := b.DeleteVersion(v.ID); !errors.Is(err, ErrVersionNotFound) {
		t.Fatalf("second delete = %v", err)
	}
}
