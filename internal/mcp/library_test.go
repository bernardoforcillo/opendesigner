package mcp_test

import (
	"context"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestLibraryTools: one session publishes its document as a library, another imports a component from it.
func TestLibraryTools(t *testing.T) {
	url := serveInMemory(t)
	client := odmcp.NewClient(url)
	libID, appID := newDoc(t, client), newDoc(t, client)
	lib := startSession(t, url, libID, "lib")
	app := startSession(t, url, appID, "app")
	ctx := context.Background()

	card := frame(t, lib, "Card")
	comp, err := lib.CreateComponent(ctx, odmcp.CreateComponentInput{RootNodeId: card, Name: "Card"})
	if err != nil {
		t.Fatal(err)
	}

	in := odmcp.ImportFromLibraryInput{LibraryDocId: libID, Items: []odmcp.LibraryItemRef{{Kind: "component", Id: comp.ComponentId}}}
	if _, err := app.ImportFromLibrary(ctx, in); err == nil {
		t.Fatal("importing from a document that is not a library must fail")
	}
	if _, err := lib.SetLibrary(ctx, odmcp.SetLibraryInput{Library: true}); err != nil {
		t.Fatal(err)
	}
	docs, err := app.ListDocuments(ctx, struct{}{})
	if err != nil {
		t.Fatal(err)
	}
	var flagged int
	for _, d := range docs.Documents {
		if d.Library {
			flagged++
			if d.Id != libID {
				t.Errorf("unexpected library %s", d.Id)
			}
		}
	}
	if flagged != 1 {
		t.Fatalf("libraries in list_documents = %d", flagged)
	}
	got, err := app.GetLibrary(ctx, odmcp.GetLibraryInput{DocId: libID})
	if err != nil || len(got.Items) != 1 || got.Items[0].Kind != "component" || got.Items[0].Name != "Card" {
		t.Fatalf("get_library = %+v, %v", got, err)
	}

	out, err := app.ImportFromLibrary(ctx, in)
	if err != nil || len(out.Imported) != 1 || out.PageId == "" {
		t.Fatalf("import = %+v, %v", out, err)
	}
	comps, _ := app.ListComponents(ctx, struct{}{})
	if len(comps.Components) != 1 || comps.Components[0].Id != comp.ComponentId {
		t.Fatalf("components after import = %+v", comps.Components)
	}
	if _, err := app.ImportFromLibrary(ctx, odmcp.ImportFromLibraryInput{LibraryDocId: libID, Items: []odmcp.LibraryItemRef{{Kind: "bogus", Id: "x"}}}); err == nil {
		t.Fatal("an unknown kind must fail")
	}
}
