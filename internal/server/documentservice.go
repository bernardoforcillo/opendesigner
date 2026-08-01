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
	// Hello message's doc_id.
	h, err := s.m.HubFor(req.Msg.GetDocId())
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, err)
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
				return nil
			}
			if err := stream.Send(&brawtv1.ServerMsg{Kind: &brawtv1.ServerMsg_Applied{Applied: rec}}); err != nil {
				return err
			}
		}
	}
}
