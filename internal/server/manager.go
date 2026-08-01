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
	infos     map[string]*brawtv1.DocInfo
}

func NewManager(workspace string) *Manager {
	return &Manager{workspace: workspace, hubs: map[string]*Hub{}, infos: map[string]*brawtv1.DocInfo{}}
}

func (m *Manager) Create(name string) (*brawtv1.DocInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	id := uuid.NewString()
	b, err := store.Open(m.workspace, id, name)
	if err != nil {
		return nil, err
	}
	h, err := NewHub(b)
	if err != nil {
		return nil, err
	}
	m.hubs[id] = h
	info := &brawtv1.DocInfo{Id: id, Name: name}
	m.infos[id] = info
	return info, nil
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
	b, err := store.Open(m.workspace, docID, "Untitled")
	if err != nil {
		return nil, err
	}
	h, err := NewHub(b)
	if err != nil {
		return nil, err
	}
	m.hubs[docID] = h
	if _, ok := m.infos[docID]; !ok {
		m.infos[docID] = &brawtv1.DocInfo{Id: docID, Name: "Untitled"}
	}
	return h, nil
}

func (m *Manager) List() []*brawtv1.DocInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*brawtv1.DocInfo, 0, len(m.infos))
	for _, i := range m.infos {
		out = append(out, i)
	}
	return out
}
