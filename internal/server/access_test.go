package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1/opendesignerv1connect"
)

type accessEnv struct {
	m   *Manager
	url string
	hc  *http.Client
}

func newAccessEnv(t *testing.T) *accessEnv {
	t.Helper()
	m := NewManager(t.TempDir())
	m.SetAdminToken("admin-secret")
	svc := NewDocumentService(m)
	path, handler := opendesignerv1connect.NewDocumentServiceHandler(svc, connect.WithInterceptors(NewAccessInterceptor(m)))
	mux := httpMux(path, handler)
	mux.Handle(AssetPrefix, m.GuardAssets(NewAssetHandler(m.workspace)))
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return &accessEnv{m: m, url: srv.URL, hc: srv.Client()}
}

// as returns a client that presents `token` ("" = none). remote=true makes it look like it came
// through a proxy (the test server is on loopback, which would otherwise make every caller trusted).
func (e *accessEnv) as(token string, remote bool) opendesignerv1connect.DocumentServiceClient {
	return opendesignerv1connect.NewDocumentServiceClient(e.hc, e.url, connect.WithInterceptors(&headerInterceptor{token: token, remote: remote}))
}

// headerInterceptor sets the access headers on unary calls AND streams.
type headerInterceptor struct {
	token  string
	remote bool
}

func (h *headerInterceptor) set(hd http.Header) {
	if h.token != "" {
		hd.Set("Authorization", "Bearer "+h.token)
	}
	if h.remote {
		hd.Set("X-Forwarded-For", "203.0.113.9")
	}
}

func (h *headerInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		h.set(req.Header())
		return next(ctx, req)
	}
}

func (h *headerInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return func(ctx context.Context, spec connect.Spec) connect.StreamingClientConn {
		conn := next(ctx, spec)
		h.set(conn.RequestHeader())
		return conn
	}
}

func (h *headerInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return next
}

func code(err error) connect.Code {
	if err == nil {
		return 0
	}
	return connect.CodeOf(err)
}

