package server

import (
	"errors"
	"fmt"
	"io"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/library"
	"github.com/bernardoforcillo/opendesigner/internal/store"
)

// SHARED LIBRARIES (internal/library). A document is published as a library with SetLibrary; the flag is
// part of the document's identity (meta.json), not of its op-log. Another document imports from it with
// ImportFromLibrary, which copies the items as ordinary ops.

// ErrNotALibrary: the document has not been published as a library.
var ErrNotALibrary = errors.New("the document is not published as a library")

// ErrLibrarySelf: a document cannot import from itself.
var ErrLibrarySelf = errors.New("a document cannot import from itself")

// metaOf is the identity of a document that is open in this process (the bundle's meta.json), falling
// back to a bare id and name.
func (m *Manager) metaOf(docID, name string) store.Meta {
	m.mu.Lock()
	h := m.hubs[docID]
	m.mu.Unlock()
	if h != nil {
		if b, ok := h.versionStore(); ok {
			return b.Meta()
		}
	}
	return store.Meta{ID: docID, Name: name}
}

// SetLibrary publishes the document as a library, or withdraws it. Documents that already imported from
// it keep their copies.
func (m *Manager) SetLibrary(docID string, on bool) (*opendesignerv1.DocInfo, error) {
	if !m.Exists(docID) {
		return nil, ErrDocNotFound
	}
	h, err := m.HubFor(docID)
	if err != nil {
		return nil, err
	}
	b, ok := h.versionStore()
	if !ok {
		return nil, errors.New("the document cannot be published")
	}
	if err := b.SetLibrary(on); err != nil {
		return nil, err
	}
	return m.info(b.Meta()), nil
}

// GetLibrary says what a library document offers.
func (m *Manager) GetLibrary(docID string) (*opendesignerv1.GetLibraryResponse, error) {
	if !m.Exists(docID) {
		return nil, ErrDocNotFound
	}
	h, err := m.HubFor(docID)
	if err != nil {
		return nil, err
	}
	meta := m.metaOf(docID, "")
	if !meta.Library {
		return nil, ErrNotALibrary
	}
	doc, _ := h.Snapshot()
	return &opendesignerv1.GetLibraryResponse{Info: m.info(meta), Items: library.Items(doc)}, nil
}

// ImportFromLibrary copies items of a library document into docID. The assets (images, font files) go
// first, then the ops, in one go on the importing document's hub; nothing is written when the plan does
// not apply.
func (m *Manager) ImportFromLibrary(req *opendesignerv1.ImportFromLibraryRequest) (*opendesignerv1.ImportFromLibraryResponse, error) {
	docID, libID := req.GetDocId(), req.GetLibraryDocId()
	if docID == libID {
		return nil, ErrLibrarySelf
	}
	if !m.Exists(docID) || !m.Exists(libID) {
		return nil, ErrDocNotFound
	}
	if !m.metaOf(libID, "").Library {
		// metaOf only knows open hubs: open the library to read its meta.json.
		if _, err := m.HubFor(libID); err != nil {
			return nil, err
		}
		if !m.metaOf(libID, "").Library {
			return nil, ErrNotALibrary
		}
	}
	lh, err := m.HubFor(libID)
	if err != nil {
		return nil, err
	}
	dh, err := m.HubFor(docID)
	if err != nil {
		return nil, err
	}
	src, _ := lh.Snapshot()
	// Serialise imports into one document, so the plan is checked against the state it is applied to.
	dh.writeMu.Lock()
	defer dh.writeMu.Unlock()
	dst, _ := dh.Snapshot()
	plan, err := library.BuildImport(src, dst, libID, req.GetItems())
	if err != nil {
		return nil, err
	}
	from, to := store.NewAssets(m.workspace, libID), store.NewAssets(m.workspace, docID)
	for _, hash := range plan.Assets {
		if err := copyAsset(from, to, hash); err != nil {
			return nil, fmt.Errorf("copying asset %s: %w", hash, err)
		}
	}
	if err := dh.submitLocked("server", plan.Ops); err != nil {
		return nil, err
	}
	return &opendesignerv1.ImportFromLibraryResponse{Imported: plan.Imported, Skipped: plan.Skipped, PageId: plan.PageID}, nil
}

// copyAsset puts one asset of the library into the importing document's store. An asset the library
// does not hold is skipped (an image that was never uploaded stays as broken in the copy as it was).
func copyAsset(from, to *store.Assets, hash string) error {
	f, _, err := from.Open(hash)
	if errors.Is(err, store.ErrAssetNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = to.Put(io.Reader(f))
	return err
}
