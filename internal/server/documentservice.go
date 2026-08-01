package server

import (
	"context"
	"errors"

	"connectrpc.com/connect"
	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
)

type DocumentService struct{ m *Manager }

func NewDocumentService(m *Manager) *DocumentService { return &DocumentService{m: m} }

func (s *DocumentService) ListDocuments(_ context.Context, _ *connect.Request[brawtv1.ListDocumentsRequest]) (*connect.Response[brawtv1.ListDocumentsResponse], error) {
	// List reads the workspace directory, so it can fail for reasons the
	// caller has no part in (permissions, a missing mount).
	docs, err := s.m.List()
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	return connect.NewResponse(&brawtv1.ListDocumentsResponse{Docs: docs}), nil
}

func (s *DocumentService) CreateDocument(_ context.Context, req *connect.Request[brawtv1.CreateDocumentRequest]) (*connect.Response[brawtv1.DocInfo], error) {
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

func (s *DocumentService) OpenDocument(_ context.Context, req *connect.Request[brawtv1.OpenRequest]) (*connect.Response[brawtv1.OpenResponse], error) {
	h, err := s.m.HubFor(req.Msg.GetDocId())
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, err)
	}
	doc, seq := h.Snapshot()
	return connect.NewResponse(&brawtv1.OpenResponse{Snapshot: doc, Seq: seq}), nil
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

// SubmitOp è la metà client→server del vecchio stream bidi Sync: una unary RPC
// che applica l'operazione sull'hub del documento e restituisce l'Ack.
// Il broadcast dell'OpRecord applicato a TUTTI i client (incluso il mittente)
// passa da Subscribe, non da qui.
//
// Bidi streaming è irraggiungibile dal browser (@connectrpc/connect-web rifiuta
// qualunque methodKind diverso da server_streaming perché fetch non supporta i
// request body in streaming), quindi la coppia unary + server-stream sostituisce
// Sync mantenendone identica la semantica lato Hub.
func (s *DocumentService) SubmitOp(_ context.Context, req *connect.Request[brawtv1.SubmitOpRequest]) (*connect.Response[brawtv1.SubmitOpResponse], error) {
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
	return connect.NewResponse(&brawtv1.SubmitOpResponse{Ack: &brawtv1.Ack{
		OpId: op.GetOpId(), Seq: rec.GetSeq(),
	}}), nil
}

// Subscribe è la metà server→client: catch-up dei record con seq > since_seq,
// poi live, ciascuno inviato come ServerMsg{applied}. Un solo goroutine (questo)
// scrive sullo stream, quindi non serve più il writer multiplexer di Sync.
func (s *DocumentService) Subscribe(ctx context.Context, req *connect.Request[brawtv1.SubscribeRequest], stream *connect.ServerStream[brawtv1.ServerMsg]) error {
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
			if err := stream.Send(&brawtv1.ServerMsg{Kind: &brawtv1.ServerMsg_Applied{Applied: rec}}); err != nil {
				return err
			}
		}
	}
}
