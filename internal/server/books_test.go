package server

import (
	"context"
	"testing"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1/opendesignerv1connect"
	"github.com/google/uuid"
)

func bookDoc(t *testing.T, c opendesignerv1connect.DocumentServiceClient, name string) string {
	t.Helper()
	info, err := c.CreateDocument(context.Background(), connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: name}))
	if err != nil {
		t.Fatal(err)
	}
	return info.Msg.GetId()
}

func submitOp(t *testing.T, c opendesignerv1connect.DocumentServiceClient, doc string, op *opendesignerv1.Op) {
	t.Helper()
	op.OpId, op.DocId = uuid.NewString(), doc
	if _, err := c.SubmitOp(context.Background(), connect.NewRequest(&opendesignerv1.SubmitOpRequest{DocId: doc, ClientId: "t", Op: op})); err != nil {
		t.Fatal(err)
	}
}

func addPage(t *testing.T, c opendesignerv1connect.DocumentServiceClient, doc, id string) {
	t.Helper()
	submitOp(t, c, doc, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreatePage{CreatePage: &opendesignerv1.CreatePage{Page: &opendesignerv1.Page{Id: id, Name: id}}}})
}

func textStyle(id, name, base string, size float64) *opendesignerv1.Op {
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetTextStyleDef{SetTextStyleDef: &opendesignerv1.SetTextStyleDef{TextStyle: &opendesignerv1.TextStyleDef{
		Id: id, Name: name, BasedOn: base, Style: &opendesignerv1.TextStyle{FontFamily: "Inter", FontSize: size, LineHeight: 1.4},
	}}}}
}

func snapshotOf(t *testing.T, c opendesignerv1connect.DocumentServiceClient, doc string) *opendesignerv1.Document {
	t.Helper()
	r, err := c.OpenDocument(context.Background(), connect.NewRequest(&opendesignerv1.OpenRequest{DocId: doc}))
	if err != nil {
		t.Fatal(err)
	}
	return r.Msg.GetSnapshot()
}

func TestBookCrud(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()
	a, b := bookDoc(t, c, "One"), bookDoc(t, c, "Two")

	saved, err := c.SaveBook(ctx, connect.NewRequest(&opendesignerv1.SaveBookRequest{Book: &opendesignerv1.Book{Name: " My book ", DocIds: []string{a, b}}}))
	if err != nil {
		t.Fatal(err)
	}
	if saved.Msg.GetId() == "" || saved.Msg.GetName() != "My book" {
		t.Fatalf("saved %v", saved.Msg)
	}
	l, _ := c.ListBooks(ctx, connect.NewRequest(&opendesignerv1.ListBooksRequest{}))
	if len(l.Msg.GetBooks()) != 1 {
		t.Fatalf("books %v", l.Msg.GetBooks())
	}
	// Replace: reorder and rename.
	saved.Msg.Name, saved.Msg.DocIds = "Renamed", []string{b, a}
	if _, err := c.SaveBook(ctx, connect.NewRequest(&opendesignerv1.SaveBookRequest{Book: saved.Msg})); err != nil {
		t.Fatal(err)
	}
	g, err := c.GetBook(ctx, connect.NewRequest(&opendesignerv1.GetBookRequest{BookId: saved.Msg.GetId()}))
	if err != nil {
		t.Fatal(err)
	}
	if g.Msg.GetBook().GetName() != "Renamed" || g.Msg.GetChapters()[0].GetDocId() != b || g.Msg.GetChapters()[0].GetName() != "Two" {
		t.Fatalf("book %v", g.Msg)
	}

	// Refused: empty name, duplicate or unknown chapter, a source that is not a chapter, an unknown book.
	for name, bk := range map[string]*opendesignerv1.Book{
		"name":      {DocIds: []string{a}},
		"duplicate": {Name: "x", DocIds: []string{a, a}},
		"unknown":   {Name: "x", DocIds: []string{uuid.NewString()}},
		"source":    {Name: "x", DocIds: []string{a}, StyleSourceId: b},
		"ghost":     {Id: "nope", Name: "x"},
	} {
		_, err := c.SaveBook(ctx, connect.NewRequest(&opendesignerv1.SaveBookRequest{Book: bk}))
		want := connect.CodeInvalidArgument
		if name == "ghost" {
			want = connect.CodeNotFound
		}
		if connect.CodeOf(err) != want {
			t.Errorf("%s: %v", name, err)
		}
	}
	if _, err := c.DeleteBook(ctx, connect.NewRequest(&opendesignerv1.DeleteBookRequest{BookId: saved.Msg.GetId()})); err != nil {
		t.Fatal(err)
	}
	if _, err := c.GetBook(ctx, connect.NewRequest(&opendesignerv1.GetBookRequest{BookId: saved.Msg.GetId()})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("after delete: %v", err)
	}
	// The documents survive their book.
	if l, _ := c.ListDocuments(ctx, connect.NewRequest(&opendesignerv1.ListDocumentsRequest{})); len(l.Msg.GetDocs()) != 2 {
		t.Fatalf("docs %v", l.Msg.GetDocs())
	}
}

