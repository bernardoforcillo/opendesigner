package server

import (
	"context"
	"errors"
	"github.com/bernardoforcillo/opendesigner/internal/board"
	"github.com/bernardoforcillo/opendesigner/internal/review"
	"github.com/bernardoforcillo/opendesigner/internal/store"
	"os"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/internal/codegen"
	"github.com/bernardoforcillo/opendesigner/internal/diagram"
	"github.com/bernardoforcillo/opendesigner/internal/flow"
)

type DocumentService struct{ m *Manager }

func NewDocumentService(m *Manager) *DocumentService { return &DocumentService{m: m} }

func (s *DocumentService) ListDocuments(_ context.Context, _ *connect.Request[opendesignerv1.ListDocumentsRequest]) (*connect.Response[opendesignerv1.ListDocumentsResponse], error) {
	// List reads the workspace directory, so it can fail for reasons the
	// caller has no part in (permissions, a missing mount).
	docs, err := s.m.List()
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&opendesignerv1.ListDocumentsResponse{Docs: docs}), nil
}

func (s *DocumentService) CreateDocument(_ context.Context, req *connect.Request[opendesignerv1.CreateDocumentRequest]) (*connect.Response[opendesignerv1.DocInfo], error) {
	name := req.Msg.GetName()
	if name == "" {
		name = "Untitled"
	}
	info, err := s.m.Create(name)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(info), nil
}

func (s *DocumentService) RenameDocument(_ context.Context, req *connect.Request[opendesignerv1.RenameDocumentRequest]) (*connect.Response[opendesignerv1.DocInfo], error) {
	info, err := s.m.Rename(req.Msg.GetDocId(), req.Msg.GetName())
	switch {
	case err == nil:
		return connect.NewResponse(info), nil
	case errors.Is(err, errEmptyName), errors.Is(err, errNameTooLong):
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	case errors.Is(err, errInvalidDocID), errors.Is(err, ErrDocNotFound):
		return nil, connect.NewError(connect.CodeNotFound, err)
	default:
		return nil, connect.NewError(connect.CodeInternal, err)
	}
}

func (s *DocumentService) DeleteDocument(_ context.Context, req *connect.Request[opendesignerv1.DeleteDocumentRequest]) (*connect.Response[opendesignerv1.DeleteDocumentResponse], error) {
	err := s.m.Delete(req.Msg.GetDocId())
	switch {
	case err == nil:
		return connect.NewResponse(&opendesignerv1.DeleteDocumentResponse{}), nil
	case errors.Is(err, ErrDocInUse):
		return nil, connect.NewError(connect.CodeFailedPrecondition, err)
	case errors.Is(err, errInvalidDocID), errors.Is(err, os.ErrNotExist):
		return nil, connect.NewError(connect.CodeNotFound, err)
	default:
		return nil, connect.NewError(connect.CodeInternal, err)
	}
}

func (s *DocumentService) OpenDocument(_ context.Context, req *connect.Request[opendesignerv1.OpenRequest]) (*connect.Response[opendesignerv1.OpenResponse], error) {
	// A well-formed but unknown id must NOT bring an empty document into being
	// (HubFor opens-or-creates): a dead link shows "not found", creation
	// only goes through CreateDocument.
	if !s.m.Exists(req.Msg.GetDocId()) {
		return nil, connect.NewError(connect.CodeNotFound, ErrDocNotFound)
	}
	h, err := s.m.HubFor(req.Msg.GetDocId())
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, err)
	}
	doc, seq := h.Snapshot()
	return connect.NewResponse(&opendesignerv1.OpenResponse{Snapshot: doc, Seq: seq}), nil
}

// errMissingOp rejects a SubmitOp request whose op field is unset: there is
// nothing to apply, and letting it through would only produce an opaque
// "unknown op kind <nil>" from core.Apply.
var errMissingOp = errors.New("submit_op: op is required")

// errOpDocIDMismatch rejects a SubmitOp whose op.doc_id disagrees with the
// request's own doc_id (including an empty op.doc_id, the client's
// "scene not loaded yet" default). core.Apply ignores op.doc_id entirely --
// it only ever touches the hub resolved from the request's doc_id -- so
// nothing upstream would otherwise catch a stale or empty client-side scene
// id before it is durably persisted into the wrong (or an unaddressable)
// document's oplog.
var errOpDocIDMismatch = errors.New("submit_op: op.doc_id does not match doc_id")

