package server

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

func TestBooksRespectDocumentAccess(t *testing.T) {
	e := newAccessEnv(t)
	ctx := context.Background()
	local := e.as("", false)
	open, secret := bookDoc(t, local, "Open"), bookDoc(t, local, "Secret")
	if _, err := local.EnableAccess(ctx, connect.NewRequest(&opendesignerv1.EnableAccessRequest{DocId: secret})); err != nil {
		t.Fatal(err)
	}
	bk, err := local.SaveBook(ctx, connect.NewRequest(&opendesignerv1.SaveBookRequest{Book: &opendesignerv1.Book{Name: "Mixed", DocIds: []string{open, secret}}}))
	if err != nil {
		t.Fatal(err)
	}
	stranger := e.as("", true)
	if _, err := stranger.SyncBook(ctx, connect.NewRequest(&opendesignerv1.SyncBookRequest{BookId: bk.Msg.GetId()})); code(err) != connect.CodePermissionDenied {
		t.Fatalf("sync through a book into a protected document: %v", err)
	}
	if _, err := stranger.GetBook(ctx, connect.NewRequest(&opendesignerv1.GetBookRequest{BookId: bk.Msg.GetId()})); code(err) != connect.CodePermissionDenied {
		t.Fatalf("reading a book of a protected document: %v", err)
	}
	if _, err := stranger.SaveBook(ctx, connect.NewRequest(&opendesignerv1.SaveBookRequest{Book: &opendesignerv1.Book{Name: "Mine", DocIds: []string{secret}}})); code(err) != connect.CodePermissionDenied {
		t.Fatalf("naming a protected document in a new book: %v", err)
	}
	l, err := stranger.ListBooks(ctx, connect.NewRequest(&opendesignerv1.ListBooksRequest{}))
	if err != nil || len(l.Msg.GetBooks()) != 0 {
		t.Fatalf("the listing must hide the book: %v %v", l, err)
	}
	if l, _ := local.ListBooks(ctx, connect.NewRequest(&opendesignerv1.ListBooksRequest{})); len(l.Msg.GetBooks()) != 1 {
		t.Fatal("the trusted machine sees every book")
	}
}
