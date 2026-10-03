// gen-export-samples scrive i documenti di esempio dell'export di codice come
// protojson, pronti per `opendesigner export -json`:
//
//	go run ./scripts/gen-export-samples -out /tmp/samples
//
// produce gallery.json (+ assets/<hash>.png) per lo script di parità dei pixel
// (web/scripts/export-parity.mjs) e shop.json per il test dell'app esportata.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/bernardoforcillo/opendesigner/internal/codegen/samples"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func main() {
	out := flag.String("out", "samples", "output directory")
	flag.Parse()
	if err := os.MkdirAll(filepath.Join(*out, "assets"), 0o755); err != nil {
		fatal(err)
	}
	gallery, assets := samples.Gallery()
	write(filepath.Join(*out, "gallery.json"), gallery)
	for hash, b := range assets {
		if err := os.WriteFile(filepath.Join(*out, "assets", hash+".png"), b, 0o644); err != nil {
			fatal(err)
		}
	}
	write(filepath.Join(*out, "shop.json"), samples.Shop())
	write(filepath.Join(*out, "anim.json"), samples.AnimDemo())
	fmt.Println("scritti gallery.json, shop.json, anim.json e assets/ in", *out)
}

func write(path string, m proto.Message) {
	b, err := protojson.MarshalOptions{Multiline: true, Indent: "  "}.Marshal(m)
	if err != nil {
		fatal(err)
	}
	if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "errore:", err)
	os.Exit(1)
}
