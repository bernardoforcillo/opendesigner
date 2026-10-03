package store

import "io"

// Asset ritorna i byte dell'asset: è ciò che chiede l'export di codice
// (internal/codegen.AssetSource). L'hash è validato da Open.
func (a *Assets) Asset(hash string) ([]byte, error) {
	f, _, err := a.Open(hash)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}
