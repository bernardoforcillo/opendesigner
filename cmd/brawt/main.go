package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/bernardoforcillo/brawt/gen/brawt/v1/brawtv1connect"
	"github.com/bernardoforcillo/brawt/internal/server"
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

	log.Printf("brawt serve on %s (workspace=%s)", *addr, *workspace)
	if err := srv.ListenAndServe(); err != nil {
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
