package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/bernardoforcillo/brawt/gen/brawt/v1/brawtv1connect"
	"github.com/bernardoforcillo/brawt/internal/server"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
)

func main() {
	if len(os.Args) < 2 || os.Args[1] != "serve" {
		log.Fatal("usage: brawt serve [-addr :8080] [-workspace ~/.brawt] [-web web/dist]")
	}
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fs.String("addr", ":8080", "listen address")
	workspace := fs.String("workspace", defaultWorkspace(), "documents workspace dir")
	web := fs.String("web", "", "path to built frontend (optional)")
	_ = fs.Parse(os.Args[2:])

	if err := os.MkdirAll(*workspace, 0o755); err != nil {
		log.Fatal(err)
	}
	mgr := server.NewManager(*workspace)
	svc := server.NewDocumentService(mgr)

	mux := http.NewServeMux()
	path, handler := brawtv1connect.NewDocumentServiceHandler(svc)
	mux.Handle(path, handler)
	if *web != "" {
		mux.Handle("/", http.FileServer(http.Dir(*web)))
	}

	log.Printf("brawt serve on %s (workspace=%s)", *addr, *workspace)
	// h2c: HTTP/2 senza TLS in locale, richiesto dallo streaming Connect/gRPC.
	if err := http.ListenAndServe(*addr, h2c.NewHandler(mux, &http2.Server{})); err != nil {
		log.Fatal(err)
	}
}

func defaultWorkspace() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".brawt"
	}
	return filepath.Join(home, ".brawt")
}
