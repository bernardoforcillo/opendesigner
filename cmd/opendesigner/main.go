package main

import (
	"flag"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"

	"github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1/opendesignerv1connect"
	odmcp "github.com/bernardoforcillo/opendesigner/internal/mcp"
	"github.com/bernardoforcillo/opendesigner/internal/server"
	"github.com/bernardoforcillo/opendesigner/web"
)

func main() {
	if len(os.Args) < 2 {
		log.Fatal("usage: opendesigner <serve|flow|export|pack|unpack> ...")
	}
	switch os.Args[1] {
	case "serve":
		runServe(os.Args[2:])
	case "flow":
		os.Exit(runFlow(os.Args[2:], os.Stdout, os.Stderr))
	case "export":
		os.Exit(runExport(os.Args[2:], os.Stdout, os.Stderr))
	case "pack":
		os.Exit(runPack(os.Args[2:], os.Stdout, os.Stderr))
	case "unpack":
		os.Exit(runUnpack(os.Args[2:], os.Stdout, os.Stderr))
	default:
		log.Fatal("usage: opendesigner <serve|flow|export|pack|unpack> ...")
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
	// Images: POST /assets-api/{docId} to upload them, GET
	// /assets-api/{docId}/{hash} to serve them to an <img>. Plain HTTP rather than
	// the design's UploadAsset RPC -- the why is in internal/server/assets.go.
	// The prefix is NOT /assets/ because underneath it the file server next to this
	// serves Vite's bundles.
	server.MountAssets(mux, *workspace)
	// The editor lives INSIDE the binary (web.Dist): `opendesigner serve` alone
	// already serves the app, with no frontend build or flag. -web remains the
	// development route and takes precedence -- see internal/server/webui.go.
	server.MountWeb(mux, *webDir, web.Dist)
	// MCP over HTTP: http://localhost:8080/mcp, in the same process as the editor.
	// The MCP session calls back into the server over loopback like any other client.
	odmcp.MountHTTP(mux, loopbackURL(*addr), log.New(os.Stderr, "opendesigner-mcp ", log.LstdFlags))

	// h2c (cleartext HTTP/2) is needed for Connect streaming locally, where there is no TLS.
	// Since Go 1.24's stdlib it is enabled via Server.Protocols: no golang.org/x/net.
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
		log.Printf("on the same network open: %s", u)
	}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

// loopbackURL is the URL the process uses to reach itself: addr's host
// if specific, otherwise 127.0.0.1 (":8080", "0.0.0.0:8080", "[::]:8080").
func loopbackURL(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "http://" + addr
	}
	if ip := net.ParseIP(host); host == "" || (ip != nil && ip.IsUnspecified()) {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
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