func TestProtectingADocumentAndItsRoles(t *testing.T) {
	e := newAccessEnv(t)
	ctx := context.Background()
	local := e.as("", false)
	info, err := local.CreateDocument(ctx, connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: "Secret"}))
	if err != nil {
		t.Fatal(err)
	}
	doc := info.Msg.GetId()
	submit(t, local, doc, rectOp("a"))

	// Open to everyone until protected -- and only the trusted machine can protect it.
	stranger := e.as("", true)
	if _, err := stranger.OpenDocument(ctx, connect.NewRequest(&opendesignerv1.OpenRequest{DocId: doc})); err != nil {
		t.Fatalf("an unprotected document must stay open: %v", err)
	}
	if _, err := stranger.EnableAccess(ctx, connect.NewRequest(&opendesignerv1.EnableAccessRequest{DocId: doc})); code(err) != connect.CodePermissionDenied {
		t.Fatalf("a remote stranger protecting the document: %v", err)
	}
	en, err := local.EnableAccess(ctx, connect.NewRequest(&opendesignerv1.EnableAccessRequest{DocId: doc}))
	if err != nil || en.Msg.GetOwnerToken() == "" {
		t.Fatalf("enable: %v", err)
	}
	owner := e.as(en.Msg.GetOwnerToken(), true)
	if _, err := local.EnableAccess(ctx, connect.NewRequest(&opendesignerv1.EnableAccessRequest{DocId: doc})); err == nil {
		t.Fatal("protecting twice must fail")
	}

	// Nothing gets in without a link.
	if _, err := stranger.OpenDocument(ctx, connect.NewRequest(&opendesignerv1.OpenRequest{DocId: doc})); code(err) != connect.CodeUnauthenticated {
		t.Fatalf("open without a link: %v", err)
	}
	if _, err := e.as("not-a-token", true).OpenDocument(ctx, connect.NewRequest(&opendesignerv1.OpenRequest{DocId: doc})); code(err) != connect.CodePermissionDenied {
		t.Fatalf("open with a wrong token: %v", err)
	}

	mk := func(role string) opendesignerv1connect.DocumentServiceClient {
		r, err := owner.CreateShareLink(ctx, connect.NewRequest(&opendesignerv1.CreateShareLinkRequest{DocId: doc, Role: role, Label: role + " link"}))
		if err != nil {
			t.Fatalf("%s link: %v", role, err)
		}
		return e.as(r.Msg.GetToken(), true)
	}
	viewer, commenter, editor := mk("view"), mk("comment"), mk("edit")

	comment := &opendesignerv1.Op{OpId: "c1", DocId: doc, Kind: &opendesignerv1.Op_SetComment{SetComment: &opendesignerv1.SetComment{Comment: &opendesignerv1.Comment{Id: "c", Text: "hi", Author: "x", PageId: "page1"}}}}
	edit := setX("a", 5)
	edit.DocId = doc
	try := func(c opendesignerv1connect.DocumentServiceClient, op *opendesignerv1.Op) error {
		_, err := c.SubmitOp(ctx, connect.NewRequest(&opendesignerv1.SubmitOpRequest{DocId: doc, ClientId: "t", Op: op}))
		return err
	}
	// view: reads, cannot write anything.
	if _, err := viewer.OpenDocument(ctx, connect.NewRequest(&opendesignerv1.OpenRequest{DocId: doc})); err != nil {
		t.Fatalf("viewer open: %v", err)
	}
	if code(try(viewer, edit)) != connect.CodePermissionDenied || code(try(viewer, comment)) != connect.CodePermissionDenied {
		t.Fatal("a viewer must not write")
	}
	// comment: comments, but no edits.
	if err := try(commenter, comment); err != nil {
		t.Fatalf("a commenter commenting: %v", err)
	}
	if code(try(commenter, edit)) != connect.CodePermissionDenied {
		t.Fatal("a commenter must not edit")
	}
	// edit: edits, but does not manage access, delete, or protect.
	if err := try(editor, edit); err != nil {
		t.Fatalf("an editor editing: %v", err)
	}
	if _, err := editor.CreateShareLink(ctx, connect.NewRequest(&opendesignerv1.CreateShareLinkRequest{DocId: doc, Role: "edit"})); code(err) != connect.CodePermissionDenied {
		t.Fatalf("an editor making links: %v", err)
	}
	if _, err := editor.DeleteDocument(ctx, connect.NewRequest(&opendesignerv1.DeleteDocumentRequest{DocId: doc})); code(err) != connect.CodePermissionDenied {
		t.Fatalf("an editor deleting: %v", err)
	}
	if _, err := editor.CreateVersion(ctx, connect.NewRequest(&opendesignerv1.CreateVersionRequest{DocId: doc, Name: "v"})); err != nil {
		t.Fatalf("an editor saving a version: %v", err)
	}
	if _, err := viewer.CreateVersion(ctx, connect.NewRequest(&opendesignerv1.CreateVersionRequest{DocId: doc, Name: "v"})); code(err) != connect.CodePermissionDenied {
		t.Fatalf("a viewer saving a version: %v", err)
	}

	// Who am I?
	for c, want := range map[opendesignerv1connect.DocumentServiceClient]string{viewer: "view", commenter: "comment", editor: "edit", owner: "owner", local: "owner"} {
		r, err := c.GetAccess(ctx, connect.NewRequest(&opendesignerv1.GetAccessRequest{DocId: doc}))
		if err != nil || r.Msg.GetRole() != want || !r.Msg.GetEnabled() {
			t.Fatalf("GetAccess want %s: %v %v", want, r, err)
		}
		if (want == "owner") != (len(r.Msg.GetLinks()) > 0) {
			t.Fatalf("links must be shown to owners only (%s): %v", want, r.Msg.GetLinks())
		}
	}

	// The protected document is not even listed to a stranger, but is to the machine itself.
	if l, _ := stranger.ListDocuments(ctx, connect.NewRequest(&opendesignerv1.ListDocumentsRequest{})); len(l.Msg.GetDocs()) != 0 {
		t.Fatalf("a protected document was listed to a stranger: %v", l.Msg.GetDocs())
	}
	if l, _ := local.ListDocuments(ctx, connect.NewRequest(&opendesignerv1.ListDocumentsRequest{})); len(l.Msg.GetDocs()) != 1 {
		t.Fatal("the machine running the server must see it")
	}

	// A revoked link stops working at once.
	links, _ := owner.GetAccess(ctx, connect.NewRequest(&opendesignerv1.GetAccessRequest{DocId: doc}))
	for _, l := range links.Msg.GetLinks() {
		if l.GetRole() == "view" {
			if _, err := owner.RevokeShareLink(ctx, connect.NewRequest(&opendesignerv1.RevokeShareLinkRequest{DocId: doc, LinkId: l.GetId()})); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := viewer.OpenDocument(ctx, connect.NewRequest(&opendesignerv1.OpenRequest{DocId: doc})); err == nil {
		t.Fatal("a revoked link still works")
	}

	// Switching protection off opens the document again.
	if _, err := owner.DisableAccess(ctx, connect.NewRequest(&opendesignerv1.DisableAccessRequest{DocId: doc})); err != nil {
		t.Fatal(err)
	}
	if _, err := stranger.OpenDocument(ctx, connect.NewRequest(&opendesignerv1.OpenRequest{DocId: doc})); err != nil {
		t.Fatalf("after disabling: %v", err)
	}
}

func TestTheAdminTokenAndStreams(t *testing.T) {
	e := newAccessEnv(t)
	ctx := context.Background()
	local := e.as("", false)
	info, _ := local.CreateDocument(ctx, connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: "S"}))
	doc := info.Msg.GetId()
	en, _ := local.EnableAccess(ctx, connect.NewRequest(&opendesignerv1.EnableAccessRequest{DocId: doc}))

	// The admin token manages a document it holds no link to, from anywhere.
	admin := e.as("admin-secret", true)
	if _, err := admin.CreateShareLink(ctx, connect.NewRequest(&opendesignerv1.CreateShareLinkRequest{DocId: doc, Role: "view"})); err != nil {
		t.Fatalf("admin: %v", err)
	}
	if _, err := admin.CreateShareLink(ctx, connect.NewRequest(&opendesignerv1.CreateShareLinkRequest{DocId: doc, Role: "boss"})); code(err) != connect.CodeInvalidArgument {
		t.Fatalf("a made-up role: %v", err)
	}

	// Streams are guarded too: without a link Subscribe fails on its first message.
	stream, err := e.as("", true).Subscribe(ctx, connect.NewRequest(&opendesignerv1.SubscribeRequest{DocId: doc}))
	if err == nil {
		for stream.Receive() {
		}
		err = stream.Err()
	}
	if code(err) != connect.CodeUnauthenticated {
		t.Fatalf("a stream without a link: %v", err)
	}
	ok, err := e.as(en.Msg.GetOwnerToken(), true).WatchPresence(ctx, connect.NewRequest(&opendesignerv1.WatchPresenceRequest{DocId: doc, ClientId: "c", Nickname: "n"}))
	if err != nil {
		t.Fatal(err)
	}
	if !ok.Receive() { // the server's "ready"
		t.Fatalf("an owner's presence stream: %v", ok.Err())
	}
	_ = ok.Close()
}

