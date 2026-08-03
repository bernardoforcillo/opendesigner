package store

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// ASSET STORE — le immagini di un documento, indirizzate per contenuto.
//
// Vive nella directory `assets/` che il bundle già provvedeva (vedi Open) e che
// nessuno aveva mai scritto. È deliberatamente SEPARATO da Bundle e non un suo
// metodo: un asset non è un op, non passa dall'op-log, non entra negli snapshot
// e non ha bisogno di b.mu -- il nome di un file È il suo contenuto, quindi due
// scritture concorrenti dello stesso asset scrivono gli stessi byte nello stesso
// posto e non c'è niente da serializzare. Tenerlo fuori da Bundle è anche ciò
// che rende impossibile, per sbaglio, mettere dei byte di immagine sul percorso
// verificato dell'op-log.

// MaxAssetSize è il tetto per un singolo asset (32 MiB).
//
// Sta QUI e non solo nell'handler HTTP: è la guardia che impedisce a QUALUNQUE
// chiamante di riempire il disco, non solo a quello che passa dalla rete. 32 MiB
// è largo per una foto e stretto abbastanza da non far diventare un errore di
// battitura un problema di spazio.
const MaxAssetSize = 32 << 20

// sniffLen è quanto basta a riconoscere i quattro contenitori raster ammessi
// (il più lungo dei prefissi è WebP: 12 byte). 512 come http.DetectContentType,
// così un file più corto di così viene comunque letto per intero.
const sniffLen = 512

var (
	// ErrAssetNotFound: nessun asset con quell'hash in questo documento.
	ErrAssetNotFound = errors.New("store: asset not found")
	// ErrAssetHash: la stringa passata non è un hash (64 esadecimali minuscoli).
	// Rifiutata PRIMA di qualunque filepath.Join: è la guardia contro il path
	// traversal, non un controllo di forma.
	ErrAssetHash = errors.New("store: malformed asset hash")
	// ErrAssetDocID: l'id documento non è un segmento di percorso sicuro.
	ErrAssetDocID = errors.New("store: unsafe document id")
	// ErrAssetType: i byte non sono un'immagine di un tipo che l'editor disegna.
	ErrAssetType = errors.New("store: unsupported asset type")
	// ErrAssetTooLarge: l'asset supera MaxAssetSize.
	ErrAssetTooLarge = errors.New("store: asset too large")
)

// imageTypes è l'ALLOWLIST, e il fatto che sia chiusa è il punto.
//
// Non si usa http.DetectContentType: quella funzione ha una risposta per
// qualunque byte (text/html, application/pdf, text/plain...), e un endpoint che
// accetta byte arbitrari e li riserve con il tipo indovinato è un host
// same-origin per HTML e script -- cioè una XSS immagazzinata, servita dallo
// stesso origin dell'editor. Qui i byte devono essere uno dei quattro
// contenitori raster che il canvas sa disegnare, e il Content-Type che l'handler
// scrive esce da questa tabella, mai dal client.
//
// L'SVG è escluso di proposito, e non per pigrizia: un SVG è un documento XML
// che può contenere <script>, e servito per intero da questo origin verrebbe
// eseguito appena qualcuno ne apre l'URL. Un'immagine raster non ha quel potere.
var imageTypes = []struct {
	prefix []byte
	// mask, quando non è nil, azzera i byte VARIABILI del prefisso (la
	// dimensione del chunk RIFF di WebP): senza, il confronto dipenderebbe dalla
	// lunghezza del file.
	mask        []byte
	contentType string
}{
	{prefix: []byte("\x89PNG\r\n\x1a\n"), contentType: "image/png"},
	{prefix: []byte("\xff\xd8\xff"), contentType: "image/jpeg"},
	{prefix: []byte("GIF87a"), contentType: "image/gif"},
	{prefix: []byte("GIF89a"), contentType: "image/gif"},
	{
		prefix:      []byte("RIFF\x00\x00\x00\x00WEBP"),
		mask:        []byte("\xff\xff\xff\xff\x00\x00\x00\x00\xff\xff\xff\xff"),
		contentType: "image/webp",
	},
}

