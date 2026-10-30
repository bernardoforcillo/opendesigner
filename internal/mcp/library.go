package mcp

import (
	"context"
	"fmt"
	"strings"
	"time"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// SHARED LIBRARIES: publish a document as a library, read what it offers and import items into the
// document of this session. The server does the copying (see internal/library): an import is ordinary
// ops, so it is undoable and shared with everyone in the document.

// libraryKinds maps the tool's short names to the proto kinds.
var libraryKinds = map[string]opendesignerv1.LibraryItemKind{
	"component":    opendesignerv1.LibraryItemKind_LIBRARY_ITEM_KIND_COMPONENT,
	"text_style":   opendesignerv1.LibraryItemKind_LIBRARY_ITEM_KIND_TEXT_STYLE,
	"paint_style":  opendesignerv1.LibraryItemKind_LIBRARY_ITEM_KIND_PAINT_STYLE,
	"effect_style": opendesignerv1.LibraryItemKind_LIBRARY_ITEM_KIND_EFFECT_STYLE,
	"object_style": opendesignerv1.LibraryItemKind_LIBRARY_ITEM_KIND_OBJECT_STYLE,
	"collection":   opendesignerv1.LibraryItemKind_LIBRARY_ITEM_KIND_COLLECTION,
}

func libraryKindName(k opendesignerv1.LibraryItemKind) string {
	for name, v := range libraryKinds {
		if v == k {
			return name
		}
	}
	return "unknown"
}

type LibraryItemView struct {
	Kind  string `json:"kind" jsonschema:"component | text_style | paint_style | effect_style | object_style | collection (a variable collection, with all its variables)"`
	Id    string `json:"id"`
	Name  string `json:"name,omitempty"`
	Group string `json:"group,omitempty" jsonschema:"the folder of a 'folder/name' name"`
}

func libraryItemViews(items []*opendesignerv1.LibraryItem) []LibraryItemView {
	out := []LibraryItemView{}
	for _, i := range items {
		out = append(out, LibraryItemView{Kind: libraryKindName(i.GetKind()), Id: i.GetId(), Name: i.GetName(), Group: i.GetGroup()})
	}
	return out
}

type SetLibraryInput struct {
	DocId   string `json:"docId,omitempty" jsonschema:"default: this session's document"`
	Library bool   `json:"library" jsonschema:"true publishes the document as a shared library, false withdraws it (documents that already imported keep their copies)"`
}

// SetLibrary publishes a document as a library, or withdraws it.
func (s *Session) SetLibrary(ctx context.Context, in SetLibraryInput) (DocView, error) {
	r, err := s.client.SetLibrary(ctx, connect.NewRequest(&opendesignerv1.SetLibraryRequest{DocId: s.docOr(in.DocId), Library: in.Library}))
	if err != nil {
		return DocView{}, fmt.Errorf("set_library: %w", err)
	}
	return docView(r.Msg), nil
}

type GetLibraryInput struct {
	DocId string `json:"docId" jsonschema:"a document published as a library (see list_documents, library: true)"`
}

type GetLibraryOutput struct {
	Document DocView           `json:"document"`
	Items    []LibraryItemView `json:"items"`
}

// GetLibrary lists what a library offers.
func (s *Session) GetLibrary(ctx context.Context, in GetLibraryInput) (GetLibraryOutput, error) {
	r, err := s.client.GetLibrary(ctx, connect.NewRequest(&opendesignerv1.GetLibraryRequest{DocId: in.DocId}))
	if err != nil {
		return GetLibraryOutput{}, fmt.Errorf("get_library: %w", err)
	}
	return GetLibraryOutput{Document: docView(r.Msg.GetInfo()), Items: libraryItemViews(r.Msg.GetItems())}, nil
}

type LibraryItemRef struct {
	Kind string `json:"kind" jsonschema:"component | text_style | paint_style | effect_style | object_style | collection"`
	Id   string `json:"id"`
}

type ImportFromLibraryInput struct {
	LibraryDocId string           `json:"libraryDocId"`
	Items        []LibraryItemRef `json:"items" jsonschema:"what to import (get_library lists them)"`
}

type ImportFromLibraryOutput struct {
	Imported []LibraryItemView `json:"imported" jsonschema:"everything written, dependencies included"`
	Skipped  []LibraryItemView `json:"skipped" jsonschema:"components that were already in the document, left as they are"`
	PageId   string            `json:"pageId,omitempty" jsonschema:"the page that holds the imported component masters"`
}

// ImportFromLibrary copies items of a library into this session's document, with what they depend on
// (nested components and the other variants of a set, the styles and variables a master uses, fonts and
// images). Importing again updates styles, variables, sets and fonts in place and leaves existing
// components alone.
func (s *Session) ImportFromLibrary(ctx context.Context, in ImportFromLibraryInput) (ImportFromLibraryOutput, error) {
	req := &opendesignerv1.ImportFromLibraryRequest{DocId: s.docID, LibraryDocId: in.LibraryDocId}
	for _, it := range in.Items {
		k, ok := libraryKinds[strings.ToLower(it.Kind)]
		if !ok {
			return ImportFromLibraryOutput{}, fmt.Errorf("import_from_library: unknown kind %q", it.Kind)
		}
		req.Items = append(req.Items, &opendesignerv1.LibraryItem{Kind: k, Id: it.Id})
	}
	r, err := s.client.ImportFromLibrary(ctx, connect.NewRequest(req))
	if err != nil {
		return ImportFromLibraryOutput{}, fmt.Errorf("import_from_library: %w", err)
	}
	// The ops reach this session through its subscription: wait until the components are there, so the
	// next tool call sees them.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && !s.hasComponents(r.Msg.GetImported()) {
		time.Sleep(10 * time.Millisecond)
	}
	return ImportFromLibraryOutput{Imported: libraryItemViews(r.Msg.GetImported()), Skipped: libraryItemViews(r.Msg.GetSkipped()), PageId: r.Msg.GetPageId()}, nil
}

func (s *Session) hasComponents(items []*opendesignerv1.LibraryItem) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, i := range items {
		if i.GetKind() == opendesignerv1.LibraryItemKind_LIBRARY_ITEM_KIND_COMPONENT && s.doc.GetComponents()[i.GetId()] == nil {
			return false
		}
	}
	return true
}

func registerLibraryTools(srv *mcp.Server, s *Session) {
	addTool(srv, "set_library", "Publish a document as a shared library (default: this session's), or withdraw it. Its components, styles and variable collections can then be imported into other documents.", s.SetLibrary)
	addTool(srv, "get_library", "List what a library document offers: components, text / paint / effect / object styles and variable collections. list_documents shows which documents are libraries.", s.GetLibrary)
	addTool(srv, "import_from_library", "Copy items of a library into this session's document, with what they depend on (nested components, the other variants of a set, styles, variables, fonts, images). Editable and undoable like anything drawn. Importing again updates styles, variables and sets in place and leaves components already there alone.", s.ImportFromLibrary)
}