// SubmitOp is the client→server half of the old bidi Sync stream: a unary RPC
// that applies the operation on the document's hub and returns the Ack.
// The broadcast of the applied OpRecord to ALL clients (the sender included)
// goes through Subscribe, not through here.
//
// Bidi streaming is unreachable from the browser (@connectrpc/connect-web
// rejects any methodKind other than server_streaming because fetch does not
// support streaming request bodies), so the unary + server-stream pair replaces
// Sync while keeping its semantics on the Hub side identical.
func (s *DocumentService) SubmitOp(_ context.Context, req *connect.Request[opendesignerv1.SubmitOpRequest]) (*connect.Response[opendesignerv1.SubmitOpResponse], error) {
	op := req.Msg.GetOp()
	if op == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errMissingOp)
	}
	// HubFor validates/sanitizes the client-supplied doc_id (see errInvalidDocID)
	// before any filesystem access, exactly as the old Sync handler did with the
	// Hello message's doc_id. It runs before the doc_id-agreement check below
	// so a malformed/traversal doc_id is still reported as NotFound, not
	// InvalidArgument, regardless of what op.doc_id happens to contain.
	h, err := s.m.HubFor(req.Msg.GetDocId())
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, err)
	}
	if op.GetDocId() != req.Msg.GetDocId() {
		return nil, connect.NewError(connect.CodeInvalidArgument, errOpDocIDMismatch)
	}
	rec, err := h.Submit(req.Msg.GetClientId(), op)
	if err != nil {
		// A core.Apply failure is the caller's fault (duplicate node id, unknown
		// op kind, missing target...). Surface it instead of swallowing it into
		// an in-band ErrorMsg the way the bidi stream had to.
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	return connect.NewResponse(&opendesignerv1.SubmitOpResponse{Ack: &opendesignerv1.Ack{
		OpId: op.GetOpId(), Seq: rec.GetSeq(),
	}}), nil
}

// Subscribe is the server→client half: catch-up of the records with seq > since_seq,
// then live, each sent as ServerMsg{applied}. A single goroutine (this one)
// writes to the stream, so Sync's writer multiplexer is no longer needed.
func (s *DocumentService) Subscribe(ctx context.Context, req *connect.Request[opendesignerv1.SubscribeRequest], stream *connect.ServerStream[opendesignerv1.ServerMsg]) error {
	h, err := s.m.HubFor(req.Msg.GetDocId())
	if err != nil {
		return connect.NewError(connect.CodeNotFound, err)
	}
	// Hub.Subscribe registers the subscriber and pre-loads its catch-up backlog
	// under the hub mutex, so an op submitted concurrently with this call is
	// delivered exactly once: either in the backlog or as a live broadcast.
	ch, cancel, err := h.Subscribe(req.Msg.GetSinceSeq())
	if err != nil {
		if errors.Is(err, ErrHistoryTooOld) {
			// The records this client is asking to resume from have been
			// compacted into a snapshot. OUT_OF_RANGE (rather than a partial
			// stream) tells it to re-open the document and resubscribe from
			// the seq OpenDocument reports.
			return connect.NewError(connect.CodeOutOfRange, err)
		}
		return connect.NewError(connect.CodeInternal, err)
	}
	// Always unregister: the hub would otherwise keep broadcasting into a
	// channel nobody reads for the rest of the process's life.
	defer cancel()

	for {
		select {
		case <-ctx.Done():
			// Client went away (or the server is shutting down).
			return ctx.Err()
		case rec, ok := <-ch:
			if !ok {
				// Inside this loop, the hub is the ONLY goroutine that can
				// have closed ch: the other closer is the cancel func above,
				// and that runs in the deferred cleanup, i.e. strictly after
				// this loop has returned. So a closed channel here means one
				// thing -- the hub gave up on this subscriber because it fell
				// too far behind (see ErrSubscriberTooSlow).
				//
				// Returning nil would report that as a clean, SUCCESSFUL
				// end-of-stream: on the wire it is indistinguishable from a
				// graceful server shutdown or from the client cancelling
				// itself, so a client would simply stop receiving ops with no
				// hint that it must resync -- strictly worse than the silent
				// single-record drop this whole mechanism replaced.
				// RESOURCE_EXHAUSTED is the signal, and it is the contract
				// the client codes against, alongside the OUT_OF_RANGE that
				// ErrHistoryTooOld returns above: re-subscribe with since_seq
				// at the last applied record (or, if that then comes back
				// OUT_OF_RANGE, re-open the document first).
				return connect.NewError(connect.CodeResourceExhausted, ErrSubscriberTooSlow)
			}
			if err := stream.Send(&opendesignerv1.ServerMsg{Kind: &opendesignerv1.ServerMsg_Applied{Applied: rec}}); err != nil {
				return err
			}
		}
	}
}

