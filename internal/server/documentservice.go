package server

import (
	"context"

	"connectrpc.com/connect"
	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
)

type DocumentService struct{ m *Manager }

func NewDocumentService(m *Manager) *DocumentService { return &DocumentService{m: m} }

func (s *DocumentService) ListDocuments(_ context.Context, _ *connect.Request[brawtv1.ListDocumentsRequest]) (*connect.Response[brawtv1.ListDocumentsResponse], error) {
	return connect.NewResponse(&brawtv1.ListDocumentsResponse{Docs: s.m.List()}), nil
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

// Sync: il primo messaggio DEVE essere Hello; poi il client invia SubmitOp,
// mentre una goroutine drena il canale del subscriber verso lo stream.
func (s *DocumentService) Sync(ctx context.Context, stream *connect.BidiStream[brawtv1.ClientMsg, brawtv1.ServerMsg]) error {
	first, err := stream.Receive()
	if err != nil {
		return err
	}
	hello := first.GetHello()
	if hello == nil {
		return connect.NewError(connect.CodeInvalidArgument, errFirstMsgMustBeHello)
	}
	h, err := s.m.HubFor(hello.GetDocId())
	if err != nil {
		return connect.NewError(connect.CodeNotFound, err)
	}
	ch, cancel := h.Subscribe(hello.GetSinceSeq())
	defer cancel()

	// writer: record → ServerMsg.Applied
	writerErr := make(chan error, 1)
	go func() {
		for {
			select {
			case <-ctx.Done():
				writerErr <- ctx.Err()
				return
			case rec, ok := <-ch:
				if !ok {
					writerErr <- nil
					return
				}
				if err := stream.Send(&brawtv1.ServerMsg{Kind: &brawtv1.ServerMsg_Applied{Applied: rec}}); err != nil {
					writerErr <- err
					return
				}
			}
		}
	}()

	// reader: SubmitOp → Hub.Submit
	clientID := hello.GetClientId()
	for {
		msg, err := stream.Receive()
		if err != nil {
			// EOF/chiusura del client: termina normalmente
			select {
			case werr := <-writerErr:
				return werr
			default:
				return nil
			}
		}
		if sub := msg.GetSubmit(); sub != nil {
			rec, aerr := h.Submit(clientID, sub.GetOp())
			if aerr != nil {
				_ = stream.Send(&brawtv1.ServerMsg{Kind: &brawtv1.ServerMsg_Error{Error: &brawtv1.ErrorMsg{
					OpId: sub.GetOp().GetOpId(), Message: aerr.Error()}}})
				continue
			}
			_ = stream.Send(&brawtv1.ServerMsg{Kind: &brawtv1.ServerMsg_Ack{Ack: &brawtv1.Ack{
				OpId: sub.GetOp().GetOpId(), Seq: rec.GetSeq()}}})
		}
	}
}

var errFirstMsgMustBeHello = connectError("first sync message must be Hello")

type connectError string

func (e connectError) Error() string { return string(e) }
