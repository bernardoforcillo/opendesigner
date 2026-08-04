package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/bernardoforcillo/opendesigner/internal/store"
	"github.com/google/uuid"
)

// LA ROUTE DEGLI ASSET — HTTP semplice, non l'RPC `UploadAsset` del design.
//
// Il design prevedeva `UploadAsset` come client-stream su un `AssetService`.
// Non è stato implementato, e la ragione è la stessa che ha già spezzato il
// `Sync` bidi in due RPC (vedi il commento nel .proto): il `fetch` dei browser
// NON sa mandare un request body in streaming, quindi un client-stream Connect
// non è raggiungibile dall'editor -- che è l'unico client che esiste. Sarebbe
// un percorso scritto per nessuno.
//
// E poi c'è la metà che l'RPC non copre comunque: i byte devono TORNARE dentro
// un `<img src>`, cioè da un URL che il browser sa caricare da solo. Quello è un
// GET che risponde `image/png`, non un unary che risponde JSON con dentro del
// base64 (un terzo di byte in più, e un blob da montare a mano). Dato che la
// discesa è HTTP per forza, tenere anche la salita in HTTP mette tutto il
// percorso asset dietro una coppia di route sola, con una `fetch(url, {method:
// "POST", body: file})` dalla parte del client: nessun framing di chunk da
// inventare, il body lo mette in streaming il browser al livello di trasporto.
//
// Il prefisso è `/assets-api/` e non `/assets/` perché `cmd/opendesigner` serve il
// frontend compilato dalla radice, e Vite scrive i propri bundle in
// `dist/assets/`: le due cose si coprirebbero a vicenda. Il proxy di sviluppo
// (web/vite.config.ts) inoltra già questo prefisso.
//
// Superficie: due route e nient'altro.
//
//	POST /assets-api/{docId}          body = i byte dell'immagine  -> {hash,size,contentType}
//	GET  /assets-api/{docId}/{hash}   -> i byte, con il loro Content-Type
const AssetPrefix = "/assets-api/"

// MountAssets registra la route degli asset su mux.
func MountAssets(mux *http.ServeMux, workspace string) {
	mux.Handle(AssetPrefix, NewAssetHandler(workspace))
}

// NewAssetHandler ritorna l'handler della route degli asset per un workspace.
func NewAssetHandler(workspace string) http.Handler {
	return &assetHandler{workspace: workspace}
}

type assetHandler struct {
	workspace string
}

// uploadResponse è la risposta a un POST. `hash` è l'unico campo che il client
// deve conservare (finisce in ImageNode.asset_hash); gli altri due gli
// risparmiano di rileggere il file per sapere che cosa ha appena caricato.
type uploadResponse struct {
	Hash        string `json:"hash"`
	Size        int64  `json:"size"`
	ContentType string `json:"contentType"`
}

// Il percorso lo analizza l'handler invece di affidarsi ai pattern di
// ServeMux: così "POST su un asset" e "GET sulla collezione" rispondono 405 per
// una decisione scritta qui, e non per l'effetto collaterale di quali pattern
// risultano registrati.
func (h *assetHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, AssetPrefix)
	if rest == r.URL.Path {
		http.NotFound(w, r)
		return
	}
	parts := strings.Split(rest, "/")
	// Una barra finale ("/assets-api/{doc}/") è la collezione, non un asset
	// dal nome vuoto.
	if len(parts) == 2 && parts[1] == "" {
		parts = parts[:1]
	}

	switch len(parts) {
	case 1:
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "solo POST su questa route", http.StatusMethodNotAllowed)
			return
		}
		h.upload(w, r, parts[0])
	case 2:
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "solo GET su questa route", http.StatusMethodNotAllowed)
			return
		}
		h.serve(w, r, parts[0], parts[1])
	default:
		http.NotFound(w, r)
	}
}

