package server

import (
	"errors"
	"net/http"
	"sync"

	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
	"github.com/bernardoforcillo/brawt/internal/store"
	"github.com/google/uuid"
)

// errInvalidDocID is returned by HubFor when the client-supplied doc id is not
// a well-formed document id. docIDs are UUIDs minted by Create; store.Open
// joins the id straight into a filesystem path (<workspace>/<docID>.brawt), so
// a hostile doc_id containing ".." segments or path separators could otherwise
// create or open bundle directories outside the workspace root. Validating the
// id as a UUID before any filesystem access closes that path-traversal hole.
var errInvalidDocID = errors.New("invalid doc_id")

// httpMux costruisce un mux con l'handler Connect montato su path.
func httpMux(path string, handler http.Handler) *http.ServeMux {
	mux := http.NewServeMux()
	mux.Handle(path, handler)
	return mux
}

type Manager struct {
	mu        sync.Mutex
	workspace string
	hubs      map[string]*Hub
}

func NewManager(workspace string) *Manager {
	return &Manager{workspace: workspace, hubs: map[string]*Hub{}}
}

func (m *Manager) Create(name string) (*brawtv1.DocInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id := uuid.NewString()
	// store.Open persists the name (and the creation timestamp) in the
	// bundle's meta.json, which is what makes the document findable again
	// after this process exits -- see Manager.List.
	b, err := store.Open(m.workspace, id, name)
	if err != nil {
		return nil, err
	}
	h, err := NewHub(b)
	if err != nil {
		return nil, err
	}
	m.hubs[id] = h
	meta := b.Meta()
	return &brawtv1.DocInfo{Id: meta.ID, Name: meta.Name}, nil
}

func (m *Manager) HubFor(docID string) (*Hub, error) {
	// Reject a malformed/hostile doc_id before it ever reaches store.Open ->
	// filepath.Join; see errInvalidDocID.
	if uuid.Validate(docID) != nil {
		return nil, errInvalidDocID
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if h, ok := m.hubs[docID]; ok {
		return h, nil
	}
	// store.DefaultName is only a fallback for a bundle that has no recorded
	// name: an existing document keeps the one in its meta.json instead of
	// being reopened as "Untitled" forever.
	b, err := store.Open(m.workspace, docID, store.DefaultName)
	if err != nil {
		return nil, err
	}
	h, err := NewHub(b)
	if err != nil {
		return nil, err
	}
	m.hubs[docID] = h
	return h, nil
}

// List returns the documents that exist in the workspace.
//
// It scans the directory instead of reporting an in-memory registry of the
// documents this process happened to create. That registry was empty after
// every restart, so ListDocuments returned nothing and the only route back
// into a document was the doc id the browser had kept in localStorage --
// clearing it (or pressing "Nuovo documento") orphaned an intact bundle with
// no way to reach it from the UI.
//
// Scanning on every call rather than once at startup also means a bundle
// copied into the workspace by hand shows up, and it keeps the answer honest
// if a document is created by another process. The cost is one ReadDir plus a
// small JSON read per document, on a call the editor makes when it boots.
func (m *Manager) List() ([]*brawtv1.DocInfo, error) {
	// No lock: m.workspace is immutable and nothing here touches m.hubs, so
	// a directory scan never blocks a Submit the way holding m.mu would.
	metas, err := store.Scan(m.workspace)
	if err != nil {
		return nil, err
	}
	out := make([]*brawtv1.DocInfo, 0, len(metas))
	for _, meta := range metas {
		// HubFor refuses any id that is not a UUID (path traversal), so a
		// directory this Manager could never open must not be advertised as
		// a document.
		if uuid.Validate(meta.ID) != nil {
			continue
		}
		out = append(out, &brawtv1.DocInfo{Id: meta.ID, Name: meta.Name})
	}
	return out, nil
}