// DetectImageType ritorna il Content-Type dei byte iniziali di un asset, o ""
// se non sono uno dei tipi ammessi. Esportata perché è la stessa domanda che si
// pone chi scrive (Put) e chi legge (Open): un solo posto che decide che cos'è
// un'immagine.
func DetectImageType(head []byte) string {
	for _, t := range imageTypes {
		if len(head) < len(t.prefix) {
			continue
		}
		if t.mask == nil {
			if bytes.HasPrefix(head, t.prefix) {
				return t.contentType
			}
			continue
		}
		match := true
		for i := range t.prefix {
			if head[i]&t.mask[i] != t.prefix[i] {
				match = false
				break
			}
		}
		if match {
			return t.contentType
		}
	}
	return ""
}

// Ref è quello che si sa di un asset senza leggerlo: il suo nome (= il suo
// contenuto), quanto pesa e come va servito.
type Ref struct {
	Hash        string
	Size        int64
	ContentType string
}

// Assets è lo store degli asset di UN documento.
type Assets struct {
	workspace string
	docID     string
}

// NewAssets ritorna lo store degli asset del documento docID. Non tocca il
// disco: la directory viene creata alla prima scrittura (e un documento senza
// immagini non ne ha bisogno).
func NewAssets(workspace, docID string) *Assets {
	return &Assets{workspace: workspace, docID: docID}
}

// safeSegment dice se s può essere usato come UN segmento di percorso.
//
// Il chiamante (internal/server) valida già il doc id come UUID; questo è il
// controllo che NON si può saltare, perché è qui che la stringa incontra
// filepath.Join. Un ".." o un separatore lascerebbero la directory degli asset,
// e questo store legge e scrive file per conto di una route pubblica.
func safeSegment(s string) bool {
	if s == "" || s == "." || s == ".." {
		return false
	}
	if strings.ContainsAny(s, `/\:`) {
		return false
	}
	return true
}

func (a *Assets) dir() (string, error) {
	if !safeSegment(a.docID) {
		return "", fmt.Errorf("%w: %q", ErrAssetDocID, a.docID)
	}
	return filepath.Join(a.workspace, a.docID+bundleSuffix, "assets"), nil
}

// HasBundle dice se il documento esiste già sul disco.
//
// Serve alla route di upload: un POST verso un id inventato non deve far
// NASCERE un documento fatto di soli asset. I bundle li crea CreateDocument, e
// questo store non è un'altra porta d'ingresso per crearne.
func (a *Assets) HasBundle() bool {
	dir, err := a.dir()
	if err != nil {
		return false
	}
	fi, err := os.Stat(filepath.Dir(dir))
	return err == nil && fi.IsDir()
}