func TestSyncBookNumbersChaptersContinuously(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()
	a, b, d := bookDoc(t, c, "A"), bookDoc(t, c, "B"), bookDoc(t, c, "C")
	// A document is made with one page; A gets 3 pages, B 2 (and a master, not counted), C 1.
	addPage(t, c, a, "a2")
	addPage(t, c, a, "a3")
	addPage(t, c, b, "b2")
	submitOp(t, c, b, &opendesignerv1.Op{Kind: &opendesignerv1.Op_CreatePage{CreatePage: &opendesignerv1.CreatePage{Page: &opendesignerv1.Page{Id: "m", Name: "M", IsMaster: true}}}})
	bk, err := c.SaveBook(ctx, connect.NewRequest(&opendesignerv1.SaveBookRequest{Book: &opendesignerv1.Book{Name: "B", DocIds: []string{a, b, d}, StartNumber: 5}}))
	if err != nil {
		t.Fatal(err)
	}
	g, _ := c.GetBook(ctx, connect.NewRequest(&opendesignerv1.GetBookRequest{BookId: bk.Msg.GetId()}))
	var firsts, pages []uint32
	for _, ch := range g.Msg.GetChapters() {
		firsts, pages = append(firsts, ch.GetFirstPageNumber()), append(pages, ch.GetPages())
	}
	if firsts[0] != 5 || firsts[1] != 8 || firsts[2] != 10 || pages[0] != 3 || pages[1] != 2 || pages[2] != 1 {
		t.Fatalf("firsts %v pages %v", firsts, pages)
	}
	r, err := c.SyncBook(ctx, connect.NewRequest(&opendesignerv1.SyncBookRequest{BookId: bk.Msg.GetId(), Numbering: true}))
	if err != nil {
		t.Fatal(err)
	}
	if r.Msg.GetNumberingApplied() != 3 {
		t.Fatalf("applied %d", r.Msg.GetNumberingApplied())
	}
	for i, id := range []string{a, b, d} {
		p := snapshotOf(t, c, id).GetPages()[0]
		if !p.GetSectionStart() || p.GetNumberStart() != firsts[i] || !r.Msg.GetChapters()[i].GetNumbered() {
			t.Errorf("chapter %d first page %v", i, p)
		}
	}
	// Idempotent; and a page added to A pushes the later chapters on at the next sync.
	r, _ = c.SyncBook(ctx, connect.NewRequest(&opendesignerv1.SyncBookRequest{BookId: bk.Msg.GetId()}))
	if r.Msg.GetNumberingApplied() != 0 {
		t.Fatalf("second sync applied %d", r.Msg.GetNumberingApplied())
	}
	addPage(t, c, a, "a4")
	r, _ = c.SyncBook(ctx, connect.NewRequest(&opendesignerv1.SyncBookRequest{BookId: bk.Msg.GetId()}))
	if r.Msg.GetNumberingApplied() != 2 || snapshotOf(t, c, d).GetPages()[0].GetNumberStart() != 11 {
		t.Fatalf("after a page: %v", r.Msg)
	}
}

