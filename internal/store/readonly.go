package store

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	opendesignerv1 "github.com/bernardoforcillo/opendesigner/gen/opendesigner/v1"
)

// LoadReadOnly rebuilds a document from the workspace WITHOUT touching it: it serves
// offline tools (`opendesigner flow ...`) that may run while a
// `serve` writes to the same files.
//
// Bundle.Load is not harmless: Open creates missing folders and meta.json, and
// reading the oplog REPAIRS a torn tail by truncating the file -- right for
// whoever owns the bundle, wrong for a reader that crosses an append in
// progress by another process. So it works on a temporary COPY of
// snapshot.pb, oplog and meta.json (assets are not needed): the repair, if
// needed, happens on the copy and the original stays intact. A copy taken in
// the middle of an append may miss the last op, but never produces an
// inconsistent state: it is the same instant as a `serve` restarting.
func LoadReadOnly(workspace, docID string) (*opendesignerv1.Document, uint64, error) {
	src := filepath.Join(workspace, docID+bundleSuffix)
	if st, err := os.Stat(src); err != nil {
		return nil, 0, fmt.Errorf("documento %s: %w", docID, err)
	} else if !st.IsDir() {
		return nil, 0, fmt.Errorf("document %s: %s is not a directory", docID, src)
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
