package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	"github.com/google/uuid"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/store"
)

// ACCESS CONTROL, without accounts. A document is open to anyone who can reach the server until it
// is PROTECTED; from then on every request must carry a share link's token and may do only what
// the link's role allows. The roles, weakest first:
//
//	view     read the document and follow it live
//	comment  view, and write comments
//	edit     comment, and change the document, branch it, save versions, rename it
//	owner    edit, and manage the links, and delete the document
//
// "Trusted" callers -- a request straight from the machine running the server, or one carrying the
// server's admin token -- are owners of every document. Behind a reverse proxy a request is
// no longer "straight from the machine" (the proxy's forwarding headers say so), so the admin token
// is what manages access there.

type role int

const (
	roleNone role = iota
	roleView
	roleComment
	roleEdit
	roleOwner
)

func (r role) String() string {
	switch r {
	case roleView:
		return "view"
	case roleComment:
		return "comment"
	case roleEdit:
		return "edit"
	case roleOwner:
		return "owner"
	}
	return "none"
}

func parseRole(s string) (role, bool) {
	for _, r := range []role{roleView, roleComment, roleEdit, roleOwner} {
		if r.String() == s {
			return r, true
		}
	}
	return roleNone, false
}

// SetAdminToken sets the server-wide secret that can manage access to any document from anywhere.
func (m *Manager) SetAdminToken(token string) { m.adminToken = token }

type accessState struct {
	mu    sync.Mutex
	cache map[string]store.Access
}

func (m *Manager) accessOf(docID string) store.Access {
	m.access.mu.Lock()
	defer m.access.mu.Unlock()
	if a, ok := m.access.cache[docID]; ok {
		return a
	}
	if !m.Exists(docID) {
		return store.Access{}
	}
	h, err := m.HubFor(docID)
	if err != nil {
		return store.Access{}
	}
	b, ok := h.versionStore()
	if !ok {
		return store.Access{}
	}
	a, err := b.LoadAccess()
	if err != nil {
		// An unreadable access file must not open a protected document.
		a = store.Access{Enabled: true}
	}
	if m.access.cache == nil {
		m.access.cache = map[string]store.Access{}
	}
	m.access.cache[docID] = a
	return a
}

func (m *Manager) saveAccess(docID string, a store.Access) error {
	_, b, err := m.bundleOf(docID)
	if err != nil {
		return err
	}
	if err := b.SaveAccess(a); err != nil {
		return err
	}
	m.access.mu.Lock()
	if m.access.cache == nil {
		m.access.cache = map[string]store.Access{}
	}
	m.access.cache[docID] = a
	m.access.mu.Unlock()
	return nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// caller is who is asking, as far as access goes.
type caller struct {
	trusted bool   // from this machine directly, or with the admin token
	token   string // the link token presented, if any
}

type callerKey struct{}

// tokenOf reads the link token from a request: Authorization: Bearer, or ?k= (for an <img>).
func tokenOf(h http.Header, query string) string {
	if v := h.Get("Authorization"); strings.HasPrefix(v, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(v, "Bearer "))
	}
	if query != "" {
		return query
	}
	return ""
}

// identify says who a request is from its headers and peer address.
func (m *Manager) identify(h http.Header, peer, queryToken string) caller {
	c := caller{token: tokenOf(h, queryToken)}
	if m.adminToken != "" && c.token != "" && subtle.ConstantTimeCompare([]byte(c.token), []byte(m.adminToken)) == 1 {
		c.trusted = true
		return c
	}
	// A direct loopback connection: no forwarding headers, because a proxy would make EVERY request look local.
	if h.Get("X-Forwarded-For") == "" && h.Get("Forwarded") == "" && h.Get("X-Real-Ip") == "" {
		host, _, err := net.SplitHostPort(peer)
		if err != nil {
			host = peer
		}
		if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
			c.trusted = true
		}
	}
	return c
}

// roleFor is what the caller may do in the document. An unprotected document is open (owner-like).
func (m *Manager) roleFor(docID string, c caller) (r role, protected bool) {
	a := m.accessOf(docID)
	if !a.Enabled {
		return roleOwner, false
	}
	if c.trusted {
		return roleOwner, true
	}
	if c.token == "" {
		return roleNone, true
	}
	want := hashToken(c.token)
	best := roleNone
	for _, l := range a.Links {
		if subtle.ConstantTimeCompare([]byte(l.Hash), []byte(want)) == 1 {
			if lr, ok := parseRole(l.Role); ok && lr > best {
				best = lr
			}
		}
	}
	return best, true
}