func TestSyncBookCopiesStyles(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()
	a, b := bookDoc(t, c, "A"), bookDoc(t, c, "B")
	// "a-h2" is based on "h1" and sorts before it: the sync has to order them.
	submitOp(t, c, a, textStyle("h1", "Heading", "", 32))
	submitOp(t, c, a, textStyle("a-h2", "Sub", "h1", 24))
	submitOp(t, c, a, &opendesignerv1.Op{Kind: &opendesignerv1.Op_SetPaintStyleDef{SetPaintStyleDef: &opendesignerv1.SetPaintStyleDef{PaintStyle: &opendesignerv1.PaintStyleDef{Id: "brand", Name: "Brand", Paints: []*opendesignerv1.Paint{{Kind: &opendesignerv1.Paint_Solid{Solid: &opendesignerv1.SolidPaint{Color: &opendesignerv1.Color{R: 1, A: 1}}}}}}}}})
	// B has its own style, and an out-of-date h1.
	submitOp(t, c, b, textStyle("h1", "Old", "", 10))
	submitOp(t, c, b, textStyle("mine", "Mine", "", 12))
	bk, _ := c.SaveBook(ctx, connect.NewRequest(&opendesignerv1.SaveBookRequest{Book: &opendesignerv1.Book{Name: "S", DocIds: []string{a, b}}}))

	g, _ := c.GetBook(ctx, connect.NewRequest(&opendesignerv1.GetBookRequest{BookId: bk.Msg.GetId()}))
	if g.Msg.GetChapters()[0].GetStylesBehind() != 0 || g.Msg.GetChapters()[1].GetStylesBehind() != 3 {
		t.Fatalf("behind %v", g.Msg.GetChapters())
	}
	r, err := c.SyncBook(ctx, connect.NewRequest(&opendesignerv1.SyncBookRequest{BookId: bk.Msg.GetId(), Styles: true}))
	if err != nil {
		t.Fatal(err)
	}
	if r.Msg.GetStylesApplied() != 3 || r.Msg.GetNumberingApplied() != 0 {
		t.Fatalf("applied %v", r.Msg)
	}
	doc := snapshotOf(t, c, b)
	if doc.TextStyles["h1"].GetName() != "Heading" || doc.TextStyles["a-h2"].GetBasedOn() != "h1" || doc.PaintStyles["brand"] == nil || doc.TextStyles["mine"] == nil {
		t.Fatalf("styles %v %v", doc.TextStyles, doc.PaintStyles)
	}
	if r, _ = c.SyncBook(ctx, connect.NewRequest(&opendesignerv1.SyncBookRequest{BookId: bk.Msg.GetId(), Styles: true})); r.Msg.GetStylesApplied() != 0 {
		t.Fatalf("not idempotent: %v", r.Msg)
	}

	// An explicit source other than the first; then a chapter whose document is gone, which is skipped.
	submitOp(t, c, b, textStyle("h1", "From B", "", 40))
	bk.Msg.StyleSourceId = b
	if _, err := c.SaveBook(ctx, connect.NewRequest(&opendesignerv1.SaveBookRequest{Book: bk.Msg})); err != nil {
		t.Fatal(err)
	}
	if _, err := c.SyncBook(ctx, connect.NewRequest(&opendesignerv1.SyncBookRequest{BookId: bk.Msg.GetId(), Styles: true})); err != nil {
		t.Fatal(err)
	}
	if snapshotOf(t, c, a).TextStyles["h1"].GetName() != "From B" {
		t.Fatal("source not honoured")
	}
	if _, err := c.DeleteDocument(ctx, connect.NewRequest(&opendesignerv1.DeleteDocumentRequest{DocId: a})); err != nil {
		t.Fatal(err)
	}
	g, _ = c.GetBook(ctx, connect.NewRequest(&opendesignerv1.GetBookRequest{BookId: bk.Msg.GetId()}))
	if !g.Msg.GetChapters()[0].GetMissing() {
		t.Fatalf("chapters %v", g.Msg.GetChapters())
	}
	if _, err := c.SyncBook(ctx, connect.NewRequest(&opendesignerv1.SyncBookRequest{BookId: bk.Msg.GetId()})); err != nil {
		t.Fatal(err)
	}
	if p := snapshotOf(t, c, b).GetPages()[0]; p.GetNumberStart() != 1 {
		t.Fatalf("a missing chapter must not leave a gap: %v", p)
	}
}