func TestProtectedAssets(t *testing.T) {
	e := newAccessEnv(t)
	ctx := context.Background()
	local := e.as("", false)
	info, _ := local.CreateDocument(ctx, connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: "S"}))
	doc := info.Msg.GetId()
	en, _ := local.EnableAccess(ctx, connect.NewRequest(&opendesignerv1.EnableAccessRequest{DocId: doc}))
	view, _ := e.as(en.Msg.GetOwnerToken(), true).CreateShareLink(ctx, connect.NewRequest(&opendesignerv1.CreateShareLinkRequest{DocId: doc, Role: "view"}))

	do := func(method, token string, query bool) int {
		url := e.url + AssetPrefix + doc
		if method == http.MethodGet {
			url += "/" + strings.Repeat("a", 64)
		}
		if query && token != "" {
			url += "?k=" + token
		}
		req, _ := http.NewRequest(method, url, strings.NewReader("\x89PNG\r\n\x1a\nxxxx"))
		req.Header.Set("X-Forwarded-For", "203.0.113.9")
		if !query && token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := e.hc.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, resp.Body)
		return resp.StatusCode
	}
	if s := do(http.MethodGet, "", false); s != http.StatusForbidden {
		t.Fatalf("an asset without a link: %d", s)
	}
	// With a view link the route is reached (the file does not exist: 404, not 403), via header or ?k=.
	if s := do(http.MethodGet, view.Msg.GetToken(), true); s != http.StatusNotFound {
		t.Fatalf("an asset with a view link in the URL: %d", s)
	}
	if s := do(http.MethodGet, view.Msg.GetToken(), false); s != http.StatusNotFound {
		t.Fatalf("an asset with a view link in a header: %d", s)
	}
	if s := do(http.MethodPost, view.Msg.GetToken(), false); s != http.StatusForbidden {
		t.Fatalf("a viewer uploading: %d", s)
	}
	if s := do(http.MethodPost, en.Msg.GetOwnerToken(), false); s != http.StatusOK && s != http.StatusCreated {
		t.Fatalf("an owner uploading: %d", s)
	}
}

