package store

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// TrashDir è la cartella (dentro il workspace) dove finiscono i documenti
// eliminati. Non finisce in Scan: il suo nome non ha il suffisso dei bundle.
const TrashDir = ".trash"

// SetName cambia il nome del documento e lo rende durevole in meta.json.
// Passa dal Bundle (e dal suo b.mu) e NON da una riscrittura esterna del file:
// Snapshot tiene il meta in memoria e lo riscrive a ogni snapshot, quindi una
// riscrittura "da fuori" verrebbe annullata col nome vecchio al primo snapshot.
func (b *Bundle) SetName(name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("il nome del documento non può essere vuoto")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	m := b.meta
	m.Name = name
	return b.writeMetaLocked(m)
}

// ModTime è l'ultima modifica "vera" del documento: la più recente fra
// meta.json (aggiornato a ogni snapshot), snapshot.pb e il file dell'oplog
// (toccato a ogni operazione). Il solo UpdatedAt resterebbe fermo fino al
// prossimo snapshot (ogni 256 op), e una Home con "modificato 3 ore fa" su un
// documento appena toccato sarebbe una bugia. Zero se la cartella non esiste.
func ModTime(workspace, docID string) time.Time {
	dir := filepath.Join(workspace, docID+bundleSuffix)
	var latest time.Time
	for _, name := range []string{"oplog", "snapshot.pb", metaFileName} {
		if st, err := os.Stat(filepath.Join(dir, name)); err == nil && st.ModTime().After(latest) {
			latest = st.ModTime()
		}
	}
	return latest.UTC()
}

// Trash sposta il bundle del documento in <workspace>/.trash invece di
// cancellarlo: eliminare per errore deve restare rimediabile a mano. Il nome di
// destinazione porta un timestamp, così eliminare due volte lo stesso id (un
// bundle ricreato) non collide. Il chiamante garantisce che nessun Bundle sia
// più aperto su quella cartella.
func Trash(workspace, docID string) error {
	src := filepath.Join(workspace, docID+bundleSuffix)
	if st, err := os.Stat(src); err != nil {
		return err
	} else if !st.IsDir() {
		return fmt.Errorf("%s non è una cartella", src)
	}
	trash := filepath.Join(workspace, TrashDir)
	if err := os.MkdirAll(trash, 0o755); err != nil {
		return err
	}
	dst := filepath.Join(trash, fmt.Sprintf("%s%s-%d", docID, bundleSuffix, time.Now().UnixNano()))
	if err := os.Rename(src, dst); err != nil {
		return err
	}
	return syncDir(workspace)
}

// Exists: la cartella del bundle c'è. Non crea niente (Open invece sì).
func Exists(workspace, docID string) bool {
	st, err := os.Stat(filepath.Join(workspace, docID+bundleSuffix))
	return err == nil && st.IsDir()
}
