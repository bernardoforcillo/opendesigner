package mcp_test

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1/opendesignerv1connect"
	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
	"github.com/bernardoforcillo/opendesigner/internal/server"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// safeBuffer collects log output from the handler's goroutines. The teardown
// line is written by a goroutine the test does not join, so the read side must
// be race-free.
type safeBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *safeBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *safeBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// serveWithMCP starts the real DocumentService AND mounts the MCP endpoint on
// the same mux, exactly as `opendesigner serve` does: one process, one port,
// the MCP session reaching the runtime over the server's own loopback address.
// It returns the base URL and the log sink.
func serveWithMCP(t *testing.T) (string, *safeBuffer) {
	t.Helper()
	svc := server.NewDocumentService(server.NewManager(t.TempDir()))
	path, handler := opendesignerv1connect.NewDocumentServiceHandler(svc)
	mux := http.NewServeMux()
	mux.Handle(path, handler)

	srv := httptest.NewUnstartedServer(mux)
	p := new(http.Protocols)
	p.SetHTTP1(true)
	p.SetUnencryptedHTTP2(true)
	srv.Config.Protocols = p
	srv.Start()
	// Subscribe is a long-lived stream: Close alone waits on it forever, so drop
	// the connections first. Only the test harness needs this; the sessions under
	// test are torn down explicitly, and asserted on, in their own tests.
	t.Cleanup(func() {
		srv.CloseClientConnections()
		srv.Close()
	})

	// Mounted after Start because selfURL is the server's OWN address, which
	// does not exist until it is listening -- the same ordering runServe has to
	// respect around its listener.
	logs := &safeBuffer{}
	odmcp.MountHTTP(mux, srv.URL, log.New(logs, "", 0))
	return srv.URL, logs
}

// connectMCP dials the MCP endpoint as a real MCP client over streamable HTTP.
func connectMCP(t *testing.T, url string) *mcp.ClientSession {
	t.Helper()
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil)
	cs, err := client.Connect(context.Background(), &mcp.StreamableClientTransport{Endpoint: url}, nil)
	if err != nil {
		t.Fatalf("connect to %s: %v", url, err)
	}
	t.Cleanup(func() { _ = cs.Close() })
	return cs
}

// callText runs a no-argument tool and returns its output as one string.
func callText(t *testing.T, cs *mcp.ClientSession, name string) string {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name})
	if err != nil {
		t.Fatalf("CallTool(%s): %v", name, err)
	}
	if res.IsError {
		t.Fatalf("CallTool(%s) returned a tool error: %+v", name, res.Content)
	}
	var sb strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			sb.WriteString(tc.Text)
		}
	}
	return sb.String()
}

// The whole point of phase 2: an MCP client talks to the SAME process that
// serves the editor, over HTTP, and drives the real document runtime.
func TestMountHTTPDrivesTheDocumentRuntime(t *testing.T) {
	url, _ := serveWithMCP(t)
	docID := newDoc(t, odmcp.NewClient(url))

	cs := connectMCP(t, url+odmcp.HTTPPath+"?doc="+docID)

	if got := callText(t, cs, "get_document"); !strings.Contains(got, docID) {
		t.Errorf("get_document = %q, want it to describe document %s", got, docID)
	}
}

// ?doc= pins the session, so an editor tab open on something else cannot drag
// it away. This is the escape hatch from the browser-follow default.
func TestMountHTTPPinsDocumentFromQuery(t *testing.T) {
	url, _ := serveWithMCP(t)
	rpc := odmcp.NewClient(url)
	_ = newDoc(t, rpc)
	wanted := newDoc(t, rpc)

	cs := connectMCP(t, url+odmcp.HTTPPath+"?doc="+wanted)

	if got := callText(t, cs, "get_document"); !strings.Contains(got, wanted) {
		t.Errorf("get_document = %q, want the pinned document %s", got, wanted)
	}
}

// With no ?doc= and exactly one document in the workspace, there is nothing to
// disambiguate: adopt it rather than making the agent navigate first.
func TestMountHTTPAdoptsSoleDocument(t *testing.T) {
	url, _ := serveWithMCP(t)
	only := newDoc(t, odmcp.NewClient(url))

	cs := connectMCP(t, url+odmcp.HTTPPath)

	if got := callText(t, cs, "get_document"); !strings.Contains(got, only) {
		t.Errorf("get_document = %q, want the sole document %s", got, only)
	}
}

// A session that cannot open its document must not advertise editing tools it
// can only fail at, and must say why -- the instructions are the one channel an
// MCP client always shows.
func TestMountHTTPUnknownDocumentOffersNoTools(t *testing.T) {
	url, _ := serveWithMCP(t)
	_ = newDoc(t, odmcp.NewClient(url))

	cs := connectMCP(t, url+odmcp.HTTPPath+"?doc=not-a-real-document")

	tools, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if len(tools.Tools) != 0 {
		t.Errorf("ListTools returned %d tools, want none for an unopenable document", len(tools.Tools))
	}
	if instr := cs.InitializeResult().Instructions; !strings.Contains(instr, "not-a-real-document") {
		t.Errorf("instructions = %q, want them to name the document that failed to open", instr)
	}
}

// Every MCP session holds a Subscribe stream against the hub for as long as it
// lives. If closing the session did not stop it, each dropped client would leak
// a stream and a goroutine for the life of the server.
func TestMountHTTPStopsSyncLoopOnSessionClose(t *testing.T) {
	url, logs := serveWithMCP(t)
	docID := newDoc(t, odmcp.NewClient(url))

	cs := connectMCP(t, url+odmcp.HTTPPath+"?doc="+docID)
	callText(t, cs, "get_document") // the session is live and syncing
	if err := cs.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(logs.String(), "sync loop stopped") {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no teardown after closing the MCP session; logs were:\n%s", logs.String())
}
