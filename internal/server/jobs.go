package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/google/uuid"
)

// EDITOR JOBS. Some outputs need the text layout and the fonts only the editor (the browser) has: PDF, EPUB, PNG,
// SVG, the print package, the full preflight. An agent cannot run them itself, so it asks the server (RunJob);
// the server hands the job to an editor that has the document open (WatchJobs), waits for its answer
// (CompleteJob) and returns it. Nothing is queued: with no editor open the job fails at once with a message
// that says so, because a job nobody will run is worse than an error.
//
// Files produced are kept in memory (a few per document, bounded in size and time) and served at
// /export-api/{docId}/{resultId}; they are the agent's to download once.

const (
	defaultJobTimeout = 120 * time.Second
	maxJobTimeout     = 10 * time.Minute
	maxResultBytes    = 64 << 20
	maxResultText     = 256 << 10
	maxPayloadBytes   = 32 << 20
	resultsPerDoc     = 8
	resultTTL         = 15 * time.Minute
	jobChanCap        = 16

	// ExportPrefix is the route that serves a job's file.
	ExportPrefix = "/export-api/"
)

type jobWatcher struct {
	clientID string
	ch       chan *opendesignerv1.EditorJob
}

type pendingJob struct {
	watcher *jobWatcher
	done    chan *opendesignerv1.CompleteJobRequest
}

type jobResult struct {
	id          string
	filename    string
	contentType string
	data        []byte
	at          time.Time
}

type jobRoom struct {
	mu       sync.Mutex
	watchers []*jobWatcher
	pending  map[string]*pendingJob
	results  []*jobResult
	next     int // round robin over the watchers
}

func newJobRoom() *jobRoom { return &jobRoom{pending: map[string]*pendingJob{}} }

func (r *jobRoom) join(clientID string) (*jobWatcher, func()) {
	w := &jobWatcher{clientID: clientID, ch: make(chan *opendesignerv1.EditorJob, jobChanCap)}
	r.mu.Lock()
	r.watchers = append(r.watchers, w)
	r.mu.Unlock()
	return w, func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		for i, x := range r.watchers {
			if x == w {
				r.watchers = append(r.watchers[:i], r.watchers[i+1:]...)
				break
			}
		}
		// A job given to a watcher that left will never be answered.
		for id, p := range r.pending {
			if p.watcher == w {
				select {
				case p.done <- &opendesignerv1.CompleteJobRequest{JobId: id, Ok: false, Message: "the editor that was running this job closed"}:
				default:
				}
			}
		}
	}
}

// dispatch gives the job to a watcher; ok=false when there is none.
func (r *jobRoom) dispatch(job *opendesignerv1.EditorJob) (*pendingJob, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.watchers) == 0 {
		return nil, false
	}
	w := r.watchers[r.next%len(r.watchers)]
	r.next++
	p := &pendingJob{watcher: w, done: make(chan *opendesignerv1.CompleteJobRequest, 1)}
	select {
	case w.ch <- job:
	default:
		return nil, false // that editor is swamped; better to say no than to wait behind it
	}
	r.pending[job.GetJobId()] = p
	return p, true
}

func (r *jobRoom) forget(id string) {
	r.mu.Lock()
	delete(r.pending, id)
	r.mu.Unlock()
}

// complete delivers an editor's answer; only the watcher that was given the job may answer it.
func (r *jobRoom) complete(req *opendesignerv1.CompleteJobRequest) error {
	r.mu.Lock()
	p, ok := r.pending[req.GetJobId()]
	r.mu.Unlock()
	if !ok {
		return errors.New("no such job (it finished, timed out or was never given)")
	}
	if p.watcher.clientID != req.GetClientId() {
		return errors.New("this job was given to another editor")
	}
	select {
	case p.done <- req:
	default:
	}
	return nil
}

// keep stores a produced file and returns its id, evicting the oldest beyond the per-document cap.
func (r *jobRoom) keep(filename, contentType string, data []byte) string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	id := hex.EncodeToString(b)
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	live := r.results[:0]
	for _, x := range r.results {
		if now.Sub(x.at) < resultTTL {
			live = append(live, x)
		}
	}
	r.results = append(live, &jobResult{id: id, filename: filename, contentType: contentType, data: data, at: now})
	for len(r.results) > resultsPerDoc {
		r.results = r.results[1:]
	}
	return id
}

func (r *jobRoom) result(id string) *jobResult {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, x := range r.results {
		if x.id == id && time.Since(x.at) < resultTTL {
			return x
		}
	}
	return nil
}

// WatchJobs: an editor offers to run jobs for this document while the stream is open.
func (s *DocumentService) WatchJobs(ctx context.Context, req *connect.Request[opendesignerv1.WatchJobsRequest], stream *connect.ServerStream[opendesignerv1.EditorJob]) error {
	if req.Msg.GetClientId() == "" {
		return connect.NewError(connect.CodeInvalidArgument, errors.New("watch_jobs: client_id is required"))
	}
	h, err := s.m.HubFor(req.Msg.GetDocId())
	if err != nil {
		return connect.NewError(connect.CodeNotFound, err)
	}
	w, leave := h.jobs.join(req.Msg.GetClientId())
	defer leave()
	// An empty first message: Connect sends the headers with the first message, and an idle editor would otherwise wait forever.
	if err := stream.Send(&opendesignerv1.EditorJob{}); err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case job := <-w.ch:
			if err := stream.Send(job); err != nil {
				return err
			}
		}
	}
}

