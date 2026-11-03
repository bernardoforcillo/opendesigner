package server

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/core"
	"github.com/bernardoforcillo/opendesigner/internal/store"
	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"
)

// BOOKS: several documents (the chapters) that share styles and one page count. A book is a small record in the
// workspace (store.BookRecord) that only names documents; syncing it writes ordinary ops into the chapters, so
// every edit a sync makes is in the chapter's own history, shared with whoever has it open, and can be undone.

var errBadBook = errors.New("invalid book")

const maxBookChapters = 200

func bookMsg(b store.BookRecord) *opendesignerv1.Book {
	return &opendesignerv1.Book{
		Id: b.ID, Name: b.Name, DocIds: append([]string{}, b.DocIDs...), StyleSourceId: b.StyleSourceID,
		StartNumber: b.StartNumber, UpdatedAt: b.UpdatedAt.Unix(),
	}
}

// ListBooks returns the books of the workspace.
func (m *Manager) ListBooks() ([]*opendesignerv1.Book, error) {
	recs, err := store.ListBooks(m.workspace)
	if err != nil {
		return nil, err
	}
	out := make([]*opendesignerv1.Book, 0, len(recs))
	for _, r := range recs {
		out = append(out, bookMsg(r))
	}
	return out, nil
}

// SaveBook creates (empty id) or replaces a book. The chapters must be existing documents, each once.
func (m *Manager) SaveBook(in *opendesignerv1.Book) (*opendesignerv1.Book, error) {
	name := strings.TrimSpace(in.GetName())
	if name == "" {
		return nil, errEmptyName
	}
	if utf8.RuneCountInString(name) > maxNameRunes {
		return nil, errNameTooLong
	}
	if len(in.GetDocIds()) > maxBookChapters {
		return nil, fmt.Errorf("%w: at most %d chapters", errBadBook, maxBookChapters)
	}
	seen := map[string]bool{}
	for _, id := range in.GetDocIds() {
		if seen[id] {
			return nil, fmt.Errorf("%w: chapter %s is listed twice", errBadBook, id)
		}
		seen[id] = true
		if !m.Exists(id) {
			return nil, fmt.Errorf("%w: %s: %v", errBadBook, id, ErrDocNotFound)
		}
	}
	if src := in.GetStyleSourceId(); src != "" && !seen[src] {
		return nil, fmt.Errorf("%w: the style source must be one of the chapters", errBadBook)
	}
	id := in.GetId()
	if id == "" {
		id = uuid.NewString()
	} else if _, err := store.LoadBook(m.workspace, id); err != nil {
		return nil, err
	}
	rec := store.BookRecord{
		ID: id, Name: name, DocIDs: append([]string{}, in.GetDocIds()...), StyleSourceID: in.GetStyleSourceId(),
		StartNumber: in.GetStartNumber(), UpdatedAt: time.Now().UTC().Truncate(time.Second),
	}
	if err := store.SaveBook(m.workspace, rec); err != nil {
		return nil, err
	}
	return bookMsg(rec), nil
}

// DeleteBook removes the book; its documents are left as they are.
func (m *Manager) DeleteBook(id string) error { return store.DeleteBook(m.workspace, id) }

// sourceOf is the chapter whose styles are the book's.
func sourceOf(b store.BookRecord) string {
	if b.StyleSourceID != "" {
		return b.StyleSourceID
	}
	if len(b.DocIDs) > 0 {
		return b.DocIDs[0]
	}
	return ""
}

// firstRegular is the index of the first page that is not a master, or -1.
func firstRegular(doc *opendesignerv1.Document) int {
	for i, p := range doc.GetPages() {
		if !p.GetIsMaster() {
			return i
		}
	}
	return -1
}

func regularCount(doc *opendesignerv1.Document) uint32 {
	n := uint32(0)
	for _, p := range doc.GetPages() {
		if !p.GetIsMaster() {
			n++
		}
	}
	return n
}

func effectiveStart(p *opendesignerv1.Page) uint32 {
	if p.GetNumberStart() == 0 {
		return 1
	}
	return p.GetNumberStart()
}

