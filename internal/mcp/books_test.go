package mcp_test

import (
	"context"
	"testing"

	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
)

// TestBookTools: an agent groups two documents in a book, sees the second one start after the first,
// syncs the numbering and is refused a delete without confirm.
func TestBookTools(t *testing.T) {
	url := serveInMemory(t)
	client := odmcp.NewClient(url)
	a, b := newDoc(t, client), newDoc(t, client)
	s := startSession(t, url, a, "agent")
	ctx := context.Background()

	book, err := s.SaveBook(ctx, odmcp.SaveBookInput{Name: "Novel", DocIds: []string{a, b}, StartNumber: 3})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveBook(ctx, odmcp.SaveBookInput{Name: "Bad", DocIds: []string{a, a}}); err == nil {
		t.Error("a chapter listed twice must be refused")
	}
	if l, _ := s.ListBooks(ctx, struct{}{}); len(l.Books) != 1 || l.Books[0].Id != book.Id {
		t.Fatalf("list = %+v", l.Books)
	}
	g, err := s.GetBook(ctx, odmcp.GetBookInput{BookId: book.Id})
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Chapters) != 2 || g.Chapters[0].FirstPageNumber != 3 || g.Chapters[1].FirstPageNumber != 3+g.Chapters[0].Pages || g.Chapters[0].Numbered {
		t.Fatalf("chapters = %+v", g.Chapters)
	}
	out, err := s.SyncBook(ctx, odmcp.SyncBookInput{BookId: book.Id, Numbering: true})
	if err != nil {
		t.Fatal(err)
	}
	if out.NumberingApplied != 2 || !out.Chapters[0].Numbered || !out.Chapters[1].Numbered {
		t.Fatalf("sync = %+v", out)
	}
	if _, err := s.DeleteBook(ctx, odmcp.DeleteBookInput{BookId: book.Id}); err == nil {
		t.Error("delete without confirm must be refused")
	}
	if _, err := s.DeleteBook(ctx, odmcp.DeleteBookInput{BookId: book.Id, Confirm: true}); err != nil {
		t.Fatal(err)
	}
	if l, _ := s.ListBooks(ctx, struct{}{}); len(l.Books) != 0 {
		t.Fatalf("list after delete = %+v", l.Books)
	}
}