var jobKinds = map[string]bool{
	"export_pdf": true, "export_package": true, "export_epub": true, "export_epub_reflow": true, "export_png": true, "export_svg": true, "preflight": true, "command": true,
}

// RunJob: runs `kind` in an editor and returns what it produced.
func (s *DocumentService) RunJob(ctx context.Context, req *connect.Request[opendesignerv1.RunJobRequest]) (*connect.Response[opendesignerv1.RunJobResponse], error) {
	if !jobKinds[req.Msg.GetKind()] {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("run_job: unknown kind %q", req.Msg.GetKind()))
	}
	if len(req.Msg.GetOptionsJson()) > 16<<10 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("run_job: options too large"))
	}
	if len(req.Msg.GetPayload()) > maxPayloadBytes {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("run_job: the input file is larger than 32 MiB"))
	}
	h, err := s.m.HubFor(req.Msg.GetDocId())
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, err)
	}
	timeout := defaultJobTimeout
	if t := req.Msg.GetTimeoutSeconds(); t > 0 {
		timeout = min(time.Duration(t)*time.Second, maxJobTimeout)
	}
	job := &opendesignerv1.EditorJob{JobId: uuid.NewString(), Kind: req.Msg.GetKind(), OptionsJson: req.Msg.GetOptionsJson(), Payload: req.Msg.GetPayload(), PayloadName: safeFilename(req.Msg.GetPayloadName())}
	p, ok := h.jobs.dispatch(job)
	if !ok {
		return connect.NewResponse(&opendesignerv1.RunJobResponse{Message: "no editor has this document open: open it in the editor (the app runs the layout and the fonts) and try again"}), nil
	}
	defer h.jobs.forget(job.GetJobId())
	tctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	select {
	case <-tctx.Done():
		return connect.NewResponse(&opendesignerv1.RunJobResponse{Message: fmt.Sprintf("the editor did not answer within %s", timeout)}), nil
	case done := <-p.done:
		out := &opendesignerv1.RunJobResponse{Ok: done.GetOk(), Message: done.GetMessage(), Text: done.GetText()}
		if len(out.Text) > maxResultText {
			return connect.NewResponse(&opendesignerv1.RunJobResponse{Message: "the text result is too large"}), nil
		}
		if done.GetOk() && len(done.GetData()) > 0 {
			name := safeFilename(done.GetFilename())
			out.ResultId, out.Filename, out.ContentType, out.Size, out.Data = h.jobs.keep(name, done.GetContentType(), done.GetData()), name, done.GetContentType(), uint64(len(done.GetData())), done.GetData()
		}
		return connect.NewResponse(out), nil
	}
}

// CompleteJob: the editor's answer to a job it was given.
func (s *DocumentService) CompleteJob(_ context.Context, req *connect.Request[opendesignerv1.CompleteJobRequest]) (*connect.Response[opendesignerv1.CompleteJobResponse], error) {
	if len(req.Msg.GetData()) > maxResultBytes {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("complete_job: the file is larger than 64 MiB"))
	}
	h, err := s.m.HubFor(req.Msg.GetDocId())
	if err != nil {
		return nil, connect.NewError(connect.CodeNotFound, err)
	}
	if err := h.jobs.complete(req.Msg); err != nil {
		return nil, connect.NewError(connect.CodeFailedPrecondition, err)
	}
	return connect.NewResponse(&opendesignerv1.CompleteJobResponse{}), nil
}

func safeFilename(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || strings.ContainsRune(`\/:*?"<>|`, r) {
			return '-'
		}
		return r
	}, s)
	s = strings.Trim(s, " .-")
	if s == "" {
		return "export"
	}
	if len(s) > 120 {
		s = s[:120]
	}
	return s
}

// NewExportHandler serves a job's file: GET /export-api/{docId}/{resultId}.
func NewExportHandler(m *Manager) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "only GET on this route", http.StatusMethodNotAllowed)
			return
		}
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, ExportPrefix), "/")
		if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
			http.NotFound(w, r)
			return
		}
		h, err := m.HubFor(parts[0])
		if err != nil {
			http.NotFound(w, r)
			return
		}
		res := h.jobs.result(parts[1])
		if res == nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", res.contentType)
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", res.filename))
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(res.data)
	})
}

// GuardExports protects the export route like the asset route: reading needs view access.
func (m *Manager) GuardExports(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		docID, _, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, ExportPrefix), "/")
		if docID != "" {
			c := m.identify(r.Header, r.RemoteAddr, r.URL.Query().Get("k"))
			if have, _ := m.roleFor(docID, c); have < roleView {
				http.Error(w, "this document is protected", http.StatusForbidden)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
