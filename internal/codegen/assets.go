package codegen

import (
	"errors"
	"os"
	"path/filepath"
)

// FuncAssets adapts a function to AssetSource.
type FuncAssets func(hash string) ([]byte, error)

// Asset implements AssetSource.
func (f FuncAssets) Asset(hash string) ([]byte, error) { return f(hash) }

// DirAssets reads assets from a directory: the file is named after the hash,
// with or without an extension (`<hash>`, `<hash>.png`...). It serves `export
// -json`, where there is no workspace to take them from.
func DirAssets(dir string) AssetSource {
	return FuncAssets(func(hash string) ([]byte, error) {
		// The hash comes from the document: it is only acceptable as a plain file name.
		if hash == "" || hash != filepath.Base(hash) || hash == "." || hash == ".." {
			return nil, errors.New("invalid hash")
		}
		if b, err := os.ReadFile(filepath.Join(dir, hash)); err == nil {
			return b, nil
		}
		matches, _ := filepath.Glob(filepath.Join(dir, hash+".*"))
		if len(matches) == 0 {
			return nil, os.ErrNotExist
		}
		return os.ReadFile(matches[0])
	})
}