func TestMergeNeedsEditOnBothDocuments(t *testing.T) {
	e := newAccessEnv(t)
	ctx := context.Background()
	local := e.as("", false)
	info, _ := local.CreateDocument(ctx, connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: "Main"}))
	doc := info.Msg.GetId()
	submit(t, local, doc, rectOp("a"))
	br, _ := local.BranchDocument(ctx, connect.NewRequest(&opendesignerv1.BranchRequest{DocId: doc, Name: "Try"}))
	// Protect only the original; the branch stays open.
	if _, err := local.EnableAccess(ctx, connect.NewRequest(&opendesignerv1.EnableAccessRequest{DocId: doc})); err != nil {
		t.Fatal(err)
	}
	if _, err := e.as("", true).ReviewMerge(ctx, connect.NewRequest(&opendesignerv1.ReviewMergeRequest{DocId: br.Msg.GetId()})); code(err) != connect.CodePermissionDenied {
		t.Fatalf("reviewing a merge into a protected original without a link: %v", err)
	}
	if _, err := local.ReviewMerge(ctx, connect.NewRequest(&opendesignerv1.ReviewMergeRequest{DocId: br.Msg.GetId()})); err != nil {
		t.Fatalf("the machine running the server: %v", err)
	}
}

func TestImportFigRejectsWhatIsNotAFigFileAndNeedsEdit(t *testing.T) {
	e := newAccessEnv(t)
	ctx := context.Background()
	local := e.as("", false)
	info, _ := local.CreateDocument(ctx, connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: "S"}))
	doc := info.Msg.GetId()
	if _, err := local.ImportFig(ctx, connect.NewRequest(&opendesignerv1.ImportFigRequest{DocId: doc, Data: []byte("not a fig file"), Name: "x.fig"})); code(err) != connect.CodeInvalidArgument {
		t.Fatalf("garbage: %v", err)
	}
	if _, err := local.ImportFig(ctx, connect.NewRequest(&opendesignerv1.ImportFigRequest{DocId: "00000000-0000-0000-0000-000000000000", Data: []byte("x")})); code(err) != connect.CodeNotFound {
		t.Fatalf("unknown document: %v", err)
	}
	en, _ := local.EnableAccess(ctx, connect.NewRequest(&opendesignerv1.EnableAccessRequest{DocId: doc}))
	view, _ := e.as(en.Msg.GetOwnerToken(), true).CreateShareLink(ctx, connect.NewRequest(&opendesignerv1.CreateShareLinkRequest{DocId: doc, Role: "view"}))
	if _, err := e.as(view.Msg.GetToken(), true).ImportFig(ctx, connect.NewRequest(&opendesignerv1.ImportFigRequest{DocId: doc, Data: []byte("x")})); code(err) != connect.CodePermissionDenied {
		t.Fatalf("a viewer importing: %v", err)
	}
}