// assetsFor valida il doc id e ritorna lo store degli asset di quel documento.
//
// La validazione come UUID è la stessa di Manager.HubFor e per lo stesso
// motivo: il doc id entra in un percorso del filesystem. store.Assets rifiuta a
// sua volta qualunque segmento non sicuro -- due controlli perché quello del
// trasporto può cambiare (un giorno gli id potrebbero non essere UUID) mentre
// quello dello store non deve poter essere aggirato da nessun chiamante.
func (h *assetHandler) assetsFor(w http.ResponseWriter, docID string) *store.Assets {
	if uuid.Validate(docID) != nil {
		http.Error(w, "doc_id non valido", http.StatusBadRequest)
		return nil
	}
	return store.NewAssets(h.workspace, docID)
}

func (h *assetHandler) upload(w http.ResponseWriter, r *http.Request, docID string) {
	assets := h.assetsFor(w, docID)
	if assets == nil {
		return
	}
	if !assets.HasBundle() {
		http.Error(w, "documento inesistente", http.StatusNotFound)
		return
	}

	// Tetto anche al TRASPORTO, oltre a quello dello store: senza, un body
	// infinito verrebbe letto per intero solo per essere rifiutato alla fine.
	// Il +1 lascia allo store il compito di dire "troppo grande" nel caso al
	// limite, invece di far tagliare il corpo a metà da qui.
	r.Body = http.MaxBytesReader(w, r.Body, store.MaxAssetSize+1)

	ref, err := assets.Put(r.Body)
	if err != nil {
		var tooBig *http.MaxBytesError
		switch {
		case errors.Is(err, store.ErrAssetTooLarge) || errors.As(err, &tooBig):
			http.Error(w, "immagine troppo grande", http.StatusRequestEntityTooLarge)
		case errors.Is(err, store.ErrAssetType):
			// 415 e non 400: la richiesta è formata bene, è il TIPO del
			// contenuto a non essere accettato.
			http.Error(w, "tipo di immagine non supportato", http.StatusUnsupportedMediaType)
		case errors.Is(err, store.ErrAssetDocID):
			http.Error(w, "doc_id non valido", http.StatusBadRequest)
		default:
			http.Error(w, "impossibile salvare l'immagine", http.StatusInternalServerError)
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_ = json.NewEncoder(w).Encode(uploadResponse{Hash: ref.Hash, Size: ref.Size, ContentType: ref.ContentType})
}

func (h *assetHandler) serve(w http.ResponseWriter, r *http.Request, docID, hash string) {
	assets := h.assetsFor(w, docID)
	if assets == nil {
		return
	}
	f, ref, err := assets.Open(hash)
	if err != nil {
		// Un hash malformato è 404 come un hash sconosciuto, non 400: sono la
		// stessa cosa per chi chiede (quell'asset non c'è), e distinguerli
		// direbbe a un curioso quali nomi hanno la forma giusta.
		if errors.Is(err, store.ErrAssetNotFound) || errors.Is(err, store.ErrAssetHash) ||
			errors.Is(err, store.ErrAssetDocID) || errors.Is(err, store.ErrAssetType) {
			http.NotFound(w, r)
			return
		}
		http.Error(w, "impossibile leggere l'immagine", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	// Il tipo esce dall'allowlist dello store, mai dal client, ed è accompagnato
	// da nosniff: insieme sono ciò che impedisce a questa route -- che serve byte
	// caricati da fuori, dallo STESSO origin dell'editor -- di diventare un host
	// per HTML o script.
	w.Header().Set("Content-Type", ref.ContentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Il nome È il contenuto: i byte a questo URL non possono cambiare, mai.
	// Senza questo il browser riscaricherebbe ogni immagine a ogni ricarica
	// della pagina, e il render loop mostrerebbe il segnaposto nel frattempo.
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")

	// ServeContent invece di io.Copy: gestisce Range e HEAD, scrive
	// Content-Length, e non indovina il tipo perché gliel'abbiamo già scritto.
	// Il modtime è zero apposta -- la validazione condizionale su un contenuto
	// immutabile non ha niente da aggiungere all'hash.
	http.ServeContent(w, r, "", time.Time{}, f)
}
