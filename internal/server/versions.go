package server

import (
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/store"
)

// NAMED VERSIONS and BRANCHES of a document (see store/versions.go). A version is a frozen
// copy; a branch is a NEW document seeded from a version (or from the current state), with
// the assets it uses, that evolves on its own.

var errNoVersionStore = errors.New("this document cannot keep versions")

func (m *Manager) bundleOf(docID string) (*Hub, *store.Bundle, error) {
	if !m.Exists(docID) {
		return nil, nil, ErrDocNotFound
	}
	h, err := m.HubFor(docID)
	if err != nil {
		return nil, nil, err
	}
	b, ok := h.versionStore()
	if !ok {
		return nil, nil, errNoVersionStore
	}
	return h, b, nil
}

func versionInfo(v store.Version) *opendesignerv1.VersionInfo {
	return &opendesignerv1.VersionInfo{Id: v.ID, Name: v.Name, CreatedAt: v.CreatedAt.Unix(), Seq: v.Seq}
}

func cleanName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", errEmptyName
	}
	if utf8.RuneCountInString(name) > maxNameRunes {
		return "", errNameTooLong
	}
	return name, nil
}

// CreateVersion freezes the document as it is now.
func (m *Manager) CreateVersion(docID, name string) (*opendesignerv1.VersionInfo, error) {
	name, err := cleanName(name)
	if err != nil {
		return nil, err
	}
	h, b, err := m.bundleOf(docID)
	if err != nil {
		return nil, err
	}
	doc, seq := h.Snapshot()
	v, err := b.SaveVersion(name, doc, seq)
	if err != nil {
		return nil, err
	}
	return versionInfo(v), nil
}

// ListVersions returns the saved versions, newest first.
func (m *Manager) ListVersions(docID string) ([]*opendesignerv1.VersionInfo, error) {
	_, b, err := m.bundleOf(docID)
	if err != nil {
		return nil, err
	}
	vs, err := b.ListVersions()
	if err != nil {
		return nil, err
	}
	out := make([]*opendesignerv1.VersionInfo, 0, len(vs))
	for _, v := range vs {
		out = append(out, versionInfo(v))
	}
	return out, nil
}

// DeleteVersion removes a saved version.
func (m *Manager) DeleteVersion(docID, versionID string) error {
	_, b, err := m.bundleOf(docID)
	if err != nil {
		return err
	}
	return b.DeleteVersion(versionID)
}

// Branch creates a new document seeded from a version (versionID empty = the current
// state). The new document has its own id and name, and a copy of the source's assets.
func (m *Manager) Branch(docID, versionID, name string) (*opendesignerv1.DocInfo, error) {
	name, err := cleanName(name)
	if err != nil {
		return nil, err
	}
	h, b, err := m.bundleOf(docID)
	if err != nil {
		return nil, err
	}
	var src *opendesignerv1.Document
	var seq uint64
	if versionID == "" {
		src, seq = h.Snapshot()
	} else {
		d, v, err := b.LoadVersion(versionID)
		if err != nil {
			return nil, err
		}
		src, seq = d, v.Seq
	}
	if seq == 0 {
		seq = 1 // a snapshot of seq 0 would be "no snapshot": the hub would start from an empty document
	}
	id := uuid.NewString()
	nb, err := store.Open(m.workspace, id, name)
	if err != nil {
		return nil, err
	}
	doc := proto.Clone(src).(*opendesignerv1.Document)
	doc.Id, doc.Name = id, name
	if err := nb.Snapshot(doc, seq); err != nil {
		return nil, err
	}
	if err := store.CopyAssets(m.workspace, docID, id); err != nil {
		return nil, err
	}
	nh, err := NewHub(nb)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	m.hubs[id] = nh
	m.mu.Unlock()
	meta := nb.Meta()
	return &opendesignerv1.DocInfo{Id: meta.ID, Name: meta.Name, UpdatedAt: meta.UpdatedAt.Unix()}, nil
}
