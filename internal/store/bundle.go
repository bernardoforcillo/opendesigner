// Package store persiste un documento come bundle-directory: snapshot + op-log append-only.
package store

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	brawtv1 "github.com/bernardoforcillo/brawt/gen/brawt/v1"
	"github.com/bernardoforcillo/brawt/internal/core"
	"google.golang.org/protobuf/encoding/protodelim"
	"google.golang.org/protobuf/proto"
)

type Bundle struct {
	mu    sync.Mutex
	dir   string // <workspace>/<docID>.brawt
	docID string
	name  string
}

func Open(workspace, docID, name string) (*Bundle, error) {
	dir := filepath.Join(workspace, docID+".brawt")
	if err := os.MkdirAll(filepath.Join(dir, "assets"), 0o755); err != nil {
		return nil, err
	}
	return &Bundle{dir: dir, docID: docID, name: name}, nil
}

func (b *Bundle) snapshotPath() string { return filepath.Join(b.dir, "snapshot.pb") }
func (b *Bundle) seqPath() string      { return filepath.Join(b.dir, "snapshot.seq") }
func (b *Bundle) oplogPath() string    { return filepath.Join(b.dir, "oplog") }

// Load ricostruisce documento e ultimo seq: snapshot + replay oplog.
func (b *Bundle) Load() (*brawtv1.Document, uint64, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	doc := core.NewDocument(b.docID, b.name)
	var seq uint64

	if data, err := os.ReadFile(b.snapshotPath()); err == nil {
		if err := proto.Unmarshal(data, doc); err != nil {
			return nil, 0, fmt.Errorf("unmarshal snapshot: %w", err)
		}
		if s, err := os.ReadFile(b.seqPath()); err == nil {
			seq, _ = strconv.ParseUint(strings.TrimSpace(string(s)), 10, 64)
		}
	} else if !os.IsNotExist(err) {
		return nil, 0, err
	}

	f, err := os.Open(b.oplogPath())
	if err != nil {
		if os.IsNotExist(err) {
			return doc, seq, nil
		}
		return nil, 0, err
	}
	defer f.Close()
	r := newReader(f)
	for {
		rec := &brawtv1.OpRecord{}
		if err := protodelim.UnmarshalFrom(r, rec); err != nil {
			if isEOF(err) {
				break
			}
			return nil, 0, fmt.Errorf("read oplog: %w", err)
		}
		if err := core.Apply(doc, rec.GetOp()); err != nil {
			return nil, 0, fmt.Errorf("replay seq %d: %w", rec.GetSeq(), err)
		}
		seq = rec.GetSeq()
	}
	return doc, seq, nil
}

// Append aggiunge un OpRecord length-delimited in coda all'oplog.
func (b *Bundle) Append(recrd *brawtv1.OpRecord) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	f, err := os.OpenFile(b.oplogPath(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := protodelim.MarshalTo(f, recrd); err != nil {
		return err
	}
	return f.Sync()
}

// Snapshot riscrive lo snapshot al seq dato e tronca l'oplog.
func (b *Bundle) Snapshot(doc *brawtv1.Document, seq uint64) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	data, err := proto.Marshal(doc)
	if err != nil {
		return err
	}
	if err := os.WriteFile(b.snapshotPath(), data, 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(b.seqPath(), []byte(strconv.FormatUint(seq, 10)), 0o644); err != nil {
		return err
	}
	return os.Truncate(b.oplogPath(), 0)
}
