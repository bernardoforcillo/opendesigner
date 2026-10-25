package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

func jobSetup(t *testing.T) (*DocumentService, *Manager, string) {
	t.Helper()
	m := NewManager(t.TempDir())
	info, err := m.Create("Jobs")
	if err != nil {
		t.Fatal(err)
	}
	return NewDocumentService(m), m, info.GetId()
}

func run(svc *DocumentService, doc, kind string, timeout uint32) (*opendesignerv1.RunJobResponse, error) {
	r, err := svc.RunJob(context.Background(), connect.NewRequest(&opendesignerv1.RunJobRequest{DocId: doc, Kind: kind, OptionsJson: `{"bleed":true}`, TimeoutSeconds: timeout}))
	if err != nil {
		return nil, err
	}
	return r.Msg, nil
}

func TestRunJobWithNoEditorSaysSo(t *testing.T) {
	svc, _, doc := jobSetup(t)
	out, err := run(svc, doc, "export_pdf", 1)
	if err != nil || out.GetOk() || !strings.Contains(out.GetMessage(), "no editor has this document open") {
		t.Fatalf("out=%v err=%v", out, err)
	}
}

func TestRunJobRefusesUnknownKinds(t *testing.T) {
	svc, _, doc := jobSetup(t)
	if _, err := run(svc, doc, "format_disk", 1); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("err = %v", err)
	}
}

func TestRunJobRoundTripAndDownload(t *testing.T) {
	svc, m, doc := jobSetup(t)
	h, _ := m.HubFor(doc)
	w, leave := h.jobs.join("editor-1")
	defer leave()

	// The editor: takes the job, answers with a file.
	go func() {
		job := <-w.ch
		if job.GetKind() != "export_pdf" || job.GetOptionsJson() != `{"bleed":true}` {
			t.Errorf("job = %v", job)
		}
		_, err := svc.CompleteJob(context.Background(), connect.NewRequest(&opendesignerv1.CompleteJobRequest{
			DocId: doc, JobId: job.GetJobId(), ClientId: "editor-1", Ok: true, Message: "1 image placeholder", Filename: "My: book?.pdf", ContentType: "application/pdf", Data: []byte("%PDF-fake"),
		}))
		if err != nil {
			t.Errorf("complete: %v", err)
		}
	}()
	out, err := run(svc, doc, "export_pdf", 5)
	if err != nil || !out.GetOk() || out.GetSize() != 9 || out.GetFilename() != "My- book-.pdf" || out.GetMessage() != "1 image placeholder" || out.GetResultId() == "" {
		t.Fatalf("out=%v err=%v", out, err)
	}

	// The file is served for download.
	srv := httptest.NewServer(m.GuardExports(NewExportHandler(m)))
	defer srv.Close()
	res, err := http.Get(srv.URL + ExportPrefix + doc + "/" + out.GetResultId())
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || string(body) != "%PDF-fake" || res.Header.Get("Content-Type") != "application/pdf" || !strings.Contains(res.Header.Get("Content-Disposition"), "My- book-.pdf") {
		t.Fatalf("status=%d body=%q headers=%v", res.StatusCode, body, res.Header)
	}
	if res, _ := http.Get(srv.URL + ExportPrefix + doc + "/nope"); res.StatusCode != 404 {
		t.Fatalf("unknown result = %d", res.StatusCode)
	}
}

func TestRunJobTextResultAndFailure(t *testing.T) {
	svc, m, doc := jobSetup(t)
	h, _ := m.HubFor(doc)
	w, leave := h.jobs.join("e")
	defer leave()
	answer := func(req *opendesignerv1.CompleteJobRequest) {
		go func() {
			job := <-w.ch
			req.DocId, req.JobId, req.ClientId = doc, job.GetJobId(), "e"
			_, _ = svc.CompleteJob(context.Background(), connect.NewRequest(req))
		}()
	}
	answer(&opendesignerv1.CompleteJobRequest{Ok: true, Text: `{"issues":[]}`})
	out, _ := run(svc, doc, "preflight", 5)
	if !out.GetOk() || out.GetText() != `{"issues":[]}` || out.GetResultId() != "" {
		t.Fatalf("out=%v", out)
	}
	answer(&opendesignerv1.CompleteJobRequest{Ok: false, Message: "nothing to export: every page is empty"})
	out, _ = run(svc, doc, "export_pdf", 5)
	if out.GetOk() || out.GetMessage() != "nothing to export: every page is empty" {
		t.Fatalf("out=%v", out)
	}
}

func TestOnlyTheEditorThatGotTheJobMayAnswer(t *testing.T) {
	svc, m, doc := jobSetup(t)
	h, _ := m.HubFor(doc)
	w, leave := h.jobs.join("owner")
	defer leave()
	got := make(chan error, 1)
	go func() {
		job := <-w.ch
		_, err := svc.CompleteJob(context.Background(), connect.NewRequest(&opendesignerv1.CompleteJobRequest{DocId: doc, JobId: job.GetJobId(), ClientId: "intruder", Ok: true, Data: []byte("x")}))
		got <- err
	}()
	out, _ := run(svc, doc, "export_pdf", 1)
	if err := <-got; connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("intruder err = %v", err)
	}
	if out.GetOk() || !strings.Contains(out.GetMessage(), "did not answer") {
		t.Fatalf("out=%v", out)
	}
	if _, err := svc.CompleteJob(context.Background(), connect.NewRequest(&opendesignerv1.CompleteJobRequest{DocId: doc, JobId: "gone", ClientId: "owner"})); err == nil {
		t.Fatal("an unknown job should be refused")
	}
}

func TestAJobFailsWhenItsEditorLeaves(t *testing.T) {
	svc, m, doc := jobSetup(t)
	h, _ := m.HubFor(doc)
	w, leave := h.jobs.join("e")
	go func() {
		<-w.ch
		time.Sleep(20 * time.Millisecond)
		leave()
	}()
	out, _ := run(svc, doc, "export_pdf", 5)
	if out.GetOk() || !strings.Contains(out.GetMessage(), "closed") {
		t.Fatalf("out=%v", out)
	}
}

func TestResultsAreBounded(t *testing.T) {
	r := newJobRoom()
	var first string
	for i := 0; i < resultsPerDoc+3; i++ {
		id := r.keep("f", "text/plain", []byte("x"))
		if i == 0 {
			first = id
		}
	}
	if r.result(first) != nil || len(r.results) != resultsPerDoc {
		t.Fatalf("results = %d, first still there = %v", len(r.results), r.result(first) != nil)
	}
}
