package server

import (
	"io/fs"
	"net/http"
)

// noWebUIMessage is what a binary built without a frontend answers on "/". It
// names both ways out because the two audiences are different: whoever built
// from a clean checkout wants the pnpm line, and whoever is mid `pnpm --dir web
// dev` wants -web. A bare 404 from a FileServer would send either one looking
// for a routing bug.
const noWebUIMessage = `opendesigner was built without the web UI.

web/dist was empty at build time. Build the frontend and rebuild the binary:

    pnpm --dir web build

or point the running server at a frontend directory:

    opendesigner serve -web web/dist
`

// MountWeb serves the editor at "/".
//
// dir wins when non-empty: -web is the development escape hatch, and a
// developer's freshly built frontend must never be masked by whatever copy was
// baked into the binary. With dir empty the embedded copy is served, which is
// what makes `npx @opendesigner/cli` work with no build step and no flags.
//
// embedded is an fs.FS rather than the embed.FS itself so that the caller owns
// the "dist" prefix (see web/embed.go) and tests can pass an fstest.MapFS.
//
// The pattern is "/" and therefore the mux's weakest: every API route mounted
// beside it is longer and keeps precedence.
func MountWeb(mux *http.ServeMux, dir string, embedded fs.FS) {
	if dir != "" {
		mux.Handle("/", http.FileServer(http.Dir(dir)))
		return
	}
	// web/dist is gitignored, so a clean checkout embeds only the placeholder
	// and still compiles. Detecting that here, once at mount time, turns a
	// puzzling 404 into an answer.
	if _, err := fs.Stat(embedded, "index.html"); err != nil {
		mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, noWebUIMessage, http.StatusInternalServerError)
		}))
		return
	}
	mux.Handle("/", http.FileServerFS(embedded))
}