// WatchPresence: the list of who is already there, then the peers' updates.
// Closing the stream (closing the tab, losing the network) removes the client
// from the room -- presence has no other lifecycle.
func (s *DocumentService) WatchPresence(ctx context.Context, req *connect.Request[opendesignerv1.WatchPresenceRequest], stream *connect.ServerStream[opendesignerv1.PresenceEvent]) error {
	if req.Msg.GetClientId() == "" {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("watch_presence: client_id is required"))
	}
	h, err := s.m.HubFor(req.Msg.GetDocId())
	if err != nil {
		return connect.NewError(connect.CodeNotFound, err)
	}
	ch, leave := h.presence.join(req.Msg.GetClientId(), req.Msg.GetNickname())
	defer leave()
	// An EMPTY event (no `kind`) as the first message: Connect only sends the
	// response headers with the first message, so in an empty room the client
	// would wait forever. It also says "you are in": from here on this client's
	// UpdatePresence is accepted.
	if err := stream.Send(&opendesignerv1.PresenceEvent{}); err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case ev := <-ch:
			if err := stream.Send(ev); err != nil {
				return err
			}
		}
	}
}

// UpdatePresence: the client's cursor, selection and page. A client without an
// open WatchPresence stream is ignored (it is not in the room): this is the
// reason presence never leaves residue.
func (s *DocumentService) UpdatePresence(_ context.Context, req *connect.Request[opendesignerv1.UpdatePresenceRequest]) (*connect.Response[opendesignerv1.UpdatePresenceResponse], error) {
	st := req.Msg.GetState()
	if st == nil || st.GetClientId() == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("update_presence: state.client_id is required"))
	}
	h, err := s.m.HubFor(req.Msg.GetDocId())
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, err)
	}
	h.presence.update(st)
	return connect.NewResponse(&opendesignerv1.UpdatePresenceResponse{}), nil
}

// AnalyzeFlows: the real analysis lives in internal/flow; here the hub is
// resolved and the current snapshot is taken.
func (s *DocumentService) AnalyzeFlows(_ context.Context, req *connect.Request[opendesignerv1.AnalyzeFlowsRequest]) (*connect.Response[opendesignerv1.AnalyzeFlowsResponse], error) {
	h, err := s.m.HubFor(req.Msg.GetDocId())
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, err)
	}
	doc, _ := h.Snapshot()
	// empty flow_id = all flows; an unknown id gives zero reports, not an error.
	return connect.NewResponse(&opendesignerv1.AnalyzeFlowsResponse{Reports: flow.Analyze(doc, req.Msg.GetFlowId())}), nil
}

// ExportCode: the real generation lives in internal/codegen; here the hub is
// resolved, the current snapshot is taken and the workspace's assets are passed.
// Input errors (unknown target or flow, document without screens)
// are InvalidArgument: the caller can fix them.
func (s *DocumentService) ExportCode(_ context.Context, req *connect.Request[opendesignerv1.ExportCodeRequest]) (*connect.Response[opendesignerv1.ExportCodeResponse], error) {
	h, err := s.m.HubFor(req.Msg.GetDocId())
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, err)
	}
	doc, _ := h.Snapshot()
	out, err := codegen.Generate(doc, codegen.Options{Target: codegen.Target(req.Msg.GetTarget()), FlowID: req.Msg.GetFlowId()}, s.m.Assets(req.Msg.GetDocId()))
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	resp := &opendesignerv1.ExportCodeResponse{Warnings: out.Warnings}
	for _, f := range out.Files {
		resp.Files = append(resp.Files, &opendesignerv1.ExportFile{Path: f.Path, Content: f.Content})
	}
	return connect.NewResponse(resp), nil
}

