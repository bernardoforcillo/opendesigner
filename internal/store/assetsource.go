package store

import "io"

// Asset returns the asset's bytes: it is what the code export asks for
// (internal/codegen.AssetSource). The hash is validated by Open.
func (a *Assets) Asset(hash string) ([]byte, error) {
	f, _, err := a.Open(hash)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}
