package store

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// LoadReadOnly ricostruisce un documento dal workspace SENZA toccarlo: serve
// agli strumenti offline (`opendesigner flow ...`) che possono girare mentre un
// `serve` scrive sugli stessi file.
//
// Bundle.Load non è innocuo: Open crea cartelle e meta.json mancanti, e la
// lettura dell'oplog RIPARA una coda strappata troncando il file -- giusto per
// chi possiede il bundle, sbagliato per un lettore che incrocia un'append in
// corso di un altro processo. Quindi si lavora su una COPIA temporanea di
// snapshot.pb, oplog e meta.json (gli asset non servono): la riparazione, se
// serve, avviene sulla copia e l'originale resta intatto. Una copia presa a
// metà di un'append può mancare dell'ultima op, mai produrre uno stato
// incoerente: è lo stesso istante di un `serve` che riparte.
func LoadReadOnly(workspace, docID string) (*opendesignerv1.Document, uint64, error) {
	src := filepath.Join(workspace, docID+bundleSuffix)
	if st, err := os.Stat(src); err != nil {
		return nil, 0, fmt.Errorf("documento %s: %w", docID, err)
	} else if !st.IsDir() {
		return nil, 0, fmt.Errorf("documento %s: %s non è una cartella", docID, src)
	}
	tmp, err := os.MkdirTemp("", "opendesigner-ro-*")
	if err != nil {
		return nil, 0, err
	}
	defer os.RemoveAll(tmp)

	dst := filepath.Join(tmp, docID+bundleSuffix)
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return nil, 0, err
	}
	for _, name := range []string{"snapshot.pb", "oplog", metaFileName} {
		if err := copyIfExists(filepath.Join(src, name), filepath.Join(dst, name)); err != nil {
			return nil, 0, err
		}
	}
	b, err := Open(tmp, docID, DefaultName)
	if err != nil {
		return nil, 0, err
	}
	return b.Load()
}

func copyIfExists(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	defer in.Close()
	out, err := os.Create(to)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
