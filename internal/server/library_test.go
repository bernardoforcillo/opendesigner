package server

import (
	"bytes"
	"context"
	"testing"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/store"
)

func newDoc(t *testing.T, c interface {
	CreateDocument(context.Context, *connect.Request[opendesignerv1.CreateDocumentRequest]) (*connect.Response[opendesignerv1.DocInfo], error)
}, name string) string {
	t.Helper()
	r, err := c.CreateDocument(context.Background(), connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: name}))
	if err != nil {
		t.Fatal(err)
	}
	return r.Msg.GetId()
}

func libSubmit(t *testing.T, h *Hub, docID string, kind any) {
	t.Helper()
	op := &opendesignerv1.Op{OpId: docID + t.Name() + "x", DocId: docID}
	switch v := kind.(type) {
	case *opendesignerv1.CreateNode:
		op.Kind = &opendesignerv1.Op_CreateNode{CreateNode: v}
	case *opendesignerv1.CreateComponent:
		op.Kind = &opendesignerv1.Op_CreateComponent{CreateComponent: v}
	}
	if _, err := h.Submit("test", op); err != nil {
		t.Fatal(err)
	}
}

func TestSharedLibraryPublishAndImport(t *testing.T) {
	ws := t.TempDir()
	ctx := context.Background()
	c, m := newTestClientWithManager(t, ws)
	libID, appID := newDoc(t, c, "Kit"), newDoc(t, c, "App")

	// The library has a component whose master fills with an uploaded image.
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{7}, 64)...)
	ref, err := m.Assets(libID).Put(bytes.NewReader(png))
	if err != nil {
		t.Fatal(err)
	}
	lh, _ := m.HubFor(libID)
	ldoc, _ := lh.Snapshot()
	page := ldoc.GetPages()[0].GetId()
	libSubmit(t, lh, libID, &opendesignerv1.CreateNode{Node: &opendesignerv1.Node{Id: "m1", ParentId: page, OrderKey: "a", Visible: true, Opacity: 1, Width: 80, Height: 40,
		Fills: []*opendesignerv1.Paint{{Kind: &opendesignerv1.Paint_Image{Image: &opendesignerv1.ImagePaint{AssetHash: ref.Hash}}}},
		Shape: &opendesignerv1.Node_Frame{Frame: &opendesignerv1.FrameNode{}}}})
	lh.writeMu.Lock()
	op := &opendesignerv1.Op{OpId: "comp", DocId: libID, Kind: &opendesignerv1.Op_CreateComponent{CreateComponent: &opendesignerv1.CreateComponent{ComponentId: "k-btn", RootNodeId: "m1", Name: "Button"}}}
	_, err = lh.applyLocked("test", op)
	lh.writeMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}

	items := []*opendesignerv1.LibraryItem{{Kind: opendesignerv1.LibraryItemKind_LIBRARY_ITEM_KIND_COMPONENT, Id: "k-btn"}}
	imp := func(doc, lib string) error {
		_, err := c.ImportFromLibrary(ctx, connect.NewRequest(&opendesignerv1.ImportFromLibraryRequest{DocId: doc, LibraryDocId: lib, Items: items}))
		return err
	}

	// Not published yet: nothing to read, nothing to import.
	if _, err := c.GetLibrary(ctx, connect.NewRequest(&opendesignerv1.GetLibraryRequest{DocId: libID})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("GetLibrary of a plain document: %v", err)
	}
	if err := imp(appID, libID); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("import from a plain document: %v", err)
	}

	info, err := c.SetLibrary(ctx, connect.NewRequest(&opendesignerv1.SetLibraryRequest{DocId: libID, Library: true}))
	if err != nil || !info.Msg.GetLibrary() {
		t.Fatalf("SetLibrary = %v, %v", info, err)
	}
	// Durable: a new process lists it as a library.
	cold, err := NewManager(ws).List()
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range cold {
		if d.GetId() == libID && !d.GetLibrary() {
			t.Fatal("the library flag did not survive a restart")
		}
		if d.GetId() == appID && d.GetLibrary() {
			t.Fatal("a plain document is listed as a library")
		}
	}
	// Renaming keeps the flag.
	if r, err := c.RenameDocument(ctx, connect.NewRequest(&opendesignerv1.RenameDocumentRequest{DocId: libID, Name: "Kit 2"})); err != nil || !r.Msg.GetLibrary() {
		t.Fatalf("rename lost the flag: %v %v", r, err)
	}

	got, err := c.GetLibrary(ctx, connect.NewRequest(&opendesignerv1.GetLibraryRequest{DocId: libID}))
	if err != nil || len(got.Msg.GetItems()) != 1 || got.Msg.GetItems()[0].GetName() != "Button" {
		t.Fatalf("GetLibrary = %v, %v", got, err)
	}

	if err := imp(libID, libID); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("self import: %v", err)
	}
	if err := imp(appID, libID); err != nil {
		t.Fatal(err)
	}
	ah, _ := m.HubFor(appID)
	adoc, _ := ah.Snapshot()
	comp := adoc.GetComponents()["k-btn"]
	if comp == nil || adoc.GetNodes()[comp.GetRootNodeId()] == nil {
		t.Fatalf("component not imported: %v", adoc.GetComponents())
	}
	// The image came along into the app's own asset store.
	f, _, err := store.NewAssets(ws, appID).Open(ref.Hash)
	if err != nil {
		t.Fatalf("asset not copied: %v", err)
	}
	f.Close()

	// Importing again leaves the component alone and reports it.
	r, err := c.ImportFromLibrary(ctx, connect.NewRequest(&opendesignerv1.ImportFromLibraryRequest{DocId: appID, LibraryDocId: libID, Items: items}))
	if err != nil || len(r.Msg.GetSkipped()) != 1 || len(r.Msg.GetImported()) != 0 {
		t.Fatalf("re-import = %v, %v", r, err)
	}
	// An unknown item is refused and nothing is written.
	_, err = c.ImportFromLibrary(ctx, connect.NewRequest(&opendesignerv1.ImportFromLibraryRequest{DocId: appID, LibraryDocId: libID,
		Items: []*opendesignerv1.LibraryItem{{Kind: opendesignerv1.LibraryItemKind_LIBRARY_ITEM_KIND_TEXT_STYLE, Id: "ghost"}}}))
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("unknown item: %v", err)
	}

	// Withdrawn: no longer importable.
	if _, err := c.SetLibrary(ctx, connect.NewRequest(&opendesignerv1.SetLibraryRequest{DocId: libID, Library: false})); err != nil {
		t.Fatal(err)
	}
	if err := imp(appID, libID); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("import from a withdrawn library: %v", err)
	}
}
