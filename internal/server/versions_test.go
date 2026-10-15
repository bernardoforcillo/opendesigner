package server

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
)

func rectOp(id string) *opendesignerv1.Op {
	return &opendesignerv1.Op{OpId: "op-" + id, Kind: &opendesignerv1.Op_CreateNode{CreateNode: &opendesignerv1.CreateNode{Node: &opendesignerv1.Node{
		Id: id, ParentId: "page1", OrderKey: "a" + id, Name: id, Visible: true, Opacity: 1, Width: 10, Height: 10,
		Shape: &opendesignerv1.Node_Rect{Rect: &opendesignerv1.RectNode{}},
	}}}}
}

func submit(t *testing.T, c interface {
	SubmitOp(context.Context, *connect.Request[opendesignerv1.SubmitOpRequest]) (*connect.Response[opendesignerv1.SubmitOpResponse], error)
}, doc string, op *opendesignerv1.Op) {
	t.Helper()
	op.DocId = doc
	if _, err := c.SubmitOp(context.Background(), connect.NewRequest(&opendesignerv1.SubmitOpRequest{DocId: doc, ClientId: "t", Op: op})); err != nil {
		t.Fatal(err)
	}
}

func nodeIDs(t *testing.T, c interface {
	OpenDocument(context.Context, *connect.Request[opendesignerv1.OpenRequest]) (*connect.Response[opendesignerv1.OpenResponse], error)
}, doc string) map[string]bool {
	t.Helper()
	r, err := c.OpenDocument(context.Background(), connect.NewRequest(&opendesignerv1.OpenRequest{DocId: doc}))
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for id := range r.Msg.GetSnapshot().GetNodes() {
		out[id] = true
	}
	return out
}

// TestVersionsAndBranches: a named version freezes the document; a branch opens a version (or
// the current state) as a NEW document that evolves on its own, with the assets it uses.
func TestVersionsAndBranches(t *testing.T) {
	ws := t.TempDir()
	c, m := newTestClientWithManager(t, ws)
	ctx := context.Background()
	info, err := c.CreateDocument(ctx, connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: "Main"}))
	if err != nil {
		t.Fatal(err)
	}
	doc := info.Msg.GetId()
	submit(t, c, doc, rectOp("a"))
	// An asset the document uses: it must follow a branch.
	if _, err := m.Assets(doc).Put(bytesReader("\x89PNG\r\n\x1a\n tiny")); err != nil {
		t.Fatal(err)
	}

	v1, err := c.CreateVersion(ctx, connect.NewRequest(&opendesignerv1.CreateVersionRequest{DocId: doc, Name: "  First draft  "}))
	if err != nil || v1.Msg.GetName() != "First draft" || v1.Msg.GetSeq() == 0 {
		t.Fatalf("CreateVersion = %+v %v", v1.Msg, err)
	}
	submit(t, c, doc, rectOp("b"))
	if _, err := c.CreateVersion(ctx, connect.NewRequest(&opendesignerv1.CreateVersionRequest{DocId: doc, Name: "Second"})); err != nil {
		t.Fatal(err)
	}
	list, err := c.ListVersions(ctx, connect.NewRequest(&opendesignerv1.ListVersionsRequest{DocId: doc}))
	if err != nil || len(list.Msg.GetVersions()) != 2 {
		t.Fatalf("ListVersions = %+v %v", list.Msg, err)
	}

	// Branch from the first version: only "a", under its own id and name; the original keeps both.
	br, err := c.BranchDocument(ctx, connect.NewRequest(&opendesignerv1.BranchRequest{DocId: doc, VersionId: v1.Msg.GetId(), Name: "Experiment"}))
	if err != nil || br.Msg.GetId() == doc || br.Msg.GetName() != "Experiment" {
		t.Fatalf("BranchDocument = %+v %v", br.Msg, err)
	}
	got := nodeIDs(t, c, br.Msg.GetId())
	if len(got) != 1 || !got["a"] {
		t.Fatalf("branch nodes = %v, want only a", got)
	}
	if orig := nodeIDs(t, c, doc); len(orig) != 2 {
		t.Fatalf("original nodes = %v", orig)
	}
	// The branch is independent: editing it does not touch the original.
	submit(t, c, br.Msg.GetId(), rectOp("z"))
	if orig := nodeIDs(t, c, doc); orig["z"] {
		t.Fatal("the branch leaked into the original")
	}
	// ...and has the assets (content-addressed files copied over).
	entries, err := os.ReadDir(filepath.Join(ws, br.Msg.GetId()+".opendesigner", "assets"))
	if err != nil || len(entries) == 0 {
		t.Fatalf("branch assets = %v %v", entries, err)
	}
	// Branch from the current state.
	cur, err := c.BranchDocument(ctx, connect.NewRequest(&opendesignerv1.BranchRequest{DocId: doc, Name: "Copy"}))
	if err != nil {
		t.Fatal(err)
	}
	if got := nodeIDs(t, c, cur.Msg.GetId()); len(got) != 2 {
		t.Fatalf("current-state branch nodes = %v", got)
	}

	// A version survives a restart of the server over the same workspace.
	c2 := newTestClientOn(t, ws)
	if l, err := c2.ListVersions(ctx, connect.NewRequest(&opendesignerv1.ListVersionsRequest{DocId: doc})); err != nil || len(l.Msg.GetVersions()) != 2 {
		t.Fatalf("after restart: %+v %v", l, err)
	}

	if _, err := c.DeleteVersion(ctx, connect.NewRequest(&opendesignerv1.DeleteVersionRequest{DocId: doc, VersionId: v1.Msg.GetId()})); err != nil {
		t.Fatal(err)
	}
	if l, _ := c.ListVersions(ctx, connect.NewRequest(&opendesignerv1.ListVersionsRequest{DocId: doc})); len(l.Msg.GetVersions()) != 1 {
		t.Fatalf("after delete: %+v", l.Msg)
	}
}

