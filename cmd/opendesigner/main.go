package main

import (
	"context"
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"

	"connectrpc.com/connect"
	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
	"github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1/opendesignerv1connect"
	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
	"github.com/bernardoforcillo/opendesigner/internal/server"
	"github.com/bernardoforcillo/opendesigner/web"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func main() {
	if len(os.Args) < 2 {
		log.Fatal("usage: opendesigner <serve|mcp> ...")
	}
	switch os.Args[1] {
	case "serve":
		runServe(os.Args[2:])
	case "mcp":
		runMCP(os.Args[2:])
	default:
		log.Fatal("usage: opendesigner <serve|mcp> ...")
	}
}

func runServe(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fs.String("addr", ":8080", "listen address")
	workspace := fs.String("workspace", defaultWorkspace(), "documents workspace dir")
	webDir := fs.String("web", "", "serve the frontend from this directory instead of the embedded one (development)")
	_ = fs.Parse(args)

	if err := os.MkdirAll(*workspace, 0o755); err != nil {
		log.Fatal(err)
	}
	mgr := server.NewManager(*workspace)
	svc := server.NewDocumentService(mgr)

	mux := http.NewServeMux()
	path, handler := opendesignerv1connect.NewDocumentServiceHandler(svc)
	mux.Handle(path, handler)
	// Le immagini: POST /assets-api/{docId} per caricarle, GET
	// /assets-api/{docId}/{hash} per servirle a un <img>. HTTP semplice e non
	// l'RPC UploadAsset del design -- il perché sta in internal/server/assets.go.
	// Il prefisso NON è /assets/ perché lì sotto il file server qui accanto serve
	// i bundle di Vite.
	server.MountAssets(mux, *workspace)
	// L'editor sta DENTRO il binario (web.Dist): `opendesigner serve` da solo
	// serve già l'app, senza build del frontend né flag. -web resta la via di
	// sviluppo e ha la precedenza -- vedi internal/server/webui.go.
	server.MountWeb(mux, *webDir, web.Dist)

	// h2c (HTTP/2 in chiaro) serve allo streaming Connect in locale, dove non c'è TLS.
	// Dalla stdlib Go 1.24 lo si abilita con Server.Protocols: niente golang.org/x/net.
	protocols := new(http.Protocols)
	protocols.SetHTTP1(true)
	protocols.SetUnencryptedHTTP2(true)
	srv := &http.Server{
		Addr:      *addr,
		Handler:   mux,
		Protocols: protocols,
	}

	log.Printf("opendesigner serve on %s (workspace=%s)", *addr, *workspace)
	for _, u := range lanURLs(*addr) {
		log.Printf("sulla stessa rete apri: %s", u)
	}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

// runMCP starts the stdio MCP server: it connects to a running `opendesigner
// serve` as an h2c Connect client, opens the shared document, keeps a local
// mirror synced via Subscribe, and exposes the design tools over MCP. stdout is
// the MCP stdio channel, so every log line goes to stderr.
func runMCP(args []string) {
	logger := log.New(os.Stderr, "opendesigner-mcp ", log.LstdFlags)

	fs := flag.NewFlagSet("mcp", flag.ExitOnError)
	serverURL := fs.String("server", "http://localhost:8080", "base URL of a running `opendesigner serve`")
	docID := fs.String("doc", "", "document id to co-design (shared with the web client)")
	clientID := fs.String("client-id", "", "client id for this MCP session (defaults to a random one)")
	_ = fs.Parse(args)

	// Ctrl-C / SIGTERM cancels the whole session: it stops the Subscribe loop
	// and unblocks srv.Run.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	client := odmcp.NewClient(*serverURL)

	resolvedDoc, err := resolveDoc(ctx, client, *docID, logger)
	if err != nil {
		logger.Fatalf("resolve document: %v", err)
	}

	sess := odmcp.NewSession(client, resolvedDoc, *clientID, logger)
	if err := sess.Open(ctx); err != nil {
		logger.Fatalf("open document: %v", err)
	}
	logger.Printf("co-designing document %s as client %s via %s", resolvedDoc, sess.ClientID(), *serverURL)

	// The sync loop is the only writer of the local doc; it runs until ctx ends.
	go sess.SyncLoop(ctx)

	srv := mcp.NewServer(&mcp.Implementation{Name: "opendesigner", Version: "0.1.0"}, nil)
	odmcp.RegisterTools(srv, sess)

	if err := srv.Run(ctx, &mcp.StdioTransport{}); err != nil && ctx.Err() == nil {
		logger.Fatalf("mcp server: %v", err)
	}
}

// resolveDoc turns the -doc flag into a concrete document id. Empty -doc is a
// convenience: on an empty workspace it creates a document and uses it; when
// documents already exist it refuses and lists them, so a session never
// silently co-designs the wrong one.
func resolveDoc(ctx context.Context, client opendesignerv1connect.DocumentServiceClient, docID string, logger *log.Logger) (string, error) {
	if docID != "" {
		return docID, nil
	}
	list, err := client.ListDocuments(ctx, connect.NewRequest(&opendesignerv1.ListDocumentsRequest{}))
	if err != nil {
		return "", err
	}
	docs := list.Msg.GetDocs()
	if len(docs) == 0 {
		created, err := client.CreateDocument(ctx, connect.NewRequest(&opendesignerv1.CreateDocumentRequest{Name: "MCP Session"}))
		if err != nil {
			return "", err
		}
		logger.Printf("no -doc given and workspace empty; created document %s", created.Msg.GetId())
		return created.Msg.GetId(), nil
	}
	logger.Printf("no -doc given; available documents:")
	for _, d := range docs {
		logger.Printf("  %s  %q", d.GetId(), d.GetName())
	}
	return "", &missingDocError{}
}

type missingDocError struct{}

func (*missingDocError) Error() string {
	return "pass -doc <id> to choose which document to co-design (see the list above)"
}

func defaultWorkspace() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".opendesigner"
	}
	return filepath.Join(home, ".opendesigner")
}

// lanURLs returns the http:// addresses other machines on the same network can
// use to reach this server, or nothing when it only listens on loopback. There
// is no authentication: anyone who can reach the port can edit, which is the
// point on a trusted LAN and the reason to bind to 127.0.0.1 elsewhere.
func lanURLs(addr string) []string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil
	}
	if host != "" && host != "0.0.0.0" && host != "::" {
		ip := net.ParseIP(host)
		if ip == nil || ip.IsLoopback() {
			return nil
		}
		return []string{"http://" + net.JoinHostPort(host, port)}
	}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	var out []string
	for _, a := range addrs {
		ipn, ok := a.(*net.IPNet)
		if !ok || ipn.IP.IsLoopback() || ipn.IP.To4() == nil || !ipn.IP.IsPrivate() {
			continue
		}
		out = append(out, "http://"+net.JoinHostPort(ipn.IP.String(), port))
	}
	return out
}
