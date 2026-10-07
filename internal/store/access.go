package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// ACCESS CONTROL of a document: whether it is protected and which links may reach it. One small
// file in the bundle (access.json). A link's token is never stored, only its SHA-256.

const accessFile = "access.json"

// Link is one share link: a role and the hash of its secret token.
type Link struct {
	ID        string    `json:"id"`
	Role      string    `json:"role"` // owner | edit | comment | view
	Label     string    `json:"label"`
	Hash      string    `json:"hash"`
	CreatedAt time.Time `json:"createdAt"`
}

// Access is the protection state of a document. The zero value is "not protected".
type Access struct {
	Enabled bool   `json:"enabled"`
	Links   []Link `json:"links"`
}

// LoadAccess reads the access file; a missing one is "not protected".
func (b *Bundle) LoadAccess() (Access, error) {
	data, err := os.ReadFile(filepath.Join(b.dir, accessFile))
	if err != nil {
		if os.IsNotExist(err) {
			return Access{}, nil
		}
		return Access{}, err
	}
	var a Access
	if err := json.Unmarshal(data, &a); err != nil {
		return Access{}, err
	}
	return a, nil
}

// SaveAccess writes the access file (0600: it holds hashes of secrets).
func (b *Bundle) SaveAccess(a Access) error {
	data, err := json.Marshal(a)
	if err != nil {
		return err
	}
	return writeFileSync(filepath.Join(b.dir, accessFile), data, 0o600)
}
