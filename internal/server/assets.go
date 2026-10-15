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

// THE ASSET ROUTE — plain HTTP, not the design's `UploadAsset` RPC.
//
// The design called for `UploadAsset` as a client-stream on an `AssetService`.
// It was not implemented, and the reason is the same one that already split the
// bidi `Sync` into two RPCs (see the comment in the .proto): browsers' `fetch`
// CANNOT send a streaming request body, so a Connect client-stream is not
// reachable from the editor -- the only client that exists. It would be a path
// written for nobody.
//
// And then there is the half the RPC does not cover anyway: the bytes must come
// BACK into an `<img src>`, that is from a URL the browser can load by itself.
// That is a GET answering `image/png`, not a unary answering JSON with base64
// inside (a third more bytes, and a blob to assemble by hand). Since the
// download is HTTP out of necessity, keeping the upload on HTTP too puts the
// whole asset path behind a single pair of routes, with a `fetch(url, {method:
// "POST", body: file})` on the client side: no chunk framing to invent, the
// browser streams the body at the transport level.
//
// The prefix is `/assets-api/` and not `/assets/` because `cmd/opendesigner`
// serves the built frontend from the root, and Vite writes its own bundles into
// `dist/assets/`: the two would shadow each other. The development proxy
// (web/vite.config.ts) already forwards this prefix.
//
// Surface: two routes and nothing else.
//
//	POST /assets-api/{docId}          body = the image bytes  -> {hash,size,contentType}
//	GET  /assets-api/{docId}/{hash}   -> the bytes, with their Content-Type
const AssetPrefix = "/assets-api/"

// MountAssets registers the asset route on mux.
func MountAssets(mux *http.ServeMux, workspace string) {
	mux.Handle(AssetPrefix, NewAssetHandler(workspace))
}

// NewAssetHandler returns the asset route's handler for a workspace.
func NewAssetHandler(workspace string) http.Handler {
	return &assetHandler{workspace: workspace}
}

type assetHandler struct {
	workspace string
}

// uploadResponse is the response to a POST. `hash` is the only field the client
// must keep (it ends up in ImageNode.asset_hash); the other two spare it from
// re-reading the file to know what it just uploaded.
type uploadResponse struct {
	Hash        string `json:"hash"`
	Size        int64  `json:"size"`
	ContentType string `json:"contentType"`
}

// The handler parses the path instead of relying on ServeMux patterns: this way
// "POST on an asset" and "GET on the collection" answer 405 by a decision
// written here, and not as a side effect of which patterns happen to be
// registered.
func (h *assetHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, AssetPrefix)
	if rest == r.URL.Path {
		http.NotFound(w, r)
		return
	}
	parts := strings.Split(rest, "/")
	// A trailing slash ("/assets-api/{doc}/") is the collection, not an asset
	// with an empty name.
	if len(parts) == 2 && parts[1] == "" {
		parts = parts[:1]
	}

	switch len(parts) {
	case 1:
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "only POST on this route", http.StatusMethodNotAllowed)
			return
		}
		h.upload(w, r, parts[0])
	case 2:
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "only GET on this route", http.StatusMethodNotAllowed)
			return
		}
		h.serve(w, r, parts[0], parts[1])
	default:
		http.NotFound(w, r)
	}
}

// assetsFor validates the doc id and returns that document's asset store.
//
// The UUID validation is the same as Manager.HubFor and for the same reason:
// the doc id enters a filesystem path. store.Assets in turn rejects any unsafe
// segment -- two checks because the transport's can change (one day ids might
// not be UUIDs) while the store's must not be circumventable by any caller.
func (h *assetHandler) assetsFor(w http.ResponseWriter, docID string) *store.Assets {
	if uuid.Validate(docID) != nil {
		http.Error(w, "invalid doc_id", http.StatusBadRequest)
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
		http.Error(w, "document does not exist", http.StatusNotFound)
		return
	}

	// A cap on the TRANSPORT too, on top of the store's: without it, an infinite
	// body would be read in full only to be rejected at the end. The +1 leaves it
	// to the store to say "too large" in the borderline case, instead of having the
	// body cut off halfway from here.
	r.Body = http.MaxBytesReader(w, r.Body, store.MaxAssetSize+1)

	ref, err := assets.Put(r.Body)
	if err != nil {
		var tooBig *http.MaxBytesError
		switch {
		case errors.Is(err, store.ErrAssetTooLarge) || errors.As(err, &tooBig):
			http.Error(w, "image too large", http.StatusRequestEntityTooLarge)
		case errors.Is(err, store.ErrAssetType):
			// 415 and not 400: the request is well-formed, it is the content TYPE
			// that is not accepted.
			http.Error(w, "unsupported file type", http.StatusUnsupportedMediaType)
		case errors.Is(err, store.ErrAssetDocID):
			http.Error(w, "invalid doc_id", http.StatusBadRequest)
		default:
			http.Error(w, "could not save the image", http.StatusInternalServerError)
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
		// A malformed hash is a 404 like an unknown hash, not a 400: they are the
		// same thing to whoever asks (that asset is not there), and telling them apart
		// would tell a curious caller which names have the right shape.
		if errors.Is(err, store.ErrAssetNotFound) || errors.Is(err, store.ErrAssetHash) ||
			errors.Is(err, store.ErrAssetDocID) || errors.Is(err, store.ErrAssetType) {
			http.NotFound(w, r)
			return
		}
		http.Error(w, "could not read the image", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	// The type comes from the store's allowlist, never from the client, and is
	// accompanied by nosniff: together they are what stops this route -- which
	// serves bytes uploaded from outside, from the SAME origin as the editor --
	// from becoming a host for HTML or script.
	w.Header().Set("Content-Type", ref.ContentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// The name IS the content: the bytes at this URL can never change.
	// Without this the browser would re-download every image on every page
	// reload, and the render loop would show the placeholder in the meantime.
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")

	// ServeContent instead of io.Copy: it handles Range and HEAD, writes
	// Content-Length, and does not guess the type because we already wrote it.
	// The modtime is zero on purpose -- conditional validation on immutable
	// content has nothing to add to the hash.
	http.ServeContent(w, r, "", time.Time{}, f)
}