// styleOps are the ops that bring dst's shared styles into line with src's. A style only dst has is left alone.
func styleOps(src, dst *opendesignerv1.Document) []*opendesignerv1.Op {
	var ops []*opendesignerv1.Op
	add := func(k any) {
		op := &opendesignerv1.Op{}
		switch v := k.(type) {
		case *opendesignerv1.SetTextStyleDef:
			op.Kind = &opendesignerv1.Op_SetTextStyleDef{SetTextStyleDef: v}
		case *opendesignerv1.SetPaintStyleDef:
			op.Kind = &opendesignerv1.Op_SetPaintStyleDef{SetPaintStyleDef: v}
		case *opendesignerv1.SetEffectStyleDef:
			op.Kind = &opendesignerv1.Op_SetEffectStyleDef{SetEffectStyleDef: v}
		case *opendesignerv1.SetObjectStyleDef:
			op.Kind = &opendesignerv1.Op_SetObjectStyleDef{SetObjectStyleDef: v}
		}
		ops = append(ops, op)
	}
	for _, id := range sortedKeys(src.GetTextStyles()) {
		if d := src.TextStyles[id]; !proto.Equal(d, dst.GetTextStyles()[id]) {
			add(&opendesignerv1.SetTextStyleDef{TextStyle: proto.Clone(d).(*opendesignerv1.TextStyleDef)})
		}
	}
	for _, id := range sortedKeys(src.GetPaintStyles()) {
		if d := src.PaintStyles[id]; !proto.Equal(d, dst.GetPaintStyles()[id]) {
			add(&opendesignerv1.SetPaintStyleDef{PaintStyle: proto.Clone(d).(*opendesignerv1.PaintStyleDef)})
		}
	}
	for _, id := range sortedKeys(src.GetEffectStyles()) {
		if d := src.EffectStyles[id]; !proto.Equal(d, dst.GetEffectStyles()[id]) {
			add(&opendesignerv1.SetEffectStyleDef{EffectStyle: proto.Clone(d).(*opendesignerv1.EffectStyleDef)})
		}
	}
	for _, id := range sortedKeys(src.GetObjectStyles()) {
		if d := src.ObjectStyles[id]; !proto.Equal(d, dst.GetObjectStyles()[id]) {
			add(&opendesignerv1.SetObjectStyleDef{ObjectStyle: proto.Clone(d).(*opendesignerv1.ObjectStyleDef)})
		}
	}
	return ops
}

func sortedKeys[V any](m map[string]V) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

// numberingOp makes the first page of doc start at n, or nil when it already does.
func numberingOp(doc *opendesignerv1.Document, n uint32) *opendesignerv1.Op {
	i := firstRegular(doc)
	if i < 0 {
		return nil
	}
	p := doc.Pages[i]
	if p.GetSectionStart() && effectiveStart(p) == n {
		return nil
	}
	np := proto.Clone(p).(*opendesignerv1.Page)
	np.SectionStart = true
	np.NumberStart = n
	return &opendesignerv1.Op{Kind: &opendesignerv1.Op_UpdatePage{UpdatePage: &opendesignerv1.UpdatePage{Page: np}}}
}

type bookState struct {
	rec      store.BookRecord
	docs     map[string]*opendesignerv1.Document // existing chapters
	chapters []*opendesignerv1.BookChapter
}

// bookState reads the chapters and works out where each one's numbering starts.
func (m *Manager) bookState(id string) (*bookState, error) {
	rec, err := store.LoadBook(m.workspace, id)
	if err != nil {
		return nil, err
	}
	st := &bookState{rec: rec, docs: map[string]*opendesignerv1.Document{}}
	next := rec.StartNumber
	if next == 0 {
		next = 1
	}
	var src *opendesignerv1.Document
	for _, did := range rec.DocIDs {
		ch := &opendesignerv1.BookChapter{DocId: did}
		if !m.Exists(did) {
			ch.Missing = true
			st.chapters = append(st.chapters, ch)
			continue
		}
		h, err := m.HubFor(did)
		if err != nil {
			return nil, err
		}
		doc, _ := h.Snapshot()
		st.docs[did] = doc
		ch.Name = doc.GetName()
		ch.Pages = regularCount(doc)
		ch.FirstPageNumber = next
		if i := firstRegular(doc); i >= 0 {
			p := doc.Pages[i]
			ch.Numbered = p.GetSectionStart() && effectiveStart(p) == next
		}
		next += ch.Pages
		st.chapters = append(st.chapters, ch)
	}
	if sid := sourceOf(rec); sid != "" {
		src = st.docs[sid]
	}
	if src != nil {
		for _, ch := range st.chapters {
			if d := st.docs[ch.DocId]; d != nil && ch.DocId != sourceOf(rec) {
				ch.StylesBehind = uint32(len(styleOps(src, d)))
			}
		}
	}
	return st, nil
}