func TestVersionsRejectBadInput(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()
	info, _ := c.CreateDocument(ctx, connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: "Main"}))
	doc := info.Msg.GetId()
	code := func(err error) connect.Code { return connect.CodeOf(err) }
	if _, err := c.CreateVersion(ctx, connect.NewRequest(&opendesignerv1.CreateVersionRequest{DocId: doc, Name: "  "})); code(err) != connect.CodeInvalidArgument {
		t.Errorf("empty name: %v", err)
	}
	if _, err := c.CreateVersion(ctx, connect.NewRequest(&opendesignerv1.CreateVersionRequest{DocId: "11111111-1111-1111-1111-111111111111", Name: "x"})); code(err) != connect.CodeNotFound {
		t.Errorf("unknown document: %v", err)
	}
	for _, id := range []string{"../../etc/passwd", "nope", "11111111-1111-1111-1111-111111111111"} {
		if _, err := c.DeleteVersion(ctx, connect.NewRequest(&opendesignerv1.DeleteVersionRequest{DocId: doc, VersionId: id})); code(err) != connect.CodeNotFound {
			t.Errorf("delete %q: %v", id, err)
		}
		if _, err := c.BranchDocument(ctx, connect.NewRequest(&opendesignerv1.BranchRequest{DocId: doc, VersionId: id, Name: "x"})); code(err) != connect.CodeNotFound {
			t.Errorf("branch %q: %v", id, err)
		}
	}
}

type stringReader struct {
	s string
	i int
}

func (r *stringReader) Read(p []byte) (int, error) {
	if r.i >= len(r.s) {
		return 0, io.EOF
	}
	n := copy(p, r.s[r.i:])
	r.i += n
	return n, nil
}

func bytesReader(s string) *stringReader { return &stringReader{s: s} }

func setX(id string, x float64) *opendesignerv1.Op {
	return &opendesignerv1.Op{OpId: "setx-" + id, Kind: &opendesignerv1.Op_SetProps{SetProps: &opendesignerv1.SetProperties{
		Id: id, Patch: &opendesignerv1.Node{X: x}, Mask: &fieldmaskpb.FieldMask{Paths: []string{"x"}},
	}}}
}

func xOf(t *testing.T, c interface {
	OpenDocument(context.Context, *connect.Request[opendesignerv1.OpenRequest]) (*connect.Response[opendesignerv1.OpenResponse], error)
}, doc, id string) float64 {
	t.Helper()
	r, err := c.OpenDocument(context.Background(), connect.NewRequest(&opendesignerv1.OpenRequest{DocId: doc}))
	if err != nil {
		t.Fatal(err)
	}
	return r.Msg.GetSnapshot().GetNodes()[id].GetX()
}