// RenderDiagram: draws a diagram from Mermaid text (internal/diagram). It is
// pure -- it opens no document -- so the editor inserts the returned nodes as
// a single gesture. Text that cannot be read is InvalidArgument,
// with the message to show to the user.
func (s *DocumentService) RenderDiagram(_ context.Context, req *connect.Request[opendesignerv1.RenderDiagramRequest]) (*connect.Response[opendesignerv1.RenderDiagramResponse], error) {
	res, err := diagram.Render(req.Msg.GetSource())
	if err != nil {
		var de *diagram.Error
		if errors.As(err, &de) {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&opendesignerv1.RenderDiagramResponse{
		Nodes: res.Nodes, Kind: res.Kind, Width: res.Width, Height: res.Height, Warnings: res.Warnings,
	}), nil
}

// versionErr maps the Manager's errors to Connect codes.
func versionErr(err error) error {
	switch {
	case errors.Is(err, ErrDocNotFound), errors.Is(err, store.ErrVersionNotFound), errors.Is(err, errInvalidDocID):
		return connect.NewError(connect.CodeNotFound, err)
	case errors.Is(err, errEmptyName), errors.Is(err, errNameTooLong):
		return connect.NewError(connect.CodeInvalidArgument, err)
	default:
		return connect.NewError(connect.CodeInternal, err)
	}
}

func (s *DocumentService) CreateVersion(_ context.Context, req *connect.Request[opendesignerv1.CreateVersionRequest]) (*connect.Response[opendesignerv1.VersionInfo], error) {
	v, err := s.m.CreateVersion(req.Msg.GetDocId(), req.Msg.GetName())
	if err != nil {
		return nil, versionErr(err)
	}
	return connect.NewResponse(v), nil
}

func (s *DocumentService) ListVersions(_ context.Context, req *connect.Request[opendesignerv1.ListVersionsRequest]) (*connect.Response[opendesignerv1.ListVersionsResponse], error) {
	vs, err := s.m.ListVersions(req.Msg.GetDocId())
	if err != nil {
		return nil, versionErr(err)
	}
	return connect.NewResponse(&opendesignerv1.ListVersionsResponse{Versions: vs}), nil
}

func (s *DocumentService) DeleteVersion(_ context.Context, req *connect.Request[opendesignerv1.DeleteVersionRequest]) (*connect.Response[opendesignerv1.DeleteVersionResponse], error) {
	if err := s.m.DeleteVersion(req.Msg.GetDocId(), req.Msg.GetVersionId()); err != nil {
		return nil, versionErr(err)
	}
	return connect.NewResponse(&opendesignerv1.DeleteVersionResponse{}), nil
}

func (s *DocumentService) BranchDocument(_ context.Context, req *connect.Request[opendesignerv1.BranchRequest]) (*connect.Response[opendesignerv1.DocInfo], error) {
	d, err := s.m.Branch(req.Msg.GetDocId(), req.Msg.GetVersionId(), req.Msg.GetName())
	if err != nil {
		return nil, versionErr(err)
	}
	return connect.NewResponse(d), nil
}

func (s *DocumentService) ReviewDesign(_ context.Context, req *connect.Request[opendesignerv1.ReviewDesignRequest]) (*connect.Response[opendesignerv1.ReviewDesignResponse], error) {
	if !s.m.Exists(req.Msg.GetDocId()) {
		return nil, connect.NewError(connect.CodeNotFound, ErrDocNotFound)
	}
	h, err := s.m.HubFor(req.Msg.GetDocId())
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, err)
	}
	doc, _ := h.Snapshot()
	out := &opendesignerv1.ReviewDesignResponse{}
	for _, i := range review.Review(doc) {
		out.Issues = append(out.Issues, &opendesignerv1.ReviewIssue{
			Rule: i.Rule, Severity: i.Severity, NodeId: i.NodeID, NodeName: i.NodeName, Message: i.Message,
		})
	}
	return connect.NewResponse(out), nil
}

func (s *DocumentService) RenderBoard(_ context.Context, req *connect.Request[opendesignerv1.RenderBoardRequest]) (*connect.Response[opendesignerv1.RenderBoardResponse], error) {
	m := req.Msg
	res, err := board.Render(m.GetKind(), board.Params{Items: m.GetItems(), Rows: int(m.GetRows()), Columns: int(m.GetColumns()), Color: m.GetColor()})
	if err != nil {
		var be *board.Error
		if errors.As(err, &be) {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&opendesignerv1.RenderBoardResponse{Nodes: res.Nodes, Width: res.Width, Height: res.Height}), nil
}
