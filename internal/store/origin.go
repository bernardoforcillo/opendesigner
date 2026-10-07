package store

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"google.golang.org/protobuf/proto"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// A BRANCH remembers where it came from: the id and name of the document it was seeded from and
// the document AS IT WAS then (the common ancestor of a later three-way merge). Two small files in
// the bundle, next to the versions; a document that is not a branch has neither.

const (
	originFile = "origin.json"
	baseFile   = "origin-base.pb"
)

// ErrNoOrigin: the bundle is not a branch.
var ErrNoOrigin = errors.New("this document is not a branch")

// Origin is where a branch came from.
type Origin struct {
	SourceDocID string    `json:"sourceDocId"`
	SourceName  string    `json:"sourceName"`
	CreatedAt   time.Time `json:"createdAt"`
	BaseSeq     uint64    `json:"baseSeq"`
}

// SaveOrigin records the origin and its base document (the branch's starting point, or the state
// it was last merged at).
func (b *Bundle) SaveOrigin(o Origin, base *opendesignerv1.Document) error {
	data, err := proto.Marshal(base)
	if err != nil {
		return err
	}
	meta, err := json.Marshal(o)
	if err != nil {
		return err
	}
	// The base first: an origin file always has its base next to it.
	if err := writeFileSync(filepath.Join(b.dir, baseFile), data, 0o644); err != nil {
		return err
	}
	return writeFileSync(filepath.Join(b.dir, originFile), meta, 0o644)
}

// LoadOrigin returns the origin and base of a branch, or ErrNoOrigin.
func (b *Bundle) LoadOrigin() (Origin, *opendesignerv1.Document, error) {
	meta, err := os.ReadFile(filepath.Join(b.dir, originFile))
	if err != nil {
		if os.IsNotExist(err) {
			return Origin{}, nil, ErrNoOrigin
		}
		return Origin{}, nil, err
	}
	var o Origin
	if err := json.Unmarshal(meta, &o); err != nil {
		return Origin{}, nil, err
	}
	data, err := os.ReadFile(filepath.Join(b.dir, baseFile))
	if err != nil {
		return Origin{}, nil, err
	}
	base := &opendesignerv1.Document{}
	if err := proto.Unmarshal(data, base); err != nil {
		return Origin{}, nil, err
	}
	return o, base, nil
}
