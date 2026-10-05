package server

import (
	"context"
	"errors"
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
	// Un id ben formato ma sconosciuto NON deve far nascere un documento vuoto
	// (HubFor apre-o-crea): un link morto mostra "non trovato", la creazione
	// passa solo da CreateDocument.
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

// SubmitOp è la metà client→server del vecchio stream bidi Sync: una unary RPC
// che applica l'operazione sull'hub del documento e restituisce l'Ack.
// Il broadcast dell'OpRecord applicato a TUTTI i client (incluso il mittente)
// passa da Subscribe, non da qui.
//
// Bidi streaming è irraggiungibile dal browser (@connectrpc/connect-web rifiuta
// qualunque methodKind diverso da server_streaming perché fetch non supporta i
// request body in streaming), quindi la coppia unary + server-stream sostituisce
// Sync mantenendone identica la semantica lato Hub.
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

// Subscribe è la metà server→client: catch-up dei record con seq > since_seq,
// poi live, ciascuno inviato come ServerMsg{applied}. Un solo goroutine (questo)
// scrive sullo stream, quindi non serve più il writer multiplexer di Sync.
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

// WatchPresence: l'elenco di chi c'è già, poi gli aggiornamenti dei peer.
// Chiudere lo stream (chiudere la scheda, perdere la rete) toglie il client
// dalla stanza -- la presenza non ha altro ciclo di vita.
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
	// Un evento VUOTO (nessun `kind`) come primo messaggio: Connect manda le
	// intestazioni di risposta solo col primo messaggio, quindi in una stanza
	// vuota il client resterebbe in attesa per sempre. Dice anche "sei dentro":
	// da qui in poi UpdatePresence di questo client viene accettato.
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

// UpdatePresence: cursore, selezione e pagina del client. Un client senza
// stream WatchPresence aperto viene ignorato (non è nella stanza): è la
// ragione per cui la presenza non lascia mai residui.
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

// AnalyzeFlows: l'analisi vera vive in internal/flow; qui si risolve l'hub e si
// prende lo snapshot corrente.
func (s *DocumentService) AnalyzeFlows(_ context.Context, req *connect.Request[opendesignerv1.AnalyzeFlowsRequest]) (*connect.Response[opendesignerv1.AnalyzeFlowsResponse], error) {
	h, err := s.m.HubFor(req.Msg.GetDocId())
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, err)
	}
	doc, _ := h.Snapshot()
	// flow_id vuoto = tutti i flussi; un id sconosciuto dà zero report, non un errore.
	return connect.NewResponse(&opendesignerv1.AnalyzeFlowsResponse{Reports: flow.Analyze(doc, req.Msg.GetFlowId())}), nil
}

// ExportCode: la generazione vera vive in internal/codegen; qui si risolve
// l'hub, si prende lo snapshot corrente e si passano gli asset del workspace.
// Gli errori di input (target o flusso sconosciuti, documento senza schermate)
// sono InvalidArgument: il chiamante può correggerli.
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

// RenderDiagram: disegna un diagramma da testo Mermaid (internal/diagram). È
// pura -- non apre nessun documento -- quindi l'editor inserisce i nodi
// restituiti come un unico gesto. Un testo che non si legge è InvalidArgument,
// con il messaggio da mostrare all'utente.
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
