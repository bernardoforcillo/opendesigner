package codegen

import (
	"errors"
	"os"
	"path/filepath"
)

// FuncAssets adatta una funzione ad AssetSource.
type FuncAssets func(hash string) ([]byte, error)

// Asset implementa AssetSource.
func (f FuncAssets) Asset(hash string) ([]byte, error) { return f(hash) }

// DirAssets legge gli asset da una cartella: il file si chiama come l'hash,
// con o senza estensione (`<hash>`, `<hash>.png`...). Serve a `export -json`,
// dove non c'è un workspace da cui prenderli.
func DirAssets(dir string) AssetSource {
	return FuncAssets(func(hash string) ([]byte, error) {
		// L'hash arriva dal documento: va bene solo se è un nome di file semplice.
		if hash == "" || hash != filepath.Base(hash) || hash == "." || hash == ".." {
			return nil, errors.New("hash non valido")
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