// requiredRole is what a procedure needs. ok=false: it is not tied to a document.
func requiredRole(name string, msg any) (docID string, need role, ok bool) {
	d, hasDoc := msg.(interface{ GetDocId() string })
	if !hasDoc {
		return "", roleNone, false
	}
	docID = d.GetDocId()
	switch name {
	case "OpenDocument", "Subscribe", "WatchPresence", "UpdatePresence", "AnalyzeFlows", "ExportCode", "ListVersions",
		"ReviewDesign", "GetBranchOrigin", "GetAccess":
		return docID, roleView, true
	case "SubmitOp":
		if r, ok := msg.(*opendesignerv1.SubmitOpRequest); ok {
			switch r.GetOp().GetKind().(type) {
			case *opendesignerv1.Op_SetComment, *opendesignerv1.Op_DeleteComment:
				return docID, roleComment, true
			}
		}
		return docID, roleEdit, true
	case "CreateVersion", "DeleteVersion", "BranchDocument", "RenameDocument", "ReviewMerge", "MergeBranch", "ImportFig":
		return docID, roleEdit, true
	case "DeleteDocument", "DisableAccess", "CreateShareLink", "RevokeShareLink", "EnableAccess":
		return docID, roleOwner, true
	}
	// A procedure added later that names a document and is not listed: the strictest answer.
	return docID, roleOwner, true
}

// authorize checks one request. It returns the error to send, or nil.
func (m *Manager) authorize(procedure string, msg any, c caller) error {
	name := procedure[strings.LastIndex(procedure, "/")+1:]
	docID, need, ok := requiredRole(name, msg)
	if !ok || docID == "" {
		return nil
	}
	have, protected := m.roleFor(docID, c)
	// Turning protection ON is for a trusted caller only: until it is on, "owner" is everyone.
	if name == "EnableAccess" {
		if c.trusted {
			return nil
		}
		if protected && have >= roleOwner {
			return nil
		}
		return connect.NewError(connect.CodePermissionDenied, errors.New("only the machine running the server (or its admin token) can protect a document"))
	}
	if have >= need {
		// A merge reads one document and writes another: edit rights on the original too.
		if name == "MergeBranch" || name == "ReviewMerge" {
			if o, err := m.BranchOrigin(docID); err == nil && o.GetIsBranch() && o.GetSourceExists() {
				if sr, _ := m.roleFor(o.GetSourceDocId(), c); sr < roleEdit {
					return connect.NewError(connect.CodePermissionDenied, errors.New("merging needs edit access to the original document too"))
				}
			}
		}
		return nil
	}
	if have == roleNone && c.token == "" {
		return connect.NewError(connect.CodeUnauthenticated, errors.New("this document is protected: open it from a share link"))
	}
	return connect.NewError(connect.CodePermissionDenied, errors.New("your link does not allow this ("+need.String()+" access is needed)"))
}

// NewAccessInterceptor enforces access control on every RPC of the service.
func NewAccessInterceptor(m *Manager) connect.Interceptor { return &accessInterceptor{m: m} }

type accessInterceptor struct{ m *Manager }

func (a *accessInterceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, req connect.AnyRequest) (connect.AnyResponse, error) {
		if req.Spec().IsClient {
			return next(ctx, req)
		}
		c := a.m.identify(req.Header(), req.Peer().Addr, "")
		if err := a.m.authorize(req.Spec().Procedure, req.Any(), c); err != nil {
			return nil, err
		}
		return next(context.WithValue(ctx, callerKey{}, c), req)
	}
}

func (a *accessInterceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return next
}

func (a *accessInterceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return func(ctx context.Context, conn connect.StreamingHandlerConn) error {
		c := a.m.identify(conn.RequestHeader(), conn.Peer().Addr, "")
		checked := &checkedConn{StreamingHandlerConn: conn, m: a.m, caller: c}
		return next(context.WithValue(ctx, callerKey{}, c), checked)
	}
}

// checkedConn authorizes a stream on its first received message (which names the document).
type checkedConn struct {
	connect.StreamingHandlerConn
	m      *Manager
	caller caller
	done   bool
}

func (c *checkedConn) Receive(msg any) error {
	if err := c.StreamingHandlerConn.Receive(msg); err != nil {
		return err
	}
	if !c.done {
		c.done = true
		return c.m.authorize(c.StreamingHandlerConn.Spec().Procedure, msg, c.caller)
	}
	return nil
}