// GetBook returns a book with its chapters.
func (m *Manager) GetBook(id string) (*opendesignerv1.GetBookResponse, error) {
	st, err := m.bookState(id)
	if err != nil {
		return nil, err
	}
	return &opendesignerv1.GetBookResponse{Book: bookMsg(st.rec), Chapters: st.chapters}, nil
}

// SyncBook brings the chapters into line: styles (the source's into every other chapter) and numbering (each
// chapter continues where the one before ends). All or nothing: every op is checked against a copy of its
// document before any is submitted. Both flags false means both.
func (m *Manager) SyncBook(id string, styles, numbering bool) (*opendesignerv1.SyncBookResponse, error) {
	if !styles && !numbering {
		styles, numbering = true, true
	}
	st, err := m.bookState(id)
	if err != nil {
		return nil, err
	}
	source := sourceOf(st.rec)
	type plan struct {
		ops              []*opendesignerv1.Op
		styles, numbered int
	}
	plans := map[string]*plan{}
	for _, ch := range st.chapters {
		doc := st.docs[ch.DocId]
		if doc == nil {
			continue
		}
		scratch := proto.Clone(doc).(*opendesignerv1.Document)
		p := &plan{}
		if styles && ch.DocId != source && st.docs[source] != nil {
			ordered, err := applyInOrder(scratch, styleOps(st.docs[source], doc))
			if err != nil {
				return nil, fmt.Errorf("the styles would not apply to %q: %w", ch.Name, err)
			}
			p.ops = append(p.ops, ordered...)
			p.styles = len(ordered)
		}
		if numbering {
			if op := numberingOp(scratch, ch.FirstPageNumber); op != nil {
				if err := core.Apply(scratch, proto.Clone(op).(*opendesignerv1.Op)); err != nil {
					return nil, fmt.Errorf("the numbering would not apply to %q: %w", ch.Name, err)
				}
				p.ops = append(p.ops, op)
				p.numbered = 1
			}
		}
		plans[ch.DocId] = p
	}
	out := &opendesignerv1.SyncBookResponse{}
	for _, ch := range st.chapters {
		p := plans[ch.DocId]
		if p == nil {
			continue
		}
		h, err := m.HubFor(ch.DocId)
		if err != nil {
			return nil, err
		}
		for _, op := range p.ops {
			op.OpId, op.DocId = uuid.NewString(), ch.DocId
			if _, err := h.Submit("book-"+id, op); err != nil {
				return nil, err
			}
		}
		out.StylesApplied += uint32(p.styles)
		out.NumberingApplied += uint32(p.numbered)
	}
	after, err := m.bookState(id)
	if err != nil {
		return nil, err
	}
	out.Chapters = after.chapters
	return out, nil
}

// applyInOrder applies ops to scratch, retrying the ones that fail until no more succeed, so a style that is
// based on another can be listed before it. The ops that succeeded are returned in the order that worked.
func applyInOrder(scratch *opendesignerv1.Document, ops []*opendesignerv1.Op) ([]*opendesignerv1.Op, error) {
	var done []*opendesignerv1.Op
	pending := ops
	for len(pending) > 0 {
		var failed []*opendesignerv1.Op
		var firstErr error
		for _, op := range pending {
			if err := core.Apply(scratch, proto.Clone(op).(*opendesignerv1.Op)); err != nil {
				if firstErr == nil {
					firstErr = err
				}
				failed = append(failed, op)
				continue
			}
			done = append(done, op)
		}
		if len(failed) == len(pending) {
			return nil, firstErr
		}
		pending = failed
	}
	return done, nil
}

// ---- access: books name several documents, the caller needs the right on every one ----

