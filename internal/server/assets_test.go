package server

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/bernardoforcillo/brawt/internal/store"
	"github.com/google/uuid"
)

// assetServer starts the asset route over a fresh workspace and returns the
// server plus the id of one document that really exists in it.
func assetServer(t *testing.T) (*httptest.Server, string, string) {
	t.Helper()
	ws := t.TempDir()
	docID := uuid.NewString()
	if _, err := store.Open(ws, docID, "Test"); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	MountAssets(mux, ws)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, ws, docID
}

func testPNG(t *testing.T, c color.Color) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 3, 3))
	for y := 0; y < 3; y++ {
		for x := 0; x < 3; x++ {
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func postAsset(t *testing.T, srv *httptest.Server, docID string, body []byte) *http.Response {
	t.Helper()
	res, err := srv.Client().Post(srv.URL+"/assets-api/"+docID, "application/octet-stream", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

func uploadedHash(t *testing.T, res *http.Response) string {
	t.Helper()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	var out struct {
		Hash        string `json:"hash"`
		Size        int64  `json:"size"`
		ContentType string `json:"contentType"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.Hash == "" {
		t.Fatal("the upload answered without a hash")
	}
	return out.Hash
}

// The round trip the editor actually makes: POST the file, then put the hash in
// an <img src> and get the very same bytes back.
func TestAssetUploadThenServeRoundTrip(t *testing.T) {
	srv, _, docID := assetServer(t)
	data := testPNG(t, color.RGBA{R: 255, A: 255})

	hash := uploadedHash(t, postAsset(t, srv, docID, data))

	res, err := srv.Client().Get(srv.URL + "/assets-api/" + docID + "/" + hash)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET status = %d, want 200", res.StatusCode)
	}
	got, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("served %d bytes, want the %d that were uploaded", len(got), len(data))
	}
	if ct := res.Header.Get("Content-Type"); ct != "image/png" {
		t.Fatalf("Content-Type = %q, want image/png", ct)
	}
	// The type comes from OUR allowlist, so the browser must not be allowed to
	// second-guess it: nosniff is what stops a crafted file from being treated
	// as anything else.
	if res.Header.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("the asset route must send X-Content-Type-Options: nosniff")
	}
	// The name IS the content, so the bytes at a URL can never change: without
	// this the browser re-fetches every image on every reload.
	if cc := res.Header.Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Fatalf("Cache-Control = %q, want an immutable response", cc)
	}
}

// Dedup end to end: the same picture dropped twice is one file on disk.
func TestAssetUploadTwiceStoresOneFile(t *testing.T) {
	srv, ws, docID := assetServer(t)
	data := testPNG(t, color.RGBA{B: 255, A: 255})

	first := uploadedHash(t, postAsset(t, srv, docID, data))
	second := uploadedHash(t, postAsset(t, srv, docID, data))

	if first != second {
		t.Fatalf("the same bytes gave two hashes: %q and %q", first, second)
	}
	entries, err := os.ReadDir(filepath.Join(ws, docID+".brawt", "assets"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("assets dir holds %d files, want 1", len(entries))
	}
}

func TestAssetGetUnknownHashIs404(t *testing.T) {
	srv, _, docID := assetServer(t)
	res, err := srv.Client().Get(srv.URL + "/assets-api/" + docID + "/" + strings.Repeat("ab", 32))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", res.StatusCode)
	}
}

// A path that tries to climb out of the assets directory must be refused, and
// must certainly not answer with the bundle's own files.
func TestAssetGetRefusesPathTraversal(t *testing.T) {
	srv, ws, docID := assetServer(t)
	meta, err := os.ReadFile(filepath.Join(ws, docID+".brawt", "meta.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		"/assets-api/" + docID + "/..%2fmeta.json",
		"/assets-api/" + docID + "/....//meta.json",
		"/assets-api/" + docID + "/meta.json",
		"/assets-api/" + docID + "/" + strings.Repeat("AB", 32),
	} {
		res, err := srv.Client().Get(srv.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if res.StatusCode == http.StatusOK {
			t.Errorf("GET %s answered 200", path)
		}
		if bytes.Contains(body, meta) {
			t.Errorf("GET %s served the bundle's meta.json", path)
		}
	}
}

// An upload aimed at a document that does not exist must not bring one into
// being: a bundle is created by CreateDocument, not by dropping a file.
func TestAssetUploadToAnUnknownDocumentIs404(t *testing.T) {
	srv, ws, _ := assetServer(t)
	ghost := uuid.NewString()

	res := postAsset(t, srv, ghost, testPNG(t, color.Black))
	if res.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", res.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(ws, ghost+".brawt")); !os.IsNotExist(err) {
		t.Fatal("the upload created a bundle for a document that does not exist")
	}
}

func TestAssetUploadRejectsANonImage(t *testing.T) {
	srv, _, docID := assetServer(t)
	res := postAsset(t, srv, docID, []byte("<html><script>alert(1)</script></html>"))
	if res.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d, want 415", res.StatusCode)
	}
}

func TestAssetUploadRejectsAnOversizeBody(t *testing.T) {
	srv, _, docID := assetServer(t)
	data := append(testPNG(t, color.Black), bytes.Repeat([]byte{0}, store.MaxAssetSize)...)

	res, err := srv.Client().Post(srv.URL+"/assets-api/"+docID, "application/octet-stream", bytes.NewReader(data))
	if err != nil {
		// A server that closes the connection on an oversize body is an
		// acceptable outcome too; what must not happen is a stored file.
		t.Logf("post failed as expected: %v", err)
	} else {
		defer res.Body.Close()
		if res.StatusCode != http.StatusRequestEntityTooLarge {
			t.Fatalf("status = %d, want 413", res.StatusCode)
		}
	}
}

func TestAssetRouteRejectsAMalformedDocumentID(t *testing.T) {
	srv, _, _ := assetServer(t)
	for _, path := range []string{
		"/assets-api/not-a-uuid",
		"/assets-api/not-a-uuid/" + strings.Repeat("ab", 32),
	} {
		res, err := srv.Client().Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode == http.StatusOK {
			t.Errorf("GET %s answered 200", path)
		}
	}
}

func TestAssetRouteRejectsTheWrongMethod(t *testing.T) {
	srv, _, docID := assetServer(t)
	hash := uploadedHash(t, postAsset(t, srv, docID, testPNG(t, color.White)))

	cases := []struct{ method, path string }{
		{http.MethodGet, "/assets-api/" + docID},
		{http.MethodDelete, "/assets-api/" + docID + "/" + hash},
		{http.MethodPost, "/assets-api/" + docID + "/" + hash},
	}
	for _, c := range cases {
		req, err := http.NewRequest(c.method, srv.URL+c.path, nil)
		if err != nil {
			t.Fatal(err)
		}
		res, err := srv.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusMethodNotAllowed {
			t.Errorf("%s %s status = %d, want 405", c.method, c.path, res.StatusCode)
		}
	}
}