// TestMergeABranchBack: a branch remembers its original; reviewing lists what it did (conflicts
// included) and merging applies it to the original as ordinary ops, all or nothing.
func TestMergeABranchBack(t *testing.T) {
	c, _ := newTestClientWithManager(t, t.TempDir())
	ctx := context.Background()
	info, err := c.CreateDocument(ctx, connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: "Main"}))
	if err != nil {
		t.Fatal(err)
	}
	doc := info.Msg.GetId()
	submit(t, c, doc, rectOp("a"))
	submit(t, c, doc, rectOp("b"))

	// A document that is not a branch.
	if o, err := c.GetBranchOrigin(ctx, connect.NewRequest(&opendesignerv1.GetBranchOriginRequest{DocId: doc})); err != nil || o.Msg.GetIsBranch() {
		t.Fatalf("origin of a plain document: %v %v", o, err)
	}
	if _, err := c.ReviewMerge(ctx, connect.NewRequest(&opendesignerv1.ReviewMergeRequest{DocId: doc})); err == nil {
		t.Fatal("reviewing a merge of a document that is not a branch must fail")
	}

	br, err := c.BranchDocument(ctx, connect.NewRequest(&opendesignerv1.BranchRequest{DocId: doc, Name: "Try"}))
	if err != nil {
		t.Fatal(err)
	}
	branch := br.Msg.GetId()
	if o, _ := c.GetBranchOrigin(ctx, connect.NewRequest(&opendesignerv1.GetBranchOriginRequest{DocId: branch})); !o.Msg.GetIsBranch() || o.Msg.GetSourceDocId() != doc || !o.Msg.GetSourceExists() || o.Msg.GetSourceName() != "Main" {
		t.Fatalf("origin = %v", o.Msg)
	}

	// Work on both sides: the branch moves a (and b), adds c; the original moves b elsewhere.
	submit(t, c, branch, setX("a", 40))
	submit(t, c, branch, setX("b", 70))
	submit(t, c, branch, rectOp("c"))
	submit(t, c, doc, setX("b", 99))

	rev, err := c.ReviewMerge(ctx, connect.NewRequest(&opendesignerv1.ReviewMergeRequest{DocId: branch}))
	if err != nil {
		t.Fatal(err)
	}
	if rev.Msg.GetSourceName() != "Main" || len(rev.Msg.GetChanges()) != 3 {
		t.Fatalf("review = %v", rev.Msg)
	}
	conflicts := 0
	for _, ch := range rev.Msg.GetChanges() {
		if ch.GetConflict() {
			conflicts++
			if ch.GetId() != "b" || ch.GetConflictPaths()[0] != "x" {
				t.Fatalf("wrong conflict: %v", ch)
			}
		}
	}
	if conflicts != 1 {
		t.Fatalf("conflicts = %d", conflicts)
	}

	res, err := c.MergeBranch(ctx, connect.NewRequest(&opendesignerv1.MergeBranchRequest{DocId: branch}))
	if err != nil {
		t.Fatal(err)
	}
	if res.Msg.GetApplied() != 2 || res.Msg.GetSkippedConflicts() != 1 {
		t.Fatalf("merge = %v", res.Msg)
	}
	if !nodeIDs(t, c, doc)["c"] || xOf(t, c, doc, "a") != 40 || xOf(t, c, doc, "b") != 99 {
		t.Fatal("the original did not get the branch's work, or lost its own")
	}

	// Merged work is not offered again, and the resolved conflict is not either.
	again, err := c.ReviewMerge(ctx, connect.NewRequest(&opendesignerv1.ReviewMergeRequest{DocId: branch}))
	if err != nil || len(again.Msg.GetChanges()) != 0 {
		t.Fatalf("second review = %v %v", again, err)
	}
}

// TestMergePreferringTheBranch takes the branch's side of a conflict.
func TestMergePreferringTheBranch(t *testing.T) {
	c, _ := newTestClientWithManager(t, t.TempDir())
	ctx := context.Background()
	info, _ := c.CreateDocument(ctx, connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: "Main"}))
	doc := info.Msg.GetId()
	submit(t, c, doc, rectOp("a"))
	br, _ := c.BranchDocument(ctx, connect.NewRequest(&opendesignerv1.BranchRequest{DocId: doc, Name: "Try"}))
	submit(t, c, br.Msg.GetId(), setX("a", 11))
	submit(t, c, doc, setX("a", 22))
	if _, err := c.MergeBranch(ctx, connect.NewRequest(&opendesignerv1.MergeBranchRequest{DocId: br.Msg.GetId(), PreferBranch: true})); err != nil {
		t.Fatal(err)
	}
	if got := xOf(t, c, doc, "a"); got != 11 {
		t.Fatalf("x = %v, want the branch's 11", got)
	}
}
