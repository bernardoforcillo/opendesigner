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

	// connect-go forbids concurrent stream.Send calls on a single BidiStream,
	// so ALL sends go through one writer goroutine. It multiplexes two sources:
	// broadcast records from the subscriber channel (ServerMsg.Applied) and the
	// reader loop's per-op replies (Ack/Error) handed over via `out`. The reader
	// never calls stream.Send itself.
	out := make(chan *brawtv1.ServerMsg)
	writerDone := make(chan struct{})
	var writerErr error
	go func() {
		defer close(writerDone)
		for {
			select {
			case <-ctx.Done():
				writerErr = ctx.Err()
				return
			case rec, ok := <-ch:
				if !ok {
					return
				}
				if err := stream.Send(&brawtv1.ServerMsg{Kind: &brawtv1.ServerMsg_Applied{Applied: rec}}); err != nil {
					writerErr = err
					return
				}
			case msg := <-out:
				if err := stream.Send(msg); err != nil {
					writerErr = err
					return
				}
			}
		}
	}()

	// send hands a reply to the writer goroutine. It returns false if the writer
	// has already exited (its Send failed or ctx was cancelled), so the reader
	// never blocks forever on a writer that is gone.
	send := func(msg *brawtv1.ServerMsg) bool {
		select {
		case out <- msg:
			return true
		case <-writerDone:
			return false
		}
	}

	// reader: SubmitOp → Hub.Submit
	clientID := hello.GetClientId()
	for {
		msg, err := stream.Receive()
		if err != nil {
			// Client closed its send side (EOF) or the RPC failed. Signal the
			// writer to stop (cancel closes the subscriber channel) and JOIN it
			// before returning, so no stream.Send is still in flight when
			// connect-go finalizes the RPC after Sync returns.
			cancel()
			<-writerDone
			return writerErr
		}
		sub := msg.GetSubmit()
		if sub == nil {
			continue
		}
		var reply *brawtv1.ServerMsg
		if rec, aerr := h.Submit(clientID, sub.GetOp()); aerr != nil {
			reply = &brawtv1.ServerMsg{Kind: &brawtv1.ServerMsg_Error{Error: &brawtv1.ErrorMsg{
				OpId: sub.GetOp().GetOpId(), Message: aerr.Error()}}}
		} else {
			reply = &brawtv1.ServerMsg{Kind: &brawtv1.ServerMsg_Ack{Ack: &brawtv1.Ack{
				OpId: sub.GetOp().GetOpId(), Seq: rec.GetSeq()}}}
		}
		if !send(reply) {
			// Writer already gone; the stream is finished. writerDone is closed,
			// so writerErr is safely readable here.
			return writerErr
		}
	}
}

var errFirstMsgMustBeHello = connectError("first sync message must be Hello")

type connectError string

func (e connectError) Error() string { return string(e) }
