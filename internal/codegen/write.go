package codegen

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// WriteFiles scrive i file dell'output sotto `dir` e ritorna i percorsi scritti
// (relativi, nell'ordine dell'output). Rifiuta una cartella NON vuota a meno di
// `force`: un export non deve cancellare né mescolarsi in silenzio con il lavoro
// di qualcuno. Con `force` sovrascrive i file omonimi e lascia in pace gli altri.
func WriteFiles(out *Output, dir string, force bool) ([]string, error) {
	if dir == "" {
		return nil, errors.New("cartella di destinazione vuota")
	}
	if entries, err := os.ReadDir(dir); err == nil && len(entries) > 0 && !force {
		return nil, fmt.Errorf("la cartella %s non è vuota: usa -force per sovrascrivere i file generati", dir)
	}
	var written []string
	for _, f := range out.Files {
		// I percorsi sono generati qui, ma un controllo costa niente e protegge
		// da un bug futuro che scriva fuori dalla cartella.
		clean := filepath.Clean(filepath.FromSlash(f.Path))
		if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			return nil, fmt.Errorf("percorso non ammesso: %s", f.Path)
		}
		full := filepath.Join(dir, clean)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(full, f.Content, 0o644); err != nil {
			return nil, err
		}
		written = append(written, f.Path)
	}
	return written, nil
}
