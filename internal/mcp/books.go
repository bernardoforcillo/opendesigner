package mcp

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// BOOKS: several documents (chapters) with shared styles and one page count. Thin wrappers over the server's
// book RPCs (docs/book.md), so the rules and the access checks are the server's.

type BookView struct {
	Id            string   `json:"id"`
	Name          string   `json:"name"`
	DocIds        []string `json:"docIds" jsonschema:"the chapters in reading order"`
	StyleSourceId string   `json:"styleSourceId,omitempty" jsonschema:"the chapter whose styles are the book's (default: the first)"`
	StartNumber   uint32   `json:"startNumber,omitempty" jsonschema:"number of the first page of the first chapter (default 1)"`
}

type BookChapterView struct {
	DocId           string `json:"docId"`
	Name            string `json:"name,omitempty"`
	Pages           uint32 `json:"pages" jsonschema:"pages that are not masters"`
	FirstPageNumber uint32 `json:"firstPageNumber" jsonschema:"where this chapter's numbering should start"`
	Numbered        bool   `json:"numbered" jsonschema:"its first page already starts there"`
	StylesBehind    uint32 `json:"stylesBehind" jsonschema:"styles of the source this chapter lacks or has different"`
	Missing         bool   `json:"missing,omitempty" jsonschema:"the document no longer exists"`
}

func bookView(b *opendesignerv1.Book) BookView {
	return BookView{Id: b.GetId(), Name: b.GetName(), DocIds: append([]string{}, b.GetDocIds()...), StyleSourceId: b.GetStyleSourceId(), StartNumber: b.GetStartNumber()}
}

func chapterViews(cs []*opendesignerv1.BookChapter) []BookChapterView {
	out := []BookChapterView{}
	for _, c := range cs {
		out = append(out, BookChapterView{DocId: c.GetDocId(), Name: c.GetName(), Pages: c.GetPages(), FirstPageNumber: c.GetFirstPageNumber(),
			Numbered: c.GetNumbered(), StylesBehind: c.GetStylesBehind(), Missing: c.GetMissing()})
	}
	return out
}

type ListBooksOutput struct {
	Books []BookView `json:"books"`
}

// ListBooks lists the books of the workspace.
func (s *Session) ListBooks(ctx context.Context, _ struct{}) (ListBooksOutput, error) {
	r, err := s.client.ListBooks(ctx, connect.NewRequest(&opendesignerv1.ListBooksRequest{}))
	if err != nil {
		return ListBooksOutput{}, fmt.Errorf("list_books: %w", err)
	}
	out := ListBooksOutput{Books: []BookView{}}
	for _, b := range r.Msg.GetBooks() {
		out.Books = append(out.Books, bookView(b))
	}
	return out, nil
}

type GetBookInput struct {
	BookId string `json:"bookId"`
}

type GetBookOutput struct {
	Book     BookView          `json:"book"`
	Chapters []BookChapterView `json:"chapters"`
}

// GetBook returns a book with its chapters: page counts, where each one's numbering should start and how far its
// styles are behind the source's.
func (s *Session) GetBook(ctx context.Context, in GetBookInput) (GetBookOutput, error) {
	r, err := s.client.GetBook(ctx, connect.NewRequest(&opendesignerv1.GetBookRequest{BookId: in.BookId}))
	if err != nil {
		return GetBookOutput{}, fmt.Errorf("get_book: %w", err)
	}
	return GetBookOutput{Book: bookView(r.Msg.GetBook()), Chapters: chapterViews(r.Msg.GetChapters())}, nil
}

type SaveBookInput struct {
	BookId        string   `json:"bookId,omitempty" jsonschema:"empty = create a new book; otherwise replace that book"`
	Name          string   `json:"name"`
	DocIds        []string `json:"docIds" jsonschema:"the chapters in reading order, each once; existing documents"`
	StyleSourceId string   `json:"styleSourceId,omitempty" jsonschema:"one of docIds; default the first"`
	StartNumber   uint32   `json:"startNumber,omitempty" jsonschema:"number of the first page; default 1"`
}

// SaveBook creates or replaces a book.
func (s *Session) SaveBook(ctx context.Context, in SaveBookInput) (BookView, error) {
	r, err := s.client.SaveBook(ctx, connect.NewRequest(&opendesignerv1.SaveBookRequest{Book: &opendesignerv1.Book{
		Id: in.BookId, Name: in.Name, DocIds: in.DocIds, StyleSourceId: in.StyleSourceId, StartNumber: in.StartNumber,
	}}))
	if err != nil {
		return BookView{}, fmt.Errorf("save_book: %w", err)
	}
	return bookView(r.Msg), nil
}

type DeleteBookInput struct {
	BookId  string `json:"bookId"`
	Confirm bool   `json:"confirm" jsonschema:"must be true"`
}

// DeleteBook removes a book; its documents stay.
func (s *Session) DeleteBook(ctx context.Context, in DeleteBookInput) (struct{}, error) {
	if !in.Confirm || in.BookId == "" {
		return struct{}{}, fmt.Errorf("delete_book: pass the bookId and confirm: true")
	}
	if _, err := s.client.DeleteBook(ctx, connect.NewRequest(&opendesignerv1.DeleteBookRequest{BookId: in.BookId})); err != nil {
		return struct{}{}, fmt.Errorf("delete_book: %w", err)
	}
	return struct{}{}, nil
}

type SyncBookInput struct {
	BookId    string `json:"bookId"`
	Styles    bool   `json:"styles,omitempty" jsonschema:"copy the source chapter's text, paint, effect and object styles into the other chapters"`
	Numbering bool   `json:"numbering,omitempty" jsonschema:"make each chapter's first page continue the count of the chapters before it"`
}

type SyncBookOutput struct {
	StylesApplied    uint32            `json:"stylesApplied"`
	NumberingApplied uint32            `json:"numberingApplied"`
	Chapters         []BookChapterView `json:"chapters"`
}

// SyncBook brings the chapters into line, as ordinary edits in each chapter. Both flags false means both.
func (s *Session) SyncBook(ctx context.Context, in SyncBookInput) (SyncBookOutput, error) {
	r, err := s.client.SyncBook(ctx, connect.NewRequest(&opendesignerv1.SyncBookRequest{BookId: in.BookId, Styles: in.Styles, Numbering: in.Numbering}))
	if err != nil {
		return SyncBookOutput{}, fmt.Errorf("sync_book: %w", err)
	}
	return SyncBookOutput{StylesApplied: r.Msg.GetStylesApplied(), NumberingApplied: r.Msg.GetNumberingApplied(), Chapters: chapterViews(r.Msg.GetChapters())}, nil
}

func registerBookTools(srv *mcp.Server, s *Session) {
	addTool(srv, "list_books", "List the books of the workspace: several documents (chapters) that share styles and one continuous page count.", s.ListBooks)
	addTool(srv, "get_book", "A book with its chapters: pages, where each chapter's numbering should start, whether it does, and how many styles it is behind the source.", s.GetBook)
	addTool(srv, "save_book", "Create a book (no bookId) or replace one: name, chapters (docIds in order), the style-source chapter and the first page number.", s.SaveBook)
	addTool(srv, "delete_book", "Delete a book (its documents stay). Needs the bookId and confirm: true.", s.DeleteBook)
	addTool(srv, "sync_book", "Bring a book's chapters into line, as ordinary edits in each: styles (the source's text/paint/effect/object styles are copied into the others; a chapter's own other styles stay) and numbering (each chapter's first page starts after the last page of the one before). Neither flag = both. Needs edit access to every chapter.", s.SyncBook)
}
