package codegen

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// WriteFiles writes the output files under `dir` and returns the written paths
// (relative, in output order). It refuses a NON-empty directory unless `force`
// is set: an export must not silently delete or mix with someone's work. With
// `force` it overwrites files of the same name and leaves the others alone.
func WriteFiles(out *Output, dir string, force bool) ([]string, error) {
	if dir == "" {
		return nil, errors.New("empty destination directory")
	}
	if entries, err := os.ReadDir(dir); err == nil && len(entries) > 0 && !force {
		return nil, fmt.Errorf("directory %s is not empty: use -force to overwrite the generated files", dir)
	}
	var written []string
	for _, f := range out.Files {
		// The paths are generated here, but a check costs nothing and protects
		// against a future bug that writes outside the directory.
		clean := filepath.Clean(filepath.FromSlash(f.Path))
		if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
			return nil, fmt.Errorf("path not allowed: %s", f.Path)
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
