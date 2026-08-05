package server

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

// getBody issues a GET against mux and returns the status and body, so each
// test below reads as one request and one assertion.
func getBody(t *testing.T, mux *http.ServeMux, path string) (int, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec.Code, rec.Body.String()
}

// A binary built with the frontend embedded serves it with no flags at all:
// this is the whole point of `npx @opendesigner/cli` needing no build step.
func TestMountWebServesEmbeddedIndex(t *testing.T) {
	mux := http.NewServeMux()
	MountWeb(mux, "", fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<title>embedded</title>")},
	})

	code, body := getBody(t, mux, "/")
	if code != http.StatusOK {
		t.Fatalf("GET / = %d, want 200", code)
	}
	if !strings.Contains(body, "embedded") {
		t.Errorf("GET / body = %q, want the embedded index.html", body)
	}
}

// -web keeps working for `pnpm --dir web dev` workflows, and must win over the
// embedded copy -- otherwise a developer's rebuilt frontend would be masked by
// whatever was baked into the binary.
func TestMountWebDirOverridesEmbedded(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<title>from disk</title>"), 0o644); err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	MountWeb(mux, dir, fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<title>embedded</title>")},
	})

	code, body := getBody(t, mux, "/")
	if code != http.StatusOK {
		t.Fatalf("GET / = %d, want 200", code)
	}
	if !strings.Contains(body, "from disk") {
		t.Errorf("GET / body = %q, want the on-disk index.html to win", body)
	}
}

// web/dist is gitignored, so a clean checkout embeds only the placeholder and
// the binary compiles with no frontend in it. That must say so, because the
// bare 404 a FileServer would return sends you looking for a routing bug
// instead of a missing `pnpm --dir web build`.
func TestMountWebMissingIndexExplainsHowToBuild(t *testing.T) {
	mux := http.NewServeMux()
	MountWeb(mux, "", fstest.MapFS{})

	code, body := getBody(t, mux, "/")
	if code != http.StatusInternalServerError {
		t.Fatalf("GET / = %d, want 500", code)
	}
	if !strings.Contains(body, "pnpm --dir web build") {
		t.Errorf("GET / body = %q, want it to name the build command", body)
	}
	if !strings.Contains(body, "-web") {
		t.Errorf("GET / body = %q, want it to mention the -web escape hatch", body)
	}
}

// The editor loads its Vite bundles from /assets/, a sibling of index.html, so
// serving the root alone is not enough.
func TestMountWebServesEmbeddedSubdirectory(t *testing.T) {
	mux := http.NewServeMux()
	MountWeb(mux, "", fstest.MapFS{
		"index.html":     &fstest.MapFile{Data: []byte("<title>embedded</title>")},
		"assets/main.js": &fstest.MapFile{Data: []byte("console.log(1)")},
	})

	code, body := getBody(t, mux, "/assets/main.js")
	if code != http.StatusOK {
		t.Fatalf("GET /assets/main.js = %d, want 200", code)
	}
	if !strings.Contains(body, "console.log(1)") {
		t.Errorf("GET /assets/main.js body = %q, want the embedded bundle", body)
	}
}

// MountWeb must not shadow the API routes mounted beside it. ServeMux gives
// longer patterns precedence, so this is really a guard against someone later
// "simplifying" MountWeb into a catch-all that swallows /assets-api/.
func TestMountWebLeavesAssetRouteAlone(t *testing.T) {
	mux := http.NewServeMux()
	mux.Handle(AssetPrefix, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("asset api"))
	}))
	MountWeb(mux, "", fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<title>embedded</title>")},
	})

	code, body := getBody(t, mux, AssetPrefix+"doc1/abc")
	if code != http.StatusOK || body != "asset api" {
		t.Errorf("GET %sdoc1/abc = %d %q, want 200 %q", AssetPrefix, code, body, "asset api")
	}
}

// compile-time guard: MountWeb takes an fs.FS, so web.Dist and fstest.MapFS are
// interchangeable and the handler stays testable without touching the embed.
var _ func(*http.ServeMux, string, fs.FS) = MountWeb