func (m *Manager) authorizeBook(name string, msg any, c caller) (handled bool, err error) {
	var need role
	var ids []string
	switch name {
	case "GetBook":
		need = roleView
		ids = m.bookDocIDs(msg.(*opendesignerv1.GetBookRequest).GetBookId())
	case "SyncBook":
		need = roleEdit
		ids = m.bookDocIDs(msg.(*opendesignerv1.SyncBookRequest).GetBookId())
	case "DeleteBook":
		need = roleEdit
		ids = m.bookDocIDs(msg.(*opendesignerv1.DeleteBookRequest).GetBookId())
	case "SaveBook":
		need = roleEdit
		b := msg.(*opendesignerv1.SaveBookRequest).GetBook()
		ids = append(m.bookDocIDs(b.GetId()), b.GetDocIds()...)
	default:
		return false, nil
	}
	for _, id := range ids {
		if have, _ := m.roleFor(id, c); have < need {
			return true, connect.NewError(connect.CodePermissionDenied, fmt.Errorf("the book names a document you may not use that way (%s access is needed)", need))
		}
	}
	return true, nil
}

func (m *Manager) bookDocIDs(bookID string) []string {
	if bookID == "" {
		return nil
	}
	if b, err := store.LoadBook(m.workspace, bookID); err == nil {
		return b.DocIDs
	}
	return nil
}

// visibleBooks leaves out the books that name a document the caller may not see.
func (m *Manager) visibleBooks(books []*opendesignerv1.Book, c caller) []*opendesignerv1.Book {
	if c.trusted {
		return books
	}
	out := books[:0:0]
	for _, b := range books {
		ok := true
		for _, id := range b.GetDocIds() {
			if have, _ := m.roleFor(id, c); have < roleView {
				ok = false
				break
			}
		}
		if ok {
			out = append(out, b)
		}
	}
	return out
}

func bookErr(err error) error {
	switch {
	case errors.Is(err, store.ErrNoBook), errors.Is(err, ErrDocNotFound):
		return connect.NewError(connect.CodeNotFound, err)
	case errors.Is(err, errBadBook), errors.Is(err, errEmptyName), errors.Is(err, errNameTooLong):
		return connect.NewError(connect.CodeInvalidArgument, err)
	default:
		return connect.NewError(connect.CodeInternal, err)
	}
}

func (s *DocumentService) ListBooks(ctx context.Context, _ *connect.Request[opendesignerv1.ListBooksRequest]) (*connect.Response[opendesignerv1.ListBooksResponse], error) {
	books, err := s.m.ListBooks()
	if err != nil {
		return nil, bookErr(err)
	}
	return connect.NewResponse(&opendesignerv1.ListBooksResponse{Books: s.m.visibleBooks(books, callerOf(ctx))}), nil
}

func (s *DocumentService) GetBook(_ context.Context, req *connect.Request[opendesignerv1.GetBookRequest]) (*connect.Response[opendesignerv1.GetBookResponse], error) {
	r, err := s.m.GetBook(req.Msg.GetBookId())
	if err != nil {
		return nil, bookErr(err)
	}
	return connect.NewResponse(r), nil
}

func (s *DocumentService) SaveBook(_ context.Context, req *connect.Request[opendesignerv1.SaveBookRequest]) (*connect.Response[opendesignerv1.Book], error) {
	b, err := s.m.SaveBook(req.Msg.GetBook())
	if err != nil {
		return nil, bookErr(err)
	}
	return connect.NewResponse(b), nil
}

func (s *DocumentService) DeleteBook(_ context.Context, req *connect.Request[opendesignerv1.DeleteBookRequest]) (*connect.Response[opendesignerv1.DeleteBookResponse], error) {
	if err := s.m.DeleteBook(req.Msg.GetBookId()); err != nil {
		return nil, bookErr(err)
	}
	return connect.NewResponse(&opendesignerv1.DeleteBookResponse{}), nil
}

func (s *DocumentService) SyncBook(_ context.Context, req *connect.Request[opendesignerv1.SyncBookRequest]) (*connect.Response[opendesignerv1.SyncBookResponse], error) {
	r, err := s.m.SyncBook(req.Msg.GetBookId(), req.Msg.GetStyles(), req.Msg.GetNumbering())
	if err != nil {
		return nil, bookErr(err)
	}
	return connect.NewResponse(r), nil
}
