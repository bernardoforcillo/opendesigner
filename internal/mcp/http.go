package mcp

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// HTTPPath is where the MCP endpoint lives on the serve mux. Clients are
// configured with a URL and nothing else:
//
//	http://localhost:8080/mcp
const HTTPPath = "/mcp"

// serverVersion is what the MCP handshake reports.
const serverVersion = "0.1.0"

// sessionIdleTimeout reaps sessions whose client vanished without closing.
// Teardown normally rides on ServerSession.Wait (see serverFor); this is the
// backstop for the client that simply stops talking, because every live session
// holds a Subscribe stream against the hub.
const sessionIdleTimeout = 30 * time.Minute

// MountHTTP registers the MCP endpoint on mux.
//
// selfURL is the base URL of the serve process this handler runs inside: the
// MCP session dials it back over loopback and drives the document as an
// ORDINARY client, through the same Open/Subscribe/Submit path the browser
// uses. That is what makes the agent a peer of the editor rather than a
// privileged insider, and it is why co-editing works at all -- every op lands
// in the same log and comes back out on the same broadcast.
func MountHTTP(mux *http.ServeMux, selfURL string, logger *log.Logger) {
	mux.Handle(HTTPPath, Handler(selfURL, logger))
}

// Handler builds the MCP endpoint without mounting it.
func Handler(selfURL string, logger *log.Logger) http.Handler {
	if logger == nil {
		logger = log.New(io.Discard, "", 0)
	}
	h := &httpMount{selfURL: selfURL, logger: logger}
	// The SDK refuses non-localhost Origins by default, which is what stops a
	// hostile web page in the user's browser from driving their editor through
	// this endpoint. Local-first is not the same as unguarded.
	return mcp.NewStreamableHTTPHandler(h.serverFor, &mcp.StreamableHTTPOptions{
		SessionTimeout: sessionIdleTimeout,
	})
}

type httpMount struct {
	selfURL string
	logger  *log.Logger
}

// serverFor builds one MCP server per MCP session. The SDK calls it on session
// creation, which is the only seam where per-session state (the open document,
// the local mirror, the sync goroutine) can be established.
func (h *httpMount) serverFor(req *http.Request) *mcp.Server {
	docID, err := h.resolveDoc(req.Context(), req.URL.Query().Get("doc"))
	if err != nil {
		return refusingServer(err)
	}

	sess := NewSession(NewClient(h.selfURL), docID, "", h.logger)

	// The context outlives this request on purpose: it belongs to the MCP
	// SESSION, not to the initialize call that created it.
	ctx, cancel := context.WithCancel(context.Background())
	if err := sess.Open(ctx); err != nil {
		cancel()
		return refusingServer(err)
	}
	go func() {
		sess.SyncLoop(ctx)
		// The teardown line operators look for when a session goes quiet, and
		// the proof that the Subscribe stream really ended.
		h.logger.Printf("sync loop stopped for document %s (client %s)", docID, sess.ClientID())
	}()

	srv := mcp.NewServer(&mcp.Implementation{Name: "opendesigner", Version: serverVersion}, &mcp.ServerOptions{
		// The session object does not exist until initialization completes, so
		// this is the earliest point at which its end can be watched. A client
		// that connects and never initializes is left to sessionIdleTimeout.
		InitializedHandler: func(_ context.Context, r *mcp.InitializedRequest) {
			ss := r.Session
			go func() {
				_ = ss.Wait()
				cancel()
			}()
		},
	})
	RegisterTools(srv, sess)
	h.logger.Printf("mcp session co-designing document %s as client %s", docID, sess.ClientID())
	return srv
}

// resolveDoc decides which document this session edits.
//
// An explicit ?doc= pins it. Otherwise the workspace decides: a single document
// is unambiguous, and an empty one is worth creating into rather than refusing.
// Anything else needs the caller to say which, until the focus signal lands and
// the browser can answer that question on their behalf.
func (h *httpMount) resolveDoc(ctx context.Context, pinned string) (string, error) {
	if pinned != "" {
		return pinned, nil
	}
	client := NewClient(h.selfURL)
	list, err := client.ListDocuments(ctx, connect.NewRequest(&opendesignerv1.ListDocumentsRequest{}))
	if err != nil {
		return "", fmt.Errorf("list documents: %w", err)
	}
	docs := list.Msg.GetDocs()
	switch len(docs) {
	case 1:
		return docs[0].GetId(), nil
	case 0:
		created, err := client.CreateDocument(ctx, connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: "MCP Session"}))
		if err != nil {
			return "", fmt.Errorf("create document: %w", err)
		}
		return created.Msg.GetId(), nil
	default:
		return "", fmt.Errorf("this workspace has %d documents: add ?doc=<id> to the MCP url to choose one", len(docs))
	}
}

// refusingServer answers a session that has no document to edit. It advertises
// NO tools deliberately: a tool list that cannot work is worse than an empty
// one, and instructions are the single channel every MCP client surfaces, so
// the reason travels with the failure.
func refusingServer(reason error) *mcp.Server {
	return mcp.NewServer(
		&mcp.Implementation{Name: "opendesigner", Version: serverVersion},
		&mcp.ServerOptions{Instructions: "opendesigner has no document open: " + reason.Error()},
	)
}
