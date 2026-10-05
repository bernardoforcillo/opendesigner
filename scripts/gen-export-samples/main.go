// gen-export-samples writes the code export's example documents as
// protojson, ready for `opendesigner export -json`:
//
//	go run ./scripts/gen-export-samples -out /tmp/samples
//
// it produces gallery.json (+ assets/<hash>.png) for the pixel-parity script
// (web/scripts/export-parity.mjs) and shop.json for the exported app's test.
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
	fmt.Println("wrote gallery.json, shop.json, anim.json and assets/ in", *out)
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
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}