// validHash accetta esattamente 64 esadecimali MINUSCOLI.
//
// Minuscoli e non "case-insensitive" apposta: l'hash è il nome del file, e su
// un filesystem case-sensitive due grafie dello stesso hash sarebbero due file
// diversi -- cioè lo stesso asset immagazzinato due volte, che è precisamente
// ciò che l'indirizzamento per contenuto esiste per evitare. Una sola grafia
// canonica, quella che stampa hex.EncodeToString.
func validHash(hash string) bool {
	if len(hash) != sha256.Size*2 {
		return false
	}
	for i := 0; i < len(hash); i++ {
		c := hash[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// Path è il percorso del file di un asset. Errore (e nessun percorso) se l'hash
// o il doc id non sono sicuri.
func (a *Assets) Path(hash string) (string, error) {
	dir, err := a.dir()
	if err != nil {
		return "", err
	}
	if !validHash(hash) {
		return "", fmt.Errorf("%w: %q", ErrAssetHash, hash)
	}
	// Il nome del file è l'hash NUDO, senza estensione, e la deviazione dal
	// design (`assets/<sha256>.<ext>`) è voluta: il nodo porta solo l'hash,
	// quindi con un'estensione ogni lettura dovrebbe indovinarla o scandire la
	// directory, mentre il tipo si ricava dai byte stessi (DetectImageType) --
	// che è l'unica fonte che non può divergere dal contenuto. Il percorso resta
	// una funzione pura dell'hash: nessuna ricerca, nessuna ambiguità.
	return filepath.Join(dir, hash), nil
}

// Put immagazzina i byte di r e ne ritorna il riferimento.
//
// Indirizzato per contenuto: la stessa immagine messa due volte occupa UN file.
// La scrittura passa da un file temporaneo rinominato al suo posto, quindi un
// lettore non può mai osservare un asset a metà -- e un asset esiste se e solo
// se è completo, che è ciò che permette al nome di essere una promessa sui byte.
func (a *Assets) Put(r io.Reader) (Ref, error) {
	dir, err := a.dir()
	if err != nil {
		return Ref{}, err
	}

	// Il tipo si decide PRIMA di creare qualunque file: un upload rifiutato non
	// deve aver toccato il disco.
	head := make([]byte, sniffLen)
	n, err := io.ReadFull(r, head)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return Ref{}, err
	}
	head = head[:n]
	ct := DetectImageType(head)
	if ct == "" {
		return Ref{}, ErrAssetType
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Ref{}, err
	}
	tmp, err := os.CreateTemp(dir, ".upload-*")
	if err != nil {
		return Ref{}, err
	}
	tmpName := tmp.Name()
	committed := false
	defer func() {
		if !committed {
			// Un upload interrotto non lascia niente: né byte a metà, né un file
			// che occupa spazio senza essere raggiungibile da nessun hash.
			tmp.Close()
			os.Remove(tmpName)
		}
	}()

	sum := sha256.New()
	// LimitReader a MaxAssetSize+1: il byte in più è come si distingue "grande
	// esattamente quanto il tetto" (lecito) da "più grande del tetto" (rifiutato)
	// senza dover leggere il resto di un upload che comunque non entrerà.
	src := io.LimitReader(io.MultiReader(bytes.NewReader(head), r), MaxAssetSize+1)
	size, err := io.Copy(io.MultiWriter(tmp, sum), src)
	if err != nil {
		return Ref{}, err
	}
	if size > MaxAssetSize {
		return Ref{}, fmt.Errorf("%w: oltre %d byte", ErrAssetTooLarge, MaxAssetSize)
	}
	if err := tmp.Sync(); err != nil {
		return Ref{}, err
	}
	if err := tmp.Close(); err != nil {
		return Ref{}, err
	}

	hash := hex.EncodeToString(sum.Sum(nil))
	path := filepath.Join(dir, hash)
	// Già presente: la stessa immagine è già immagazzinata, e i byte sono per
	// costruzione gli stessi (è lo stesso sha256). Non si riscrive -- rinominare
	// sopra un file che qualcuno sta servendo fallisce su Windows, e non ci
	// sarebbe comunque niente da cambiare.
	if _, err := os.Stat(path); err == nil {
		return Ref{Hash: hash, Size: size, ContentType: ct}, nil
	} else if !os.IsNotExist(err) {
		return Ref{}, err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return Ref{}, err
	}
	committed = true
	// La directory va fsyncata perché la voce appena creata sia durabile, non
	// solo i suoi byte (no-op su Windows, vedi syncDir).
	if err := syncDir(dir); err != nil {
		return Ref{}, err
	}
	return Ref{Hash: hash, Size: size, ContentType: ct}, nil
}

// Open apre l'asset e ne ritorna il riferimento. Il chiamante chiude il file.
//
// Il Content-Type si RICALCOLA dai byte sul disco invece di fidarsi di
// qualcosa scritto a fianco: è la stessa allowlist della scrittura, quindi un
// file finito lì per altre vie (una copia a mano) non può farsi servire come
// HTML.
func (a *Assets) Open(hash string) (*os.File, Ref, error) {
	path, err := a.Path(hash)
	if err != nil {
		return nil, Ref{}, err
	}
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, Ref{}, fmt.Errorf("%w: %s", ErrAssetNotFound, hash)
		}
		return nil, Ref{}, err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, Ref{}, err
	}
	head := make([]byte, sniffLen)
	n, err := io.ReadFull(f, head)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		f.Close()
		return nil, Ref{}, err
	}
	ct := DetectImageType(head[:n])
	if ct == "" {
		f.Close()
		return nil, Ref{}, ErrAssetType
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		f.Close()
		return nil, Ref{}, err
	}
	return f, Ref{Hash: hash, Size: fi.Size(), ContentType: ct}, nil
}