func callerOf(ctx context.Context) caller {
	c, _ := ctx.Value(callerKey{}).(caller)
	return c
}

// GuardAssets protects the asset route: reading needs view access, uploading needs edit.
func (m *Manager) GuardAssets(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rest := strings.TrimPrefix(r.URL.Path, AssetPrefix)
		docID, _, _ := strings.Cut(rest, "/")
		if docID != "" {
			c := m.identify(r.Header, r.RemoteAddr, r.URL.Query().Get("k"))
			need := roleView
			if r.Method == http.MethodPost {
				need = roleEdit
			}
			if have, _ := m.roleFor(docID, c); have < need {
				http.Error(w, "this document is protected", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// ---- managing access ----

func linkInfo(l store.Link) *opendesignerv1.AccessLink {
	return &opendesignerv1.AccessLink{Id: l.ID, Role: l.Role, Label: l.Label, CreatedAt: l.CreatedAt.Unix()}
}

func (m *Manager) GetAccess(docID string, c caller) (*opendesignerv1.GetAccessResponse, error) {
	if !m.Exists(docID) {
		return nil, ErrDocNotFound
	}
	have, protected := m.roleFor(docID, c)
	out := &opendesignerv1.GetAccessResponse{Enabled: protected, Role: "open"}
	if protected {
		out.Role = have.String()
		if have >= roleOwner {
			for _, l := range m.accessOf(docID).Links {
				out.Links = append(out.Links, linkInfo(l))
			}
		}
	}
	return out, nil
}

// EnableAccess protects the document and returns its first (owner) link token.
func (m *Manager) EnableAccess(docID string) (string, error) {
	if !m.Exists(docID) {
		return "", ErrDocNotFound
	}
	if a := m.accessOf(docID); a.Enabled {
		return "", errors.New("this document is already protected")
	}
	token, err := newToken()
	if err != nil {
		return "", err
	}
	a := store.Access{Enabled: true, Links: []store.Link{{
		ID: uuid.NewString(), Role: roleOwner.String(), Label: "Owner", Hash: hashToken(token), CreatedAt: time.Now().UTC().Truncate(time.Second),
	}}}
	return token, m.saveAccess(docID, a)
}

func (m *Manager) DisableAccess(docID string) error {
	if !m.Exists(docID) {
		return ErrDocNotFound
	}
	return m.saveAccess(docID, store.Access{})
}

const maxLinks = 100

func (m *Manager) CreateShareLink(docID, roleName, label string) (*opendesignerv1.AccessLink, string, error) {
	if !m.Exists(docID) {
		return nil, "", ErrDocNotFound
	}
	r, ok := parseRole(roleName)
	if !ok {
		return nil, "", errors.New("the role must be view, comment, edit or owner")
	}
	label = strings.TrimSpace(label)
	if len([]rune(label)) > 60 {
		return nil, "", errors.New("the label is too long")
	}
	a := m.accessOf(docID)
	if !a.Enabled {
		return nil, "", errors.New("protect the document first")
	}
	if len(a.Links) >= maxLinks {
		return nil, "", errors.New("too many links: revoke some first")
	}
	token, err := newToken()
	if err != nil {
		return nil, "", err
	}
	l := store.Link{ID: uuid.NewString(), Role: r.String(), Label: label, Hash: hashToken(token), CreatedAt: time.Now().UTC().Truncate(time.Second)}
	a.Links = append(append([]store.Link(nil), a.Links...), l)
	if err := m.saveAccess(docID, a); err != nil {
		return nil, "", err
	}
	return linkInfo(l), token, nil
}

func (m *Manager) RevokeShareLink(docID, linkID string) error {
	if !m.Exists(docID) {
		return ErrDocNotFound
	}
	a := m.accessOf(docID)
	var kept []store.Link
	found := false
	for _, l := range a.Links {
		if l.ID == linkID {
			found = true
			continue
		}
		kept = append(kept, l)
	}
	if !found {
		return errors.New("no such link")
	}
	// The last owner link may go: the machine running the server can always get back in.
	a.Links = kept
	return m.saveAccess(docID, a)
}

// protectedDocs filters a listing for a caller who is not trusted: protected documents are not listed.
func (m *Manager) hideProtected(docs []*opendesignerv1.DocInfo, c caller) []*opendesignerv1.DocInfo {
	if c.trusted {
		return docs
	}
	out := docs[:0:0]
	for _, d := range docs {
		if m.accessOf(d.GetId()).Enabled {
			continue
		}
		out = append(out, d)
	}
	return out
}
