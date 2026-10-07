package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// NAMED VERSIONS live in <bundle>/versions/: for each version a small <id>.json (its name,
// time and the op sequence it was taken at) and the frozen document <id>.pb. They are
// plain files next to the oplog -- copying the bundle copies its history -- and nothing in
// the document or the oplog refers to them.

const versionsDir = "versions"

// ErrVersionNotFound: no version with that id.
var ErrVersionNotFound = errors.New("version not found")

// Version is the identity of a saved version.
type Version struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
	Seq       uint64    `json:"seq"`
}

func (b *Bundle) versionPaths(id string) (info, doc string, err error) {
	// The id is joined into a path: only a UUID gets through.
	if uuid.Validate(id) != nil {
		return "", "", fmt.Errorf("%w: %q", ErrVersionNotFound, id)
	}
	dir := filepath.Join(b.dir, versionsDir)
	return filepath.Join(dir, id+".json"), filepath.Join(dir, id+".pb"), nil
}

// SaveVersion freezes `doc` (taken at op sequence `seq`) as a new version called `name`.
func (b *Bundle) SaveVersion(name string, doc *opendesignerv1.Document, seq uint64) (Version, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return Version{}, errors.New("the version name cannot be empty")
	}
	v := Version{ID: uuid.NewString(), Name: name, CreatedAt: time.Now().UTC().Truncate(time.Second), Seq: seq}
	data, err := proto.Marshal(doc)
	if err != nil {
		return Version{}, err
	}
	meta, err := json.Marshal(v)
	if err != nil {
		return Version{}, err
	}
	infoPath, docPath, err := b.versionPaths(v.ID)
	if err != nil {
		return Version{}, err
	}
	if err := os.MkdirAll(filepath.Dir(docPath), 0o755); err != nil {
		return Version{}, err
	}
	// The document first: a version listed by its .json must always be loadable.
	if err := writeFileSync(docPath, data, 0o644); err != nil {
		return Version{}, err
	}
	if err := writeFileSync(infoPath, meta, 0o644); err != nil {
		os.Remove(docPath)
		return Version{}, err
	}
	return v, nil
}

// ListVersions returns the saved versions, newest first. An unreadable entry is skipped:
// it must not hide the others.
func (b *Bundle) ListVersions() ([]Version, error) {
	entries, err := os.ReadDir(filepath.Join(b.dir, versionsDir))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []Version
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(b.dir, versionsDir, e.Name()))
		if err != nil {
			continue
		}
		var v Version
		if json.Unmarshal(data, &v) != nil || uuid.Validate(v.ID) != nil || v.ID+".json" != e.Name() {
			continue
		}
		out = append(out, v)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// LoadVersion returns the frozen document of a version.
func (b *Bundle) LoadVersion(id string) (*opendesignerv1.Document, Version, error) {
	infoPath, docPath, err := b.versionPaths(id)
	if err != nil {
		return nil, Version{}, err
	}
	meta, err := os.ReadFile(infoPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, Version{}, fmt.Errorf("%w: %s", ErrVersionNotFound, id)
		}
		return nil, Version{}, err
	}
	var v Version
	if err := json.Unmarshal(meta, &v); err != nil {
		return nil, Version{}, fmt.Errorf("version %s: %w", id, err)
	}
	data, err := os.ReadFile(docPath)
	if err != nil {
		return nil, Version{}, err
	}
	doc := &opendesignerv1.Document{}
	if err := proto.Unmarshal(data, doc); err != nil {
		return nil, Version{}, fmt.Errorf("version %s: %w", id, err)
	}
	return doc, v, nil
}

// DeleteVersion removes a version.
func (b *Bundle) DeleteVersion(id string) error {
	infoPath, docPath, err := b.versionPaths(id)
	if err != nil {
		return err
	}
	if _, err := os.Stat(infoPath); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("%w: %s", ErrVersionNotFound, id)
		}
		return err
	}
	// The listing entry goes first: a half-deleted version must not be listed.
	if err := os.Remove(infoPath); err != nil {
		return err
	}
	if err := os.Remove(docPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// CopyAssets copies the files of document srcID's asset store into dstID's. They are
// content-addressed, so a copy never conflicts with what is already there.
func CopyAssets(workspace, srcID, dstID string) error {
	src, err := NewAssets(workspace, srcID).dir()
	if err != nil {
		return err
	}
	dst, err := NewAssets(workspace, dstID).dir()
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(src)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if err := copyFile(filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())); err != nil {
			return err
		}
	}
	return nil
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// Import creates the bundle of `doc` in the workspace from a document that was built
// elsewhere (a packed folder, a copy), with the asset files of `assets` (a directory of
// files named by hash; it may not exist). The document keeps its id and name.
func Import(workspace string, doc *opendesignerv1.Document, assets string) error {
	if uuid.Validate(doc.GetId()) != nil {
		return fmt.Errorf("the document id %q is not a UUID", doc.GetId())
	}
	b, err := Open(workspace, doc.GetId(), doc.GetName())
	if err != nil {
		return err
	}
	// Seq 1: a snapshot of seq 0 would read as "no snapshot".
	if err := b.Snapshot(doc, 1); err != nil {
		return err
	}
	if assets == "" {
		return nil
	}
	dst, err := NewAssets(workspace, doc.GetId()).dir()
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(assets)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	for _, e := range entries {
		if !e.IsDir() {
			if err := copyFile(filepath.Join(assets, e.Name()), filepath.Join(dst, e.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}
