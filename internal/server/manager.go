package server

import (
	"errors"
	"net/http"
	"strings"
	"sync"
	"unicode/utf8"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/store"
	"github.com/google/uuid"
)

// errInvalidDocID is returned by HubFor when the client-supplied doc id is not
// a well-formed document id. docIDs are UUIDs minted by Create; store.Open
// joins the id straight into a filesystem path (<workspace>/<docID>.opendesigner), so
// a hostile doc_id containing ".." segments or path separators could otherwise
// create or open bundle directories outside the workspace root. Validating the
// id as a UUID before any filesystem access closes that path-traversal hole.
var errInvalidDocID = errors.New("invalid doc_id")

var (
	errEmptyName   = errors.New("il nome del documento non può essere vuoto")
	errNameTooLong = errors.New("il nome del documento è troppo lungo")
	// ErrDocInUse: il documento è aperto da qualcuno, non si può eliminare.
	ErrDocInUse = errors.New("il documento è aperto in un editor: chiudilo prima di eliminarlo")
)

// ErrDocNotFound: nessun documento con quell'id.
var ErrDocNotFound = errors.New("documento non trovato")

const maxNameRunes = 120

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

func (m *Manager) Create(name string) (*opendesignerv1.DocInfo, error) {
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
	return &opendesignerv1.DocInfo{Id: meta.ID, Name: meta.Name, UpdatedAt: meta.UpdatedAt.Unix()}, nil
}

// Exists dice se il documento c'è davvero (in memoria o come bundle sul
// disco), senza crearlo: HubFor invece apre-o-crea, quindi un link a un
// documento inesistente (o eliminato) ne farebbe nascere uno vuoto.
func (m *Manager) Exists(docID string) bool {
	if uuid.Validate(docID) != nil {
		return false
	}
	m.mu.Lock()
	_, ok := m.hubs[docID]
	m.mu.Unlock()
	if ok {
		return true
	}
	return store.Exists(m.workspace, docID)
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
func (m *Manager) List() ([]*opendesignerv1.DocInfo, error) {
	// No lock: m.workspace is immutable and nothing here touches m.hubs, so
	// a directory scan never blocks a Submit the way holding m.mu would.
	metas, err := store.Scan(m.workspace)
	if err != nil {
		return nil, err
	}
	out := make([]*opendesignerv1.DocInfo, 0, len(metas))
	for _, meta := range metas {
		// HubFor refuses any id that is not a UUID (path traversal), so a
		// directory this Manager could never open must not be advertised as
		// a document.
		if uuid.Validate(meta.ID) != nil {
			continue
		}
		out = append(out, m.info(meta))
	}
	return out, nil
}

// info arricchisce l'identità di un documento con ciò che la Home mostra:
// ultima modifica e conteggi. Se l'hub è già aperto in questo processo i
// conteggi sono quelli vivi (e a costo zero); altrimenti si legge il bundle in
// sola lettura (store.LoadReadOnly: nessuna riparazione, nessuna scrittura).
// Un bundle illeggibile resta in elenco con i conteggi a zero: non deve
// nascondere gli altri.
func (m *Manager) info(meta store.Meta) *opendesignerv1.DocInfo {
	di := &opendesignerv1.DocInfo{Id: meta.ID, Name: meta.Name}
	t := store.ModTime(m.workspace, meta.ID)
	if meta.UpdatedAt.After(t) {
		t = meta.UpdatedAt
	}
	if !t.IsZero() {
		di.UpdatedAt = t.Unix()
	}
	m.mu.Lock()
	h := m.hubs[meta.ID]
	m.mu.Unlock()
	if h != nil {
		s, f := h.Counts()
		di.Screens, di.Flows = uint32(s), uint32(f)
		return di
	}
	if doc, _, err := store.LoadReadOnly(m.workspace, meta.ID); err == nil {
		s, f := countDoc(doc)
		di.Screens, di.Flows = uint32(s), uint32(f)
	}
	return di
}

// Rename cambia il nome del documento (durevole + in memoria).
func (m *Manager) Rename(docID, name string) (*opendesignerv1.DocInfo, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, errEmptyName
	}
	if utf8.RuneCountInString(name) > maxNameRunes {
		return nil, errNameTooLong
	}
	if !m.Exists(docID) {
		return nil, ErrDocNotFound
	}
	h, err := m.HubFor(docID)
	if err != nil {
		return nil, err
	}
	if err := h.SetName(name); err != nil {
		return nil, err
	}
	return m.info(store.Meta{ID: docID, Name: name}), nil
}

// Delete elimina un documento spostandone il bundle nel cestino del workspace.
// Rifiuta (ErrDocInUse) se qualcuno ha uno stream aperto sul documento: un
// editor aperto continuerebbe a scrivere su una cartella sparita. Se l'hub è in
// memoria ma nessuno lo guarda, si attendono gli snapshot in volo e lo si
// toglie dal registro PRIMA di spostare la cartella.
func (m *Manager) Delete(docID string) error {
	if uuid.Validate(docID) != nil {
		return errInvalidDocID
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if h, ok := m.hubs[docID]; ok {
		if h.Subscribers() > 0 {
			return ErrDocInUse
		}
		h.writeMu.Lock()
		h.waitSnapshots()
		delete(m.hubs, docID)
		h.writeMu.Unlock()
	}
	return store.Trash(m.workspace, docID)
}

// Assets ritorna lo store degli asset (le immagini) del documento: serve
// all'export di codice, che li copia nel progetto generato.
func (m *Manager) Assets(docID string) *store.Assets { return store.NewAssets(m.workspace, docID) }
