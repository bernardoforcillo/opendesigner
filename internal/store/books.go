package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// BooksDir is the folder (inside the workspace) that holds the books. Like TrashDir its name lacks the bundle
// suffix, so Scan never takes it for a document.
const BooksDir = ".books"

// ErrNoBook: no book with that id.
var ErrNoBook = errors.New("book not found")

// BookRecord is a book on disk: a name and the documents it groups. It holds ids only; the documents
// themselves stay ordinary bundles, so deleting a book never touches them.
type BookRecord struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	DocIDs        []string  `json:"docIds"`
	StyleSourceID string    `json:"styleSourceId,omitempty"`
	StartNumber   uint32    `json:"startNumber,omitempty"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

func bookPath(workspace, id string) (string, error) {
	// The id is joined into a path: it must be a plain file name.
	if id == "" || strings.ContainsAny(id, `/\`) || strings.HasPrefix(id, ".") {
		return "", fmt.Errorf("invalid book id %q", id)
	}
	return filepath.Join(workspace, BooksDir, id+".json"), nil
}

// SaveBook writes the book atomically (temp file, rename, directory fsync).
func SaveBook(workspace string, b BookRecord) error {
	p, err := bookPath(workspace, b.ID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := stageFileSync(p, append(data, '\n'), 0o644)
	if err != nil {
		return err
	}
	return commitStagedFile(tmp, p)
}

// LoadBook reads one book.
func LoadBook(workspace, id string) (BookRecord, error) {
	p, err := bookPath(workspace, id)
	if err != nil {
		return BookRecord{}, ErrNoBook
	}
	data, err := os.ReadFile(p)
	if os.IsNotExist(err) {
		return BookRecord{}, ErrNoBook
	}
	if err != nil {
		return BookRecord{}, err
	}
	var b BookRecord
	if err := json.Unmarshal(data, &b); err != nil {
		return BookRecord{}, fmt.Errorf("book %s: %w", id, err)
	}
	b.ID = id
	return b, nil
}

// ListBooks returns every readable book, oldest first. A book file that cannot be read is left out rather
// than failing the list.
func ListBooks(workspace string) ([]BookRecord, error) {
	entries, err := os.ReadDir(filepath.Join(workspace, BooksDir))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []BookRecord
	for _, e := range entries {
		id, ok := strings.CutSuffix(e.Name(), ".json")
		if !ok || e.IsDir() {
			continue
		}
		if b, err := LoadBook(workspace, id); err == nil {
			out = append(out, b)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].UpdatedAt.Equal(out[j].UpdatedAt) {
			return out[i].UpdatedAt.Before(out[j].UpdatedAt)
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// DeleteBook removes the book file (the documents it named are untouched).
func DeleteBook(workspace, id string) error {
	p, err := bookPath(workspace, id)
	if err != nil {
		return ErrNoBook
	}
	if err := os.Remove(p); os.IsNotExist(err) {
		return ErrNoBook
	} else if err != nil {
		return err
	}
	return syncDir(filepath.Dir(p))
}
